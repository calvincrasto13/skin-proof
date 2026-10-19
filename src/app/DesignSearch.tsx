import { useRef, useState } from 'react';
import { ISearch } from './icons';

const STYLES = ['Fine line', 'Blackwork', 'Botanical', 'Traditional', 'Script', 'Geometric'];

/** Openverse (openly licensed images from Flickr, Wikimedia and others) answers in CORS mode, so under this site's COEP
 *  its thumbnails can be shown inline and fetched straight into a layer. Search engines like Google, Bing and Pinterest
 *  refuse framing and send no CORS headers, so they can't. */
const API = 'https://api.openverse.org/v1/images/';

type Hit = { id: string; title: string; thumb: string; creator?: string; license: string; source: string };
type State = { stage: 'idle' } | { stage: 'loading' } | { stage: 'done'; hits: Hit[] } | { stage: 'error'; message: string };

async function searchOpenverse(terms: string, signal: AbortSignal): Promise<Hit[]> {
  const url = `${API}?${new URLSearchParams({ q: terms, page_size: '20', mature: 'false' })}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(r.status === 429 ? 'Too many searches, try again in a minute' : `Search failed (${r.status})`);
  const body = await r.json() as { results: { id: string; title?: string; thumbnail?: string; creator?: string; license: string; foreign_landing_url: string }[] };
  return body.results.filter((x) => x.thumbnail).map((x) => ({
    id: x.id, title: x.title || 'Untitled', thumb: x.thumbnail!, creator: x.creator, license: x.license, source: x.foreign_landing_url,
  }));
}

/** The image as a File, in memory only: the larger rendering first, the grid thumbnail if that fails. */
async function fetchDesign(hit: Hit): Promise<File> {
  for (const url of [`${hit.thumb}?full_size=true&compressed=false`, hit.thumb]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const blob = await r.blob();
      if (!blob.type.startsWith('image/')) continue;
      return new File([blob], hit.title.slice(0, 60), { type: blob.type });
    } catch { /* try the next size */ }
  }
  throw new Error(`Couldn't fetch "${hit.title}"`);
}

/** Image search in the studio: click a result and it becomes a tattoo layer, nothing saved to disk. */
export function DesignSearch({ canAdd, onAdd }: { canAdd: boolean; onAdd: (files: File[]) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState<State>({ stage: 'idle' });
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const search = async (query: string) => {
    const words = query.trim();
    if (!words) return;
    setQ(words);
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setState({ stage: 'loading' });
    setAddError(null);
    try {
      const terms = /\btattoo/i.test(words) ? words : `${words} tattoo`;
      setState({ stage: 'done', hits: await searchOpenverse(terms, ac.signal) });
    } catch (e) {
      if (!ac.signal.aborted) setState({ stage: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const add = async (hit: Hit) => {
    if (!canAdd || adding) return;
    setAdding(hit.id);
    setAddError(null);
    try {
      await onAdd([await fetchDesign(hit)]);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="design-search" aria-labelledby="design-search-title">
      <h2 id="design-search-title" className="panel-title">Find a design</h2>
      <form role="search" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. snake, peony, moth"
          aria-label="Search for tattoo designs" enterKeyHint="search" />
        <button type="submit" className="btn btn-icon" aria-label="Search" disabled={!q.trim()}><ISearch /></button>
      </form>
      <div className="ds-chips">
        {STYLES.map((s) => <button key={s} type="button" onClick={() => void search(s)}>{s}</button>)}
      </div>

      {state.stage === 'loading' && <p className="note" aria-live="polite">Searching…</p>}
      {state.stage === 'error' && <p className="err" role="alert">{state.message}</p>}
      {state.stage === 'done' && (state.hits.length === 0
        ? <p className="note" aria-live="polite">No results. Try a simpler word.</p>
        : (
          <>
            {!canAdd && <p className="note">Add a body photo first, then click a design to place it.</p>}
            <ul className="ds-grid" aria-label="Search results">
              {state.hits.map((h) => (
                <li key={h.id}>
                  <button type="button" disabled={!canAdd || !!adding} aria-busy={adding === h.id} onClick={() => void add(h)}
                    title={`${h.title}${h.creator ? ` by ${h.creator}` : ''} (${h.license.toUpperCase()}). Click to add.`}>
                    <img src={h.thumb} alt={h.title} crossOrigin="anonymous" loading="lazy" decoding="async"
                      onError={(e) => { (e.currentTarget.closest('li') as HTMLElement).hidden = true; }} />
                    {adding === h.id && <span className="ds-busy">Adding…</span>}
                  </button>
                </li>
              ))}
            </ul>
            {addError && <p className="err" role="alert">{addError}</p>}
            <p className="note">Openly licensed images via <a href="https://openverse.org" target="_blank" rel="noopener noreferrer">Openverse</a>. Hover for the creator and licence; check it before getting one inked.</p>
          </>
        ))}
    </section>
  );
}

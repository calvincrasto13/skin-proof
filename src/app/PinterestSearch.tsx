import { useState } from 'react';
import { ISearch } from './icons';

const STYLES = ['Fine line', 'Blackwork', 'Botanical', 'Traditional', 'Script', 'Geometric'];

/** Pinterest blocks framing and its pin images carry no CORS/CORP headers, so under this site's COEP they can't be shown
 *  inline. Searching opens Pinterest in a new tab instead; the user saves a design and adds it here. */
export function PinterestSearch() {
  const [q, setQ] = useState('');
  const search = (query: string) => {
    const words = query.trim();
    if (!words) return;
    const terms = /\btattoo/i.test(words) ? words : `${words} tattoo`;
    window.open(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(terms)}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="pin-search" aria-labelledby="pin-search-title">
      <h2 id="pin-search-title" className="panel-title">Find a design on Pinterest</h2>
      <form role="search" onSubmit={(e) => { e.preventDefault(); search(q); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. snake, peony, moth"
          aria-label="Search Pinterest for tattoo ideas" enterKeyHint="search" />
        <button type="submit" className="btn btn-icon" aria-label="Search Pinterest (opens a new tab)" disabled={!q.trim()}><ISearch /></button>
      </form>
      <div className="pin-chips">
        {STYLES.map((s) => <button key={s} type="button" onClick={() => search(s)}>{s}</button>)}
      </div>
      <p className="note">Opens in a new tab. Save a design you like, then add it with <strong>Add tattoo files</strong>.</p>
    </section>
  );
}

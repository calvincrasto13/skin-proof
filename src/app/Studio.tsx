import { useEffect, useRef, useState } from 'react';
import { testDesign } from '../design/key';
import { loadPhoto } from '../ingest/loadPhoto';
import { syntheticLimb } from '../ingest/syntheticLimb';
import type { BlendMode, LayerInk } from '../render/compositor';
import { useTryOn, type Layer, type TryOn } from '../studio/useTryOn';
import {
  ICompare, IDown, IDownload, IEye, IEyeOff, IFit, IImage, IInk, ILayers, ILock, IMove, IPlus, IRedo, ITrash, IUndo, IUp, IUpload, Logo,
} from './icons';
import { DesignSearch } from './DesignSearch';

export type IncomingPhoto = { bitmap: ImageBitmap; name: string } | 'sample' | null;

type Tab = 'place' | 'ink' | 'fit' | 'layers';

const INKS: { name: string; ink: LayerInk }[] = [
  // Pigment as it sits in the dermis, before epidermal scatter lifts it.
  { name: 'Black', ink: { color: '#1d1e22', saturation: 1, opacity: 0.85 } },
  { name: 'Blue-black', ink: { color: '#19273c', saturation: 1, opacity: 0.85 } },
  { name: 'Grey wash', ink: { color: '#1d1e22', saturation: 1, opacity: 0.45 } },
];
const inkName = (ink: LayerInk) => INKS.find((p) => p.ink.color === ink.color && p.ink.opacity === ink.opacity)?.name ?? 'Custom';

/** The working screen: tattoos on the left, the photo in the middle, the selected tattoo on the right. */
export function Studio({ incoming, onConsumed }: { incoming: IncomingPhoto; onConsumed: () => void }) {
  const t = useTryOn();
  const [tab, setTab] = useState<Tab>('place');
  const [dragOver, setDragOver] = useState<'photo' | 'designs' | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);

  // A photo handed over from the landing page, or the sample arm.
  useEffect(() => {
    if (!incoming) return;
    let cancelled = false;
    (async () => {
      const p = incoming === 'sample' ? { bitmap: await syntheticLimb(), name: 'sample arm' } : incoming;
      if (cancelled) return;
      t.loadPhoto(p.bitmap, p.name);
      if (t.layers.length === 0) t.addLayer('memento (sample)', testDesign('lineart'), p.bitmap);
      onConsumed();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  // Dev only: ?photo=/dev/<file> loads a test photo from the gitignored dev/ folder (served by the dev server, never built), or
  // /docs/stock/<file> one of the committed stock photos; &nosample skips the sample tattoo.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(location.search);
    const url = params.get('photo');
    if (!url || !(url.startsWith('/dev/') || url.startsWith('/docs/stock/'))) return;
    let cancelled = false;
    fetch(url).then((r) => r.blob()).then(loadPhoto).then(({ bitmap }) => {
      if (cancelled) return;
      t.loadPhoto(bitmap, url.split('/').pop() ?? 'photo');
      if (!params.has('nosample')) t.addLayer('memento (sample)', testDesign('lineart'), bitmap);
    }).catch((e) => t.setError(String(e)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: Space compares; Ctrl/Cmd+Z undoes, +Shift (or Y) redoes; Delete removes the selection.
  const tRef = useRef(t);
  tRef.current = t;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      return el.isContentEditable || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox') || el.tagName === 'TEXTAREA';
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || !rootRef.current?.offsetParent) return; // hidden behind the landing page
      const t = tRef.current;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space' && !mod && (e.target === document.body || (e.target as HTMLElement).tagName === 'CANVAS')) {
        e.preventDefault(); t.setComparing(true);
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault(); if (e.shiftKey) t.redo(); else t.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault(); t.redo();
      } else if (e.key === 'Escape' && t.editMesh) {
        t.setEditMesh(false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && t.selectedId && e.target === document.body) {
        e.preventDefault(); t.removeLayer(t.selectedId);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') tRef.current.setComparing(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const openPhoto = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    const { bitmap } = await loadPhoto(f);
    t.loadPhoto(bitmap, f.name);
  };

  const sel = t.selected;
  const fit = sel ? t.fits.get(sel.id) : undefined;
  const L = t.photo ? Math.max(t.photo.width, t.photo.height) : 1000;

  return (
    <div className="studio" data-tab={tab} ref={rootRef}>
      <header className="st-top">
        <a href="#/" className="wordmark" aria-label="Skin Proof home"><Logo size={24} accent="#E0553A" /><span>Skin Proof</span></a>
        {t.photo && <DepthChip t={t} />}
        {(t.photo || t.layers.length > 0) && (
          <button type="button" className="btn btn-ghost" onClick={() => deleteDialog.current?.showModal()}>
            <ITrash /><span className="compare-label">Delete images</span>
          </button>
        )}
        <div className="grow" />
        <div role="group" aria-label="History" style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!t.canUndo} onClick={t.undo}><IUndo /></button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!t.canRedo} onClick={t.redo}><IRedo /></button>
        </div>
        <button
          type="button" className="btn" aria-pressed={t.comparing} disabled={!t.photo}
          onPointerDown={() => t.setComparing(true)} onPointerUp={() => t.setComparing(false)} onPointerLeave={() => t.setComparing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter') t.setComparing(true); }} onKeyUp={() => t.setComparing(false)}
        >
          <ICompare /><span className="compare-label">Hold to compare</span><kbd>Space</kbd>
        </button>
        <button type="button" className="btn btn-red" aria-label="Save picture" disabled={!t.photo || t.layers.length === 0} onClick={() => void t.exportPng()}>
          <IDownload /><span className="save-label" aria-hidden="true">Save picture</span>
        </button>
      </header>

      <div className="st-body">
        <aside className="st-left" aria-label="Tattoos">
          <DesignSearch canAdd={!!t.photo} onAdd={t.addFiles} />
          <div className="section-head">
            <h2 className="panel-title">Tattoos</h2>
            <span className="note">{t.layers.length}</span>
          </div>
          <label
            className={`dropzone${dragOver === 'designs' ? ' dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver('designs'); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => { e.preventDefault(); setDragOver(null); void t.addFiles(e.dataTransfer.files); }}
          >
            <IPlus /> Add tattoo files
            <input type="file" accept="image/*" multiple className="sr-only" disabled={!t.photo}
              onChange={(e) => { if (e.target.files) void t.addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          {t.error && <p className="err" role="alert">{t.error}</p>}
          {t.layers.length > 0 ? (
            <ul className="layer-list">
              {[...t.layers].reverse().map((l, i, arr) => (
                <LayerRow key={l.id} t={t} layer={l} isTop={i === 0} isBottom={i === arr.length - 1}
                  onPick={() => { t.setSelectedId(l.id); setTab('place'); }} />
              ))}
            </ul>
          ) : (
            <p className="note">Line art on white paper works best: a scan, a photo of a sketch, or flash. The paper is removed for you.</p>
          )}
          <div className="row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className="btn btn-ghost" disabled={!t.photo} onClick={() => t.addLayer('memento (sample)', testDesign('lineart'))}>+ Sample design</button>
            <button type="button" className="btn btn-ghost" disabled={!t.photo} onClick={() => t.addLayer('checker (test)', testDesign('checker'))}>+ Checker</button>
          </div>
          <p className="note">Top of the list sits on top. Click a tattoo on the photo to select it.</p>
        </aside>

        <main className="st-stage">
          <div className="st-canvas" ref={t.stageRef}>
            <canvas ref={t.canvasRef} className="gl" aria-label="Your photo with the tattoos placed on it"
              onPointerDown={t.pointerDown} onPointerMove={t.pointerMove} onPointerUp={t.pointerUp} onPointerCancel={t.pointerUp} />
            <canvas ref={t.overlayRef} className="overlay" aria-hidden="true" />
            {!t.photo && (
              <div
                className={`empty${dragOver === 'photo' ? ' dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver('photo'); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); void openPhoto(e.dataTransfer.files); }}
              >
                <div>
                  <IImage size={40} />
                  <h2>Start with a photo</h2>
                  <p>Your arm, forearm or back, straight on, in soft light. Drop it here.</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                    <label className="btn btn-red">
                      <IUpload /> Choose a body photo
                      <input type="file" accept="image/*" className="sr-only" onChange={(e) => { void openPhoto(e.target.files); e.target.value = ''; }} />
                    </label>
                    <button type="button" className="btn" onClick={async () => {
                      const bitmap = await syntheticLimb();
                      t.loadPhoto(bitmap, 'sample arm');
                      if (t.layers.length === 0) t.addLayer('memento (sample)', testDesign('lineart'), bitmap);
                    }}>Try a sample arm</button>
                  </div>
                  <p className="note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ILock size={14} /> Stays on this device.</p>
                </div>
              </div>
            )}
          </div>
          <div className="st-status">
            <span className="hint" aria-live="polite"><StatusHint t={t} /></span>
            <div className="zoom" role="group" aria-label="Zoom">
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Zoom out" disabled={!t.photo || t.zoom <= 1} onClick={() => t.setZoom(t.zoom / 1.5)}>−</button>
              <output aria-label="Zoom level">{Math.round(t.zoom * 100)}%</output>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Zoom in" disabled={!t.photo || t.zoom >= 8} onClick={() => t.setZoom(t.zoom * 1.5)}>+</button>
              <button type="button" className="btn btn-ghost" disabled={!t.photo || t.zoom === 1} onClick={() => t.setZoom(1)}>Fit</button>
            </div>
          </div>
        </main>

        <aside className="st-right" aria-label="Selected tattoo">
          {sel ? (
            <>
              <div className="section-head">
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.name}</h2>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`Delete ${sel.name}`} onClick={() => t.removeLayer(sel.id)}><ITrash /></button>
              </div>

              <section className="group" data-section="place">
                <h3 className="panel-title">Placement</h3>
                <Range label="Size" value={sel.width} min={20} max={Math.round(L * 1.2)} step={1} display={`${Math.round((sel.width / L) * 100)}% of photo`}
                  onChange={(v) => t.updateLayer(sel.id, { width: v }, `size:${sel.id}`)} />
                <Range label="Rotation" value={sel.rotation} min={-180} max={180} step={1} display={`${sel.rotation}°`}
                  onChange={(v) => t.updateLayer(sel.id, { rotation: v }, `rot:${sel.id}`)} />
              </section>

              <section className="group" data-section="fit">
                <h3 className="panel-title">Fit to body</h3>
                <label className="toggle">
                  <span>Follow the body's curve<small>Off shows it flat, like a sticker</small></span>
                  <input type="checkbox" checked={sel.warp} onChange={(e) => t.updateLayer(sel.id, { warp: e.target.checked })} />
                </label>
                <div className="field">
                  <div className="top">
                    <label htmlFor="curve">Curve strength</label>
                    <span className="val">
                      {sel.autoK ? 'Auto' : (fit?.k ?? sel.manualK).toFixed(2)}
                      {!sel.autoK && <button type="button" className="link-btn" onClick={() => t.updateLayer(sel.id, { autoK: true })}>Auto</button>}
                    </span>
                  </div>
                  <input id="curve" type="range" min={0.02} max={2} step={0.01} value={fit?.k ?? sel.manualK} disabled={!sel.warp || !t.hasDepth}
                    onChange={(e) => t.updateLayer(sel.id, { autoK: false, manualK: +e.target.value }, `k:${sel.id}`)} />
                </div>
                <button type="button" className="btn" aria-pressed={t.editMesh} disabled={!sel.visible}
                  onClick={() => t.setEditMesh(!t.editMesh)}>
                  {t.editMesh ? 'Done adjusting' : 'Adjust the mesh by hand'}
                </button>
                {t.hasCorrections(sel) && (
                  <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => t.resetMesh(sel.id)}>
                    Reset to the automatic fit
                  </button>
                )}
              </section>

              <section className="group" data-section="ink">
                <h3 className="panel-title">Ink</h3>
                <div className="inks" role="radiogroup" aria-label="Ink colour">
                  {INKS.map((p) => (
                    <button key={p.name} type="button" role="radio" className="ink-opt" aria-checked={inkName(sel.ink) === p.name}
                      onClick={() => t.updateLayer(sel.id, { ink: { ...p.ink } })}>
                      <span className="sw" style={{ background: p.name === 'Grey wash' ? '#6e6a66' : p.ink.color }} />{p.name}
                    </button>
                  ))}
                  <label className="ink-opt" aria-checked={inkName(sel.ink) === 'Custom'}>
                    <span className="sw" style={{ background: sel.ink.color }} />Custom
                    <input type="color" value={sel.ink.color} aria-label="Custom ink colour"
                      onChange={(e) => t.updateLayer(sel.id, { ink: { ...sel.ink, color: e.target.value } }, `color:${sel.id}`)} />
                  </label>
                </div>
                <Range label="Strength" value={Math.round(sel.ink.opacity * 100)} min={0} max={100} step={1}
                  display={`${Math.round(sel.ink.opacity * 100)}%${sel.ink.opacity >= 0.75 && sel.ink.opacity <= 0.9 ? ' · healed' : sel.ink.opacity > 0.9 ? ' · fresh' : ''}`}
                  onChange={(v) => t.updateLayer(sel.id, { ink: { ...sel.ink, opacity: v / 100 } }, `op:${sel.id}`)} />
              </section>
            </>
          ) : (
            <p className="nothing" data-section="place">{t.layers.length ? 'Select a tattoo to edit it.' : 'Add a tattoo file to start.'}</p>
          )}

          <section className="group" data-section="ink">
            <h3 className="panel-title">Skin &amp; photo · all tattoos</h3>
            <Range label="Edge softness" value={t.ink.blur} min={0} max={4} step={0.05}
              display={Math.abs(t.ink.blur - t.suggestedBlur) < 0.03 ? 'Matched to photo' : `${t.ink.blur.toFixed(2)} px`}
              onChange={(v) => t.setInk((s) => ({ ...s, blur: v }))} />
            {Math.abs(t.ink.blur - t.suggestedBlur) >= 0.03 && (
              <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => t.setInk((s) => ({ ...s, blur: +t.suggestedBlur.toFixed(2) }))}>Match the photo again</button>
            )}
          </section>

          <details data-section="fit">
            <summary>Under the hood</summary>
            <div>
              <label className="toggle"><span>Show the fitted mesh</span><input type="checkbox" checked={t.showMesh} onChange={(e) => t.setShowMesh(e.target.checked)} /></label>
              {sel && (
                <Range label="Ink saturation" value={sel.ink.saturation} min={0} max={2} step={0.01} display={sel.ink.saturation.toFixed(2)}
                  onChange={(v) => t.updateLayer(sel.id, { ink: { ...sel.ink, saturation: v } }, `sat:${sel.id}`)} />
              )}
              <Range label="Skin scatter" value={t.ink.scatter} min={0} max={0.6} step={0.01} display={t.ink.scatter.toFixed(2)}
                onChange={(v) => t.setInk((s) => ({ ...s, scatter: v }))} />
              <Range label="Grain" value={t.ink.grain} min={0} max={3} step={0.05} display={`${t.ink.grain.toFixed(2)}× photo`}
                onChange={(v) => t.setInk((s) => ({ ...s, grain: v }))} />
              <Range label="Surface smoothing" value={t.smoothSigma} min={0} max={12} step={0.5} display={`σ ${t.smoothSigma}`}
                onChange={(v) => t.setSmoothSigma(v)} />
              <label className="field">
                <span>Blend (for comparison)</span>
                <select value={t.mode} onChange={(e) => t.setMode(e.target.value as BlendMode)}>
                  <option value="physical">Ink in skin (default)</option>
                  <option value="srgb-multiply">Plain multiply</option>
                  <option value="sticker">Sticker</option>
                </select>
              </label>
              <a href="#/labs" className="note">Engineering labs →</a>
            </div>
          </details>
        </aside>
      </div>

      <dialog ref={deleteDialog} className="confirm" aria-labelledby="del-title" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
        <form method="dialog">
          <h2 id="del-title">Delete all images?</h2>
          <p>
            This removes your body photo{t.layers.length ? ` and ${t.layers.length === 1 ? 'your tattoo design' : `all ${t.layers.length} tattoo designs`}` : ''} from
            this page, along with the undo history. It can't be undone.
          </p>
          <p className="note">Nothing was ever uploaded, so there is no copy anywhere else. Pictures you saved stay in your downloads.</p>
          <div className="actions">
            <button type="submit" className="btn" autoFocus>Cancel</button>
            <button type="button" className="btn btn-red" onClick={() => { t.clearAll(); deleteDialog.current?.close(); setTab('place'); }}>
              <ITrash /> Delete everything
            </button>
          </div>
        </form>
      </dialog>

      <nav className="st-tabs" aria-label="Tools">
        <TabBtn tab="place" cur={tab} set={setTab} icon={<IMove />} label="Place" />
        <TabBtn tab="ink" cur={tab} set={setTab} icon={<IInk />} label="Ink" />
        <TabBtn tab="fit" cur={tab} set={setTab} icon={<IFit />} label="Fit" />
        <TabBtn tab="layers" cur={tab} set={setTab} icon={<ILayers />} label="Tattoos" />
      </nav>
    </div>
  );
}

function TabBtn({ tab, cur, set, icon, label }: { tab: Tab; cur: Tab; set: (t: Tab) => void; icon: React.ReactNode; label: string }) {
  return <button type="button" aria-pressed={cur === tab} onClick={() => set(tab)}>{icon}{label}</button>;
}

function LayerRow({ t, layer: l, isTop, isBottom, onPick }: { t: TryOn; layer: Layer; isTop: boolean; isBottom: boolean; onPick: () => void }) {
  const selected = l.id === t.selectedId;
  return (
    <li className={`layer${selected ? ' selected' : ''}${l.visible ? '' : ' hidden'}`}>
      <button type="button" className="pick" aria-pressed={selected} onClick={onPick}>
        <img className="thumb" src={l.thumb} alt="" />
        <span className="meta">
          <span className="name" title={l.name}>{l.name}</span>
          <span className="sub">{l.visible ? `${inkName(l.ink)} · ${Math.round(l.ink.opacity * 100)}%${t.hasCorrections(l) ? ' · adjusted' : ''}` : 'Hidden'}</span>
        </span>
      </button>
      <span className="tools">
        <button type="button" className="reorder" aria-label={`Bring ${l.name} forward`} disabled={isTop} onClick={() => t.moveLayer(l.id, 1)}><IUp size={16} /></button>
        <button type="button" className="reorder" aria-label={`Send ${l.name} backward`} disabled={isBottom} onClick={() => t.moveLayer(l.id, -1)}><IDown size={16} /></button>
        <button type="button" aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`} onClick={() => t.updateLayer(l.id, { visible: !l.visible })}>
          {l.visible ? <IEye size={16} /> : <IEyeOff size={16} />}
        </button>
        <button type="button" aria-label={`Delete ${l.name}`} title="Delete (Ctrl+Z brings it back)" onClick={() => t.removeLayer(l.id)}>
          <ITrash size={16} />
        </button>
      </span>
    </li>
  );
}

function Range(p: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  const id = useRef(`r-${Math.random().toString(36).slice(2, 8)}`).current;
  return (
    <div className="field">
      <div className="top"><label htmlFor={id}>{p.label}</label><span className="val">{p.display}</span></div>
      <input id={id} type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(+e.target.value)} />
    </div>
  );
}

function DepthChip({ t }: { t: TryOn }) {
  const d = t.depthState;
  const MB = (b: number) => (b / 1048576).toFixed(0);
  return (
    <span className="chip" title={t.photoName}>
      <ILock size={14} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{t.photoName}</span>
      <span aria-hidden="true">·</span>
      {d.stage === 'downloading' && (
        <>
          <span>{d.total ? `Getting the shape model ${MB(d.loaded)}/${MB(d.total)} MB` : 'Getting the shape model'}</span>
          {d.total > 0 && <span className="bar"><i style={{ width: `${(d.loaded / d.total) * 100}%` }} /></span>}
        </>
      )}
      {d.stage === 'working' && <span>{d.label}…</span>}
      {d.stage === 'done' && <span>Shape mapped on this device · {(d.ms / 1000).toFixed(1)} s</span>}
      {d.stage === 'error' && <span>Shape unavailable — flat placement</span>}
      {d.stage === 'idle' && <span>Waiting</span>}
    </span>
  );
}

function StatusHint({ t }: { t: TryOn }) {
  if (!t.photo) return <><span className="dot" />No photo yet</>;
  if (t.depthState.stage === 'downloading' || t.depthState.stage === 'working')
    return <><span className="dot busy" />Reading the shape of your body. Tattoos sit flat until it's done.</>;
  if (t.depthState.stage === 'error') return <><span className="dot" />Couldn't read the body shape: {t.depthState.message}</>;
  if (!t.layers.length) return <><span className="dot" />Add a tattoo file to start</>;
  if (!t.selected) return <><span className="dot ok" />Click a tattoo to select it</>;
  if (t.editMesh) return <><span className="dot busy" />Drag the dots to correct the fit · Esc when done</>;
  const fit = t.fits.get(t.selected.id);
  if (!t.selected.warp) return <><span className="dot" />Flat, like a sticker · drag to move</>;
  if (fit && !fit.onSkin) return <><span className="dot busy" />Off the body · drag it onto skin</>;
  return <><span className="dot ok" />Wrapping to your body · drag to move</>;
}


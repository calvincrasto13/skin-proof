import { useEffect, useMemo, useRef, useState } from 'react';
import { DepthClient, type DepthResult } from '../depth/client';
import { keyLineArt, testDesign, type Density } from '../design/key';
import { loadPhoto } from '../ingest/loadPhoto';
import { syntheticLimb } from '../ingest/syntheticLimb';
import { Compositor, type BlendMode, type DebugView, type InkParams, type LayerInk } from '../render/compositor';
import { buildDepthSurface, type Calibration, type DepthSurface } from '../surface/depthSurface';
import { FlatSurface } from '../surface/types';
import { layoutByArcLength, type Layout } from '../warp/arcLength';
import { DEFAULT_INK, LayerInkControls, ModelFieldset, SkinFieldset } from './InkControls';

const MESH_N = 33;

type Pt = { x: number; y: number };

/** One tattoo design placed on the body. Array order is z-order, bottom first. */
type Layer = {
  id: string;
  name: string;
  design: Density;
  visible: boolean;
  anchor: Pt;
  /** Design width measured on the skin, image px. */
  width: number;
  rotation: number;
  warp: boolean;
  autoK: boolean;
  manualK: number;
  ink: LayerInk;
};

type Fit = { layout: Layout; cal: Calibration | null; k: number };

let nextId = 1;
const newId = () => `layer-${nextId++}`;

/**
 * Deliverable 4 plus layers: each design laid onto the depth surface by arc length, rendered as a
 * mesh into the compositor, and stacked. Auto-fit only; the manual lattice (5) adds a per-layer
 * delta on top of each layout.
 */
export function WarpLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const comp = useRef<Compositor | null>(null);
  const depthClient = useRef(new DepthClient());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);

  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [photoInfo, setPhotoInfo] = useState('');
  const [depth, setDepth] = useState<DepthResult | null>(null);
  const [depthStatus, setDepthStatus] = useState('');
  const [smoothSigma, setSmoothSigma] = useState(4);

  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = layers.find((l) => l.id === selectedId) ?? null;

  const [ink, setInk] = useState<InkParams>(DEFAULT_INK);
  const [mode, setMode] = useState<BlendMode>('physical');
  const [debug, setDebug] = useState<DebugView>('composite');
  const [comparing, setComparing] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState<Pt | undefined>(undefined);
  /** Offset from the pointer to the dragged layer's anchor, so grabbing doesn't jump. */
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    try {
      comp.current = new Compositor(canvasRef.current!);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: Math.max(320, window.innerHeight * 0.72) }));
    ro.observe(wrapRef.current!);
    const client = depthClient.current;
    return () => { ro.disconnect(); comp.current?.dispose(); client.dispose(); };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setComparing(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setComparing(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const updateLayer = (id: string, patch: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  /** New layers land near the photo centre, staggered so several adds don't stack exactly. */
  const addLayer = (name: string, design: Density, bitmap = photo) => {
    const W = bitmap?.width ?? 1000, H = bitmap?.height ?? 1000;
    const id = newId();
    setLayers((ls) => {
      const step = ls.length * 0.04 * Math.max(W, H);
      const layer: Layer = {
        id, name, design, visible: true,
        anchor: { x: W / 2 + step, y: H / 2 + step },
        width: Math.round(Math.max(W, H) * 0.2),
        rotation: 0, warp: true, autoK: true, manualK: 0.5,
        ink: { color: DEFAULT_INK.color, saturation: DEFAULT_INK.saturation, opacity: DEFAULT_INK.opacity },
      };
      return [...ls, layer];
    });
    setSelectedId(id);
  };

  const removeLayer = (id: string) => {
    setLayers((ls) => ls.filter((l) => l.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  };

  const moveLayer = (id: string, dir: 1 | -1) =>
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const out = [...ls];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const addFiles = async (files: FileList) => {
    setError(null);
    for (const f of Array.from(files)) {
      try {
        const bitmap = await createImageBitmap(f);
        addLayer(f.name.replace(/\.[^.]+$/, ''), keyLineArt(bitmap));
        bitmap.close();
      } catch (e) {
        setError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const applyPhoto = (bitmap: ImageBitmap, info: string) => {
    const c = comp.current;
    if (!c) return;
    c.setPhoto(bitmap);
    setPhoto(bitmap);
    setDepth(null);
    setDepthStatus('');
    setInk((s) => ({ ...s, blur: +c.suggestedBlur.toFixed(2) }));
    setPhotoInfo(`${info} · edge σ ≈ ${Number.isFinite(c.edgeSigma) ? c.edgeSigma.toFixed(2) : 'n/a'} px`);
    // Re-centre existing layers on the new photo; start with a sample if there are none.
    const L = Math.max(bitmap.width, bitmap.height);
    setLayers((ls) => ls.map((l, i) => ({
      ...l, anchor: { x: bitmap.width / 2 + i * 0.04 * L, y: bitmap.height / 2 + i * 0.04 * L }, width: Math.round(L * 0.2),
    })));
    if (layers.length === 0) addLayer('sample line art', testDesign('lineart'), bitmap);
  };

  // Dev only: ?photo=/dev/<file> from the gitignored dev/ folder (served by the dev server, never built).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const url = new URLSearchParams(location.search).get('photo');
    if (!url || !url.startsWith('/dev/')) return;
    let cancelled = false; // StrictMode mounts twice; only the surviving mount applies the photo
    fetch(url).then((r) => r.blob()).then(loadPhoto)
      .then(({ bitmap, originalW, originalH }) => { if (!cancelled) applyPhoto(bitmap, `${url} ${originalW}×${originalH}`); })
      .catch((e) => setError(String(e)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runDepth = async () => {
    if (!photo) return;
    setError(null);
    try {
      const r = await depthClient.current.run(photo, 'auto', (e) =>
        setDepthStatus(e.type === 'stage' ? e.stage : `downloading ${(e.loaded / 1048576).toFixed(0)}/${(e.total / 1048576).toFixed(0)} MB`));
      setDepth(r);
      setDepthStatus(`${r.device}/${r.dtype} · ${Math.round(r.inferMs)} ms`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDepthStatus('');
    }
  };

  const baseSurface = useMemo(
    () => (depth && photo
      ? buildDepthSurface({ data: depth.disparity, w: depth.width, h: depth.height }, photo.width, photo.height, { smoothSigma, occlusionThreshold: 0.02 })
      : null),
    [depth, photo, smoothSigma],
  );

  // Body mask: clips ink at the silhouette and keeps the background out of the skin-colour base.
  useEffect(() => {
    const c = comp.current;
    if (!c || !photo) return;
    if (baseSurface) c.setBodyMask(baseSurface.d.body, baseSurface.disparity.w, baseSurface.disparity.h);
    else c.setBodyMask(null);
  }, [baseSurface, photo]);

  // Per-layer fits, cached by layer identity: dragging one layer doesn't re-lay-out the others.
  const fitCache = useRef(new Map<string, { layer: Layer; surface: DepthSurface | null; photo: ImageBitmap; fit: Fit }>());
  const fits = useMemo(() => {
    const out = new Map<string, Fit>();
    if (!photo) return out;
    for (const l of layers) {
      const hit = fitCache.current.get(l.id);
      if (hit && hit.layer === l && hit.surface === baseSurface && hit.photo === photo) { out.set(l.id, hit.fit); continue; }
      // Start from continuous skin: snap off seams; off the body entirely, lay out flat so the
      // layer stays visible as an outline and can be dragged back on (its ink is masked anyway).
      const start = baseSurface && l.warp ? baseSurface.nearestInside(l.anchor.x, l.anchor.y) : l.anchor;
      const onSkin = !!start && !!baseSurface && l.warp;
      const from = start ?? l.anchor;
      const cal = onSkin ? baseSurface!.calibrateAt(from.x, from.y) : baseSurface ? baseSurface.calibrateAt(l.anchor.x, l.anchor.y) : null;
      const k = l.autoK ? cal?.kAuto ?? l.manualK : l.manualK;
      const rimR = cal?.ok ? cal.halfWidth : 0;
      const surface = onSkin ? baseSurface!.withK(k, rimR) : new FlatSurface(photo.width, photo.height);
      const layout = layoutByArcLength(surface, {
        cx: from.x, cy: from.y, size: l.width, sizeV: (l.width * l.design.h) / l.design.w,
        rotation: (l.rotation * Math.PI) / 180, n: MESH_N,
      });
      const fit = { layout, cal, k };
      fitCache.current.set(l.id, { layer: l, surface: baseSurface, photo, fit });
      out.set(l.id, fit);
    }
    return out;
  }, [layers, baseSurface, photo]);

  // Sync GPU resources with the layer list: designs on change, meshes on re-fit, deletions.
  const uploaded = useRef(new Map<string, { design: Density; layout: Layout | null }>());
  useEffect(() => {
    const c = comp.current;
    if (!c) return;
    const live = new Set(layers.map((l) => l.id));
    for (const id of [...uploaded.current.keys()]) {
      if (!live.has(id)) { c.removeLayer(id); uploaded.current.delete(id); fitCache.current.delete(id); }
    }
    for (const l of layers) {
      let u = uploaded.current.get(l.id);
      if (!u || u.design !== l.design) {
        c.setLayerDesign(l.id, l.design.data, l.design.w, l.design.h);
        uploaded.current.set(l.id, (u = { design: l.design, layout: null }));
      }
      const fit = fits.get(l.id);
      if (fit && u.layout !== fit.layout) {
        c.setLayerMesh(l.id, fit.layout);
        u.layout = fit.layout;
      }
    }
  }, [layers, fits]);

  // Order, visibility and per-layer ink don't change any mesh, but they change the ink totals.
  const inkSignature = layers.map((l) => `${l.id}:${l.visible}:${l.ink.color}:${l.ink.opacity}:${l.ink.saturation}`).join('|');
  useEffect(() => { comp.current?.invalidateInk(); }, [inkSignature, ink.blur, ink.scatter]);

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__warp = { baseSurface, layers, fits, selectedId };
  }, [baseSurface, layers, fits, selectedId]);

  useEffect(() => {
    if (!photo || !size.w) return;
    const id = requestAnimationFrame(() => {
      const source = { kind: 'layers' as const, layers: layers.filter((l) => l.visible).map((l) => ({ id: l.id, ink: l.ink })) };
      comp.current!.render({ source, ink, mode, debug: comparing ? 'original' : debug, cssW: size.w, cssH: size.h, zoom, focus });
      drawOverlay();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, size, layers, fits, ink, mode, debug, comparing, zoom, focus, showMesh, selectedId]);

  /** Selection outline always; full mesh for the selected layer when "Show mesh" is on. */
  function drawOverlay() {
    const cv = overlayRef.current, c = comp.current;
    if (!cv || !c) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    const fit = selectedId ? fits.get(selectedId) : undefined;
    const layer = selected;
    if (!fit || !layer || comparing) return;
    const v = c.view(size.w, size.h, zoom, focus);
    g.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
    const { n, pos, valid } = fit.layout;
    const line = (idx: (t: number) => number) => {
      g.beginPath();
      let pen = false;
      for (let t = 0; t < n; t++) {
        const k2 = idx(t);
        if (!valid[k2]) { pen = false; continue; }
        if (pen) g.lineTo(pos[2 * k2], pos[2 * k2 + 1]);
        else g.moveTo(pos[2 * k2], pos[2 * k2 + 1]);
        pen = true;
      }
      g.stroke();
    };
    g.lineWidth = 1 / v.scale;
    if (showMesh) {
      g.strokeStyle = 'rgba(0, 220, 255, 0.85)';
      for (let j = 4; j < n - 1; j += 4) line((t) => j * n + t);
      for (let i = 4; i < n - 1; i += 4) line((t) => t * n + i);
    }
    g.strokeStyle = 'rgba(255, 51, 102, 0.9)';
    g.setLineDash([6 / v.scale, 4 / v.scale]);
    line((t) => t);
    line((t) => (n - 1) * n + t);
    line((t) => t * n);
    line((t) => t * n + n - 1);
    g.setLineDash([]);
    g.fillStyle = '#ff3366';
    g.beginPath();
    g.arc(layer.anchor.x, layer.anchor.y, 4 / v.scale, 0, Math.PI * 2);
    g.fill();
  }

  const toImage = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = comp.current!.view(r.width, r.height, zoom, focus);
    return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale };
  };

  /** Topmost visible layer whose laid-out mesh covers p. */
  const pick = (p: Pt): string | null => {
    for (let li = layers.length - 1; li >= 0; li--) {
      const l = layers[li];
      const fit = fits.get(l.id);
      if (!l.visible || !fit) continue;
      if (meshContains(fit.layout, p)) return l.id;
    }
    return null;
  };

  const L = photo ? Math.max(photo.width, photo.height) : 1000;
  const fitSel = selected ? fits.get(selected.id) : undefined;

  return (
    <div>
      <section className="controls">
        <fieldset>
          <legend>Photo & depth</legend>
          <input type="file" accept="image/*" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const { bitmap, originalW, originalH } = await loadPhoto(f);
            applyPhoto(bitmap, `${originalW}×${originalH} → ${bitmap.width}×${bitmap.height}`);
          }} />
          <button onClick={async () => applyPhoto(await syntheticLimb(), 'synthetic limb')}>Use synthetic test limb</button>
          {photoInfo && <div className="muted small">{photoInfo}</div>}
          <button disabled={!photo || /download|infer|detect/.test(depthStatus)} onClick={runDepth}>
            {depth ? 'Re-run depth' : 'Estimate depth'}
          </button>
          {depthStatus && <div className="muted small">{depthStatus}</div>}
          <label>Surface smoothing σ {smoothSigma} (depth px)
            <input type="range" min={0} max={12} step={0.5} value={smoothSigma} onChange={(e) => setSmoothSigma(+e.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
        </fieldset>

        <fieldset disabled={!photo}>
          <legend>Tattoos</legend>
          <label className="file-add">Add tattoo files
            <input type="file" accept="image/*" multiple onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <div className="row">
            <button onClick={() => addLayer('sample line art', testDesign('lineart'))}>+ sample</button>
            <button onClick={() => addLayer('checker', testDesign('checker'))}>+ checker</button>
            <button onClick={() => addLayer('rings', testDesign('rings'))}>+ rings</button>
          </div>
          <ul className="layers">
            {[...layers].reverse().map((l) => (
              <li key={l.id} className={l.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(l.id)}>
                <input type="checkbox" checked={l.visible} title="Visible" onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateLayer(l.id, { visible: e.target.checked })} />
                <span className="layer-name" title={l.name}>{l.name}</span>
                <button title="Bring forward" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, 1); }}>▲</button>
                <button title="Send backward" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, -1); }}>▼</button>
                <button title="Delete" onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }}>✕</button>
              </li>
            ))}
          </ul>
          {layers.length === 0 && <div className="muted small">No tattoos yet. Add line-art files (dark on white).</div>}
          <div className="muted small">Click a tattoo on the image to select it; drag to move.</div>
        </fieldset>

        <fieldset disabled={!selected}>
          <legend>{selected ? `Selected: ${selected.name}` : 'Selected tattoo'}</legend>
          {selected && (
            <>
              <label>Width on skin {selected.width}px
                <input type="range" min={20} max={L} step={1} value={selected.width} onChange={(e) => updateLayer(selected.id, { width: +e.target.value })} />
              </label>
              <label>Rotation {selected.rotation}°
                <input type="range" min={-180} max={180} step={1} value={selected.rotation} onChange={(e) => updateLayer(selected.id, { rotation: +e.target.value })} />
              </label>
              <label><input type="checkbox" checked={selected.warp} onChange={(e) => updateLayer(selected.id, { warp: e.target.checked })} /> Warp to surface (off = flat sticker)</label>
              <label><input type="checkbox" checked={selected.autoK} onChange={(e) => updateLayer(selected.id, { autoK: e.target.checked })} /> Auto relief k</label>
              <label>k {(fitSel?.k ?? selected.manualK).toFixed(3)}
                <input type="range" min={0.02} max={2} step={0.01} disabled={selected.autoK} value={fitSel?.k ?? selected.manualK}
                  onChange={(e) => updateLayer(selected.id, { manualK: +e.target.value })} />
              </label>
              <div className="muted small">
                {!baseSurface ? 'No depth yet: flat layout, no silhouette clipping.'
                  : fitSel?.cal?.ok ? `limb half-width ${fitSel.cal.halfWidth.toFixed(0)} depth px under the anchor`
                  : `calibration: ${fitSel?.cal?.reason}; set k by hand`}
              </div>
              <LayerInkControls ink={selected.ink} onChange={(ink) => updateLayer(selected.id, { ink })} />
            </>
          )}
        </fieldset>

        <SkinFieldset ink={ink} setInk={setInk} />
        <ModelFieldset
          ink={ink} setInk={setInk} mode={mode} setMode={setMode} debug={debug} setDebug={setDebug}
          setComparing={setComparing}
          onReset={() => { setInk({ ...DEFAULT_INK, blur: +(comp.current?.suggestedBlur ?? DEFAULT_INK.blur).toFixed(2) }); setMode('physical'); setDebug('composite'); }}
        >
          <label><input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} /> Show mesh (selected)</label>
          <label>View zoom {zoom.toFixed(1)}×
            <input type="range" min={1} max={10} step={0.5} value={zoom} onChange={(e) => {
              const z = +e.target.value;
              if (z > 1 && zoom <= 1) setFocus(selected ? { ...selected.anchor } : photo ? { x: photo.width / 2, y: photo.height / 2 } : undefined);
              setZoom(z);
            }} />
          </label>
        </ModelFieldset>
      </section>

      <div ref={wrapRef} className="pane" style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, display: 'block', touchAction: 'none', cursor: 'move' }}
          onPointerDown={(e) => {
            if (!photo) return;
            const p = toImage(e);
            const hit = pick(p) ?? selectedId;
            const l = layers.find((x) => x.id === hit);
            if (!l) return;
            setSelectedId(l.id);
            // Grabbing a tattoo keeps the grab point; clicking empty skin moves the selected one there.
            const grabbed = pick(p) === l.id;
            drag.current = { id: l.id, dx: grabbed ? l.anchor.x - p.x : 0, dy: grabbed ? l.anchor.y - p.y : 0 };
            if (!grabbed) updateLayer(l.id, { anchor: p });
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const p = toImage(e);
            updateLayer(d.id, { anchor: { x: p.x + d.dx, y: p.y + d.dy } });
          }}
          onPointerUp={() => (drag.current = null)}
        />
        <canvas ref={overlayRef} style={{ position: 'absolute', left: 8, top: 8, width: size.w, height: size.h, pointerEvents: 'none' }} />
        {!photo && <div className="muted" style={{ padding: 12 }}>Load a photo or the synthetic limb, then estimate depth.</div>}
      </div>
    </div>
  );
}

/** Point-in-mesh over valid quads (each split into two triangles, as rendered). */
function meshContains(l: Layout, p: Pt): boolean {
  const { n, pos, valid } = l;
  const tri = (a: number, b: number, c: number) => {
    const ax = pos[2 * a], ay = pos[2 * a + 1], bx = pos[2 * b], by = pos[2 * b + 1], cx = pos[2 * c], cy = pos[2 * c + 1];
    const d1 = (p.x - bx) * (ay - by) - (ax - bx) * (p.y - by);
    const d2 = (p.x - cx) * (by - cy) - (bx - cx) * (p.y - cy);
    const d3 = (p.x - ax) * (cy - ay) - (cx - ax) * (p.y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos3 = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos3);
  };
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (!valid[a] || !valid[b] || !valid[c] || !valid[d]) continue;
      if (tri(a, b, d) || tri(a, d, c)) return true;
    }
  return false;
}

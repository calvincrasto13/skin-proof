import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DepthClient, type DepthResult } from '../depth/client';
import { keyLineArt, type Density } from '../design/key';
import { flipDensity } from '../design/flip';
import { Compositor, type BlendMode, type InkParams, type LayerInk } from '../render/compositor';
import { buildDepthSurface, type Calibration, type DepthSurface } from '../surface/depthSurface';
import { FlatSurface } from '../surface/types';
import { layoutByArcLength, type Layout } from '../warp/arcLength';
import { applyLattice, controlVertex, isIdentity, LATTICE_M, nudgeControl, type Lattice } from '../warp/lattice';
import { DEFAULT_INK } from '../ui/InkControls';

const MESH_N = 33;
const HISTORY_LIMIT = 100;

export type Pt = { x: number; y: number };

/** One tattoo design placed on the body. Array order is z-order, bottom first. */
export type Layer = {
  id: string;
  name: string;
  design: Density;
  /** Small preview of the keyed design, for the layer list. */
  thumb: string;
  visible: boolean;
  /** Pinned in place: the canvas can't select, drag or reshape it, and it gets no outline. */
  locked: boolean;
  anchor: Pt;
  /** Design width measured on the skin, image px. */
  width: number;
  rotation: number;
  warp: boolean;
  autoK: boolean;
  manualK: number;
  /**
   * Hand corrections on top of the auto-fit (null = none). Kept separate from it, in the design's
   * own frame, so "reset to auto" is clearing this and a new depth result keeps the corrections.
   */
  lattice: Lattice | null;
  ink: LayerInk;
};

/** `layout` is what's drawn: the auto-fit with the layer's hand corrections applied. */
export type Fit = { layout: Layout; cal: Calibration | null; k: number; onSkin: boolean };

export type DepthState =
  | { stage: 'idle' }
  | { stage: 'downloading'; loaded: number; total: number }
  | { stage: 'working'; label: string }
  | { stage: 'done'; ms: number; device: string }
  | { stage: 'error'; message: string };

/**
 * The try-on engine behind the studio: photo, on-device depth, layers (with undo/redo),
 * per-layer fits, GPU sync, rendering, picking and export. The UI only lays it out.
 *
 * Undo keeps whole layer arrays. That's cheap here: layers are small records and designs are
 * shared by reference, never copied; the photo and depth map are not part of history at all.
 */
export function useTryOn() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const comp = useRef<Compositor | null>(null);
  const depthClient = useRef(new DepthClient());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);

  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [photoName, setPhotoName] = useState('');
  const [depth, setDepth] = useState<DepthResult | null>(null);
  const [depthState, setDepthState] = useState<DepthState>({ stage: 'idle' });

  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const [ink, setInk] = useState<InkParams>(DEFAULT_INK);
  const [mode, setMode] = useState<BlendMode>('physical');
  const [smoothSigma, setSmoothSigma] = useState(4);
  const [comparing, setComparing] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  /** Editing the selected layer's control lattice: handles show and drag. */
  const [editMesh, setEditMesh] = useState(false);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  const [zoom, setZoomState] = useState(1);
  const [focus, setFocus] = useState<Pt | undefined>(undefined);

  // ---------- lifecycle ----------
  useEffect(() => {
    try {
      comp.current = new Compositor(canvasRef.current!);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(stageRef.current!);
    const client = depthClient.current;
    return () => { ro.disconnect(); comp.current?.dispose(); client.dispose(); };
  }, []);

  // ---------- history ----------
  const hist = useRef({ past: [] as Layer[][], future: [] as Layer[][], lastKey: '', lastAt: 0 });
  const [, setHistVersion] = useState(0);

  /**
   * Record the state before an edit. Edits sharing a `key` within 800 ms (a slider drag, a run
   * of nudges) fold into one undo step.
   */
  const checkpoint = useCallback((key?: string) => {
    const h = hist.current, now = performance.now();
    if (key && key === h.lastKey && now - h.lastAt < 800) { h.lastAt = now; return; }
    h.past.push(layersRef.current);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    h.lastKey = key ?? '';
    h.lastAt = now;
    setHistVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(layersRef.current);
    h.lastKey = '';
    setLayers(prev);
    setHistVersion((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(layersRef.current);
    h.lastKey = '';
    setLayers(next);
    setHistVersion((v) => v + 1);
  }, []);

  // ---------- layers ----------
  /** Patch without recording history: for the middle of a gesture already checkpointed. */
  const patchLayer = useCallback((id: string, patch: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l))), []);

  const updateLayer = useCallback((id: string, patch: Partial<Layer>, key?: string) => {
    checkpoint(key);
    patchLayer(id, patch);
  }, [checkpoint, patchLayer]);

  const addLayer = useCallback((name: string, design: Density, bitmap: ImageBitmap | null = photo) => {
    const W = bitmap?.width ?? 1000, H = bitmap?.height ?? 1000;
    const L = Math.max(W, H);
    const id = crypto.randomUUID(); // unique across hot reloads and undo/redo restores
    checkpoint();
    setLayers((ls) => {
      const step = (ls.length % 6) * 0.04 * L;
      return [...ls, {
        id, name, design, thumb: densityThumb(design), visible: true, locked: false,
        anchor: { x: W / 2 + step, y: H / 2 + step },
        width: Math.round(L * 0.2),
        rotation: 0, warp: true, autoK: true, manualK: 0.5, lattice: null,
        ink: { color: DEFAULT_INK.color, saturation: DEFAULT_INK.saturation, opacity: DEFAULT_INK.opacity },
      }];
    });
    setSelectedId(id);
  }, [photo, checkpoint]);

  /** Locked tattoos can't be deleted one by one; "Delete images" still clears everything. */
  const removeLayer = useCallback((id: string) => {
    if (layersRef.current.find((l) => l.id === id)?.locked) return;
    checkpoint();
    setLayers((ls) => ls.filter((l) => l.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, [checkpoint]);

  /** Mirrors the artwork itself, so the fit, hand corrections and GPU upload all just follow the new design. */
  const flipLayer = useCallback((id: string, axis: 'h' | 'v') => {
    const l = layersRef.current.find((x) => x.id === id);
    if (!l || l.locked) return;
    const design = flipDensity(l.design, axis);
    updateLayer(id, { design, thumb: densityThumb(design) });
  }, [updateLayer]);

  const moveLayer = useCallback((id: string, dir: 1 | -1) => {
    checkpoint();
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const out = [...ls];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  }, [checkpoint]);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    setError(null);
    // Copy first: a FileList is live, and the caller clears its input right after this starts.
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const bitmap = await createImageBitmap(f);
        addLayer(f.name.replace(/\.[^.]+$/, ''), keyLineArt(bitmap));
        bitmap.close();
      } catch (e) {
        setError(`Couldn't read ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, [addLayer]);

  // ---------- photo + depth ----------
  /** Bumped on every new photo and on delete-all, so a depth run that finishes late is ignored. */
  const photoGen = useRef(0);
  const photoRef = useRef<ImageBitmap | null>(null);

  const runDepth = useCallback(async (bitmap: ImageBitmap) => {
    const gen = photoGen.current;
    const current = () => gen === photoGen.current;
    setDepthState({ stage: 'working', label: 'Getting ready' });
    try {
      const r = await depthClient.current.run(bitmap, 'auto', (e) => {
        if (!current()) return;
        if (e.type === 'download') setDepthState({ stage: 'downloading', loaded: e.loaded, total: e.total });
        else if (e.stage === 'inferring') setDepthState({ stage: 'working', label: 'Reading the shape of your body' });
        else if (e.stage === 'downloading') setDepthState({ stage: 'downloading', loaded: 0, total: 0 });
      });
      if (!current()) return;
      setDepth(r);
      setDepthState({ stage: 'done', ms: r.inferMs, device: r.device });
    } catch (e) {
      if (current()) setDepthState({ stage: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const loadPhoto = useCallback((bitmap: ImageBitmap, name: string) => {
    const c = comp.current;
    if (!c) return;
    photoGen.current++;
    if (photoRef.current && photoRef.current !== bitmap) photoRef.current.close();
    photoRef.current = bitmap;
    c.setPhoto(bitmap);
    setPhoto(bitmap);
    setPhotoName(name);
    setDepth(null);
    setZoomState(1);
    setFocus(undefined);
    setInk((s) => ({ ...s, blur: +c.suggestedBlur.toFixed(2) }));
    // Re-centre any existing layers on the new photo.
    const L = Math.max(bitmap.width, bitmap.height);
    setLayers((ls) => ls.map((l, i) => ({
      ...l, anchor: { x: bitmap.width / 2 + (i % 6) * 0.04 * L, y: bitmap.height / 2 + (i % 6) * 0.04 * L }, width: Math.round(L * 0.2),
    })));
    void runDepth(bitmap);
  }, [runDepth]);

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

  // ---------- fits ----------
  // Cached by layer identity: dragging one layer doesn't re-lay-out the others.
  const fitCache = useRef(new Map<string, { layer: Layer; surface: DepthSurface | null; photo: ImageBitmap; fit: Fit }>());
  const fits = useMemo(() => {
    const out = new Map<string, Fit>();
    if (!photo) return out;
    for (const l of layers) {
      const hit = fitCache.current.get(l.id);
      if (hit && hit.layer === l && hit.surface === baseSurface && hit.photo === photo) { out.set(l.id, hit.fit); continue; }
      out.set(l.id, fitLayer(l, baseSurface, photo));
      fitCache.current.set(l.id, { layer: l, surface: baseSurface, photo, fit: out.get(l.id)! });
    }
    return out;
  }, [layers, baseSurface, photo]);

  // ---------- GPU sync ----------
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

  // Order, visibility and per-layer ink change the ink totals without touching any mesh.
  const inkSignature = layers.map((l) => `${l.id}:${l.visible}:${l.ink.color}:${l.ink.opacity}:${l.ink.saturation}`).join('|');
  useEffect(() => { comp.current?.invalidateInk(); }, [inkSignature, ink.blur, ink.scatter]);


  // ---------- render ----------
  const source = useMemo(
    () => ({ kind: 'layers' as const, layers: layers.filter((l) => l.visible).map((l) => ({ id: l.id, ink: l.ink })) }),
    [layers],
  );

  useEffect(() => {
    if (!photo || !size.w || !size.h) return;
    const id = requestAnimationFrame(() => {
      comp.current!.render({ source, ink, mode, debug: comparing ? 'original' : 'composite', cssW: size.w, cssH: size.h, zoom, focus });
      drawOverlay();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, size, source, fits, ink, mode, comparing, zoom, focus, showMesh, selectedId, editMesh, activeHandle]);

  const selected = layers.find((l) => l.id === selectedId) ?? null;

  /** Selection outline and handles always; the full mesh when asked for. */
  function drawOverlay() {
    const cv = overlayRef.current, c = comp.current;
    if (!cv || !c) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    const fit = selectedId ? fits.get(selectedId) : undefined;
    if (!fit || !selected || comparing || !selected.visible || selected.locked) return;
    const v = c.view(size.w, size.h, zoom, focus);
    g.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
    const px = 1 / v.scale;
    const { n, pos, valid } = fit.layout;
    const line = (idx: (t: number) => number) => {
      g.beginPath();
      let pen = false;
      for (let t = 0; t < n; t++) {
        const k = idx(t);
        if (!valid[k]) { pen = false; continue; }
        if (pen) g.lineTo(pos[2 * k], pos[2 * k + 1]);
        else g.moveTo(pos[2 * k], pos[2 * k + 1]);
        pen = true;
      }
      g.stroke();
    };
    g.lineWidth = px;
    if (showMesh) {
      g.strokeStyle = 'rgba(0, 220, 255, 0.8)';
      for (let j = 4; j < n - 1; j += 4) line((t) => j * n + t);
      for (let i = 4; i < n - 1; i += 4) line((t) => t * n + i);
    }
    g.strokeStyle = '#e0553a';
    g.lineWidth = 2 * px;
    g.setLineDash([8 * px, 6 * px]);
    line((t) => t);
    line((t) => (n - 1) * n + t);
    line((t) => t * n);
    line((t) => t * n + n - 1);
    g.setLineDash([]);
    if (editMesh) {
      // The control lattice, drawn along the mesh so its lines bend with the fit.
      const step = (n - 1) / (LATTICE_M - 1);
      g.strokeStyle = 'rgba(243, 239, 231, 0.75)';
      g.lineWidth = 1.25 * px;
      for (let b = 1; b < LATTICE_M - 1; b++) line((t) => b * step * n + t);
      for (let a = 1; a < LATTICE_M - 1; a++) line((t) => t * n + a * step);
      for (let b = 0; b < LATTICE_M; b++)
        for (let a = 0; a < LATTICE_M; a++) {
          const k = controlVertex(n, LATTICE_M, a, b);
          const active = activeHandle === b * LATTICE_M + a;
          g.globalAlpha = valid[k] ? 1 : 0.45; // past the horizon: still draggable, but hidden ink
          g.beginPath();
          g.arc(pos[2 * k], pos[2 * k + 1], (active ? 9 : 7) * px, 0, Math.PI * 2);
          g.fillStyle = active ? '#e0553a' : '#f3efe7';
          g.fill();
          g.strokeStyle = '#e0553a';
          g.lineWidth = 2.5 * px;
          g.stroke();
        }
      g.globalAlpha = 1;
      return;
    }
    // The anchor as a small ring, so the design under it stays readable.
    g.strokeStyle = '#e0553a';
    g.lineWidth = 2 * px;
    g.beginPath();
    g.arc(selected.anchor.x, selected.anchor.y, 5 * px, 0, Math.PI * 2);
    g.stroke();
  }

  // ---------- interaction ----------
  const toImage = useCallback((clientX: number, clientY: number): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = comp.current!.view(r.width, r.height, zoom, focus);
    return { x: (clientX - r.left - v.ox) / v.scale, y: (clientY - r.top - v.oy) / v.scale };
  }, [zoom, focus]);

  /** Topmost visible, unlocked layer whose laid-out mesh covers p. Clicks pass through locked ones. */
  const pick = useCallback((p: Pt): string | null => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i], fit = fits.get(l.id);
      if (l.visible && !l.locked && fit && meshContains(fit.layout, p)) return l.id;
    }
    return null;
  }, [layers, fits]);

  type Drag =
    | { kind: 'move'; id: string; dx: number; dy: number }
    | { kind: 'handle'; id: string; a: number; b: number; start: Pt; base: Lattice | null };
  const drag = useRef<Drag | null>(null);

  /** Control handle of the selected layer under p, within a finger-sized radius. */
  const pickHandle = useCallback((p: Pt): { a: number; b: number } | null => {
    if (!editMesh || !selectedId || layersRef.current.find((l) => l.id === selectedId)?.locked) return null;
    const fit = fits.get(selectedId);
    const r = canvasRef.current?.getBoundingClientRect();
    if (!fit || !r || !comp.current) return null;
    const radius = 16 / comp.current.view(r.width, r.height, zoom, focus).scale;
    let best: { a: number; b: number } | null = null, bestD = radius * radius;
    for (let b = 0; b < LATTICE_M; b++)
      for (let a = 0; a < LATTICE_M; a++) {
        const k = controlVertex(fit.layout.n, LATTICE_M, a, b);
        const d2 = (fit.layout.pos[2 * k] - p.x) ** 2 + (fit.layout.pos[2 * k + 1] - p.y) ** 2;
        if (d2 < bestD) { bestD = d2; best = { a, b }; }
      }
    return best;
  }, [editMesh, selectedId, fits, zoom, focus]);

  const pointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!photo) return;
    const p = toImage(e.clientX, e.clientY);
    const handle = pickHandle(p);
    if (handle && selectedId) {
      checkpoint(); // one undo step per handle drag
      const l = layersRef.current.find((x) => x.id === selectedId);
      drag.current = { kind: 'handle', id: selectedId, ...handle, start: p, base: l?.lattice ?? null };
      setActiveHandle(handle.b * LATTICE_M + handle.a);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const hit = pick(p);
    const id = hit ?? selectedId;
    const l = layersRef.current.find((x) => x.id === id);
    if (!l || l.locked) return;
    setSelectedId(l.id);
    checkpoint(); // one undo step per drag
    // Grabbing a tattoo keeps the grab point; tapping empty skin moves the selected one there.
    drag.current = { kind: 'move', id: l.id, dx: hit ? l.anchor.x - p.x : 0, dy: hit ? l.anchor.y - p.y : 0 };
    if (!hit) patchLayer(l.id, { anchor: p });
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [photo, toImage, pickHandle, pick, selectedId, checkpoint, patchLayer]);

  const pointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e.clientX, e.clientY);
    if (d.kind === 'move') {
      patchLayer(d.id, { anchor: { x: p.x + d.dx, y: p.y + d.dy } });
      return;
    }
    // The corrected mesh passes through each control point, so offsetting the lattice the drag
    // started from by the pointer's total travel keeps the handle exactly under the pointer.
    // (Measured from the start, not per move: moves can arrive faster than React re-renders.)
    const l = layersRef.current.find((x) => x.id === d.id);
    if (!l) return;
    const lattice = nudgeControl(d.base, d.a, d.b, p.x - d.start.x, p.y - d.start.y, l.width, (l.rotation * Math.PI) / 180);
    patchLayer(d.id, { lattice });
  }, [toImage, patchLayer]);

  const pointerUp = useCallback(() => { drag.current = null; setActiveHandle(null); }, []);

  /** Back to the pure auto-fit for one layer. */
  const resetMesh = useCallback((id: string) => updateLayer(id, { lattice: null }), [updateLayer]);

  /**
   * Delete every image from this session: the body photo, all designs, their thumbnails, the depth
   * map and the undo history (which would otherwise still hold the designs). GPU copies are freed
   * and both canvases blanked. Not undoable, by design.
   */
  const clearAll = useCallback(() => {
    photoGen.current++;
    comp.current?.clearAll();
    const ov = overlayRef.current;
    ov?.getContext('2d')?.clearRect(0, 0, ov.width, ov.height);
    photoRef.current?.close();
    photoRef.current = null;
    uploaded.current.clear();
    fitCache.current.clear();
    hist.current = { past: [], future: [], lastKey: '', lastAt: 0 };
    drag.current = null;
    setPhoto(null);
    setPhotoName('');
    setDepth(null);
    setDepthState({ stage: 'idle' });
    setLayers([]);
    setSelectedId(null);
    setEditMesh(false);
    setComparing(false);
    setZoomState(1);
    setFocus(undefined);
    setError(null);
    setHistVersion((v) => v + 1);
  }, []);

  const setZoom = useCallback((z: number) => {
    const clamped = Math.min(8, Math.max(1, z));
    if (clamped > 1 && zoom <= 1) {
      const sel = layersRef.current.find((l) => l.id === selectedId);
      setFocus(sel ? { ...sel.anchor } : photo ? { x: photo.width / 2, y: photo.height / 2 } : undefined);
    }
    setZoomState(clamped);
  }, [zoom, selectedId, photo]);

  const exportPng = useCallback(async () => {
    const c = comp.current;
    if (!c || !photo) return;
    const blob = await c.exportPng({ source, ink, mode });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(photoName || 'skin-proof').replace(/\.[^.]+$/, '')}-tattoo.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setSize((s) => ({ ...s })); // repaint the view the export replaced
  }, [photo, photoName, source, ink, mode]);

  // Dev only: inspect and drive the engine from the console (and the README screenshot script).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__tryon = {
      layers, fits, selectedId, zoom, focus, baseSurface, depthState,
      updateLayer, removeLayer, setSelectedId, setEditMesh, setShowMesh, setComparing, setZoom, patchLayer,
    };
  });

  return {
    canvasRef, overlayRef, stageRef,
    error, setError,
    photo, photoName, loadPhoto, depthState, hasDepth: !!baseSurface,
    layers, selected, selectedId, setSelectedId, fits,
    addLayer, addFiles, updateLayer, removeLayer, flipLayer, moveLayer,
    undo, redo, canUndo: hist.current.past.length > 0, canRedo: hist.current.future.length > 0,
    ink, setInk, mode, setMode, smoothSigma, setSmoothSigma,
    comparing, setComparing, showMesh, setShowMesh,
    editMesh, setEditMesh, resetMesh, clearAll,
    hasCorrections: (l: Layer | null) => !!l && !isIdentity(l.lattice),
    zoom, setZoom,
    pointerDown, pointerMove, pointerUp,
    exportPng,
    suggestedBlur: comp.current?.suggestedBlur ?? DEFAULT_INK.blur,
  };
}

export type TryOn = ReturnType<typeof useTryOn>;

function fitLayer(l: Layer, base: DepthSurface | null, photo: ImageBitmap): Fit {
  // Start from continuous skin: snap off seams; off the body entirely, lay out flat so the
  // layer stays visible as an outline and can be dragged back on (its ink is masked anyway).
  const start = base && l.warp ? base.nearestInside(l.anchor.x, l.anchor.y) : null;
  const onSkin = !!start;
  const from = start ?? l.anchor;
  const cal = base ? base.calibrateAt(from.x, from.y) : null;
  const k = l.autoK ? cal?.kAuto ?? l.manualK : l.manualK;
  const surface = onSkin ? base!.withK(k, cal?.ok ? cal.halfWidth : 0) : new FlatSurface(photo.width, photo.height);
  const rotation = (l.rotation * Math.PI) / 180;
  const auto = layoutByArcLength(surface, {
    cx: from.x, cy: from.y, size: l.width, sizeV: (l.width * l.design.h) / l.design.w, rotation, n: MESH_N,
  });
  return { layout: applyLattice(auto, l.lattice, l.width, rotation), cal, k, onSkin };
}

/** Point-in-mesh over valid quads (each split into two triangles, as rendered). */
function meshContains(l: Layout, p: Pt): boolean {
  const { n, pos, valid } = l;
  const tri = (a: number, b: number, c: number) => {
    const ax = pos[2 * a], ay = pos[2 * a + 1], bx = pos[2 * b], by = pos[2 * b + 1], cx = pos[2 * c], cy = pos[2 * c + 1];
    const d1 = (p.x - bx) * (ay - by) - (ax - bx) * (p.y - by);
    const d2 = (p.x - cx) * (by - cy) - (bx - cx) * (p.y - cy);
    const d3 = (p.x - ax) * (cy - ay) - (cx - ax) * (p.y - ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (!valid[a] || !valid[b] || !valid[c] || !valid[d]) continue;
      if (tri(a, b, d) || tri(a, d, c)) return true;
    }
  return false;
}

/** The keyed design as dark ink on paper, fitted into a small square. */
function densityThumb(d: Density, size = 96): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f3efe7';
  g.fillRect(0, 0, size, size);
  const src = new OffscreenCanvas(d.w, d.h);
  const img = new ImageData(d.w, d.h);
  for (let i = 0; i < d.data.length; i++) {
    img.data[4 * i] = 21; img.data[4 * i + 1] = 19; img.data[4 * i + 2] = 15; img.data[4 * i + 3] = d.data[i];
  }
  src.getContext('2d')!.putImageData(img, 0, 0);
  const s = (size * 0.86) / Math.max(d.w, d.h);
  g.drawImage(src, (size - d.w * s) / 2, (size - d.h * s) / 2, d.w * s, d.h * s);
  return c.toDataURL('image/png');
}

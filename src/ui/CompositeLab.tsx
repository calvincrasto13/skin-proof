import { useEffect, useRef, useState } from 'react';
import { loadPhoto } from '../ingest/loadPhoto';
import { syntheticLimb } from '../ingest/syntheticLimb';
import { Compositor, type BlendMode, type DebugView, type InkParams, type ShapeParams } from '../render/compositor';
import { DEFAULT_INK, InkFieldset, ModelFieldset } from './InkControls';

export function CompositeLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const comp = useRef<Compositor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoInfo, setPhotoInfo] = useState('');
  const [hasPhoto, setHasPhoto] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const [shape, setShape] = useState<ShapeParams>({ kind: 'rect', cx: 0, cy: 0, w: 300, h: 180, rotation: 0 });
  const [ink, setInk] = useState<InkParams>(DEFAULT_INK);
  const [mode, setMode] = useState<BlendMode>('physical');
  const [debug, setDebug] = useState<DebugView>('composite');
  const [comparing, setComparing] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Zoomed views centre on where the shape was when zooming started, so dragging doesn't chase itself.
  const [focus, setFocus] = useState<{ x: number; y: number } | undefined>(undefined);
  const [frameMs, setFrameMs] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    try {
      comp.current = new Compositor(canvasRef.current!);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: Math.max(320, window.innerHeight * 0.72) }));
    ro.observe(wrapRef.current!);
    return () => { ro.disconnect(); comp.current?.dispose(); };
  }, []);

  // Space = flash the original, for before/after.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setComparing(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setComparing(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const applyPhoto = (bitmap: ImageBitmap, info: string) => {
    const c = comp.current;
    if (!c) return;
    c.setPhoto(bitmap);
    const L = Math.max(bitmap.width, bitmap.height);
    setShape((s) => ({ ...s, cx: bitmap.width / 2, cy: bitmap.height / 2, w: Math.round(L * 0.18), h: Math.round(L * 0.11) }));
    setPhotoInfo(
      `${info} · noise σ ≈ ${(c.noiseSigma * 255).toFixed(2)}/255 · edge σ ≈ ${Number.isFinite(c.edgeSigma) ? c.edgeSigma.toFixed(2) + ' px' : 'n/a'}`,
    );
    // Ink edges should be exactly as soft as the photo's own: measured, not a constant.
    setInk((s) => ({ ...s, blur: +c.suggestedBlur.toFixed(2) }));
    setHasPhoto(true);
  };

  // Dev only: ?photo=/dev/<file> loads a photo from the gitignored public/dev folder, so a test
  // photo can be driven without the file picker. Served from localhost; never in a build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const url = new URLSearchParams(location.search).get('photo');
    if (!url || !url.startsWith('/dev/')) return;
    fetch(url)
      .then((r) => r.blob())
      .then((b) => loadPhoto(b))
      .then(({ bitmap, originalW, originalH }) => applyPhoto(bitmap, `${url} ${originalW}×${originalH}`))
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ink density only re-renders when the shape or its blur changes; everything else is one pass.
  useEffect(() => { comp.current?.invalidateInk(); }, [shape, ink.blur, hasPhoto]);

  useEffect(() => {
    if (!hasPhoto || !size.w) return;
    const id = requestAnimationFrame(() => {
      const t0 = performance.now();
      comp.current!.render({ source: { kind: 'shape', shape }, ink, mode, debug: comparing ? 'original' : debug, cssW: size.w, cssH: size.h, zoom, focus });
      setFrameMs(performance.now() - t0);
    });
    return () => cancelAnimationFrame(id);
  }, [hasPhoto, size, shape, ink, mode, debug, comparing, zoom, focus]);

  const toImage = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = comp.current!.view(r.width, r.height, zoom, focus);
    return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale };
  };

  const L = Math.max(comp.current?.imageSize.w ?? 1000, comp.current?.imageSize.h ?? 1000);

  return (
    <div>
      <section className="controls">
        <fieldset>
          <legend>Photo</legend>
          <input type="file" accept="image/*" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const { bitmap, originalW, originalH } = await loadPhoto(f);
            applyPhoto(bitmap, `${originalW}×${originalH} → ${bitmap.width}×${bitmap.height}`);
          }} />
          <button onClick={async () => applyPhoto(await syntheticLimb(), 'synthetic limb')}>Use synthetic test limb</button>
          {photoInfo && <div className="muted small">{photoInfo}</div>}
          {error && <div className="error">{error}</div>}
          <label>Test shape{' '}
            <select value={shape.kind} onChange={(e) => setShape((s) => ({ ...s, kind: e.target.value as ShapeParams['kind'] }))}>
              <option value="rect">flat rectangle: the blend itself</option>
              <option value="ramp">density ramp 0→1: opacity curve</option>
              <option value="rings">line rings, hairline→bold: edges</option>
            </select>
          </label>
          <label>Width {shape.w}px
            <input type="range" min={20} max={L} step={1} value={shape.w} onChange={(e) => setShape((s) => ({ ...s, w: +e.target.value }))} />
          </label>
          <label>Height {shape.h}px
            <input type="range" min={20} max={L} step={1} value={shape.h} onChange={(e) => setShape((s) => ({ ...s, h: +e.target.value }))} />
          </label>
          <label>View zoom {zoom.toFixed(1)}×
            <input type="range" min={1} max={10} step={0.5} value={zoom} onChange={(e) => {
              const z = +e.target.value;
              if (z > 1 && zoom <= 1) setFocus({ x: shape.cx, y: shape.cy });
              setZoom(z);
            }} />
          </label>
          <div className="muted small">Drag on the image to move the shape. Zoom centres on it.</div>
        </fieldset>

        <InkFieldset ink={ink} setInk={setInk} />
        <ModelFieldset
          ink={ink} setInk={setInk} mode={mode} setMode={setMode} debug={debug} setDebug={setDebug}
          setComparing={setComparing}
          onReset={() => { setInk({ ...DEFAULT_INK, blur: +(comp.current?.suggestedBlur ?? DEFAULT_INK.blur).toFixed(2) }); setMode('physical'); setDebug('composite'); }}
        >
          <div className="muted small">composite {frameMs.toFixed(1)} ms (CPU submit; GPU time not measured)</div>
        </ModelFieldset>
      </section>

      <div ref={wrapRef} className="pane">
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, display: 'block', touchAction: 'none', cursor: 'move' }}
          onPointerDown={(e) => {
            if (!hasPhoto) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = toImage(e);
            setShape((s) => ({ ...s, cx: p.x, cy: p.y }));
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const p = toImage(e);
            setShape((s) => ({ ...s, cx: p.x, cy: p.y }));
          }}
          onPointerUp={() => (dragging.current = false)}
        />
        {!hasPhoto && <div className="muted" style={{ padding: 12 }}>Load a photo or the synthetic limb.</div>}
      </div>
    </div>
  );
}

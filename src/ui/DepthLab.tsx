import { useEffect, useMemo, useRef, useState } from 'react';
import { DepthClient, type DepthEvent, type DepthResult } from '../depth/client';
import type { DevicePref } from '../depth/protocol';
import { loadPhoto } from '../ingest/loadPhoto';
import { syntheticLimb } from '../ingest/syntheticLimb';
import { CylinderSurface, type Line, type Pt } from '../surface/cylinderSurface';
import type { OverlayMode } from '../surface/debugImage';
import { buildDepthSurface } from '../surface/depthSurface';
import { SurfacePane } from './SurfacePane';
import { layoutByArcLength } from '../warp/arcLength';

type Tool = 'anchor' | 'cylinder';
type Progress = { stage: string; detail?: string; loaded?: number; total?: number } | null;

const MB = (b: number) => (b / 1048576).toFixed(1);

export function DepthLab() {
  const client = useRef(new DepthClient());
  useEffect(() => () => client.current.dispose(), []);

  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [photoInfo, setPhotoInfo] = useState('');
  const [device, setDevice] = useState<DevicePref>('auto');
  const [depth, setDepth] = useState<DepthResult | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [smoothSigma, setSmoothSigma] = useState(2);
  const [occlusionThreshold, setOcclusionThreshold] = useState(0.02);
  const [autoK, setAutoK] = useState(true);
  const [manualK, setManualK] = useState(0.3);
  const [overlay, setOverlay] = useState<OverlayMode>('normals');
  const [overlayOpacity, setOverlayOpacity] = useState(0.6);

  const [tool, setTool] = useState<Tool>('anchor');
  const [anchor, setAnchor] = useState<Pt | null>(null);
  const [sizeFrac, setSizeFrac] = useState(0.3);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [checkerOpacity, setCheckerOpacity] = useState(0.7);
  const [edges, setEdges] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pt[]>([]);

  const onFile = async (file: File) => {
    const { bitmap, originalW, originalH } = await loadPhoto(file);
    applyPhoto(bitmap, `${originalW}×${originalH} → working ${bitmap.width}×${bitmap.height}`);
  };

  const applyPhoto = (bitmap: ImageBitmap, info: string) => {
    setError(null);
    setPhoto(bitmap);
    setPhotoInfo(info);
    setDepth(null);
    setEdges([]);
    setPending([]);
    setAnchor({ x: bitmap.width / 2, y: bitmap.height / 2 });
  };

  const runDepth = async () => {
    if (!photo) return;
    setError(null);
    const onEvent = (e: DepthEvent) =>
      setProgress((prev) =>
        e.type === 'stage' ? { stage: e.stage, detail: e.detail } : { ...(prev ?? { stage: 'downloading' }), loaded: e.loaded, total: e.total },
      );
    try {
      const r = await client.current.run(photo, device, onEvent);
      setDepth(r);
      setLog((l) => [
        `${r.device}/${r.dtype} · ${r.width}×${r.height} · ${r.warm ? 'warm' : `load ${Math.round(r.loadMs)} ms ·`} infer ${Math.round(r.inferMs)} ms`,
        ...l,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const baseDepthSurface = useMemo(() => {
    if (!depth || !photo) return null;
    return buildDepthSurface({ data: depth.disparity, w: depth.width, h: depth.height }, photo.width, photo.height, { smoothSigma, occlusionThreshold });
  }, [depth, photo, smoothSigma, occlusionThreshold]);
  // Calibration is local to the limb under the anchor, so it follows the anchor. In the full
  // app k becomes a per-layer value: two tattoos on arm and torso need different reliefs.
  const cal = useMemo(
    () => (baseDepthSurface && anchor ? baseDepthSurface.calibrateAt(anchor.x, anchor.y) : null),
    [baseDepthSurface, anchor],
  );
  // Stable identity so the pane only re-rasterizes overlays when the depth data changes, not per drag.
  const depthDebug = useMemo(
    () => baseDepthSurface
      ? { disparity: baseDepthSurface.disparity, edgeMag: baseDepthSurface.d.edgeMag, cut: baseDepthSurface.d.cut, threshold: occlusionThreshold }
      : undefined,
    [baseDepthSurface, occlusionThreshold],
  );
  const depthSurface = useMemo(
    () => (baseDepthSurface && cal ? baseDepthSurface.withK(autoK ? cal.kAuto : manualK) : null),
    [baseDepthSurface, cal, autoK, manualK],
  );

  const cylSurface = useMemo(
    () => (photo && edges.length === 2 ? new CylinderSurface(photo.width, photo.height, edges[0], edges[1]) : null),
    [photo, edges],
  );

  const layoutParams = useMemo(
    () =>
      photo && anchor
        ? { cx: anchor.x, cy: anchor.y, size: sizeFrac * Math.max(photo.width, photo.height), rotation: (rotationDeg * Math.PI) / 180, n: 33 }
        : null,
    [photo, anchor, sizeFrac, rotationDeg],
  );
  const depthLayout = useMemo(
    () => (depthSurface && layoutParams ? layoutByArcLength(depthSurface, layoutParams) : null),
    [depthSurface, layoutParams],
  );
  const cylLayout = useMemo(
    () => (cylSurface && layoutParams ? layoutByArcLength(cylSurface, layoutParams) : null),
    [cylSurface, layoutParams],
  );

  const onPointer = (p: Pt, phase: 'down' | 'move') => {
    if (tool === 'anchor') return setAnchor(p);
    if (phase !== 'down') return;
    const next = [...pending, p];
    if (next.length === 2 || next.length === 4) {
      const line: Line = [next[next.length - 2], next[next.length - 1]];
      setEdges((e) => (next.length === 2 ? [line] : [...e, line]));
    }
    if (next.length === 4) {
      setPending([]);
      setTool('anchor');
    } else setPending(next);
  };


  return (
    <div>

      <section className="controls">
        <fieldset>
          <legend>Photo &amp; depth</legend>
          <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <button onClick={async () => applyPhoto(await syntheticLimb(), 'synthetic shaded cylinder 1200×1600')}>
            Use synthetic test limb
          </button>
          {photoInfo && <div className="muted">{photoInfo}</div>}
          <label>
            Backend{' '}
            <select value={device} onChange={(e) => setDevice(e.target.value as DevicePref)}>
              <option value="auto">auto (WebGPU → WASM)</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">WASM</option>
            </select>
          </label>
          <div className="row">
            <button disabled={!photo || !!progress} onClick={runDepth}>{depth ? 'Re-run' : 'Estimate depth'}</button>
            <button onClick={() => { client.current.dispose(); setLog((l) => ['worker terminated (next run is cold)', ...l]); }}>
              Unload model
            </button>
          </div>
          {progress && (
            <div className="progress">
              <div>{progress.stage}{progress.detail ? ` — ${progress.detail}` : ''}</div>
              {progress.stage === 'downloading' && progress.total ? (
                <>
                  <progress value={progress.loaded} max={progress.total} />
                  <span className="muted"> {MB(progress.loaded ?? 0)} / {MB(progress.total)} MB</span>
                </>
              ) : (
                <progress />
              )}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
        </fieldset>

        <fieldset disabled={!depth}>
          <legend>Depth surface</legend>
          <label>Smoothing σ {smoothSigma.toFixed(1)}
            <input type="range" min={0} max={8} step={0.5} value={smoothSigma} onChange={(e) => setSmoothSigma(+e.target.value)} />
          </label>
          <label>Occlusion threshold {occlusionThreshold.toFixed(3)}
            <input type="range" min={0.004} max={0.06} step={0.001} value={occlusionThreshold} onChange={(e) => setOcclusionThreshold(+e.target.value)} />
          </label>
          <label><input type="checkbox" checked={autoK} onChange={(e) => setAutoK(e.target.checked)} /> Auto relief (k)</label>
          <label>k {(autoK ? depthSurface?.k ?? 0 : manualK).toFixed(3)}
            <input type="range" min={0.01} max={2} step={0.01} disabled={autoK} value={autoK ? depthSurface?.k ?? manualK : manualK}
              onChange={(e) => setManualK(+e.target.value)} />
          </label>
          {cal && (
            <div className="muted small">
              {cal.ok
                ? `calibrated: half-width ${cal.halfWidth.toFixed(0)} px, target edge slope ${cal.targetSlope.toFixed(2)} (${(Math.atan(cal.targetSlope) * 180 / Math.PI).toFixed(0)}°), ${cal.ringPixels} ring px`
                : `calibration failed: ${cal.reason}; using fallback k (set it by hand)`}
            </div>
          )}
          <label>Overlay{' '}
            <select value={overlay} onChange={(e) => setOverlay(e.target.value as OverlayMode)}>
              <option value="none">none</option>
              <option value="disparity">disparity (depth only)</option>
              <option value="normals">normals</option>
              <option value="facing">n·v (facing)</option>
              <option value="mask">mask (red = occlusion cut)</option>
              <option value="edges">edge strength vs. threshold (depth only)</option>
            </select>
          </label>
          <label>Overlay opacity
            <input type="range" min={0} max={1} step={0.05} value={overlayOpacity} onChange={(e) => setOverlayOpacity(+e.target.value)} />
          </label>
        </fieldset>

        <fieldset disabled={!photo}>
          <legend>Checkerboard</legend>
          <div className="row">
            <button className={tool === 'anchor' ? 'active' : ''} onClick={() => setTool('anchor')}>Place / drag</button>
            <button className={tool === 'cylinder' ? 'active' : ''} onClick={() => { setTool('cylinder'); setPending([]); setEdges([]); }}>
              Draw limb edges
            </button>
          </div>
          {tool === 'cylinder' && <div className="muted small">Click 2 points along one silhouette edge, then 2 along the other. ({pending.length}/4)</div>}
          <label>Size (on skin) {Math.round(sizeFrac * 100)}%
            <input type="range" min={0.05} max={0.8} step={0.01} value={sizeFrac} onChange={(e) => setSizeFrac(+e.target.value)} />
          </label>
          <label>Rotation {rotationDeg}°
            <input type="range" min={-90} max={90} step={1} value={rotationDeg} onChange={(e) => setRotationDeg(+e.target.value)} />
          </label>
          <label>Checker opacity
            <input type="range" min={0} max={1} step={0.05} value={checkerOpacity} onChange={(e) => setCheckerOpacity(+e.target.value)} />
          </label>
        </fieldset>
      </section>

      {photo ? (
        <section className="panes">
          <SurfacePane
            title="Depth surface"
            subtitle={depthSurface ? `k = ${depthSurface.k.toFixed(3)}` : undefined}
            photo={photo}
            surface={depthSurface}
            debug={depthDebug}
            overlay={overlay}
            overlayOpacity={overlayOpacity}
            layout={depthLayout}
            checkerOpacity={checkerOpacity}
            placeholder="Run depth estimation"
            onPointer={onPointer}
          />
          <SurfacePane
            title="Cylinder surface"
            subtitle="radius from the silhouette, no unknown scale"
            photo={photo}
            surface={cylSurface}
            overlay={overlay === 'disparity' || overlay === 'edges' ? 'none' : overlay}
            overlayOpacity={overlayOpacity}
            layout={cylLayout}
            checkerOpacity={checkerOpacity}
            edges={edges}
            pending={pending}
            placeholder="Draw the two limb edges"
            onPointer={onPointer}
          />
        </section>
      ) : (
        <p className="muted">Load a photo of an arm or forearm to start.</p>
      )}
    </div>
  );
}

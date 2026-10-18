import { useEffect, useMemo, useRef, useState } from 'react';
import type { Line, Pt } from '../surface/cylinderSurface';
import { renderOverlay, type DepthDebug, type OverlayMode } from '../surface/debugImage';
import type { Surface } from '../surface/types';
import type { Layout } from '../warp/arcLength';

type Props = {
  title: string;
  subtitle?: string;
  photo: ImageBitmap;
  surface: Surface | null;
  debug?: DepthDebug;
  overlay: OverlayMode;
  overlayOpacity: number;
  layout: Layout | null;
  checkerOpacity: number;
  edges?: Line[];
  pending?: Pt[];
  placeholder?: string;
  onPointer: (p: Pt, phase: 'down' | 'move') => void;
};

const CHECK = 4; // grid cells per checker square → 8×8 checks on a 32×32 mesh

export function SurfacePane(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssW, setCssW] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setCssW(e.contentRect.width));
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
  }, []);

  // Overlay rasterized once per surface/mode at grid resolution, then scaled when drawn.
  const overlayCanvas = useMemo(() => {
    if (!p.surface || p.overlay === 'none') return null;
    if ((p.overlay === 'disparity' || p.overlay === 'edges') && !p.debug) return null;
    const gw = p.debug?.disparity.w ?? 400;
    const gh = p.debug?.disparity.h ?? Math.round((400 * p.photo.height) / p.photo.width);
    const c = new OffscreenCanvas(gw, gh);
    c.getContext('2d')!.putImageData(renderOverlay(p.surface, p.overlay, gw, gh, p.debug), 0, 0);
    return c;
  }, [p.surface, p.overlay, p.debug, p.photo]);

  const scale = cssW / p.photo.width;
  const cssH = p.photo.height * scale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cssW) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0); // draw in photo pixels
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.photo, 0, 0);

    if (overlayCanvas) {
      ctx.globalAlpha = p.overlayOpacity;
      ctx.drawImage(overlayCanvas, 0, 0, p.photo.width, p.photo.height);
      ctx.globalAlpha = 1;
    }

    if (p.layout) drawChecker(ctx, p.layout, p.checkerOpacity, 1 / scale);

    const lw = 2 / scale;
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#ffcc00';
    for (const [a, b] of p.edges ?? []) {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.fillStyle = '#ffcc00';
    for (const q of p.pending ?? []) {
      ctx.beginPath(); ctx.arc(q.x, q.y, 4 * lw, 0, Math.PI * 2); ctx.fill();
    }
  }, [cssW, cssH, scale, p.photo, overlayCanvas, p.overlayOpacity, p.layout, p.checkerOpacity, p.edges, p.pending]);

  const toPhoto = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <strong>{p.title}</strong>
        {p.subtitle && <span className="muted"> {p.subtitle}</span>}
      </div>
      <div ref={wrapRef} className="pane-canvas">
        <canvas
          ref={canvasRef}
          style={{ width: cssW, height: cssH }}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            p.onPointer(toPhoto(e), 'down');
          }}
          onPointerMove={(e) => dragging.current && p.onPointer(toPhoto(e), 'move')}
          onPointerUp={() => (dragging.current = false)}
        />
        {!p.surface && p.placeholder && <div className="pane-placeholder">{p.placeholder}</div>}
      </div>
    </div>
  );
}

function drawChecker(ctx: CanvasRenderingContext2D, l: Layout, opacity: number, px: number) {
  const { n, pos, valid, facing } = l;
  const at = (i: number, j: number) => j * n + i;
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const k = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (k.some((q) => !valid[q])) continue;
      const f = Math.min(...k.map((q) => facing[q]));
      const dark = (Math.floor(i / CHECK) + Math.floor(j / CHECK)) % 2 === 0;
      // Fade with n·v so the grazing-angle falloff is visible, not just the compression.
      ctx.fillStyle = dark ? `rgba(10,10,10,${opacity * (0.35 + 0.65 * f)})` : `rgba(255,255,255,${opacity * (0.35 + 0.65 * f)})`;
      ctx.beginPath();
      ctx.moveTo(pos[2 * k[0]], pos[2 * k[0] + 1]);
      for (let q = 1; q < 4; q++) ctx.lineTo(pos[2 * k[q]], pos[2 * k[q] + 1]);
      ctx.closePath();
      ctx.fill();
    }
  // Anchor
  const c = at((n - 1) / 2, (n - 1) / 2);
  ctx.strokeStyle = '#ff3366';
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.arc(pos[2 * c], pos[2 * c + 1], 6 * px, 0, Math.PI * 2);
  ctx.stroke();
}

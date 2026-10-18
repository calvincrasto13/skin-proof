import { normalFromSlope, type Surface } from '../surface/types';

export type LayoutParams = {
  /** Anchor (design centre) in photo pixels. */
  cx: number;
  cy: number;
  /** Design width (u) measured ON THE SKIN, in photo pixels at the anchor's scale. */
  size: number;
  /** Design height (v) on the skin; defaults to `size` (square). */
  sizeV?: number;
  /** Radians; rotates the design's u axis in the image plane. */
  rotation: number;
  /** Vertices per side (33 → a 32×32 quad mesh). Must be odd so the anchor is a vertex. */
  n: number;
  /** Integration substeps per grid step. Near the silhouette steps shrink toward zero. */
  substeps?: number;
  /** Slope beyond which a point is past the visible horizon (default tan 87°). */
  maxSlope?: number;
};

export type Layout = {
  n: number;
  /** n·n·2 photo-pixel positions, row-major (v rows, u columns). */
  pos: Float32Array;
  /** 1 where the vertex lies on visible skin. */
  valid: Uint8Array;
  /** n·v at each vertex: 1 facing the camera, → 0 at grazing angles. */
  facing: Float32Array;
};

/**
 * Lays a flat design onto the surface by arc length: one unit of design becomes one unit of
 * skin, which in the image shrinks by 1/sqrt(1 + slope²) along the marching direction.
 *
 * Marching is a cross: out along u from the anchor, then out along v from each of those
 * points, each in a fixed image-space direction. Exact for a cylinder when u or v is aligned
 * with its axis; an approximation of the true geodesic layout otherwise.
 */
export function layoutByArcLength(surface: Surface, p: LayoutParams): Layout {
  const { n } = p;
  if (n % 2 === 0) throw new Error('n must be odd');
  const substeps = p.substeps ?? 8;
  const maxSlope = p.maxSlope ?? Math.tan((87 * Math.PI) / 180);
  const c = (n - 1) / 2;
  const dsU = p.size / (n - 1);
  const dsV = (p.sizeV ?? p.size) / (n - 1);
  const u = { x: Math.cos(p.rotation), y: Math.sin(p.rotation) };
  const v = { x: -u.y, y: u.x };

  const pos = new Float32Array(n * n * 2);
  const valid = new Uint8Array(n * n);
  const set = (i: number, j: number, x: number, y: number, ok: boolean) => {
    const k = j * n + i;
    pos[2 * k] = x;
    pos[2 * k + 1] = y;
    valid[k] = ok ? 1 : 0;
  };

  const anchorOk = surface.inside(p.cx, p.cy);
  set(c, c, p.cx, p.cy, anchorOk);

  // One marching ray: returns positions for steps 1..count, carrying the "fell off" state.
  const march = (x: number, y: number, dir: { x: number; y: number }, count: number, ok: boolean, ds: number) => {
    const out: { x: number; y: number; ok: boolean }[] = [];
    const sub = ds / substeps;
    for (let s = 0; s < count; s++) {
      for (let k = 0; k < substeps && ok; k++) {
        // Midpoint rule: estimate the step, re-evaluate slope halfway, take the real step.
        const [sx0, sy0] = surface.slope(x, y);
        const d0 = sub / Math.sqrt(1 + (sx0 * dir.x + sy0 * dir.y) ** 2);
        const mx = x + dir.x * d0 * 0.5, my = y + dir.y * d0 * 0.5;
        const [sx, sy] = surface.slope(mx, my);
        const along = sx * dir.x + sy * dir.y;
        if (Math.abs(along) > maxSlope || !surface.inside(mx, my)) { ok = false; break; }
        const d = sub / Math.sqrt(1 + along * along);
        x += dir.x * d;
        y += dir.y * d;
      }
      // Once past the horizon keep extrapolating flat, so hidden vertices still have sane
      // positions for the mesh; they are flagged invalid and faded out.
      if (!ok) { x += dir.x * ds; y += dir.y * ds; }
      out.push({ x, y, ok });
    }
    return out;
  };

  const row: { x: number; y: number; ok: boolean }[] = new Array(n);
  row[c] = { x: p.cx, y: p.cy, ok: anchorOk };
  march(p.cx, p.cy, u, c, anchorOk, dsU).forEach((q, s) => (row[c + 1 + s] = q));
  march(p.cx, p.cy, { x: -u.x, y: -u.y }, c, anchorOk, dsU).forEach((q, s) => (row[c - 1 - s] = q));

  for (let i = 0; i < n; i++) {
    const r = row[i];
    set(i, c, r.x, r.y, r.ok);
    march(r.x, r.y, v, c, r.ok, dsV).forEach((q, s) => set(i, c + 1 + s, q.x, q.y, q.ok));
    march(r.x, r.y, { x: -v.x, y: -v.y }, c, r.ok, dsV).forEach((q, s) => set(i, c - 1 - s, q.x, q.y, q.ok));
  }

  const facing = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (!valid[k]) continue;
    const [sx, sy] = surface.slope(pos[2 * k], pos[2 * k + 1]);
    facing[k] = normalFromSlope(sx, sy)[2];
  }
  return { n, pos, valid, facing };
}

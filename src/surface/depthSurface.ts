import {
  dilate, distanceInside, gaussianBlur, labelComponents, largestComponent, maskedBlur, otsu, percentile, sampleBilinear,
  type Grid,
} from './grid';
import type { Surface } from './types';

export type DepthSurfaceParams = {
  /** Gaussian sigma in depth-map pixels, applied within the region only. */
  smoothSigma: number;
  /**
   * Disparity step (normalized units per depth pixel) above which the surface is treated as
   * torn: an occlusion edge, e.g. an arm crossing in front of the torso.
   */
  occlusionThreshold: number;
};

export type Calibration = {
  ok: boolean;
  reason?: string;
  /** Local half-width of the limb under the anchor, in depth pixels. */
  halfWidth: number;
  /** Slope a cylinder of that half-width would have at the calibration ring. */
  targetSlope: number;
  ringPixels: number;
  kAuto: number;
};

/** Everything derived once per depth result; k and calibration are cheap on top of it. */
type Derived = {
  /** Disparity normalized to [0, 1] by robust percentiles, then region-smoothed. */
  disparity: Grid;
  /** Body mask before occlusion cuts. */
  body: Uint8Array;
  /** Pixels on an occlusion edge. */
  cut: Uint8Array;
  /** body ∧ ¬cut: where the surface is continuous. */
  region: Uint8Array;
  /** Connected components of region, so calibration stays on the anchor's limb. */
  label: Int32Array;
  /** Distance to the nearest silhouette or occlusion edge, in depth pixels. */
  dist: Float32Array;
  /** Disparity gradient magnitude used for the cuts (for the debug overlay). */
  edgeMag: Grid;
  gx: Grid;
  gy: Grid;
  /**
   * Gradients on barely-smoothed disparity, for calibration only. The rim is where smoothing
   * flattens slopes most, so calibrating on smoothed gradients inflates k everywhere else.
   */
  cgx: Float32Array;
  cgy: Float32Array;
  /** Gradient of `dist`: unit-ish vector pointing inward, away from the nearest edge. */
  dgx: Grid;
  dgy: Grid;
};

const RING_MIN = 2, RING_MAX = 5; // depth px inset from the silhouette
const FALLBACK_K = 0.3;
const BORDER = 3;
const CALIBRATION_SIGMA = 0.75;
/** Rim prior applies within this fraction of the limb half-width from an edge. */
const RIM_BAND = 0.35;

export class DepthSurface implements Surface {
  readonly k: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly d: Derived,
    k: number,
    /** Limb half-width (depth px) for the rim prior; 0 disables it. */
    readonly rimR = 0,
  ) {
    this.k = k;
  }

  get disparity() { return this.d.disparity; }

  private toGrid(x: number, y: number): [number, number] {
    return [(x / this.width) * this.d.disparity.w - 0.5, (y / this.height) * this.d.disparity.h - 0.5];
  }

  private index(x: number, y: number): number {
    const [gx, gy] = this.toGrid(x, y);
    const ix = Math.round(gx), iy = Math.round(gy);
    const { w, h } = this.d.disparity;
    return ix < 0 || iy < 0 || ix >= w || iy >= h ? -1 : iy * w + ix;
  }

  slope(x: number, y: number): [number, number] {
    const [gx, gy] = this.toGrid(x, y);
    const { w, h } = this.d.disparity;
    const L = Math.max(this.width, this.height);
    // d(disparity)/d(depth px) → d(height)/d(photo px)
    let sx = (this.k * L * sampleBilinear(this.d.gx, gx, gy) * w) / this.width;
    let sy = (this.k * L * sampleBilinear(this.d.gy, gx, gy) * h) / this.height;
    if (this.rimR > 0) [sx, sy] = this.rimPrior(gx, gy, sx, sy);
    return [sx, sy];
  }

  /**
   * Depth is least reliable exactly at the rim, and smoothing flattens it further, so a layout
   * would hit the mask edge at ~70° and stop there like a sticker edge. Within a band of the
   * edge, don't let the surface be flatter than a cylinder of the limb's measured half-width.
   *
   * Only on the near side of an edge: past a silhouette there's background; past an occlusion
   * cut, the far side (torso behind the arm) continues under the occluder and gets no prior.
   */
  private rimPrior(gx: number, gy: number, sx: number, sy: number): [number, number] {
    const { w, h } = this.d.disparity;
    const ix = Math.round(gx), iy = Math.round(gy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return [sx, sy];
    const i = iy * w + ix;
    const R = this.rimR, band = RIM_BAND * R;
    const delta = this.d.dist[i];
    if (!this.d.region[i] || !(delta < band)) return [sx, sy];

    let dx = sampleBilinear(this.d.dgx, gx, gy), dy = sampleBilinear(this.d.dgy, gx, gy);
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return [sx, sy];
    dx /= len; dy /= len;

    const qx = Math.round(gx - dx * (delta + 3)), qy = Math.round(gy - dy * (delta + 3));
    const q = qx < 0 || qy < 0 || qx >= w || qy >= h ? -1 : qy * w + qx;
    const disp = this.d.disparity.data;
    const nearSide = q < 0 || !this.d.body[q] || disp[q] < disp[i] - 0.02;
    if (!nearSide) return [sx, sy];

    const r = R - Math.max(delta, 0.3);
    const cyl = r / Math.sqrt(R * R - r * r);
    const along = sx * dx + sy * dy; // inward = uphill, so a real rim has along > 0
    if (cyl <= along) return [sx, sy];
    const t = Math.min(1, Math.max(0, (band - delta) / (0.5 * band))); // full strength in the outer half of the band
    const boost = (cyl - along) * t;
    return [sx + boost * dx, sy + boost * dy];
  }

  inside(x: number, y: number): boolean {
    const i = this.index(x, y);
    return i >= 0 && this.d.region[i] === 1;
  }

  /**
   * Nearest point on continuous skin within `radius` depth px, in photo px; null if none.
   * Layouts start at their anchor, and an anchor that lands on an occlusion cut (a 2–3 px seam)
   * or a pixel off the silhouette would otherwise lay out nothing at all.
   */
  nearestInside(x: number, y: number, radius = 8): { x: number; y: number } | null {
    const { w, h } = this.d.disparity;
    const [gx, gy] = this.toGrid(x, y);
    const cx = Math.round(gx), cy = Math.round(gy);
    let best = -1, bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const ix = cx + dx, iy = cy + dy, d2 = dx * dx + dy * dy;
        if (ix < 0 || iy < 0 || ix >= w || iy >= h || d2 > radius * radius || d2 >= bestD) continue;
        if (this.d.region[iy * w + ix]) { best = iy * w + ix; bestD = d2; }
      }
    if (best < 0) return null;
    return { x: (((best % w) + 0.5) / w) * this.width, y: ((((best / w) | 0) + 0.5) / h) * this.height };
  }

  withK(k: number, rimR = this.rimR): DepthSurface {
    return new DepthSurface(this.width, this.height, this.d, k, rimR);
  }

  /**
   * Relative depth has no scale, so pick k so that just inside the silhouette the surface is
   * as steep as a cylinder of the LOCAL half-width would be there. Local means: the connected
   * region under the anchor, within a window sized to that limb. Calibrating against the
   * whole body measured the torso, not the arm.
   */
  calibrateAt(px: number, py: number): Calibration {
    const { w, h } = this.d.disparity;
    const { region, label, dist, cgx, cgy } = this.d;
    const fail = (reason: string, halfWidth = 0): Calibration =>
      ({ ok: false, reason, halfWidth, targetSlope: 0, ringPixels: 0, kAuto: FALLBACK_K });

    const a = this.index(px, py);
    if (a < 0 || !region[a]) return fail('Anchor is not on the body');
    const comp = label[a];
    const ax = a % w, ay = (a / w) | 0;

    // Walk up to the local ridge: the largest inside-distance near the anchor is the
    // half-width; grow the window to that and repeat until it settles.
    let R = Math.max(dist[a], 4);
    for (let iter = 0; iter < 4; iter++) {
      const win = 2 * R;
      let best = 0;
      forWindow(ax, ay, win, w, h, (i) => {
        if (label[i] === comp && Number.isFinite(dist[i]) && dist[i] > best) best = dist[i];
      });
      if (Math.abs(best - R) < 0.5) { R = best; break; }
      R = best;
    }
    if (R < 6) return fail('Limb too thin at this resolution', R);

    const L = Math.max(this.width, this.height);
    const unit: number[] = [];
    forWindow(ax, ay, 2.5 * R, w, h, (i) => {
      const x = i % w, y = (i / w) | 0;
      if (x < BORDER || y < BORDER || x >= w - BORDER || y >= h - BORDER) return; // frame edge isn't a silhouette
      if (label[i] !== comp || dist[i] < RING_MIN || dist[i] > RING_MAX) return;
      unit.push(Math.hypot((L * cgx[i] * w) / this.width, (L * cgy[i] * h) / this.height));
    });
    if (unit.length < 12) return fail('No silhouette near the anchor (limb cropped by the frame?)', R);

    const delta = (RING_MIN + RING_MAX) / 2;
    const r = R - delta;
    const targetSlope = r / Math.sqrt(R * R - r * r);
    const med = percentile(unit, 50);
    if (!(med > 1e-6)) return fail('Disparity is flat at the silhouette', R);
    return { ok: true, halfWidth: R, targetSlope, ringPixels: unit.length, kAuto: targetSlope / med };
  }
}

function forWindow(cx: number, cy: number, radius: number, w: number, h: number, fn: (i: number) => void) {
  const r = Math.ceil(radius), r2 = radius * radius;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) fn(y * w + x);
}

/**
 * Raw model disparity → usable surface.
 *  1. Normalize by 2nd/98th percentile (the model's scale and shift are arbitrary).
 *  2. Body mask = largest component above an Otsu split (body is nearer than background).
 *  3. Occlusion cuts: where disparity steps faster than any continuous body surface would,
 *     the surface is torn (arm in front of torso). Cut there so nothing smooths or marches
 *     across it.
 *  4. Smooth within the cut region only, then gradients that never reach across a cut.
 */
export function buildDepthSurface(raw: Grid, photoW: number, photoH: number, params: DepthSurfaceParams): DepthSurface {
  const { w, h } = raw;
  const lo = percentile(raw.data, 2), hi = percentile(raw.data, 98);
  const span = hi - lo || 1;
  const norm = new Float32Array(raw.data.length);
  for (let i = 0; i < norm.length; i++) norm[i] = Math.min(1, Math.max(0, (raw.data[i] - lo) / span));
  const normGrid = { data: norm, w, h };

  const forMask = gaussianBlur(normGrid, 1.5).data;
  const t = otsu(forMask);
  const mask0 = new Uint8Array(w * h);
  for (let i = 0; i < mask0.length; i++) mask0[i] = forMask[i] > t ? 1 : 0;
  const body = largestComponent(mask0, w, h);

  // Edge strength on lightly smoothed disparity, within the body only, so the body's own
  // silhouette against the background doesn't register as an internal tear.
  const light = maskedBlur(normGrid, body, 1).data;
  const mag = new Float32Array(w * h);
  const ux = new Float32Array(w * h), uy = new Float32Array(w * h);
  const interior = new Uint8Array(w * h); // body pixels with a full neighbourhood: gradient is defined
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!body[i] || !body[i - 1] || !body[i + 1] || !body[i - w] || !body[i + w]) continue;
      interior[i] = 1;
      const dx = (light[i + 1] - light[i - 1]) / 2, dy = (light[i + w] - light[i - w]) / 2;
      mag[i] = Math.hypot(dx, dy);
      if (mag[i] > 0) { ux[i] = dx / mag[i]; uy[i] = dy / mag[i]; }
    }
  // Steepness alone can't tell a tear from a limb's own rim: both are steep. The difference
  // is what lies downhill. Past a rim is background; past a tear is more body (the torso),
  // and it's gentle. Only the latter is cut.
  const cut0 = new Uint8Array(w * h);
  const τ = params.occlusionThreshold;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mag[i] <= τ) continue;
      let gentleBodyBelow = false;
      for (const step of [3, 4, 5, 6]) {
        const xx = Math.round(x - ux[i] * step), yy = Math.round(y - uy[i] * step);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
        const j = yy * w + xx;
        if (!interior[j]) break;
        if (mag[j] < τ * 0.5) { gentleBodyBelow = true; break; }
      }
      if (gentleBodyBelow) cut0[i] = 1;
    }
  // One-pixel dilation closes the small gaps that would otherwise let regions leak together.
  const cut = dilate(cut0, w, h);
  const region = new Uint8Array(w * h);
  for (let i = 0; i < region.length; i++) region[i] = body[i] && !cut[i] ? 1 : 0;

  const smooth = maskedBlur(normGrid, region, params.smoothSigma);
  const [gx, gy] = regionGradient(smooth.data, region, w, h);
  const [cgx, cgy] = regionGradient(maskedBlur(normGrid, region, CALIBRATION_SIGMA).data, region, w, h);

  const dist = distanceInside(region, w, h);
  const dgx = new Float32Array(w * h), dgy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!region[i]) continue;
      const fin = (j: number) => (Number.isFinite(dist[j]) ? dist[j] : dist[i]);
      dgx[i] = (fin(i + 1) - fin(i - 1)) / 2;
      dgy[i] = (fin(i + w) - fin(i - w)) / 2;
    }

  const derived: Derived = {
    disparity: smooth,
    body,
    cut,
    region,
    label: labelComponents(region, w, h).label,
    dist,
    edgeMag: { data: mag, w, h },
    gx: { data: gx, w, h },
    gy: { data: gy, w, h },
    cgx,
    cgy,
    dgx: { data: dgx, w, h },
    dgy: { data: dgy, w, h },
  };
  return new DepthSurface(photoW, photoH, derived, FALLBACK_K);
}

/** Central differences where both neighbours are in the region, one-sided where only one is. */
function regionGradient(s: Float32Array, region: Uint8Array, w: number, h: number): [Float32Array, Float32Array] {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  const diff = (i: number, step: number, hasPrev: boolean, hasNext: boolean) => {
    const p = hasPrev && region[i - step], n = hasNext && region[i + step];
    if (p && n) return (s[i + step] - s[i - step]) / 2;
    if (n) return s[i + step] - s[i];
    if (p) return s[i] - s[i - step];
    return 0;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!region[i]) continue;
      gx[i] = diff(i, 1, x > 0, x < w - 1);
      gy[i] = diff(i, w, y > 0, y < h - 1);
    }
  return [gx, gy];
}

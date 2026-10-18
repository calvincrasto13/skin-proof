import type { Surface } from './types';

export type Pt = { x: number; y: number };
export type Line = [Pt, Pt];

/**
 * Generalized cylinder (allows taper) from the limb's two silhouette edges. Radius comes
 * straight from the silhouette, so unlike depth there is no unknown scale: the geometry is
 * exactly right at the wrap edge, for any limb that is roughly round in cross-section.
 */
export class CylinderSurface implements Surface {
  private readonly axis: Pt; // unit, along the limb
  private readonly perp: Pt; // unit, across the limb

  constructor(
    readonly width: number,
    readonly height: number,
    readonly edgeA: Line,
    readonly edgeB: Line,
  ) {
    const dA = unit(sub(edgeA[1], edgeA[0]));
    let dB = unit(sub(edgeB[1], edgeB[0]));
    if (dot(dA, dB) < 0) dB = { x: -dB.x, y: -dB.y }; // user may draw the edges in opposite directions
    this.axis = unit({ x: dA.x + dB.x, y: dA.y + dB.y });
    this.perp = { x: -this.axis.y, y: this.axis.x };
  }

  /** Cross-section through p: centre on the axis, radius, signed offset of p from centre. */
  private section(p: Pt): { R: number; r: number } | null {
    const a = intersect(p, this.perp, this.edgeA);
    const b = intersect(p, this.perp, this.edgeB);
    if (a === null || b === null) return null;
    const R = Math.abs(a - b) / 2;
    const r = -(a + b) / 2; // p sits at t=0 on the perp line; centre at (a+b)/2
    return { R, r };
  }

  slope(x: number, y: number): [number, number] {
    const s = this.section({ x, y });
    if (!s || s.R <= 0) return [0, 0];
    // h = sqrt(R² - r²) ⇒ dh/dr = -r / h. Clamp just inside the rim to stay finite.
    const r = Math.max(-s.R * 0.9999, Math.min(s.R * 0.9999, s.r));
    const m = -r / Math.sqrt(s.R * s.R - r * r);
    return [m * this.perp.x, m * this.perp.y];
  }

  inside(x: number, y: number): boolean {
    const s = this.section({ x, y });
    return !!s && Math.abs(s.r) < s.R;
  }
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const unit = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** Parameter t along p + t·dir where it meets the (infinite) line through `line`. */
function intersect(p: Pt, dir: Pt, line: Line): number | null {
  const e = sub(line[1], line[0]);
  const den = dir.x * e.y - dir.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const q = sub(line[0], p);
  return (q.x * e.y - q.y * e.x) / den;
}

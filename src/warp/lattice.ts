import type { Layout } from './arcLength';

/**
 * Manual corrections on top of the auto-fit: an m×m lattice of offsets, one per control point.
 *
 * Offsets live in the design's own frame, in units of its width on the skin: (du, dv) moves a
 * point du·width along the design's u axis and dv·width along v. So moving, resizing or rotating
 * the tattoo carries the corrections with it, and re-running depth (a new auto-fit) keeps them.
 *
 * Control points sit exactly on mesh vertices (m − 1 must divide n − 1), and the offset field is
 * bicubic Catmull-Rom: it passes through every control point, so a handle lands where it is
 * dragged, and each one only bends its own neighbourhood (support of two cells each way).
 */
export const LATTICE_M = 5;

export type Lattice = { m: number; d: Float32Array };

export function emptyLattice(m = LATTICE_M): Lattice {
  return { m, d: new Float32Array(m * m * 2) };
}

export function isIdentity(l: Lattice | null): boolean {
  return !l || l.d.every((v) => v === 0);
}

/** Mesh vertex index for control point (a, b). */
export function controlVertex(n: number, m: number, a: number, b: number): number {
  const step = (n - 1) / (m - 1);
  return Math.round(b * step) * n + Math.round(a * step);
}

/**
 * Tangents for a monotone cubic through y[0..m-1] (Fritsch–Butland): the harmonic mean of the
 * neighbouring slopes, zero at a local peak or where either side is flat. Unlike Catmull-Rom
 * (whose negative lobe pushes ink two cells away ~7% the other way), this never overshoots; on
 * evenly spaced values it is exactly linear.
 */
function monoTangents(y: ArrayLike<number>): Float64Array {
  const m = y.length, t = new Float64Array(m);
  for (let k = 1; k < m - 1; k++) {
    const a = y[k] - y[k - 1], b = y[k + 1] - y[k];
    t[k] = a * b > 0 ? (2 * a * b) / (a + b) : 0;
  }
  // Ends: one-sided, but no steeper than the end segment allows without overshooting.
  t[0] = endTangent(y[1] - y[0], t[1]);
  t[m - 1] = endTangent(y[m - 1] - y[m - 2], t[m - 2]);
  return t;
}
function endTangent(secant: number, inner: number): number {
  const v = (3 * secant - inner) / 2;
  return v * secant > 0 ? v : 0;
}

/** Cubic Hermite through (k, y[k]) and (k+1, y[k+1]) at s ∈ [0, 1]. */
function hermite(y: ArrayLike<number>, t: ArrayLike<number>, k: number, s: number): number {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y[k] + (s3 - 2 * s2 + s) * t[k] + (-2 * s3 + 3 * s2) * y[k + 1] + (s3 - s2) * t[k + 1];
}

/** The layout with the lattice's offsets added. Validity and facing are the auto-fit's. */
export function applyLattice(layout: Layout, lattice: Lattice | null, width: number, rotation: number): Layout {
  if (!lattice || isIdentity(lattice)) return layout;
  const { n } = layout;
  const { m, d } = lattice;
  if ((n - 1) % (m - 1) !== 0) throw new Error(`lattice ${m} doesn't align with mesh ${n}`);
  const ux = Math.cos(rotation), uy = Math.sin(rotation); // design u axis in the image
  const vx = -uy, vy = ux;

  // Separable: interpolate each control row along u, then the column of row results along v.
  const rowVals: [Float64Array, Float64Array][] = [];
  const rowTans: [Float64Array, Float64Array][] = [];
  for (let b = 0; b < m; b++) {
    const du = new Float64Array(m), dv = new Float64Array(m);
    for (let a = 0; a < m; a++) { du[a] = d[2 * (b * m + a)]; dv[a] = d[2 * (b * m + a) + 1]; }
    rowVals.push([du, dv]);
    rowTans.push([monoTangents(du), monoTangents(dv)]);
  }
  const seg = (f: number) => Math.min(m - 2, Math.floor(f));

  const pos = new Float32Array(layout.pos);
  const colU = new Float64Array(m), colV = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const fx = (i / (n - 1)) * (m - 1), kx = seg(fx), sx = fx - kx;
    for (let b = 0; b < m; b++) {
      colU[b] = hermite(rowVals[b][0], rowTans[b][0], kx, sx);
      colV[b] = hermite(rowVals[b][1], rowTans[b][1], kx, sx);
    }
    const tU = monoTangents(colU), tV = monoTangents(colV);
    for (let j = 0; j < n; j++) {
      const fy = (j / (n - 1)) * (m - 1), ky = seg(fy), sy = fy - ky;
      const du = hermite(colU, tU, ky, sy), dv = hermite(colV, tV, ky, sy);
      if (du === 0 && dv === 0) continue;
      const k = 2 * (j * n + i);
      pos[k] += width * (du * ux + dv * vx);
      pos[k + 1] += width * (du * uy + dv * vy);
    }
  }
  return { ...layout, pos };
}

/** A new lattice with control point (a, b) moved by an image-space offset. */
export function nudgeControl(
  lattice: Lattice | null, a: number, b: number, dxImg: number, dyImg: number, width: number, rotation: number,
): Lattice {
  const base = lattice ?? emptyLattice();
  const ux = Math.cos(rotation), uy = Math.sin(rotation);
  const d = base.d.slice();
  const k = 2 * (b * base.m + a);
  d[k] += (dxImg * ux + dyImg * uy) / width;
  d[k + 1] += (-dxImg * uy + dyImg * ux) / width;
  return { m: base.m, d };
}

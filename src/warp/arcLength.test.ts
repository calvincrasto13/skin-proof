import { describe, expect, it } from 'vitest';
import { CylinderSurface } from '../surface/cylinderSurface';
import { buildDepthSurface, type DepthSurface } from '../surface/depthSurface';
import { layoutByArcLength } from './arcLength';

const N = 33, C = 16;
const xAt = (l: { pos: Float32Array }, i: number, j: number) => l.pos[2 * (j * N + i)];
const yAt = (l: { pos: Float32Array }, i: number, j: number) => l.pos[2 * (j * N + i) + 1];

// Vertical limb: axis x = 500, radius 100, photo 1000×1000.
const cyl = new CylinderSurface(1000, 1000, [{ x: 400, y: 0 }, { x: 400, y: 1000 }], [{ x: 600, y: 0 }, { x: 600, y: 1000 }]);

describe('arc-length layout on an analytic cylinder', () => {
  const R = 100;
  const size = 280; // ±140 skin px from the anchor ⇒ up to 80° around the limb
  const layout = layoutByArcLength(cyl, { cx: 500, cy: 500, size, rotation: 0, n: N });

  it('wraps across the limb as x = R·sin(s/R)', () => {
    for (let i = 0; i < N; i++) {
      const s = ((i - C) * size) / (N - 1);
      expect(layout.valid[C * N + i]).toBe(1);
      expect(xAt(layout, i, C)).toBeCloseTo(500 + R * Math.sin(s / R), 0);
    }
  });

  it('is undistorted along the axis', () => {
    for (let j = 0; j < N; j++) {
      const s = ((j - C) * size) / (N - 1);
      expect(yAt(layout, C, j)).toBeCloseTo(500 + s, 3);
    }
  });

  it('reports n·v = cos(angle around the limb)', () => {
    const s = ((N - 1 - C) * size) / (N - 1);
    expect(layout.facing[C * N + N - 1]).toBeCloseTo(Math.cos(s / R), 2);
  });

  it('marks skin past the horizon as invalid', () => {
    const wide = layoutByArcLength(cyl, { cx: 500, cy: 500, size: 400, rotation: 0, n: N }); // ±200 > πR/2
    expect(wide.valid[C * N + N - 1]).toBe(0);
    expect(wide.valid[C * N + 0]).toBe(0);
    expect(wide.valid[C * N + C]).toBe(1);
  });
});

const autoK = (s: DepthSurface, x: number, y: number) => {
  const cal = s.calibrateAt(x, y);
  return { cal, surface: s.withK(cal.kAuto) };
};

describe('depth-derived surface on a synthetic cylinder disparity map', () => {
  // Depth grid 400×300 standing in for a 1600×1200 photo. Affine-transformed disparity, as the
  // model would give: the absolute scale and offset are unknowable to the surface builder.
  const w = 400, h = 300, Rd = 60, axis = 200, scale = 4;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = x + 0.5 - axis;
      data[y * w + x] = Math.abs(r) < Rd ? 0.3 + (0.5 * Math.sqrt(Rd * Rd - r * r)) / Rd : 0.1;
    }
  const built = buildDepthSurface({ data, w, h }, w * scale, h * scale, { smoothSigma: 1.5, occlusionThreshold: 0.02 });
  const { cal, surface } = autoK(built, axis * scale, 600);
  const R = Rd * scale;

  it('finds the limb and calibrates', () => {
    expect(cal.ok).toBe(true);
    expect(cal.halfWidth).toBeGreaterThan(Rd - 4);
    expect(surface.inside(axis * scale, 600)).toBe(true);
    expect(surface.inside(20, 600)).toBe(false);
  });

  it('lays out within 4% of the true cylinder across the visible width', () => {
    const size = 1.6 * R; // ±0.8R ⇒ ±46° around the limb
    const layout = layoutByArcLength(surface, { cx: axis * scale, cy: 600, size, rotation: 0, n: N });
    for (let i = 0; i < N; i++) {
      const s = ((i - C) * size) / (N - 1);
      const expected = axis * scale + R * Math.sin(s / R);
      expect(Math.abs(xAt(layout, i, C) - expected)).toBeLessThan(0.04 * R);
    }
  });
});

describe('arm in front of a torso', () => {
  // Torso: wide cylinder. Arm: narrow cylinder in front of it, sharing the torso's right
  // silhouette, so its left edge is an occlusion edge INSIDE the body mask.
  const w = 400, h = 300, scale = 4;
  const torso = { axis: 150, R: 140 }, arm = { axis: 250, R: 40 };
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ra = x + 0.5 - arm.axis, rt = x + 0.5 - torso.axis;
      let d = 0.05;
      if (Math.abs(rt) < torso.R) d = 0.3 + (0.3 * Math.sqrt(torso.R ** 2 - rt * rt)) / torso.R;
      if (Math.abs(ra) < arm.R) d = 0.75 + (0.15 * Math.sqrt(arm.R ** 2 - ra * ra)) / arm.R;
      data[y * w + x] = d;
    }
  const built = buildDepthSurface({ data, w, h }, w * scale, h * scale, { smoothSigma: 1.5, occlusionThreshold: 0.02 });
  const ax = arm.axis * scale, ay = 600;
  const { cal, surface } = autoK(built, ax, ay);

  it('cuts the surface along the arm/torso occlusion edge', () => {
    const edge = (arm.axis - arm.R) * scale;
    expect(surface.inside(edge, ay)).toBe(false);
    expect(surface.inside(edge + 8 * scale, ay)).toBe(true); // arm
    expect(surface.inside(edge - 8 * scale, ay)).toBe(true); // torso
  });

  it("calibrates on the arm's half-width, not the torso's", () => {
    expect(cal.ok).toBe(true);
    expect(cal.halfWidth).toBeGreaterThan(arm.R - 6);
    expect(cal.halfWidth).toBeLessThan(arm.R + 2);
  });

  it('stops at the occlusion edge instead of sliding onto the torso', () => {
    const layout = layoutByArcLength(surface, { cx: ax, cy: ay, size: 4 * arm.R * scale, rotation: 0, n: N });
    for (let i = 0; i < N; i++) {
      if (!layout.valid[C * N + i]) continue;
      expect(xAt(layout, i, C)).toBeGreaterThan((arm.axis - arm.R - 1) * scale);
    }
    expect(layout.valid[C * N + 0]).toBe(0);
  });

  it('wraps the arm within 4% of its true cylinder', () => {
    const R = arm.R * scale, size = 1.6 * R;
    const layout = layoutByArcLength(surface, { cx: ax, cy: ay, size, rotation: 0, n: N });
    for (let i = 0; i < N; i++) {
      const s = ((i - C) * size) / (N - 1);
      expect(Math.abs(xAt(layout, i, C) - (ax + R * Math.sin(s / R)))).toBeLessThan(0.04 * R);
    }
  });
});

describe('rim prior', () => {
  const w = 400, h = 300, Rd = 60, axis = 200, scale = 4;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = x + 0.5 - axis;
      data[y * w + x] = Math.abs(r) < Rd ? 0.3 + (0.5 * Math.sqrt(Rd * Rd - r * r)) / Rd : 0.1;
    }
  // Heavy smoothing, as used for real photos: flattens the rim.
  const built = buildDepthSurface({ data, w, h }, w * scale, h * scale, { smoothSigma: 4, occlusionThreshold: 0.02 });
  const cal = built.calibrateAt(axis * scale, 600);
  const R = Rd * scale, size = 3.4 * R; // ±1.7R: past the horizon at πR/2
  const lastValidFacing = (s: DepthSurface) => {
    const l = layoutByArcLength(s, { cx: axis * scale, cy: 600, size, rotation: 0, n: N });
    let f = 1;
    for (let i = C; i < N; i++) if (l.valid[C * N + i]) f = l.facing[C * N + i];
    return f;
  };

  it('without it, the layout stops at the mask edge well short of the horizon', () => {
    expect(lastValidFacing(built.withK(cal.kAuto, 0))).toBeGreaterThan(0.25);
  });

  it('with it, the layout wraps to near-grazing before ending', () => {
    expect(lastValidFacing(built.withK(cal.kAuto, cal.halfWidth))).toBeLessThan(0.2);
  });

  it('does not steepen the far side of an occlusion cut', () => {
    const torso = { axis: 150, R: 140 }, arm = { axis: 250, R: 40 };
    const d2 = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const ra = x + 0.5 - arm.axis, rt = x + 0.5 - torso.axis;
        let d = 0.05;
        if (Math.abs(rt) < torso.R) d = 0.3 + (0.3 * Math.sqrt(torso.R ** 2 - rt * rt)) / torso.R;
        if (Math.abs(ra) < arm.R) d = 0.75 + (0.15 * Math.sqrt(arm.R ** 2 - ra * ra)) / arm.R;
        d2[y * w + x] = d;
      }
    const s = buildDepthSurface({ data: d2, w, h }, w * scale, h * scale, { smoothSigma: 4, occlusionThreshold: 0.02 });
    const torsoSide = ((arm.axis - arm.R - 6) * scale), armSide = ((arm.axis - arm.R + 6) * scale);
    const k = 0.5;
    expect(s.withK(k, arm.R).slope(torsoSide, 600)).toEqual(s.withK(k, 0).slope(torsoSide, 600));
    expect(Math.abs(s.withK(k, arm.R).slope(armSide, 600)[0])).toBeGreaterThan(Math.abs(s.withK(k, 0).slope(armSide, 600)[0]));
  });
});

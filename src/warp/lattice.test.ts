import { describe, expect, it } from 'vitest';
import { FlatSurface } from '../surface/types';
import { layoutByArcLength } from './arcLength';
import { applyLattice, controlVertex, emptyLattice, nudgeControl } from './lattice';

const N = 33, M = 5;
const flat = new FlatSurface(1000, 1000);
const lay = (rotation = 0) => layoutByArcLength(flat, { cx: 500, cy: 500, size: 400, rotation, n: N });
const at = (pos: Float32Array, k: number) => [pos[2 * k], pos[2 * k + 1]];

describe('manual lattice', () => {
  it('is the identity when empty', () => {
    const l = lay();
    expect(applyLattice(l, emptyLattice(), 400, 0)).toBe(l);
    expect(applyLattice(l, null, 400, 0)).toBe(l);
  });

  it('moves the dragged control point exactly where it was dragged', () => {
    const l = lay();
    const lat = nudgeControl(null, 2, 1, 30, -12, 400, 0);
    const out = applyLattice(l, lat, 400, 0);
    const k = controlVertex(N, M, 2, 1);
    expect(at(out.pos, k)[0]).toBeCloseTo(at(l.pos, k)[0] + 30, 4);
    expect(at(out.pos, k)[1]).toBeCloseTo(at(l.pos, k)[1] - 12, 4);
  });

  it('leaves every other control point where it was, and far vertices untouched', () => {
    const l = lay();
    const out = applyLattice(l, nudgeControl(null, 1, 1, 40, 40, 400, 0), 400, 0);
    for (let b = 0; b < M; b++)
      for (let a = 0; a < M; a++) {
        if (a === 1 && b === 1) continue;
        const k = controlVertex(N, M, a, b);
        expect(at(out.pos, k)[0]).toBeCloseTo(at(l.pos, k)[0], 4);
        expect(at(out.pos, k)[1]).toBeCloseTo(at(l.pos, k)[1], 4);
      }
    // Support is two cells each way: the far corner region doesn't move at all.
    const far = 30 * N + 30;
    expect(at(out.pos, far)).toEqual(at(l.pos, far));
  });

  it('bends smoothly between control points without pushing ink the other way', () => {
    const l = lay();
    const out = applyLattice(l, nudgeControl(null, 2, 2, 50, 0, 400, 0), 400, 0);
    // Along the middle row the offset climbs to the dragged point and never dips below zero:
    // the monotone cubic has no Catmull-Rom style negative lobe.
    const row = 16;
    let maxJump = 0, minOff = 0;
    for (let i = 0; i <= 16; i++) {
      const k = row * N + i;
      const off = out.pos[2 * k] - l.pos[2 * k];
      minOff = Math.min(minOff, off);
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(off - (out.pos[2 * (k - 1)] - l.pos[2 * (k - 1)])));
    }
    expect(out.pos[2 * (row * N + 16)] - l.pos[2 * (row * N + 16)]).toBeCloseTo(50, 3);
    expect(minOff).toBeGreaterThanOrEqual(-1e-6);
    expect(maxJump).toBeLessThan(12); // no step between neighbouring vertices
  });

  it('keeps corrections attached to the design when it rotates', () => {
    // A correction made at rotation 0 along u, viewed after rotating the design 90°, moves along +y.
    const lat = nudgeControl(null, 4, 2, 20, 0, 400, 0);
    const l90 = lay(Math.PI / 2);
    const out = applyLattice(l90, lat, 400, Math.PI / 2);
    const k = controlVertex(N, M, 4, 2);
    expect(at(out.pos, k)[0] - at(l90.pos, k)[0]).toBeCloseTo(0, 3);
    expect(at(out.pos, k)[1] - at(l90.pos, k)[1]).toBeCloseTo(20, 3);
  });

  it('stays exactly linear for evenly spaced offsets (no stair-stepping)', () => {
    let lat = null;
    for (let a = 0; a < M; a++) lat = nudgeControl(lat, a, 2, a * 10, 0, 400, 0);
    const l = lay();
    const out = applyLattice(l, lat, 400, 0);
    const row = 16;
    for (let i = 0; i < N; i++) {
      const k = row * N + i;
      expect(out.pos[2 * k] - l.pos[2 * k]).toBeCloseTo((i / (N - 1)) * 40, 3);
    }
  });

  it('scales corrections with the design', () => {
    const lat = nudgeControl(null, 3, 3, 10, 0, 400, 0);
    const big = layoutByArcLength(flat, { cx: 500, cy: 500, size: 800, rotation: 0, n: N });
    const out = applyLattice(big, lat, 800, 0);
    const k = controlVertex(N, M, 3, 3);
    expect(out.pos[2 * k] - big.pos[2 * k]).toBeCloseTo(20, 3);
  });
});

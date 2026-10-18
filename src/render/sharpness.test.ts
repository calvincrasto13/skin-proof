import { describe, expect, it } from 'vitest';
import { gaussianBlur } from '../surface/grid';
import { estimateEdgeSigma, inkBlurForPhoto } from './sharpness';

/** Rotated rectangles, pixel-area antialiased (4×4 supersampling), then Gaussian-blurred. */
function scene(sigma: number, w = 320, h = 240): Float32Array {
  const rects = [
    { cx: 80, cy: 70, hw: 40, hh: 25, a: 0.3, v: 0.85 },
    { cx: 220, cy: 80, hw: 50, hh: 30, a: -0.5, v: 0.15 },
    { cx: 120, cy: 170, hw: 45, hh: 35, a: 1.1, v: 0.9 },
    { cx: 250, cy: 180, hw: 35, hh: 30, a: 0.05, v: 0.2 },
  ];
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
          let v = 0.5;
          for (const r of rects) {
            const dx = px - r.cx, dy = py - r.cy;
            const u = Math.cos(r.a) * dx + Math.sin(r.a) * dy, t = -Math.sin(r.a) * dx + Math.cos(r.a) * dy;
            if (Math.abs(u) < r.hw && Math.abs(t) < r.hh) v = r.v;
          }
          acc += v;
        }
      img[y * w + x] = acc / 16;
    }
  return gaussianBlur({ data: img, w, h }, sigma).data;
}

describe('estimateEdgeSigma', () => {
  for (const sigma of [0.7, 1.5, 2.5]) {
    it(`recovers the ink blur that matches a σ=${sigma} photo`, () => {
      const { sigma: est, edges } = estimateEdgeSigma(scene(sigma), 320, 240);
      expect(edges).toBeGreaterThan(20);
      // Estimate includes the pixel-area antialias; inkBlurForPhoto removes it again.
      expect(Math.abs(inkBlurForPhoto(est) - sigma) / sigma).toBeLessThan(0.15);
    });
  }

  it('returns NaN when there are no clean edges', () => {
    const flat = new Float32Array(100 * 100).fill(0.5);
    expect(Number.isNaN(estimateEdgeSigma(flat, 100, 100).sigma)).toBe(true);
  });
});

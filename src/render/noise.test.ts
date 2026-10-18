import { describe, expect, it } from 'vitest';
import { estimateNoiseSigma } from './noise';

// Deterministic Gaussian via Box–Muller on a small LCG.
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

describe('estimateNoiseSigma', () => {
  const w = 400, h = 300;

  it('recovers noise on a smooth gradient', () => {
    const g = rng(1);
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = 0.2 + 0.5 * (x / w) + 0.02 * g();
    expect(estimateNoiseSigma(lum, w, h)).toBeCloseTo(0.02, 2);
  });

  it('is not fooled by sharp edges', () => {
    const g = rng(2);
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) lum[y * w + x] = ((x >> 4) + (y >> 4)) % 2 ? 0.8 : 0.2 + 0.01 * g();
    const est = estimateNoiseSigma(lum, w, h);
    expect(est).toBeLessThan(0.008); // half the image is noise-free; edges are ~12% of pixels
  });
});

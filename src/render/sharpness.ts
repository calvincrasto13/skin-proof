/**
 * How soft are the photo's edges? Returns the Gaussian sigma (px) of its effective blur:
 * lens, demosaicing, phone sharpening/denoise and any downscale, all folded together.
 *
 * Method: at strong, isolated step edges, sample the luminance profile across the edge. For a
 * step of contrast A blurred by a Gaussian σ the peak slope is A / (σ√(2π)), so
 * σ = A / (peakSlope · √(2π)). Median over many edges. Profiles that aren't clean monotone
 * steps (thin lines, texture, corners) are rejected, because they'd read as sharper or softer
 * than the optics really are.
 */
export function estimateEdgeSigma(lum: Float32Array, w: number, h: number, maxEdges = 400): { sigma: number; edges: number } {
  const at = (x: number, y: number) => {
    const fx = Math.min(Math.max(x, 0), w - 1), fy = Math.min(Math.max(y, 0), h - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const tx = fx - x0, ty = fy - y0;
    const a = lum[y0 * w + x0] * (1 - tx) + lum[y0 * w + x1] * tx;
    const b = lum[y1 * w + x0] * (1 - tx) + lum[y1 * w + x1] * tx;
    return a * (1 - ty) + b * ty;
  };

  // Candidates in order of gradient strength; each accepted edge blocks its neighbourhood so
  // one long edge doesn't dominate the median.
  const R = 8;
  const cands: { i: number; m: number; ux: number; uy: number }[] = [];
  for (let y = R + 1; y < h - R - 1; y++)
    for (let x = R + 1; x < w - R - 1; x++) {
      const i = y * w + x;
      const gx = (lum[i + 1] - lum[i - 1]) / 2, gy = (lum[i + w] - lum[i - w]) / 2;
      const m = Math.hypot(gx, gy);
      if (m < 0.02) continue;
      cands.push({ i, m, ux: gx / m, uy: gy / m });
    }
  cands.sort((a, b) => b.m - a.m);

  const sigmas: number[] = [];
  const taken = new Uint8Array(w * h);
  const N = 2 * R * 4 + 1; // profile samples at 0.25 px
  const prof = new Float32Array(N);
  for (const c of cands) {
    if (sigmas.length >= maxEdges) break;
    if (taken[c.i]) continue;
    const x = c.i % w, y = (c.i / w) | 0;
    for (let k = 0; k < N; k++) {
      const t = (k - (N - 1) / 2) / 4;
      prof[k] = at(x + c.ux * t, y + c.uy * t);
    }
    // Clean step: monotone (small tolerance for noise) with flat-ish shoulders.
    let mono = true;
    for (let k = 1; k < N && mono; k++) if (prof[k] < prof[k - 1] - 0.01) mono = false;
    if (!mono) continue;
    const lo = (prof[0] + prof[1] + prof[2]) / 3, hi = (prof[N - 1] + prof[N - 2] + prof[N - 3]) / 3;
    const A = hi - lo;
    if (A < 0.12) continue;
    const shoulder = (prof[8] - prof[0]) + (prof[N - 1] - prof[N - 9]); // change over the outer 2 px each side
    if (shoulder > 0.15 * A) continue; // not a step: still ramping at ±4 px
    let peak = 0;
    for (let k = 2; k < N - 2; k++) peak = Math.max(peak, (prof[k + 2] - prof[k - 2]) / 1.0); // slope per px over ±0.5 px
    if (peak <= 0) continue;
    sigmas.push(A / (peak * Math.sqrt(2 * Math.PI)));
    // Don't sample the same edge many times over.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) taken[(y + dy) * w + x + dx] = 1;
  }
  if (sigmas.length < 10) return { sigma: NaN, edges: sigmas.length };
  sigmas.sort((a, b) => a - b);
  // The measurement itself blurs: bilinear profile sampling (triangle kernel, variance 1/6) and
  // the ±0.5 px slope window (box, variance 1/12). Remove that in quadrature.
  const measured = sigmas[sigmas.length >> 1];
  return { sigma: Math.sqrt(Math.max(0, measured * measured - 0.25)), edges: sigmas.length };
}

/**
 * Blur to apply to rendered ink so its edges match the photo's. The ink is rasterized with a
 * 1 px box antialias (σ ≈ 1/√12), so subtract that in quadrature.
 */
export function inkBlurForPhoto(photoSigma: number): number {
  if (!Number.isFinite(photoSigma)) return 0.8;
  const box = 1 / Math.sqrt(12);
  return Math.sqrt(Math.max(0, photoSigma * photoSigma - box * box));
}

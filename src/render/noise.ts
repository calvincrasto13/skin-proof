/**
 * Photo noise standard deviation (same units as the input, here sRGB luminance 0..1).
 *
 * Immerkær's mask N = [1 -2 1; -2 4 -2; 1 -2 1] cancels locally linear structure, and on iid
 * noise of std σ its response has std 6σ (ΣN² = 36). Using the MEDIAN absolute response
 * (σ = median / 0.6745 / 6) instead of Immerkær's mean keeps edges and texture, which are a
 * minority of pixels, from inflating the estimate.
 */
export function estimateNoiseSigma(lum: Float32Array, w: number, h: number, stride = 1): number {
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y += stride)
    for (let x = 1; x < w - 1; x += stride) {
      const i = y * w + x;
      const r =
        lum[i - w - 1] - 2 * lum[i - w] + lum[i - w + 1] +
        -2 * lum[i - 1] + 4 * lum[i] - 2 * lum[i + 1] +
        lum[i + w - 1] - 2 * lum[i + w] + lum[i + w + 1];
      vals.push(Math.abs(r));
    }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1] / 0.6745 / 6;
}

/** Luminance (sRGB-encoded, 0..1) of a bitmap, for noise estimation. */
export function bitmapLuminance(image: ImageBitmap): { lum: Float32Array; w: number; h: number } {
  const { width: w, height: h } = image;
  const ctx = new OffscreenCanvas(w, h).getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255;
  return { lum, w, h };
}

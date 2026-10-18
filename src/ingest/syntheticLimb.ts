/**
 * A Lambert-shaded vertical cylinder on a grey wall. Not a stand-in for a real photo: it
 * checks the pipeline end to end and gives a case where the right answer is known.
 */
export async function syntheticLimb(w = 1200, h = 1600): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const cx = w * 0.5, R = w * 0.18;
  const light = [-0.45, -0.3, 0.84]; // upper-left key light
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 4 * (y * w + x);
      const r = (x - cx) / R;
      if (Math.abs(r) < 1) {
        const nz = Math.sqrt(1 - r * r);
        const lambert = Math.max(0, r * light[0] + nz * light[2]) * 0.85 + 0.15;
        img.data[o] = 224 * lambert; img.data[o + 1] = 172 * lambert; img.data[o + 2] = 140 * lambert;
      } else {
        const v = 120 + 20 * (y / h);
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v + 4;
      }
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return createImageBitmap(c);
}

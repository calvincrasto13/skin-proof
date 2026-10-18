/** Dense row-major float grid. */
export type Grid = { data: Float32Array; w: number; h: number };

export function sampleBilinear(g: Grid, x: number, y: number): number {
  const fx = Math.min(Math.max(x, 0), g.w - 1);
  const fy = Math.min(Math.max(y, 0), g.h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, g.w - 1), y1 = Math.min(y0 + 1, g.h - 1);
  const tx = fx - x0, ty = fy - y0;
  const d = g.data, w = g.w;
  const a = d[y0 * w + x0] + (d[y0 * w + x1] - d[y0 * w + x0]) * tx;
  const b = d[y1 * w + x0] + (d[y1 * w + x1] - d[y1 * w + x0]) * tx;
  return a + (b - a) * ty;
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian with clamped edges. */
export function gaussianBlur(g: Grid, sigma: number): Grid {
  if (sigma <= 0) return { ...g, data: g.data.slice() };
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const { w, h } = g;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * g.data[y * w + Math.min(Math.max(x + i, 0), w - 1)];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(Math.max(y + i, 0), h - 1) * w + x];
      out[y * w + x] = s;
    }
  }
  return { data: out, w, h };
}

/**
 * Normalized convolution: blur only over mask pixels, so the background's disparity doesn't
 * bleed across the silhouette. A plain blur turns the occlusion jump into a fake slope right
 * where the wrap geometry matters most.
 */
export function maskedBlur(g: Grid, mask: Uint8Array, sigma: number): Grid {
  const num = new Float32Array(g.data.length);
  const den = new Float32Array(g.data.length);
  for (let i = 0; i < num.length; i++) {
    num[i] = mask[i] ? g.data[i] : 0;
    den[i] = mask[i] ? 1 : 0;
  }
  const bn = gaussianBlur({ data: num, w: g.w, h: g.h }, sigma).data;
  const bd = gaussianBlur({ data: den, w: g.w, h: g.h }, sigma).data;
  const out = new Float32Array(num.length);
  for (let i = 0; i < out.length; i++) out[i] = bd[i] > 1e-4 ? bn[i] / bd[i] : g.data[i];
  return { data: out, w: g.w, h: g.h };
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}

/** Otsu threshold for values in [0, 1]. */
export function otsu(values: Float32Array, bins = 256): number {
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = i; }
  }
  return (best + 0.5) / bins;
}

/** Keep only the largest 4-connected component of a binary mask. */
export function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const { label, best } = labelComponents(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === best && best ? 1 : 0;
  return out;
}

/** 4-connected labels (0 = background) and the label of the largest component. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { label: Int32Array; best: number } {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0, bestSize = 0, next = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    next++;
    let top = 0, size = 0;
    stack[top++] = s;
    label[s] = next;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = next; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = next; stack[top++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  return { label, best: bestLabel };
}

/** 3×3 binary dilation. */
export function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
        }
    }
  return out;
}

/**
 * Approximate Euclidean distance (chamfer 3-4) from each mask pixel to the nearest non-mask
 * pixel. The frame border is NOT a boundary: a limb cropped by the photo edge has no
 * silhouette there.
 */
export function distanceInside(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= INF ? Infinity : d[i] / 3;
  return d;
}

import type { Density } from './key';

/** The design mirrored left-right ('h') or top-bottom ('v'). A new buffer: undo snapshots keep the old one. */
export function flipDensity(d: Density, axis: 'h' | 'v'): Density {
  const { w, h } = d;
  const out = new Uint8Array(d.data.length);
  for (let y = 0; y < h; y++) {
    const sy = axis === 'v' ? h - 1 - y : y;
    for (let x = 0; x < w; x++) out[y * w + x] = d.data[sy * w + (axis === 'h' ? w - 1 - x : x)];
  }
  return { data: out, w, h };
}

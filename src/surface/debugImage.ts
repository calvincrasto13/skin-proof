import type { Grid } from './grid';
import { normalFromSlope, type Surface } from './types';

export type OverlayMode = 'none' | 'disparity' | 'normals' | 'facing' | 'mask' | 'edges';

/** Depth-only debug layers, all at depth-map resolution. */
export type DepthDebug = { disparity: Grid; edgeMag: Grid; cut: Uint8Array; threshold: number };

/** Google's polynomial fit of the Turbo colormap. */
export function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r * 255, g * 255, b * 255];
}

/**
 * Rasterize a debug view at grid resolution; the caller scales it over the photo.
 * Works off the Surface interface, so depth and cylinder render through the same code.
 */
export function renderOverlay(
  surface: Surface,
  mode: Exclude<OverlayMode, 'none'>,
  gw: number,
  gh: number,
  debug?: DepthDebug,
): ImageData {
  const img = new ImageData(gw, gh);
  const px = img.data;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const x = ((i + 0.5) / gw) * surface.width;
      const y = ((j + 0.5) / gh) * surface.height;
      const o = 4 * (j * gw + i);
      const inside = surface.inside(x, y);
      if (mode === 'disparity' || mode === 'edges') {
        if (!debug) continue;
        const k = j * debug.disparity.w + i;
        if (mode === 'edges' && debug.cut[k]) {
          px[o] = 255; px[o + 1] = 40; px[o + 2] = 60; px[o + 3] = 255;
          continue;
        }
        // Edges: 0.5 on the colormap = exactly at threshold.
        const v = mode === 'disparity' ? debug.disparity.data[k] : debug.edgeMag.data[k] / (2 * debug.threshold);
        const [r, g, b] = turbo(v);
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
        continue;
      }
      if (mode === 'mask') {
        px[o] = inside ? 60 : 255; px[o + 1] = inside ? 220 : 40; px[o + 2] = inside ? 120 : 60; px[o + 3] = 255;
        continue;
      }
      if (!inside) continue;
      const [nx, ny, nz] = normalFromSlope(...surface.slope(x, y));
      if (mode === 'normals') {
        // Tangent-space style: R = right, G = up (image y is down, hence -ny), B = toward camera.
        px[o] = (nx * 0.5 + 0.5) * 255; px[o + 1] = (-ny * 0.5 + 0.5) * 255; px[o + 2] = (nz * 0.5 + 0.5) * 255;
      } else {
        const [r, g, b] = turbo(nz);
        px[o] = r; px[o + 1] = g; px[o + 2] = b;
      }
      px[o + 3] = 255;
    }
  return img;
}

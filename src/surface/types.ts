/**
 * A height field over the photo, viewed orthographically. All coordinates are photo pixels;
 * height is in the same units, so slopes are dimensionless (dh/dx, dh/dy).
 *
 * Everything downstream (layout, normals, debug views) talks to this interface, so the
 * depth-derived and cylinder-fitted surfaces are interchangeable and directly comparable.
 */
export interface Surface {
  readonly width: number;
  readonly height: number;
  /** Gradient of the height field at (x, y). Unbounded near the silhouette. */
  slope(x: number, y: number): [number, number];
  /** False outside the body: background, or beyond the limb's silhouette. */
  inside(x: number, y: number): boolean;
}

/** Unit normal from slope, z toward the camera. nz is n·v for an orthographic view. */
export function normalFromSlope(sx: number, sy: number): [number, number, number] {
  const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
  return [-sx * inv, -sy * inv, inv];
}

/** No relief: the "sticker geometry" baseline for A/B against the warped layout. */
export class FlatSurface implements Surface {
  constructor(readonly width: number, readonly height: number) {}
  slope(): [number, number] { return [0, 0]; }
  inside(): boolean { return true; }
}

/**
 * Spike-level ingest: decode with EXIF orientation applied, then cap the working copy.
 * Geometry runs in working-copy pixels; the full-resolution path arrives with export.
 */
const WORKING_LONG_EDGE = 2048;

export async function loadPhoto(file: Blob) {
  const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, WORKING_LONG_EDGE / Math.max(full.width, full.height));
  if (scale === 1) return { bitmap: full, originalW: full.width, originalH: full.height };
  const bitmap = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale),
    resizeHeight: Math.round(full.height * scale),
    resizeQuality: 'high',
  });
  const info = { bitmap, originalW: full.width, originalH: full.height };
  full.close(); // release the 12MP decode immediately
  return info;
}

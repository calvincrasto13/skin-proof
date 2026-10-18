import { percentile } from '../surface/grid';

export type Density = { data: Uint8Array; w: number; h: number };

/**
 * Minimal luminance key for line art on white → ink density (0..255).
 * Paper and ink levels come from the image itself (98th / 1st percentile luminance), so
 * off-white and cream paper normalize out. Density is continuous, so grey shading and
 * antialiased edges survive as partial ink; only a floor (JPEG haze, paper texture) is cut.
 *
 * The full keying pass (despeckle, local paper normalization for uneven lighting, adjustable
 * softness) is part of the design-import work; this is enough to drive the warp.
 */
export function keyLineArt(image: ImageBitmap, maxEdge = 2048, floor = 0.08): Density {
  const s = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const w = Math.round(image.width * s), h = Math.round(image.height * s);
  const ctx = new OffscreenCanvas(w, h).getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs: transparency is paper
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255;
  const paper = percentile(lum, 98), ink = Math.min(percentile(lum, 1), paper - 0.05);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const d = (paper - lum[i]) / (paper - ink);
    data[i] = Math.round(255 * Math.min(1, Math.max(0, (d - floor) / (1 - floor))));
  }
  return { data, w, h };
}

/** Generated line art for testing the warp without a design file. */
export function testDesign(kind: 'checker' | 'rings' | 'lineart'): Density {
  const w = 1024, h = kind === 'lineart' ? 640 : 1024;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = g.strokeStyle = '#000';
  if (kind === 'checker') {
    // Thick-bordered checker: square cells make foreshortening easy to read.
    const n = 8, cell = w / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i + j) % 2 === 0) g.fillRect(i * cell, j * cell, cell, cell);
    g.lineWidth = 12;
    g.strokeRect(6, 6, w - 12, h - 12);
  } else if (kind === 'rings') {
    for (let r = 40, k = 0; r < 500; r += 52, k++) {
      g.lineWidth = 4 + k * 3;
      g.beginPath();
      g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
      g.stroke();
    }
  } else {
    // Script-ish lettering with a flourish and some grey shading: outline weight, fine detail
    // and a wash all in one design.
    g.lineCap = g.lineJoin = 'round';
    g.font = 'italic 700 190px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Memento', w / 2, h * 0.42);
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(120, h * 0.72);
    g.bezierCurveTo(330, h * 0.6, 690, h * 0.86, 904, h * 0.7);
    g.stroke();
    g.lineWidth = 2.5;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.moveTo(170 + i * 80, h * 0.8);
      g.lineTo(200 + i * 80, h * 0.9);
      g.stroke();
    }
    const grad = g.createLinearGradient(0, h * 0.06, 0, h * 0.18);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(260, h * 0.06, 504, h * 0.12);
  }
  const px = g.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = 255 - px[4 * i + 1]; // black on white: invert green ≈ luminance
  return { data, w, h };
}

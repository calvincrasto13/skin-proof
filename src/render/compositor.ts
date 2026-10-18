import {
  bindTex, createContext, deleteTarget, drawFullscreen, formats, photoTexture, program, target,
  type Program, type Target,
} from './gl';
import { estimateNoiseSigma, bitmapLuminance } from './noise';
import { estimateEdgeSigma, inkBlurForPhoto } from './sharpness';
import { accumulateFS, blurFS, compositeFS, downsampleFS, fullscreenVS, meshFS, meshVS, shapeFS } from './shaders';
import type { Layout } from '../warp/arcLength';

export type InkParams = {
  /** sRGB hex of the ink as it sits in skin, before scatter. */
  color: string;
  saturation: number;
  opacity: number;
  /** Epidermal scatter lift, 0..1. */
  scatter: number;
  /** Ink edge softness, image px. */
  blur: number;
  /** 1 = re-add the photo's noise where ink removed it. */
  grain: number;
  /** 1 = specular passes over ink (physical); 0 = attenuated like the rest. */
  specPass: number;
  specFloor: number;
};

/** What varies per tattoo layer. Scatter, blur, grain and specular belong to the skin and photo. */
export type LayerInk = Pick<InkParams, 'color' | 'saturation' | 'opacity'>;

export type ShapeParams = {
  kind: 'rect' | 'ramp' | 'rings';
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
};

/**
 * Where ink comes from: one analytic test shape (inked with the global ink), or the uploaded
 * design layers, bottom to top.
 */
export type InkSource =
  | { kind: 'shape'; shape: ShapeParams }
  | { kind: 'layers'; layers: { id: string; ink: LayerInk }[] };

export type BlendMode = 'physical' | 'srgb-multiply' | 'sticker';
export type DebugView = 'composite' | 'original' | 'diffuse' | 'specular' | 'transmittance' | 'density';

const MODE: Record<BlendMode, number> = { physical: 0, 'srgb-multiply': 1, sticker: 2 };
const DEBUG: Record<DebugView, number> = { composite: 0, original: 1, diffuse: 2, specular: 3, transmittance: 4, density: 5 };
const SHAPE = { rect: 0, ramp: 1, rings: 2 } as const;

/** Base (local skin colour) lives at 1/4 resolution; its blur is ~1.2% of the long edge. */
const BASE_LOD = 2;
const BASE_SIGMA_FRAC = 0.012;

type MeshGpu = {
  vao: WebGLVertexArrayObject; pos: WebGLBuffer; vis: WebGLBuffer; uv: WebGLBuffer; idx: WebGLBuffer; n: number; count: number;
};
type LayerGpu = { design: WebGLTexture | null; mesh: MeshGpu | null };

export class Compositor {
  private gl: WebGL2RenderingContext;
  private p: { down: Program; blur: Program; shape: Program; comp: Program; mesh: Program; acc: Program };
  private fmt: ReturnType<typeof formats>;

  private photo: WebGLTexture | null = null;
  private imgW = 0;
  private imgH = 0;
  private base: [Target, Target] | null = null;
  /** Per-layer density scratch (draw, then blur ping-pong). */
  private ink: [Target, Target] | null = null;
  /** Running totals over layers: transmittance product, and the sticker composite for ablations. */
  private trans: Target | null = null;
  private stick: Target | null = null;
  private inkDirty = true;
  /** Body mask (from depth), image space at depth resolution; also makes the base mask-aware. */
  private mask: WebGLTexture | null = null;
  /** Per-layer design textures and meshes. Survive photo changes. */
  private layers = new Map<string, LayerGpu>();
  noiseSigma = 0;
  /** Photo's effective edge blur (px) and the ink blur that matches it. */
  edgeSigma = NaN;
  suggestedBlur = 0.8;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    const floatOk = !!this.gl.getExtension('EXT_color_buffer_float');
    this.fmt = formats(this.gl, floatOk);
    const gl = this.gl;
    this.p = {
      down: program(gl, fullscreenVS, downsampleFS),
      blur: program(gl, fullscreenVS, blurFS),
      shape: program(gl, fullscreenVS, shapeFS),
      comp: program(gl, fullscreenVS, compositeFS),
      mesh: program(gl, meshVS, meshFS),
      acc: program(gl, fullscreenVS, accumulateFS),
    };
  }

  get imageSize() { return { w: this.imgW, h: this.imgH }; }

  /** Once per photo: upload, measure noise and sharpness, build the base (local skin colour). */
  setPhoto(image: ImageBitmap) {
    const gl = this.gl;
    this.disposePhoto();
    this.imgW = image.width;
    this.imgH = image.height;
    this.photo = photoTexture(gl, image);

    const { lum, w, h } = bitmapLuminance(image);
    this.noiseSigma = estimateNoiseSigma(lum, w, h, 2);
    this.edgeSigma = estimateEdgeSigma(lum, w, h).sigma;
    this.suggestedBlur = inkBlurForPhoto(this.edgeSigma);

    const bw = Math.max(1, image.width >> BASE_LOD), bh = Math.max(1, image.height >> BASE_LOD);
    this.base = [target(gl, bw, bh, this.fmt.rgba16f), target(gl, bw, bh, this.fmt.rgba16f)];
    this.buildBase();

    // Ink at full working resolution: the edges are what the eye judges.
    const W = image.width, H = image.height;
    this.ink = [target(gl, W, H, this.fmt.r8), target(gl, W, H, this.fmt.r8)];
    // Mipmapped so the downscaled on-screen view doesn't alias hairlines.
    this.trans = target(gl, W, H, this.fmt.rgba16f, true);
    this.stick = target(gl, W, H, this.fmt.rgba16f, true);
    this.inkDirty = true;
  }

  invalidateInk() { this.inkDirty = true; }

  /** Local skin colour: downsample + wide blur, normalized by the body mask when there is one. */
  private buildBase() {
    const gl = this.gl;
    const [a] = this.base!;
    gl.useProgram(this.p.down.prog);
    bindTex(gl, 0, this.photo!, this.p.down.u('uSrc'));
    if (this.mask) bindTex(gl, 1, this.mask, this.p.down.u('uMask'));
    gl.uniform1i(this.p.down.u('uHasMask'), this.mask ? 1 : 0);
    gl.uniform1f(this.p.down.u('uLod'), BASE_LOD);
    gl.uniform2f(this.p.down.u('uDstSize'), a.w, a.h);
    drawFullscreen(gl, a);
    const sigma = Math.min(16, (BASE_SIGMA_FRAC * Math.max(this.imgW, this.imgH)) / (1 << BASE_LOD));
    this.blur(this.base!, sigma);
  }

  /** Body mask at any resolution covering the whole photo (1 = body). Pass null to clear. */
  setBodyMask(mask: Uint8Array | null, w = 0, h = 0) {
    const gl = this.gl;
    if (this.mask) gl.deleteTexture(this.mask);
    this.mask = null;
    if (mask) {
      const bytes = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) bytes[i] = mask[i] ? 255 : 0;
      this.mask = r8Texture(gl, bytes, w, h, false);
    }
    if (this.photo) this.buildBase();
    this.inkDirty = true;
  }

  private layer(id: string): LayerGpu {
    let l = this.layers.get(id);
    if (!l) this.layers.set(id, (l = { design: null, mesh: null }));
    return l;
  }

  /** A layer's design as ink density (0..255), row 0 = top. */
  setLayerDesign(id: string, density: Uint8Array, w: number, h: number) {
    const l = this.layer(id);
    if (l.design) this.gl.deleteTexture(l.design);
    l.design = r8Texture(this.gl, density, w, h, true);
    this.inkDirty = true;
  }

  /** Upload a layer's laid-out mesh. Topology is fixed per n; positions/visibility per call. */
  setLayerMesh(id: string, layout: Layout) {
    const gl = this.gl;
    const l = this.layer(id);
    const { n } = layout;
    if (!l.mesh || l.mesh.n !== n) {
      this.deleteMesh(l.mesh);
      l.mesh = this.createMesh(n);
    }
    // Visibility: valid vertices, softly faded right at the horizon so the wrap doesn't end on
    // a hard polygon edge. The real falloff is the compression, which the positions carry.
    const vis = new Float32Array(n * n);
    for (let i = 0; i < vis.length; i++) {
      vis[i] = layout.valid[i] ? Math.min(1, Math.max(0, (layout.facing[i] - 0.03) / 0.12)) : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, l.mesh.pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, layout.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, l.mesh.vis);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vis);
    this.inkDirty = true;
  }

  removeLayer(id: string) {
    const l = this.layers.get(id);
    if (!l) return;
    if (l.design) this.gl.deleteTexture(l.design);
    this.deleteMesh(l.mesh);
    this.layers.delete(id);
    this.inkDirty = true;
  }

  private createMesh(n: number): MeshGpu {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const prog = this.p.mesh.prog;
    const buf = (name: string, size: number, data: Float32Array | null, count: number) => {
      const loc = gl.getAttribLocation(prog, name);
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      else gl.bufferData(gl.ARRAY_BUFFER, count * size * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        uv[2 * (j * n + i)] = i / (n - 1);
        uv[2 * (j * n + i) + 1] = j / (n - 1);
      }
    const pos = buf('aPos', 2, null, n * n);
    const uvb = buf('aUv', 2, uv, n * n);
    const vis = buf('aVis', 1, null, n * n);
    const idx = new Uint16Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.set([a, b, d, a, d, c], k);
        k += 6;
      }
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, pos, vis, uv: uvb, idx: ib, n, count: idx.length };
  }

  private deleteMesh(m: MeshGpu | null) {
    if (!m) return;
    const gl = this.gl;
    gl.deleteVertexArray(m.vao);
    [m.pos, m.vis, m.uv, m.idx].forEach((b) => gl.deleteBuffer(b));
  }

  /** Separable blur, result back in pair[0]. */
  private blur(pair: [Target, Target], sigma: number) {
    const gl = this.gl;
    gl.useProgram(this.p.blur.prog);
    gl.uniform1f(this.p.blur.u('uSigma'), sigma);
    gl.uniform2f(this.p.blur.u('uDir'), 1, 0);
    bindTex(gl, 0, pair[0].tex, this.p.blur.u('uSrc'));
    drawFullscreen(gl, pair[1]);
    gl.uniform2f(this.p.blur.u('uDir'), 0, 1);
    bindTex(gl, 0, pair[1].tex, this.p.blur.u('uSrc'));
    drawFullscreen(gl, pair[0]);
  }

  private clear(t: Target, r: number, g: number, b: number, a: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Draw one layer's density into ink[0], blurred. Returns false if there's nothing to draw. */
  private drawDensity(source: { shape: ShapeParams } | { layer: LayerGpu }, blurPx: number): boolean {
    const gl = this.gl;
    const [a] = this.ink!;
    if ('shape' in source) {
      const { shape } = source;
      gl.useProgram(this.p.shape.prog);
      gl.uniform2f(this.p.shape.u('uCenter'), shape.cx, shape.cy);
      gl.uniform2f(this.p.shape.u('uHalf'), shape.w / 2, shape.h / 2);
      gl.uniform1f(this.p.shape.u('uRot'), shape.rotation);
      gl.uniform1i(this.p.shape.u('uShape'), SHAPE[shape.kind]);
      drawFullscreen(gl, a);
    } else {
      const { mesh, design } = source.layer;
      if (!mesh || !design) return false;
      this.clear(a, 0, 0, 0, 1);
      gl.useProgram(this.p.mesh.prog);
      gl.uniform2f(this.p.mesh.u('uImageSize'), this.imgW, this.imgH);
      bindTex(gl, 0, design, this.p.mesh.u('uDesign'));
      // MAX, not add: near the horizon the mesh can fold over itself.
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
    }
    this.blur(this.ink!, Math.min(16, blurPx));
    return true;
  }

  /** Fold ink[0] into the running totals with this layer's ink. */
  private accumulate(ink: LayerInk, scatter: number) {
    const gl = this.gl;
    const u = this.p.acc.u;
    gl.useProgram(this.p.acc.prog);
    bindTex(gl, 0, this.ink![0].tex, u('uDensity'));
    if (this.mask) bindTex(gl, 1, this.mask, u('uMask'));
    gl.uniform1i(u('uHasMask'), this.mask ? 1 : 0);
    const [r, g, b] = inkLinear(ink.color, ink.saturation);
    gl.uniform3f(u('uInkColor'), r, g, b);
    gl.uniform1f(u('uOpacity'), ink.opacity);
    gl.uniform1f(u('uScatter'), scatter);
    gl.enable(gl.BLEND);
    // Transmittances multiply: dst · src.
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.uniform1i(u('uTarget'), 0);
    drawFullscreen(gl, this.trans);
    // Sticker composite: premultiplied "over".
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(u('uTarget'), 1);
    drawFullscreen(gl, this.stick);
    gl.disable(gl.BLEND);
  }

  private renderInk(source: InkSource, ink: InkParams) {
    const gl = this.gl;
    this.clear(this.trans!, 1, 1, 1, 1);
    this.clear(this.stick!, 0, 0, 0, 0);
    if (source.kind === 'shape') {
      if (this.drawDensity({ shape: source.shape }, ink.blur)) this.accumulate(ink, ink.scatter);
    } else {
      for (const l of source.layers) {
        const gpu = this.layers.get(l.id);
        if (gpu && this.drawDensity({ layer: gpu }, ink.blur)) this.accumulate(l.ink, ink.scatter);
      }
    }
    for (const t of [this.trans!, this.stick!]) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  /**
   * Image px → canvas px. zoom 1 = fit (contain); above 1 the view centres on `focus`
   * (image px), so edges can be judged at 1:1 or closer.
   */
  view(cssW: number, cssH: number, zoom = 1, focus?: { x: number; y: number }) {
    const fit = Math.min(cssW / this.imgW, cssH / this.imgH);
    const scale = fit * zoom;
    if (zoom <= 1 || !focus) return { scale, ox: (cssW - this.imgW * scale) / 2, oy: (cssH - this.imgH * scale) / 2 };
    return { scale, ox: cssW / 2 - focus.x * scale, oy: cssH / 2 - focus.y * scale };
  }

  render(opts: {
    source: InkSource; ink: InkParams; mode: BlendMode; debug: DebugView; cssW: number; cssH: number;
    zoom?: number; focus?: { x: number; y: number };
  }) {
    if (!this.photo) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(opts.cssW * dpr), ch = Math.round(opts.cssH * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.drawComposite(opts, cw, ch, this.view(cw, ch, opts.zoom, opts.focus));
  }

  /**
   * The composite at full working resolution as a PNG. Renders into the same canvas at image
   * size (scale 1, so grain is at full strength), reads it out, then restores the canvas size;
   * the caller's next render() repaints the view.
   */
  async exportPng(opts: { source: InkSource; ink: InkParams; mode: BlendMode }): Promise<Blob> {
    if (!this.photo) throw new Error('No photo loaded');
    const { width: prevW, height: prevH } = this.canvas;
    this.canvas.width = this.imgW;
    this.canvas.height = this.imgH;
    this.drawComposite({ ...opts, debug: 'composite' }, this.imgW, this.imgH, { scale: 1, ox: 0, oy: 0 });
    try {
      return await new Promise<Blob>((resolve, reject) =>
        this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), 'image/png'));
    } finally {
      this.canvas.width = prevW;
      this.canvas.height = prevH;
      this.inkDirty = true;
    }
  }

  private drawComposite(
    opts: { source: InkSource; ink: InkParams; mode: BlendMode; debug: DebugView },
    cw: number, ch: number, v: { scale: number; ox: number; oy: number },
  ) {
    const gl = this.gl;
    if (this.inkDirty) {
      this.renderInk(opts.source, opts.ink);
      this.inkDirty = false;
    }
    const u = this.p.comp.u;
    gl.useProgram(this.p.comp.prog);
    bindTex(gl, 0, this.photo!, u('uPhoto'));
    bindTex(gl, 1, this.base![0].tex, u('uBase'));
    bindTex(gl, 2, this.trans!.tex, u('uTrans'));
    bindTex(gl, 3, this.stick!.tex, u('uStick'));
    gl.uniform2f(u('uImageSize'), this.imgW, this.imgH);
    gl.uniform2f(u('uCanvasSize'), cw, ch);
    gl.uniform3f(u('uView'), v.scale, v.ox, v.oy);
    gl.uniform1f(u('uSpecPass'), opts.ink.specPass);
    gl.uniform1f(u('uSpecFloor'), opts.ink.specFloor);
    gl.uniform1f(u('uGrain'), opts.ink.grain);
    // Noise was measured per image pixel. A downscaled view averages ~1/scale² image pixels into
    // each screen pixel, so the photo's visible noise (and the grain that must match it) shrinks
    // by the scale. Export renders at scale 1 and gets the full amount.
    gl.uniform1f(u('uNoiseSigma'), this.noiseSigma * Math.min(1, v.scale));
    gl.uniform1i(u('uMode'), MODE[opts.mode]);
    gl.uniform1i(u('uDebug'), DEBUG[opts.debug]);
    drawFullscreen(gl, null, cw, ch);
  }

  /** Photo-bound resources. Layers (designs, meshes) are kept: they don't depend on the photo. */
  private disposePhoto() {
    const gl = this.gl;
    if (this.photo) gl.deleteTexture(this.photo);
    this.photo = null;
    this.base?.forEach((t) => deleteTarget(gl, t));
    this.ink?.forEach((t) => deleteTarget(gl, t));
    deleteTarget(gl, this.trans);
    deleteTarget(gl, this.stick);
    if (this.mask) gl.deleteTexture(this.mask);
    this.mask = null;
    this.base = this.ink = null;
    this.trans = this.stick = null;
  }

  /**
   * Frees GPU resources. Does NOT lose the context: a canvas has exactly one WebGL context
   * for its lifetime, and React StrictMode remounts against the same canvas.
   */
  dispose() {
    this.disposePhoto();
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
  }
}

/** sRGB hex → linear RGB, with saturation applied around linear luminance. */
export function inkLinear(hex: string, saturation: number): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lin.map((c) => Math.max(0, y + (c - y) * saturation)) as [number, number, number];
}

function r8Texture(gl: WebGL2RenderingContext, data: Uint8Array, w: number, h: number, mipmaps: boolean): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

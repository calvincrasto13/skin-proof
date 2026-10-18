/** Thin WebGL2 helpers. Deliberately small: the pipeline is a handful of fullscreen passes. */

export type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    premultipliedAlpha: false,
    // Export reads the canvas back; without this the drawing buffer may already be cleared.
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL2 is not available');
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed:\n${log}`);
  }
  return sh;
}

export type Program = {
  prog: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
};

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Link failed:\n${gl.getProgramInfoLog(prog)}`);
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    prog,
    u: (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
      return cache.get(name)!;
    },
  };
}

export type TexFormat = { internal: number; format: number; type: number };

export const formats = (gl: WebGL2RenderingContext, floatOk: boolean) => ({
  r8: { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE },
  rgba16f: floatOk
    ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
    : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
});

export function target(gl: WebGL2RenderingContext, w: number, h: number, f: TexFormat, mipmaps = false): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, f.type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
  return { tex, fbo, w, h };
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target | null) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/**
 * Photo as SRGB8_ALPHA8: the sampler returns linear values for free, and there is no
 * float copy of a multi-megapixel image. Mipmapped for the downscaled on-screen view.
 */
export function photoTexture(gl: WebGL2RenderingContext, image: TexImageSource): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // row 0 = top of image, matching image-space FBOs
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export function bindTex(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}

/** Fullscreen triangle; the vertex shader derives positions from gl_VertexID, so no buffers. */
export function drawFullscreen(gl: WebGL2RenderingContext, into: Target | null, canvasW = 0, canvasH = 0) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
  gl.viewport(0, 0, into ? into.w : canvasW, into ? into.h : canvasH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

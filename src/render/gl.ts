// Thin WebGL2 helpers: programs, render targets, a fullscreen triangle.

export interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation>;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`${name}: ${log}`);
  }
  return s;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string, name: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs, `${name} (vertex)`));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs, `${name} (fragment)`));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`${name}: ${gl.getProgramInfoLog(prog)}`);
  }
  const u: Record<string, WebGLUniformLocation> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const key = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(prog, info.name);
    if (loc) u[key] = loc;
  }
  return { prog, u };
}

export interface Format {
  internal: number;
  format: number;
  type: number;
  float: boolean;
}

export interface Formats {
  color: Format; // the scene and its blur and bloom levels
  data: Format; // the pheromone field
  float: boolean;
}

// Half-float targets where the device can render to them. Otherwise 8-bit: perceptual (sRGB) for colour,
// so the dark medium does not band, and plain for the field, which holds amounts rather than colours.
// ?basic-gl forces the 8-bit path, to test it.
export function formats(gl: WebGL2RenderingContext, basic = false): Formats {
  const ok = !basic && gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_float_blend');
  if (ok) {
    const half: Format = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, float: true };
    return { color: half, data: half, float: true };
  }
  return {
    color: { internal: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, float: false },
    data: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, float: false },
    float: false,
  };
}

export class Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w = 0;
  h = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    w: number,
    h: number,
    private fmt: Format,
    private filter: number = gl.LINEAR,
  ) {
    this.tex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, this.fmt.format, this.fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.w, this.h);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

// one triangle that covers the screen
export function fullscreen(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

// a unit quad (two triangles) with per-instance attributes laid out as consecutive vec4s
export function instanced(gl: WebGL2RenderingContext, vec4s: number, capacity: number): { vao: WebGLVertexArrayObject; buf: WebGLBuffer; data: Float32Array } {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const data = new Float32Array(capacity * vec4s * 4);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  for (let k = 0; k < vec4s; k++) {
    gl.enableVertexAttribArray(1 + k);
    gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, vec4s * 16, k * 16);
    gl.vertexAttribDivisor(1 + k, 1);
  }
  gl.bindVertexArray(null);
  return { vao, buf, data };
}

// Draws the world: the ground's chemistry, the focal plane, and the lens.
import { LINEAR } from '../palette';
import { BODY, Mode } from '../world/agents';
import type { Camera } from '../world/camera';
import { depthAlpha, depthCenter, type Colony, type Finding } from '../world/colony';
import { HISTORY_SAMPLES } from '../world/history';
import { formats, fullscreen, instanced, program, Target, type Formats, type Program } from './gl';
import * as S from './shaders';

export interface FrameState {
  colony: Colony;
  camera: Camera;
  time: number; // world time: stops when the world is frozen
  dt: number; // simulated seconds this frame, 0 while frozen
  exposure: number; // 0..1 how much of the long exposure shows
  live: number; // 0..1 how much of the live colony shows
  focus: { x: number; y: number; radius: number; amount: number }; // screen pixels
  defocus: number; // 1 while the opening focus pull starts, 0 once sharp
  hand: { x: number; y: number; reach: number; pressure: number }; // world units
  hoverFood: number;
  pulse: number; // 1 normally; 0 removes flicker for reduced motion
  reduced: boolean; // reduced motion: teams that agree share a steady halo instead of flickering in unison
}

const FIELD_WIDTH = [1.0, 2.4, 1, 11]; // half-widths of a deposit by channel, world px
const FIELD_GAIN = [1.8, 1, 2.2, 12];
const FIELD_HALF_LIFE = [90, 10, 3, 0.45];
const FIELD_DIFFUSION = [5, 4, 0.3, 10]; // px^2/s: the visible field stays crisper than the smelled one
const MAX_FOODS = 24;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  ok = false;
  error = '';
  private fmts!: Formats;
  private tri!: WebGLVertexArrayObject;
  private p!: Record<string, Program>;
  private fieldA!: Target;
  private fieldB!: Target;
  private scene!: Target;
  private down: Target[] = [];
  private up: Target[] = [];
  private agentsI!: ReturnType<typeof instanced>;
  private husksI!: ReturnType<typeof instanced>;
  private sparksI!: ReturnType<typeof instanced>;
  private trailsI!: ReturnType<typeof instanced>;
  private depositsI!: ReturnType<typeof instanced>;
  private quad!: WebGLVertexArrayObject;
  private trailCount = 0;
  private sprites = new Map<Finding, { tex: WebGLTexture; w: number; h: number }>();
  private capacity = 1600;
  private viewW = 1;
  private viewH = 1;
  private scale = 1;
  private worldW = 1;
  private worldH = 1;
  // 8-bit targets clip at 1, so the field is stored at a quarter strength there and read back up
  private store = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) {
      this.gl = null as unknown as WebGL2RenderingContext;
      this.error = 'This browser cannot draw the colony: WebGL2 is turned off or unsupported.';
      return;
    }
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.ok = false;
    });
    this.init();
  }

  private init(): void {
    const gl = this.gl;
    try {
      this.fmts = formats(gl, new URLSearchParams(location.search).has('basic-gl'));
      this.store = this.fmts.float ? 1 : 0.25;
      this.tri = fullscreen(gl);
      const P = (vs: string, fs: string, name: string) => program(gl, vs, fs, name);
      this.p = {
        fieldStep: P(S.FULLSCREEN_VS, S.FIELD_STEP_FS, 'field step'),
        copy: P(S.FULLSCREEN_VS, S.COPY_FS, 'copy'),
        deposit: P(S.DEPOSIT_VS, S.DEPOSIT_FS, 'deposit'),
        substrate: P(S.FULLSCREEN_VS, S.SUBSTRATE_FS, 'substrate'),
        food: P(S.FOOD_VS, S.FOOD_FS, 'food'),
        agent: P(S.AGENT_VS, S.AGENT_FS, 'agent'),
        husk: P(S.AGENT_VS, S.HUSK_FS, 'husk'),
        spark: P(S.SPARK_VS, S.SPARK_FS, 'spark'),
        trail: P(S.TRAIL_VS, S.TRAIL_FS, 'trail'),
        sprite: P(S.SPRITE_VS, S.SPRITE_FS, 'sprite'),
        down: P(S.FULLSCREEN_VS, S.DOWN_FS, 'downsample'),
        up: P(S.FULLSCREEN_VS, S.UP_FS, 'upsample'),
        composite: P(S.FULLSCREEN_VS, S.COMPOSITE_FS, 'composite'),
      };
      this.fieldA = new Target(gl, 2, 2, this.fmts.data);
      this.fieldB = new Target(gl, 2, 2, this.fmts.data);
      this.scene = new Target(gl, 2, 2, this.fmts.color);
      this.down = [0, 1, 2, 3, 4].map(() => new Target(gl, 2, 2, this.fmts.color));
      this.up = [0, 1, 2, 3].map(() => new Target(gl, 2, 2, this.fmts.color));
      this.agentsI = instanced(gl, 3, this.capacity);
      this.husksI = instanced(gl, 3, 160);
      this.sparksI = instanced(gl, 2, 128);
      this.trailsI = instanced(gl, 2, this.capacity * HISTORY_SAMPLES);
      this.depositsI = instanced(gl, 2, 16384);
      this.quad = instanced(gl, 1, 1).vao;
      this.sprites.clear();
      this.trailCount = 0;
      this.ok = true;
      this.error = '';
      if (this.viewW > 1) this.resize(this.viewW, this.viewH, this.scale, this.worldW, this.worldH, true);
    } catch (err) {
      this.ok = false;
      this.error = err instanceof Error ? err.message : String(err);
      console.error(err);
    }
  }

  // called after the browser gives a lost context back
  restore(colony: Colony): void {
    this.init();
    if (this.ok) this.seedField(colony);
  }

  resize(viewW: number, viewH: number, scale: number, worldW: number, worldH: number, force = false): void {
    if (!this.ok) {
      // a lost display takes these sizes up when it comes back
      this.viewW = viewW;
      this.viewH = viewH;
      this.scale = scale;
      this.worldW = worldW;
      this.worldH = worldH;
      return;
    }
    const changedWorld = worldW !== this.worldW || worldH !== this.worldH;
    this.viewW = viewW;
    this.viewH = viewH;
    this.scale = scale;
    this.worldW = worldW;
    this.worldH = worldH;
    this.canvas.width = Math.max(1, Math.round(viewW * scale));
    this.canvas.height = Math.max(1, Math.round(viewH * scale));
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    this.scene.resize(sw, sh);
    this.down.forEach((t, i) => t.resize(sw / 2 ** (i + 1), sh / 2 ** (i + 1)));
    this.up.forEach((t, i) => t.resize(sw / 2 ** (i + 1), sh / 2 ** (i + 1)));
    if (changedWorld || force) {
      // keep the veins: stretch the old field into the new size
      const k = Math.min(1, 2048 / Math.max(worldW, worldH));
      const fw = Math.round(worldW * k);
      const fh = Math.round(worldH * k);
      if (fw !== this.fieldA.w || fh !== this.fieldA.h) {
        const old = this.fieldA;
        const next = new Target(this.gl, fw, fh, this.fmts.data);
        if (old.w > 2) this.blit(old, next, 1);
        else this.clear(next);
        old.dispose();
        this.fieldA = next;
        this.fieldB.resize(fw, fh);
      }
    }
  }

  private clear(t: Target): void {
    const gl = this.gl;
    t.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private blit(src: Target | WebGLTexture, dst: Target, gain: number): void {
    const gl = this.gl;
    dst.bind();
    gl.disable(gl.BLEND);
    gl.useProgram(this.p.copy.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src instanceof Target ? src.tex : src);
    gl.uniform1i(this.p.copy.u.u_src, 0);
    gl.uniform1f(this.p.copy.u.u_gain, gain);
    this.drawTri();
  }

  private drawTri(): void {
    this.gl.bindVertexArray(this.tri);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  // start the visible veins from what the colony can smell, so nothing is lost with the context
  seedField(colony: Colony): void {
    if (!this.ok) return;
    const gl = this.gl;
    const F = colony.field;
    const data = new Float32Array(F.cols * F.rows * 4);
    // a coarse cell holds the amount a fine texel line would spread over a few texels
    const k = 0.06 * this.store;
    for (let i = 0; i < F.cols * F.rows; i++) {
      data[i * 4] = F.data[0][i] * k;
      data[i * 4 + 1] = F.data[1][i] * k;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.fmts.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, F.cols, F.rows, 0, gl.RGBA, gl.FLOAT, data);
    else {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = Math.min(255, data[i] * 255);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, F.cols, F.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.blit(tex, this.fieldA, 1);
    gl.deleteTexture(tex);
  }

  // diffuse and decay the visible field, then lay this frame's deposits into it
  stepField(colony: Colony, dt: number): void {
    if (!this.ok) {
      colony.deposits.n = 0;
      return;
    }
    const gl = this.gl;
    if (dt > 0) {
      const fw = this.fieldA.w;
      const texel = this.worldW / fw;
      const k = FIELD_DIFFUSION.map(d => (d * dt) / (texel * texel));
      const passes = Math.max(1, Math.ceil(Math.max(...k) / 0.22));
      gl.disable(gl.BLEND);
      gl.useProgram(this.p.fieldStep.prog);
      const u = this.p.fieldStep.u;
      gl.uniform2f(u.u_texel, 1 / fw, 1 / this.fieldA.h);
      gl.uniform4f(u.u_k, k[0] / passes, k[1] / passes, k[2] / passes, k[3] / passes);
      const decay = FIELD_HALF_LIFE.map(h => Math.pow(0.5, dt / passes / h));
      gl.uniform4f(u.u_decay, decay[0], decay[1], decay[2], decay[3]);
      gl.uniform1f(u.u_dither, this.fmts.float ? 0 : 1 / 255);
      gl.uniform1i(u.u_src, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (let i = 0; i < passes; i++) {
        gl.uniform1f(u.u_seed, Math.random() * 1024);
        this.fieldB.bind();
        gl.bindTexture(gl.TEXTURE_2D, this.fieldA.tex);
        this.drawTri();
        [this.fieldA, this.fieldB] = [this.fieldB, this.fieldA];
      }
    }
    const D = colony.deposits;
    if (D.n > 0) {
      const inst = this.depositsI;
      const src = D.data;
      const out = inst.data;
      for (let i = 0; i < D.n; i++) {
        const a = i * 6;
        const b = i * 8;
        out[b] = src[a];
        out[b + 1] = src[a + 1];
        out[b + 2] = src[a + 2];
        out[b + 3] = src[a + 3];
        out[b + 4] = src[a + 4];
        out[b + 5] = src[a + 5];
      }
      this.fieldA.bind();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.p.deposit.prog);
      const u = this.p.deposit.u;
      gl.uniform2f(u.u_world, this.worldW, this.worldH);
      gl.uniform4f(u.u_width, FIELD_WIDTH[0], FIELD_WIDTH[1], FIELD_WIDTH[2], FIELD_WIDTH[3]);
      const g = FIELD_GAIN.map(v => v * this.store);
      gl.uniform4f(u.u_gain, g[0], g[1], g[2], g[3]);
      gl.bindVertexArray(inst.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, D.n * 8);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, D.n);
      gl.disable(gl.BLEND);
    }
    D.n = 0;
  }

  // freeze the last six seconds of every path into one long exposure
  buildExposure(colony: Colony): void {
    if (!this.ok) return;
    const H = colony.history;
    const A = colony.agents;
    const out = this.trailsI.data;
    let n = 0;
    const filled = H.filled;
    for (let s = 0; s < A.count; s++) {
      const base = s * HISTORY_SAMPLES;
      for (let j = 0; j < filled - 1; j++) {
        const k0 = (H.head - filled + j + HISTORY_SAMPLES) % HISTORY_SAMPLES;
        const k1 = (k0 + 1) % HISTORY_SAMPLES;
        if (!H.valid[base + k0] || !H.valid[base + k1]) continue;
        const x0 = H.x[base + k0];
        const y0 = H.y[base + k0];
        const x1 = H.x[base + k1];
        const y1 = H.y[base + k1];
        if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 120) continue;
        const o = n++ * 8;
        out[o] = x0;
        out[o + 1] = y0;
        out[o + 2] = x1;
        out[o + 3] = y1;
        out[o + 4] = H.glow[base + k1] / 200;
        out[o + 5] = 0.3 + 0.7 * (j / filled);
        out[o + 6] = H.ember[base + k1] / 255;
        out[o + 7] = 0;
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailsI.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * 8);
    this.trailCount = n;
  }

  private sprite(f: Finding): { tex: WebGLTexture; w: number; h: number } {
    const have = this.sprites.get(f);
    if (have) return have;
    const gl = this.gl;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const italic = '400 italic 15px "Instrument Sans Variable", system-ui, sans-serif';
    const roman = '400 15px "Instrument Sans Variable", system-ui, sans-serif';
    ctx.font = italic;
    const a = ctx.measureText(f.text).width;
    ctx.font = roman;
    const b = ctx.measureText(f.finding).width;
    const pad = 14;
    c.width = Math.ceil(Math.min(560, Math.max(a, b)) + pad * 2);
    c.height = 64;
    ctx.filter = 'blur(4.5px)';
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.font = italic;
    ctx.fillText(f.text, pad, 22, c.width - pad * 2);
    ctx.font = roman;
    ctx.fillText(f.finding, pad, 42, c.width - pad * 2);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const s = { tex, w: c.width, h: c.height };
    this.sprites.set(f, s);
    return s;
  }

  render(F: FrameState): void {
    if (!this.ok || this.gl.isContextLost()) return;
    const gl = this.gl;
    const C = F.colony;
    const cam = F.camera;
    const L = LINEAR;
    this.stepField(C, F.dt);

    // ---------- scene ----------
    this.scene.bind();
    gl.clearColor(L.abyss[0], L.abyss[1], L.abyss[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const camera = (u: Record<string, WebGLUniformLocation>) => {
      gl.uniform4f(u.u_cam, cam.cx, cam.cy, cam.zoom, F.time);
      gl.uniform2f(u.u_view, this.viewW, this.viewH);
    };

    // substrate
    {
      const { prog, u } = this.p.substrate;
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      camera(u);
      gl.uniform2f(u.u_world, this.worldW, this.worldH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fieldA.tex);
      gl.uniform1i(u.u_field, 0);
      gl.uniform3fv(u.u_abyss, L.abyss);
      gl.uniform3fv(u.u_silt, L.silt);
      gl.uniform3fv(u.u_luc, L.luciferin);
      gl.uniform3fv(u.u_bloom, L.bloom);
      gl.uniform3fv(u.u_ember, L.ember);
      gl.uniform3fv(u.u_bone, L.bone);
      gl.uniform4f(u.u_nest, C.nest.x, C.nest.y, C.nest.r, C.nest.pulse);
      gl.uniform4f(u.u_midden, C.midden.x, C.midden.y, C.midden.husks.length ? C.midden.r : 0, 0);
      gl.uniform4f(u.u_hand, F.hand.x, F.hand.y, F.hand.reach, F.hand.pressure);
      gl.uniform1f(u.u_veinGain, 1.1);
      gl.uniform1f(u.u_fieldScale, 1 / this.store);
      const fa = new Float32Array(MAX_FOODS * 4);
      const fb = new Float32Array(MAX_FOODS * 4);
      const fc = new Float32Array(MAX_FOODS * 4);
      let n = 0;
      for (const f of C.foods) {
        if (n >= MAX_FOODS || f.status === 'completed' || f.sink > 0.98) continue;
        fa.set([f.x, f.y, Math.max(f.r, 8), f.plume], n * 4);
        fb.set([f.enriching, f.appear, f.sink, 0], n * 4);
        if (F.reduced) {
          const spread = 10 + Math.sqrt(Math.max(1, f.workers)) * 5.5;
          fc.set([Math.min(1, Math.max(0, (f.lock - 0.85) / 0.1)), f.r + 8 + 0.6 * spread, 0, 0], n * 4);
        }
        n++;
      }
      gl.uniform1i(u.u_foods, n);
      gl.uniform4fv(u.u_food, fa);
      gl.uniform4fv(u.u_foodB, fb);
      gl.uniform4fv(u.u_foodC, fc);
      this.drawTri();
    }

    gl.enable(gl.BLEND);

    // depth layer: findings that have sunk, as out-of-focus light
    {
      const { prog, u } = this.p.sprite;
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(prog);
      camera(u);
      gl.uniform3fv(u.u_tint, L.luciferin);
      gl.uniform1i(u.u_tex, 0);
      gl.bindVertexArray(this.quad);
      for (const f of C.findings) {
        const alpha = depthAlpha(f, C.time);
        if (alpha <= 0.004) {
          // out of view for good, pushed out by newer ones or faded with age: give its type back to the GPU
          const old = f.deep >= 1 || (f.deep > 0 && !f.shown && f.vis === 0) ? this.sprites.get(f) : undefined;
          if (old) {
            gl.deleteTexture(old.tex);
            this.sprites.delete(f);
          }
          continue;
        }
        const s = this.sprite(f);
        f.w = s.w * 1.25;
        f.h = s.h * 1.25;
        const [cx, cy] = depthCenter(f);
        gl.uniform4f(u.u_rect, cx, cy, f.w, f.h);
        gl.uniform1f(u.u_alpha, 0.16 * alpha);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // food
    {
      const { prog, u } = this.p.food;
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(prog);
      camera(u);
      gl.uniform3fv(u.u_luc, L.luciferin);
      gl.uniform3fv(u.u_bloom, L.bloom);
      gl.bindVertexArray(this.quad);
      const bites = new Float32Array(32);
      for (const f of C.foods) {
        if (f.r <= 0.5) continue;
        bites.fill(0);
        f.bites.forEach((b, i) => {
          bites[i * 4] = b.angle;
          bites[i * 4 + 1] = b.depth;
        });
        gl.uniform4f(u.u_f, f.x, f.y + f.sink * 8, f.r, f.plume);
        gl.uniform4f(u.u_motion, f.vx, f.vy, 0, 0);
        gl.uniform4f(u.u_g, f.enriching, f.status === 'completed' ? 1 : f.appear, f.sink, f.seed);
        gl.uniform4f(u.u_h, F.hoverFood === f.index ? 1 : 0, 0, 0, 0);
        gl.uniform4fv(u.u_bites, bites);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // husks in the midden
    {
      const M = C.midden.husks;
      const out = this.husksI.data;
      let n = 0;
      for (const k of M) {
        const o = n++ * 12;
        out[o] = k.x;
        out[o + 1] = k.y;
        out[o + 2] = k.angle;
        out[o + 3] = 0;
        out[o + 4] = BODY[k.role] * 1.05;
        out[o + 5] = 1;
        out[o + 6] = 0;
        out[o + 7] = 0;
        out[o + 8] = 0;
        out[o + 9] = k.role;
        out[o + 10] = 0.5;
        out[o + 11] = 0;
      }
      if (n) {
        const { prog, u } = this.p.husk;
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(prog);
        camera(u);
        gl.uniform3fv(u.u_abyss, L.abyss);
        gl.uniform3fv(u.u_silt, L.silt);
        gl.bindVertexArray(this.husksI.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.husksI.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * 12);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      }
    }

    // agents
    if (F.live > 0.001) {
      const A = C.agents;
      const out = this.agentsI.data;
      let n = 0;
      for (let s = 0; s < A.count; s++) {
        if (!A.alive[s]) continue;
        const o = n++ * 12;
        const role = A.role[s];
        out[o] = A.x[s];
        out[o + 1] = A.y[s];
        out[o + 2] = A.heading[s];
        out[o + 3] = A.mode[s] === Mode.Bud ? 0 : Math.hypot(A.vx[s], A.vy[s]);
        out[o + 4] = BODY[role] * A.scale[s] * (0.9 + 0.2 * A.seed[s]);
        out[o + 5] = A.glow[s] * F.live;
        out[o + 6] = A.flash[s] * F.live;
        out[o + 7] = A.ember[s];
        out[o + 8] = A.phase[s];
        out[o + 9] = role;
        out[o + 10] = A.seed[s];
        out[o + 11] = A.attn[s];
      }
      if (n) {
        const { prog, u } = this.p.agent;
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(prog);
        camera(u);
        gl.uniform3fv(u.u_luc, L.luciferin);
        gl.uniform3fv(u.u_bloom, L.bloom);
        gl.uniform3fv(u.u_ember, L.ember);
        gl.uniform1f(u.u_pulse, F.pulse);
        gl.bindVertexArray(this.agentsI.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.agentsI.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * 12);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      }
    }

    // sparks
    if (C.sparks.length && F.live > 0.001) {
      const out = this.sparksI.data;
      let n = 0;
      for (const k of C.sparks) {
        if (n >= 128) break;
        const o = n++ * 8;
        out[o] = k.x;
        out[o + 1] = k.y;
        out[o + 2] = k.px;
        out[o + 3] = k.py;
        out[o + 4] = F.live;
        out[o + 5] = 0;
        out[o + 6] = 0;
        out[o + 7] = 0;
      }
      const { prog, u } = this.p.spark;
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(prog);
      camera(u);
      gl.uniform3fv(u.u_luc, L.luciferin);
      gl.uniform3fv(u.u_bloom, L.bloom);
      gl.bindVertexArray(this.sparksI.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparksI.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * 8);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    }

    // long exposure
    if (F.exposure > 0.001 && this.trailCount) {
      const { prog, u } = this.p.trail;
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(prog);
      camera(u);
      gl.uniform3fv(u.u_luc, L.luciferin);
      gl.uniform3fv(u.u_bloom, L.bloom);
      gl.uniform3fv(u.u_ember, L.ember);
      gl.uniform1f(u.u_amount, F.exposure * 0.55);
      gl.bindVertexArray(this.trailsI.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.trailCount);
    }
    gl.disable(gl.BLEND);

    // ---------- lens ----------
    {
      const { prog, u } = this.p.down;
      gl.useProgram(prog);
      gl.uniform1i(u.u_src, 0);
      gl.activeTexture(gl.TEXTURE0);
      let src = this.scene;
      for (const t of this.down) {
        t.bind();
        gl.uniform2f(u.u_texel, 1 / src.w, 1 / src.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        this.drawTri();
        src = t;
      }
    }
    {
      const { prog, u } = this.p.up;
      gl.useProgram(prog);
      gl.uniform1i(u.u_src, 0);
      gl.uniform1i(u.u_add, 1);
      gl.uniform1f(u.u_threshold, this.fmts.float ? 1.15 : 0.6);
      gl.uniform1f(u.u_carry, 0.55);
      gl.uniform1f(u.u_knee, 0.4);
      let src = this.down[4];
      for (let i = 3; i >= 0; i--) {
        const t = this.up[i];
        t.bind();
        gl.uniform2f(u.u_texel, 1 / src.w, 1 / src.h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.down[i].tex);
        this.drawTri();
        src = t;
      }
    }
    {
      const { prog, u } = this.p.composite;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(prog);
      camera(u);
      gl.uniform2f(u.u_world, this.worldW, this.worldH);
      const tex = [this.scene, this.down[1], this.down[2], this.up[0], this.fieldA];
      const names = ['u_scene', 'u_blur1', 'u_blur2', 'u_bloomTex', 'u_field'];
      tex.forEach((t, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.uniform1i(u[names[i]], i);
      });
      gl.uniform4f(u.u_focus, F.focus.x, F.focus.y, F.focus.radius, F.focus.amount);
      gl.uniform1f(u.u_defocus, F.defocus);
      gl.uniform1f(u.u_bloomGain, 0.75);
      gl.uniform1f(u.u_exposure, 1);
      gl.uniform3fv(u.u_bloomCol, L.bloom);
      gl.uniform1f(u.u_freeze, F.exposure);
      gl.uniform1f(u.u_fieldScale, 1 / this.store);
      this.drawTri();
      gl.activeTexture(gl.TEXTURE0);
    }
  }
}

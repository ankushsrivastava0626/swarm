// GLSL for every pass. World units are CSS pixels of the unmagnified view; u_cam = (cx, cy, zoom, time).

const HEAD = `#version 300 es
precision highp float;
`;

const CAMERA = `
uniform vec4 u_cam;
uniform vec2 u_view;
vec4 toClip(vec2 world) {
  vec2 sp = (world - u_cam.xy) * u_cam.z + u_view * 0.5;
  return vec4(sp.x / u_view.x * 2.0 - 1.0, 1.0 - sp.y / u_view.y * 2.0, 0.0, 1.0);
}
`;

const NOISE = `
float sq(float x) { return x * x; }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
`;

export const FULLSCREEN_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// ---------- the ground's chemistry ----------

// one step of diffusion and decay; edges reflect because sampling clamps
export const FIELD_STEP_FS = `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec4 u_k;
uniform vec4 u_decay;
uniform float u_dither;
uniform float u_seed;
in vec2 v_uv;
out vec4 o;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 c = texture(u_src, v_uv);
  vec4 l = texture(u_src, v_uv - vec2(u_texel.x, 0.0));
  vec4 r = texture(u_src, v_uv + vec2(u_texel.x, 0.0));
  vec4 d = texture(u_src, v_uv - vec2(0.0, u_texel.y));
  vec4 u = texture(u_src, v_uv + vec2(0.0, u_texel.y));
  o = max(c + u_k * (l + r + d + u - 4.0 * c), 0.0) * u_decay;
  // 8-bit storage would round a slow fade away; dithered rounding keeps it right on average
  o = max(o + (hash12(gl_FragCoord.xy + u_seed) - 0.5) * u_dither, 0.0);
}
`;

export const COPY_FS = `${HEAD}
uniform sampler2D u_src;
uniform float u_gain;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_src, v_uv) * u_gain; }
`;

// pheromone laid along a segment, a soft line with the given total amount
export const DEPOSIT_VS = `${HEAD}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_seg;
layout(location = 2) in vec4 a_val;
uniform vec2 u_world;
uniform vec4 u_width;
uniform vec4 u_gain;
out vec2 v_local;
out float v_len;
out float v_hw;
flat out vec4 v_val;
void main() {
  vec2 a = a_seg.xy;
  vec2 b = a_seg.zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  int ch = int(a_val.x + 0.5);
  float hw = u_width[ch];
  float ext = hw * 2.6;
  vec2 p = mix(a, b, a_corner.x * 0.5 + 0.5) + dir * a_corner.x * ext + nrm * a_corner.y * ext;
  v_local = vec2(dot(p - a, dir), dot(p - a, nrm));
  v_len = len;
  v_hw = hw;
  // colony deposits write memory (r) and fresh traffic (b) at once
  vec4 mask = ch == 0 ? vec4(u_gain.x, 0.0, u_gain.z, 0.0)
            : ch == 1 ? vec4(0.0, u_gain.y, 0.0, 0.0)
            : ch == 3 ? vec4(0.0, 0.0, 0.0, u_gain.w)
            : vec4(0.0, 0.0, u_gain.z, 0.0);
  v_val = mask * a_val.y / max(len + hw * 1.77, 1.0);
  vec2 uv = p / u_world;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const DEPOSIT_FS = `${HEAD}
in vec2 v_local;
in float v_len;
in float v_hw;
flat in vec4 v_val;
out vec4 o;
void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  vec2 q = vec2(v_local.x - t, v_local.y);
  o = v_val * exp(-dot(q, q) / (v_hw * v_hw));
}
`;

// ---------- the substrate: medium, veins, scent, plumes, heat ----------

export const SUBSTRATE_FS = `${HEAD}
${NOISE}
uniform sampler2D u_field;
uniform vec4 u_cam;
uniform vec2 u_view;
uniform vec2 u_world;
uniform vec3 u_abyss;
uniform vec3 u_silt;
uniform vec3 u_luc;
uniform vec3 u_bloom;
uniform vec3 u_ember;
uniform vec3 u_bone;
uniform vec4 u_nest;
uniform vec4 u_midden;
uniform vec4 u_hand;
uniform int u_foods;
uniform vec4 u_food[24];
uniform vec4 u_foodB[24];
uniform vec4 u_foodC[24];
uniform float u_veinGain;
uniform float u_fieldScale;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 sp = vec2(v_uv.x, 1.0 - v_uv.y) * u_view;
  vec2 w = u_cam.xy + (sp - u_view * 0.5) / u_cam.z;
  float t = u_cam.w;
  vec4 f = texture(u_field, w / u_world) * u_fieldScale;

  // the medium: barely-there density drifting past, so the dark reads as water, not void
  vec3 col = u_abyss;
  float m = vnoise(w * 0.0045 + vec2(t * 0.012, t * 0.007)) * vnoise(w * 0.013 - vec2(t * 0.009, -t * 0.011));
  col += u_silt * m * 0.32;

  // the nest: a faint well of light, brighter when a carrier comes home
  float dn = length(w - u_nest.xy);
  col += mix(u_silt, u_luc, 0.2) * (0.07 + 0.4 * u_nest.w) * exp(-sq(dn / (u_nest.z * 1.3)));

  // the midden: a lighter haze so dark husks read as silhouettes
  float dm = length((w - u_midden.xy) * vec2(0.62, 1.0));
  col = mix(col, u_silt * 1.35, 0.55 * exp(-sq(dm / (u_midden.z * 1.15 + 16.0))));

  // scent plumes around food: wider when enriched, rippling outward while pressed
  float plume = 0.0;
  float halo = 0.0;
  for (int i = 0; i < 24; i++) {
    if (i >= u_foods) break;
    vec4 F = u_food[i];
    vec4 G = u_foodB[i];
    float R = F.z * (2.0 + 2.6 * F.w);
    float d = length(w - F.xy);
    float alive = G.y * (1.0 - G.z);
    plume += (0.4 + 0.6 * F.w) * exp(-d * d / (R * R)) * alive;
    float ring = fract(t * 0.55 + float(i) * 0.37);
    float rr = R * (0.5 + 1.6 * ring);
    plume += G.x * 0.9 * (1.0 - ring) * exp(-sq((d - rr) / (F.z * 0.45))) * alive;
    // reduced motion: a team that agrees shares one steady halo, in place of flickering in unison
    vec4 Hc = u_foodC[i];
    halo += Hc.x * exp(-sq((d - Hc.y) / max(Hc.y * 0.3, 6.0))) * alive;
  }
  col += u_luc * plume * 0.018;
  col += mix(u_luc, u_bloom, 0.3) * halo * 0.16;

  // veins: the colony's shared memory, silt when old and faint, luciferin when used, bloom when busy
  // brightness follows the log of traffic: faint memory stays visible, crossroads never blow out
  // memory: everything the colony carried in the last minutes, a dim sheath that withers slowly
  float c = f.r * u_veinGain;
  float L = log2(1.0 + c / 0.05) / log2(61.0);
  col += u_silt * 2.4 * smoothstep(0.14, 0.55, L) * 0.38;
  col += u_luc * smoothstep(0.62, 1.0, L) * 0.1;
  // fresh traffic: what moved in the last seconds, crisp filaments inside the sheath
  float fresh = 1.0 - exp(-f.b * u_veinGain);
  float fibre = 0.85 + 0.15 * vnoise(w * 0.12 + vec2(0.0, t * 0.08));
  col += u_luc * fresh * 0.5 * fibre;
  col += u_bloom * smoothstep(0.55, 1.0, fresh) * 0.45;

  // heat: ember seeps into the middle of a boil, and only there
  float heat = 1.0 - exp(-f.a * 1.1);
  col += u_ember * heat * 0.26;

  // a person's scent: matte bone dust, painted on rather than lit
  float s = smoothstep(0.015, 0.45, f.g);
  float dust = 0.7 + 0.3 * hash12(floor(sp * 0.8));
  col = mix(col, u_bone * 0.4, s * 0.8 * dust);

  // the pressure of a fingertip, a soft shadow in the medium
  float dh = length(w - u_hand.xy);
  col *= 1.0 - 0.28 * u_hand.w * exp(-sq(dh / max(u_hand.z, 1.0)));

  o = vec4(col, 1.0);
}
`;

// ---------- the focal plane ----------

// a droplet of nectar: a meniscus rim, slow caustics inside, bites taken out of its edge
export const FOOD_VS = `${HEAD}
${CAMERA}
layout(location = 0) in vec2 a_corner;
uniform vec4 u_f;
uniform vec4 u_motion;
out vec2 v_p;
void main() {
  float ext = 3.4;
  vec2 local = a_corner * u_f.z * ext;
  // a fast droplet stretches along its motion
  vec2 vel = u_motion.xy;
  float sp = length(vel);
  float s = min(sp / 900.0, 0.35);
  vec2 dir = sp > 1.0 ? vel / sp : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 stretched = dir * dot(local, dir) * (1.0 + s) + nrm * dot(local, nrm) / (1.0 + s);
  v_p = a_corner * ext;
  gl_Position = toClip(u_f.xy + stretched);
}
`;

export const FOOD_FS = `${HEAD}
${NOISE}
uniform vec4 u_f;
uniform vec4 u_g;
uniform vec4 u_h;
uniform vec4 u_bites[8];
uniform vec3 u_luc;
uniform vec3 u_bloom;
uniform vec4 u_cam;
in vec2 v_p;
out vec4 o;
void main() {
  float t = u_cam.w;
  float seed = u_g.w;
  float appear = u_g.y;
  float sink = u_g.z;
  float hover = u_h.x;
  float enrich = u_g.x;
  vec2 p = v_p;
  float d = length(p);
  float a = atan(p.y, p.x);
  float wob = 0.035 * sin(a * 3.0 + t * 1.2 + seed * 6.3) + 0.022 * sin(a * 5.0 - t * 1.7 + seed * 2.1);
  float bite = 0.0;
  for (int i = 0; i < 8; i++) {
    float da = atan(sin(a - u_bites[i].x), cos(a - u_bites[i].x));
    bite += u_bites[i].y * 0.3 * exp(-da * da / 0.07);
  }
  float edge = 1.0 + wob - bite;
  float sd = d - edge;
  float soft = 0.03 + 0.5 * sink;
  float body = smoothstep(soft, -soft, sd);
  // inside: a lit liquid with slow swirling caustics
  vec2 q = p * 2.2 + vec2(seed * 9.0, 0.0);
  float caust = vnoise(q + vec2(t * 0.25, -t * 0.18)) * vnoise(q * 1.7 - vec2(t * 0.2, t * 0.12));
  float inner = 1.0 - clamp(d / max(edge, 0.01), 0.0, 1.0);
  float rim = exp(-sq(sd / (0.045 + 0.3 * sink)));
  float glint = exp(-dot(p - vec2(-0.35, -0.42), p - vec2(-0.35, -0.42)) * 22.0) * body;
  float halo = exp(-max(sd, 0.0) * (2.6 - 1.2 * enrich)) * (1.0 - body);
  float bright = (1.0 - 0.75 * sink) * (1.0 + 0.35 * hover + 0.5 * enrich * (0.6 + 0.4 * sin(t * 4.0)));
  vec3 col = u_luc * body * (0.04 + 0.1 * inner + 0.26 * caust);
  col += mix(u_luc, u_bloom, 0.6) * rim * 0.75;
  col += u_bloom * glint * 0.55;
  col += u_luc * halo * 0.06;
  // a drop landing: one ring spreads across the surface as it forms
  float ring = exp(-sq((d - (1.0 + appear * 2.2)) / 0.12)) * (1.0 - appear) * step(appear, 0.999);
  col += u_luc * ring * 0.9;
  o = vec4(col * bright * appear, body * 0.0);
}
`;

// agents: light with a body; size and silhouette by role, never colour
export const AGENT_VS = `${HEAD}
${CAMERA}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_i0;
layout(location = 2) in vec4 a_i1;
layout(location = 3) in vec4 a_i2;
out vec2 v_p;
flat out vec4 v_a;
flat out vec4 v_b;
void main() {
  float size = a_i1.x;
  float role = a_i2.y;
  float speed = a_i0.w;
  float elong = role < 0.5 ? 1.7 : role < 1.5 ? 1.12 : 1.35;
  float stretch = 1.0 + clamp((speed - 30.0) / 70.0, 0.0, 2.2) * (role < 0.5 ? 0.8 : role < 1.5 ? 0.35 : 0.55);
  float L = size * elong * stretch;
  float W = size / sqrt(stretch);
  float halo = size * 4.5 + 5.0;
  vec2 local = a_corner * vec2(L + halo, W + halo);
  float h = a_i0.z;
  vec2 dir = vec2(cos(h), sin(h));
  vec2 nrm = vec2(-dir.y, dir.x);
  gl_Position = toClip(a_i0.xy + dir * local.x + nrm * local.y);
  v_p = local / W;
  v_a = vec4(a_i1.y, a_i1.z, a_i1.w, pow(max(0.0, cos(a_i2.x)), 18.0));
  v_b = vec4(role, L / W, a_i2.z, a_i2.w);
}
`;

export const AGENT_FS = `${HEAD}
float sq(float x) { return x * x; }
uniform vec3 u_luc;
uniform vec3 u_bloom;
uniform vec3 u_ember;
uniform float u_pulse;
in vec2 v_p;
flat in vec4 v_a;
flat in vec4 v_b;
out vec4 o;
void main() {
  float role = v_b.x;
  float half_ = v_b.y;
  vec2 p = v_p;
  // distance to the body's spine, in half-widths: 0 on the spine, 1 at the skin
  float cd = length(vec2(max(abs(p.x) - (half_ - 1.0), 0.0), p.y));
  float aa = clamp(fwidth(cd) * 1.2, 0.04, 0.9);
  float skin = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, cd);
  float nucleus;
  if (role > 1.5) {
    // critic: two lights along the spine, like a pair of eyes
    float k = max(half_ - 1.0, 0.45) * 0.62;
    float d1 = length(vec2(p.x - k, p.y));
    float d2 = length(vec2(p.x + k, p.y));
    nucleus = max(exp(-d1 * d1 * 6.0), exp(-d2 * d2 * 6.0) * 0.9);
  } else if (role > 0.5) {
    // builder: a round cell with a bright nucleus
    nucleus = exp(-cd * cd * 4.5);
  } else {
    // scout: a needle with its light at the head
    float hd = length(vec2(p.x - (half_ - 1.0) * 0.75, p.y));
    nucleus = exp(-hd * hd * 3.5) * 0.85 + exp(-cd * cd * 6.0) * 0.4;
  }
  // a membrane: the skin catches more light than the body it holds
  float membrane = skin * exp(-sq((cd - 0.88) / 0.14));
  float body = skin * (0.16 + 0.34 * (1.0 - cd * cd)) + membrane * 0.55;
  float halo = exp(-max(cd - 1.0, 0.0) * 1.5) * (1.0 - skin) * 0.2 + exp(-cd * cd * 0.12) * 0.05;
  float glow = v_a.x;
  float flash = v_a.y;
  float ember = v_a.z;
  float flick = v_a.w * u_pulse;
  float bright = glow * (0.5 + 1.7 * flick) + flash * 1.1;
  vec3 bodyCol = mix(u_luc, u_ember, ember * 0.7);
  vec3 coreCol = mix(u_luc * 1.4, u_bloom * 1.8, clamp(bright * 0.6, 0.0, 1.0));
  coreCol = mix(coreCol, u_ember * 2.4, ember * 0.85);
  vec3 col = bodyCol * body * bright * 0.8 + coreCol * nucleus * bright * 1.7 + bodyCol * halo * bright;
  o = vec4(col, 0.0);
}
`;

// husks: what is left when an agent goes dark, a silhouette against the midden's haze
export const HUSK_FS = `${HEAD}
uniform vec3 u_abyss;
uniform vec3 u_silt;
in vec2 v_p;
flat in vec4 v_a;
flat in vec4 v_b;
out vec4 o;
void main() {
  float half_ = v_b.y;
  vec2 p = v_p;
  float cd = length(vec2(max(abs(p.x) - (half_ - 1.0), 0.0), p.y));
  float fill = smoothstep(1.08, 0.82, cd);
  float rim = smoothstep(0.7, 1.0, cd) * smoothstep(1.35, 1.0, cd);
  float a = fill * 0.92 * v_a.x;
  vec3 col = u_abyss * 0.45 * a + u_silt * 1.6 * rim * 0.55 * v_a.x;
  o = vec4(col, a);
}
`;

// sparks: context passing from one agent to another
export const SPARK_VS = `${HEAD}
${CAMERA}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_i0;
layout(location = 2) in vec4 a_i1;
out vec2 v_p;
flat out float v_len;
flat out float v_a;
void main() {
  vec2 cur = a_i0.xy;
  vec2 prev = a_i0.zw;
  vec2 d = cur - prev;
  float len = length(d);
  vec2 dir = len > 0.01 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = 1.6;
  float tail = min(len * 2.5, 18.0);
  float ext = r * 4.0;
  vec2 mid = cur - dir * tail * 0.5;
  vec2 local = vec2(a_corner.x * (tail * 0.5 + ext), a_corner.y * ext);
  gl_Position = toClip(mid + dir * local.x + nrm * local.y);
  v_p = vec2(local.x + tail * 0.5, local.y) / r;
  v_len = tail / r;
  v_a = a_i1.x;
}
`;

export const SPARK_FS = `${HEAD}
uniform vec3 u_luc;
uniform vec3 u_bloom;
in vec2 v_p;
flat in float v_len;
flat in float v_a;
out vec4 o;
void main() {
  // bright head at the front, a fading tail behind
  float t = clamp(v_p.x, 0.0, v_len);
  vec2 q = vec2(v_p.x - t, v_p.y);
  float along = v_len > 0.0 ? t / v_len : 1.0;
  float line = exp(-dot(q, q) * 1.4) * (0.15 + 0.85 * along);
  vec2 hp = v_p - vec2(v_len, 0.0);
  float head = exp(-dot(hp, hp) * 1.2);
  o = vec4(mix(u_luc, u_bloom, 0.65) * (line * 0.8 + head * 1.5) * v_a, 0.0);
}
`;

// long exposure: every recent path, accumulated like light on film
export const TRAIL_VS = `${HEAD}
${CAMERA}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_i0;
layout(location = 2) in vec4 a_i1;
out vec2 v_p;
flat out float v_len;
flat out vec4 v_c;
void main() {
  vec2 a = (a_i0.xy - u_cam.xy) * u_cam.z + u_view * 0.5;
  vec2 b = (a_i0.zw - u_cam.xy) * u_cam.z + u_view * 0.5;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 0.001 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = 1.1;
  vec2 sp = mix(a, b, a_corner.x * 0.5 + 0.5) + dir * a_corner.x * hw * 2.0 + nrm * a_corner.y * hw * 2.0;
  gl_Position = vec4(sp.x / u_view.x * 2.0 - 1.0, 1.0 - sp.y / u_view.y * 2.0, 0.0, 1.0);
  v_p = vec2(dot(sp - a, dir), dot(sp - a, nrm)) / hw;
  v_len = len / hw;
  v_c = a_i1;
}
`;

export const TRAIL_FS = `${HEAD}
uniform vec3 u_luc;
uniform vec3 u_bloom;
uniform vec3 u_ember;
uniform float u_amount;
in vec2 v_p;
flat in float v_len;
flat in vec4 v_c;
out vec4 o;
void main() {
  float t = clamp(v_p.x, 0.0, v_len);
  vec2 q = vec2(v_p.x - t, v_p.y);
  float line = exp(-dot(q, q) * 1.2);
  float g = v_c.x;
  vec3 col = mix(u_luc, u_bloom, clamp(g, 0.0, 1.0) * 0.6);
  col = mix(col, u_ember * 1.3, v_c.z);
  // older samples are fainter, as if the shutter opened on them last
  o = vec4(col * line * (0.12 + 0.9 * g) * v_c.y * u_amount, 0.0);
}
`;

// findings in the depth layer: out-of-focus type, glowing faintly from below
export const SPRITE_VS = `${HEAD}
${CAMERA}
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  vec2 local = a_corner * u_rect.zw * 0.5;
  v_uv = vec2(a_corner.x * 0.5 + 0.5, a_corner.y * 0.5 + 0.5);
  gl_Position = toClip(u_rect.xy + local);
}
`;

export const SPRITE_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec3 u_tint;
uniform float u_alpha;
in vec2 v_uv;
out vec4 o;
void main() {
  float a = texture(u_tex, v_uv).a;
  o = vec4(u_tint * a * u_alpha, 0.0);
}
`;

// ---------- post: bloom, depth of field, heat haze, lens ----------

export const DOWN_FS = `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o;
// the 13-tap downsample from Jimenez, 2014
void main() {
  vec2 t = u_texel;
  vec3 a = texture(u_src, v_uv + t * vec2(-2, 2)).rgb;
  vec3 b = texture(u_src, v_uv + t * vec2(0, 2)).rgb;
  vec3 c = texture(u_src, v_uv + t * vec2(2, 2)).rgb;
  vec3 d = texture(u_src, v_uv + t * vec2(-2, 0)).rgb;
  vec3 e = texture(u_src, v_uv).rgb;
  vec3 f = texture(u_src, v_uv + t * vec2(2, 0)).rgb;
  vec3 g = texture(u_src, v_uv + t * vec2(-2, -2)).rgb;
  vec3 h = texture(u_src, v_uv + t * vec2(0, -2)).rgb;
  vec3 i = texture(u_src, v_uv + t * vec2(2, -2)).rgb;
  vec3 j = texture(u_src, v_uv + t * vec2(-1, 1)).rgb;
  vec3 k = texture(u_src, v_uv + t * vec2(1, 1)).rgb;
  vec3 l = texture(u_src, v_uv + t * vec2(-1, -1)).rgb;
  vec3 m = texture(u_src, v_uv + t * vec2(1, -1)).rgb;
  vec3 sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = vec4(sum, 1.0);
}
`;

// tent upsample that adds the thresholded level below, building the bloom from coarse to fine
export const UP_FS = `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_add;
uniform vec2 u_texel;
uniform float u_threshold;
uniform float u_knee;
uniform float u_carry;
in vec2 v_uv;
out vec4 o;
vec3 bright(vec3 c) {
  float L = max(c.r, max(c.g, c.b));
  float s = clamp(L - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  s = s * s / (4.0 * u_knee + 1e-4);
  return c * max(s, L - u_threshold) / max(L, 1e-4);
}
void main() {
  vec2 t = u_texel;
  vec3 s = texture(u_src, v_uv + t * vec2(-1, 1)).rgb + texture(u_src, v_uv + t * vec2(1, 1)).rgb
         + texture(u_src, v_uv + t * vec2(-1, -1)).rgb + texture(u_src, v_uv + t * vec2(1, -1)).rgb;
  s += 2.0 * (texture(u_src, v_uv + t * vec2(0, 1)).rgb + texture(u_src, v_uv + t * vec2(0, -1)).rgb
           + texture(u_src, v_uv + t * vec2(1, 0)).rgb + texture(u_src, v_uv + t * vec2(-1, 0)).rgb);
  s += 4.0 * texture(u_src, v_uv).rgb;
  // coarse levels carry forward weaker, so the glow hugs its source like a macro lens's
  o = vec4(s / 16.0 * u_carry + bright(texture(u_add, v_uv).rgb), 1.0);
}
`;

export const COMPOSITE_FS = `${HEAD}
${NOISE}
uniform sampler2D u_scene;
uniform sampler2D u_blur1;
uniform sampler2D u_blur2;
uniform sampler2D u_bloomTex;
uniform sampler2D u_field;
uniform vec4 u_cam;
uniform vec2 u_view;
uniform vec2 u_world;
uniform vec4 u_focus;
uniform float u_defocus;
uniform float u_bloomGain;
uniform float u_exposure;
uniform vec3 u_bloomCol;
uniform float u_freeze;
uniform float u_fieldScale;
in vec2 v_uv;
out vec4 o;

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  float t = u_cam.w;
  vec2 uv = v_uv;
  vec2 sp = vec2(uv.x, 1.0 - uv.y) * u_view;
  vec2 w = u_cam.xy + (sp - u_view * 0.5) / u_cam.z;

  // heat haze: where the colony boils, the water shimmers
  float heat = 1.0 - exp(-texture(u_field, w / u_world).a * u_fieldScale * 1.1);
  vec2 wob = vec2(vnoise(w * 0.08 + vec2(t * 3.1, 0.0)), vnoise(w * 0.08 + vec2(0.0, t * 2.7))) - 0.5;
  uv += wob * heat * 6.0 / u_view;

  // the lens: chromatic fringe toward the rim
  vec2 fromCentre = uv - 0.5;
  float rim = dot(fromCentre, fromCentre);
  vec2 ca = fromCentre * rim * 0.006;
  vec3 sharp = vec3(texture(u_scene, uv + ca).r, texture(u_scene, uv).g, texture(u_scene, uv - ca).b);

  // depth of field: sharp around the focus, softer with distance, shallower the more you magnify
  vec2 fp = u_focus.xy;
  float dist = length((sp - fp) / u_view.y);
  float coc = clamp(smoothstep(u_focus.z, u_focus.z + 0.35, dist) * u_focus.w + u_defocus, 0.0, 1.0);
  vec3 b1 = texture(u_blur1, uv).rgb;
  vec3 b2 = texture(u_blur2, uv).rgb;
  vec3 blurred = mix(b1, b2, smoothstep(0.45, 1.0, coc));
  vec3 col = mix(sharp, blurred, smoothstep(0.0, 0.45, coc));

  col += texture(u_bloomTex, uv).rgb * u_bloomGain;
  col *= u_exposure;

  // a frozen moment is a little darker, so the long exposure carries
  col *= 1.0 - 0.18 * u_freeze;

  // roll off highlights by luminance so luciferin keeps its hue, whitening only at the top
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float Lc = L < 0.55 ? L : 0.55 + (L - 0.55) / (1.0 + (L - 0.55) * 1.25);
  col *= Lc / max(L, 1e-5);
  col = mix(col, u_bloomCol * Lc, smoothstep(0.75, 1.5, L) * 0.55);

  // lens vignette
  vec2 vq = (uv - 0.5) * vec2(u_view.x / u_view.y, 1.0);
  col *= 1.0 - 0.28 * smoothstep(0.45, 1.25, length(vq));

  vec3 srgb = toSrgb(clamp(col, 0.0, 1.0));
  // dither so the dark gradients never band
  srgb += (hash12(gl_FragCoord.xy + fract(t) * 91.0) + hash12(gl_FragCoord.yx * 1.31) - 1.0) / 255.0;
  o = vec4(srgb, 1.0);
}
`;

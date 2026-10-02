import * as THREE from 'three';
import { G, SHARED_DECL } from './globals';

export const enum P {
  Dust = 0, Spark = 1, Splash = 2, Ember = 3, Flame = 4, Ash = 5, Smoke = 6, Chip = 7, Steam = 8,
}

const VERT = /* glsl */`
attribute vec4 aStart;    // xyz = spawn position, w = spawn time
attribute vec4 aVel;      // xyz = initial velocity, w = lifetime
attribute vec4 aParams;   // x = size0, y = size1, z = type, w = seed
attribute vec3 aColor;

uniform float uTime;
uniform float uDrag;
uniform vec3  uWind;

varying float vAge;
varying float vType;
varying float vSeed;
varying vec3  vCol;
varying vec2  vUv;
varying vec3  vWorldPos;
varying float vFade;

void main() {
  float life = aVel.w;
  float age = (uTime - aStart.w) / max(life, 0.001);
  vAge = age;
  vType = aParams.z;
  vSeed = aParams.w;
  vCol = aColor;
  vUv = uv;

  if (age < 0.0 || age > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen: cheapest possible cull
    return;
  }

  float t = age * life;
  // Exponential drag integrates cleanly and keeps light debris believable.
  float k = uDrag * (aParams.z == 5.0 ? 2.6 : aParams.z == 6.0 ? 1.4 : 1.0);
  float decay = (1.0 - exp(-k * t)) / max(k, 0.0001);
  vec3 p = aStart.xyz + aVel.xyz * decay;

  float g = -9.81;
  if (aParams.z == 4.0) g = 5.5;          // flame rises
  else if (aParams.z == 6.0) g = 1.9;     // smoke rises
  else if (aParams.z == 8.0) g = 3.4;     // steam rises
  else if (aParams.z == 5.0) g = -0.55;   // ash drifts down slowly
  else if (aParams.z == 0.0) g = -1.2;    // dust hangs
  p.y += 0.5 * g * t * t * (aParams.z == 1.0 || aParams.z == 7.0 ? 1.0 : 0.55);
  p += uWind * decay * (aParams.z == 5.0 ? 0.9 : aParams.z == 6.0 ? 0.55 : aParams.z == 0.0 ? 0.35 : 0.12);

  // Curl so smoke and dust do not rise in straight lines.
  float sw = aParams.w * 31.4;
  p.x += sin(t * 1.3 + sw) * t * (aParams.z >= 5.0 ? 0.45 : 0.12);
  p.z += cos(t * 1.1 + sw * 1.7) * t * (aParams.z >= 5.0 ? 0.45 : 0.12);

  float size = mix(aParams.x, aParams.y, age);

  vec4 mv = viewMatrix * vec4(p, 1.0);
  // Sparks and chips streak along their motion; everything else is a billboard.
  if (aParams.z == 1.0 || aParams.z == 7.0) {
    vec3 vw = aVel.xyz * exp(-k * t) + vec3(0.0, g * t, 0.0);
    vec3 dir = normalize((viewMatrix * vec4(vw, 0.0)).xyz + vec3(0.0001));
    vec2 d2 = normalize(dir.xy + vec2(0.0001));
    vec2 perp = vec2(-d2.y, d2.x);
    float len = size * (2.5 + min(length(vw) * 0.25, 7.0));
    mv.xy += d2 * position.y * len + perp * position.x * size;
  } else {
    float rot = aParams.w * 6.2831 + t * (aParams.z == 6.0 ? 0.25 : 0.9) * (aParams.w - 0.5) * 2.0;
    float c = cos(rot), s = sin(rot);
    mv.xy += mat2(c, -s, s, c) * position.xy * size;
  }

  vWorldPos = p;
  vFade = 1.0;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;
varying float vAge;
varying float vType;
varying float vSeed;
varying vec3  vCol;
varying vec2  vUv;
varying vec3  vWorldPos;
${SHARED_DECL}

float h21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
float n21(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
}

void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float a = 1.0;
  vec3 col = vCol;

  if (vType == 1.0) {                       // spark
    a = smoothstep(1.0, 0.1, r) * (1.0 - vAge);
    col = mix(vec3(1.0, 0.85, 0.45), vec3(1.0, 0.30, 0.06), vAge) * 3.2;
  } else if (vType == 4.0) {                // flame
    float n = n21(vUv * 7.0 + vec2(vSeed * 40.0, -uTime * 3.4));
    float body = smoothstep(1.0, 0.18, r + n * 0.32);
    a = body * (1.0 - vAge) * 0.95;
    col = mix(vec3(1.0, 0.92, 0.55), vec3(1.0, 0.24, 0.03), pow(vAge, 0.7)) * 3.6;
  } else if (vType == 3.0) {                // ember
    a = smoothstep(1.0, 0.2, r) * (1.0 - vAge * vAge);
    float flick = 0.55 + 0.45 * sin(uTime * 22.0 + vSeed * 60.0);
    col = mix(vec3(1.0, 0.55, 0.15), vec3(0.9, 0.16, 0.03), vAge) * (1.6 + flick);
  } else if (vType == 6.0 || vType == 0.0 || vType == 8.0) {  // smoke / dust / steam
    float n = n21(vUv * 3.4 + vec2(vSeed * 25.0, vSeed * 11.0));
    float soft = smoothstep(1.05, 0.05, r + n * 0.45);
    float fadeIn = smoothstep(0.0, 0.12, vAge);
    a = soft * fadeIn * (1.0 - smoothstep(0.55, 1.0, vAge)) * (vType == 0.0 ? 0.55 : 0.42);
    col = vCol * (vType == 8.0 ? 1.25 : 1.0);
  } else if (vType == 2.0) {                // splash droplet
    a = smoothstep(1.0, 0.25, r) * (1.0 - vAge);
    col = vec3(0.72, 0.82, 0.86);
  } else if (vType == 5.0) {                // ash fleck
    a = smoothstep(1.0, 0.3, r) * (1.0 - smoothstep(0.7, 1.0, vAge)) * 0.8;
    col = vec3(0.34, 0.33, 0.32);
  } else {                                  // chip of debris
    a = smoothstep(1.0, 0.5, r) * (1.0 - smoothstep(0.75, 1.0, vAge));
  }

  if (a < 0.004) discard;

  // The world's fog applies to particles too, or they float in front of it.
  float dist = length(uCamPos - vWorldPos);
  float f = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0) * (vType == 1.0 || vType == 4.0 || vType == 3.0 ? 0.25 : 0.9));
  col += uFlashColor * uFlash * 0.4;

  gl_FragColor = vec4(col, a);
}
`;

/**
 * One GPU-resident particle buffer for the whole game. Emitting is a handful of
 * float writes; the shader integrates motion, so tens of thousands of dust,
 * spark and smoke particles cost almost nothing on the CPU.
 */
export class Particles {
  mesh: THREE.Mesh;
  private cap: number;
  private cursor = 0;
  private start: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private params: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private lo = 1e9; private hi = -1;
  time = 0;
  live = 0;

  constructor(scene: THREE.Scene, capacity = 4000, additive = false) {
    this.cap = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    geo.attributes.normal = quad.attributes.normal;
    const f4 = () => new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.start = f4(); this.vel = f4(); this.params = f4();
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    // start everything expired
    for (let i = 0; i < capacity; i++) { this.start.array[i * 4 + 3] = -1e6; this.vel.array[i * 4 + 3] = 0.001; }
    geo.setAttribute('aStart', this.start);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aParams', this.params);
    geo.setAttribute('aColor', this.color);
    geo.instanceCount = capacity;

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      // Billboards are rebuilt in view space, so their winding is not the
      // geometry's own. Never cull them.
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { ...G, uDrag: { value: 0.9 }, uWind: { value: new THREE.Vector3() } },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    scene.add(this.mesh);
  }

  setWind(v: THREE.Vector3) { (this.mat.uniforms.uWind.value as THREE.Vector3).copy(v); }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number, type: P,
    r = 1, g = 1, b = 1,
  ) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const s = this.start.array as Float32Array;
    const v = this.vel.array as Float32Array;
    const p = this.params.array as Float32Array;
    const c = this.color.array as Float32Array;
    const o = i * 4;
    s[o] = x; s[o + 1] = y; s[o + 2] = z; s[o + 3] = G.uTime.value;
    v[o] = vx; v[o + 1] = vy; v[o + 2] = vz; v[o + 3] = life;
    p[o] = size0; p[o + 1] = size1; p[o + 2] = type; p[o + 3] = (i * 0.6180339887) % 1;
    const o3 = i * 3;
    c[o3] = r; c[o3 + 1] = g; c[o3 + 2] = b;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
  }

  burst(
    pos: THREE.Vector3, n: number, type: P, speed: number, life: number,
    size0: number, size1: number, color: THREE.Color, spread = 1, up = 0.4,
  ) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.emit(
        pos.x + (Math.random() - 0.5) * size0, pos.y + (Math.random() - 0.5) * size0, pos.z + (Math.random() - 0.5) * size0,
        Math.cos(a) * s * (1 - Math.abs(e)), s * (up + e), Math.sin(a) * s * (1 - Math.abs(e)),
        life * (0.6 + Math.random() * 0.8), size0 * (0.6 + Math.random() * 0.8), size1, type,
        color.r, color.g, color.b);
    }
  }

  flush() {
    if (this.hi < this.lo) return;
    const n = this.hi - this.lo + 1;
    for (const at of [this.start, this.vel, this.params]) {
      at.clearUpdateRanges();
      if (n < this.cap * 0.55) at.addUpdateRange(this.lo * 4, n * 4);
      at.needsUpdate = true;
    }
    this.color.clearUpdateRanges();
    if (n < this.cap * 0.55) this.color.addUpdateRange(this.lo * 3, n * 3);
    this.color.needsUpdate = true;
    this.lo = 1e9; this.hi = -1;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

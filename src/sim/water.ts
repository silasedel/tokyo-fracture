import * as THREE from 'three';
import { MAP, HALF, SHORE_Z, RIVER_Z, RIVER_HALF } from '../world/cityplan';
import type { Terrain } from '../world/terrain';
import type { CityPlan } from '../world/cityplan';
import { G, SHARED_DECL, FOG_FRAG } from '../render/globals';
import { clamp, clamp01, lerp } from '../util/math';

export const SEA_LEVEL = -1.2;
const GRAV = 9.81;

export interface WaterSample {
  /** World Y of the water surface, or -Infinity where there is none. */
  surface: number;
  depth: number;
  vx: number;
  vz: number;
}

/**
 * A height-field shallow-water solver over the whole map. Rain lands on it,
 * drains pull it away, the river and the bay feed it, and a tsunami is just a
 * boundary condition. Everything that floats, tumbles or drowns reads the same
 * grid, so flooding is never a special case.
 */
export class Water {
  N: number;
  cell: number;
  h: Float32Array;          // depth, metres
  g: Float32Array;          // ground height
  vx: Float32Array;         // face velocity toward +x
  vz: Float32Array;         // face velocity toward +z
  dh: Float32Array;
  /** How fast the storm drains take water away, m/s. Falls when they clog. */
  drainRate = 0.0045;
  drainHealth = 1;
  /** Metres per second of rainfall landing on the ground. */
  rainRate = 0;
  seaLevel = SEA_LEVEL;
  /** Added to the sea boundary — this is what a tsunami actually is. */
  surge = 0;
  surgeVel = 0;
  /** Extra inflow into the river channel. */
  riverSwell = 0;
  time = 0;
  private acc = 0;
  private roadMask: Uint8Array;
  private openMask: Float32Array;
  maxDepth = 0;
  floodedFraction = 0;

  // --- rendering ---
  mesh!: THREE.Mesh;
  mat!: THREE.ShaderMaterial;
  private tex!: THREE.DataTexture;
  private texData!: Float32Array<ArrayBuffer>;

  constructor(public terrain: Terrain, public plan: CityPlan, res = 144) {
    this.N = res;
    this.cell = MAP / res;
    const n = res * res;
    this.h = new Float32Array(n);
    this.g = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.dh = new Float32Array(n);
    this.roadMask = new Uint8Array(n);
    this.openMask = new Float32Array(n);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = (i + 0.5) * this.cell - HALF;
        const z = (j + 0.5) * this.cell - HALF;
        const k = j * res + i;
        this.g[k] = terrain.heightAt(x, z);
        this.roadMask[k] = plan.isRoad(x, z) ? 1 : 0;
        this.openMask[k] = plan.isBuilt(x, z) ? 0.12 : 1;
        // Start with the bay and the river channel already wet.
        const sea = this.seaLevel - this.g[k];
        if (sea > 0 && (z > SHORE_Z - 40 || Math.abs(z - RIVER_Z) < RIVER_HALF + 2)) this.h[k] = sea;
      }
    }
  }

  private idx(i: number, j: number) { return j * this.N + i; }

  /** Bilinear sample of surface height and current. */
  sample(x: number, z: number, out: WaterSample): WaterSample {
    const N = this.N;
    const fx = clamp((x + HALF) / this.cell - 0.5, 0, N - 1.001);
    const fz = clamp((z + HALF) / this.cell - 0.5, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const k00 = this.idx(i, j), k10 = this.idx(i + 1, j), k01 = this.idx(i, j + 1), k11 = this.idx(i + 1, j + 1);
    const d = (this.h[k00] * (1 - tx) + this.h[k10] * tx) * (1 - tz)
            + (this.h[k01] * (1 - tx) + this.h[k11] * tx) * tz;
    if (d < 0.02) { out.surface = -Infinity; out.depth = 0; out.vx = 0; out.vz = 0; return out; }
    const s = ((this.g[k00] + this.h[k00]) * (1 - tx) + (this.g[k10] + this.h[k10]) * tx) * (1 - tz)
            + ((this.g[k01] + this.h[k01]) * (1 - tx) + (this.g[k11] + this.h[k11]) * tx) * tz;
    out.surface = s;
    out.depth = d;
    out.vx = (this.vx[k00] + this.vx[k10]) * 0.5;
    out.vz = (this.vz[k00] + this.vz[k01]) * 0.5;
    return out;
  }

  depthAt(x: number, z: number) {
    const N = this.N;
    const i = clamp(Math.floor((x + HALF) / this.cell), 0, N - 1);
    const j = clamp(Math.floor((z + HALF) / this.cell), 0, N - 1);
    return this.h[j * N + i];
  }

  surfaceAt(x: number, z: number) {
    const N = this.N;
    const i = clamp(Math.floor((x + HALF) / this.cell), 0, N - 1);
    const j = clamp(Math.floor((z + HALF) / this.cell), 0, N - 1);
    const k = j * N + i;
    return this.h[k] > 0.02 ? this.g[k] + this.h[k] : -Infinity;
  }

  /** Drop water in — a burst main, a wave from an impact, a splash. */
  addWater(x: number, z: number, radius: number, amount: number) {
    const N = this.N;
    const r = Math.max(1, Math.ceil(radius / this.cell));
    const ci = Math.floor((x + HALF) / this.cell), cj = Math.floor((z + HALF) / this.cell);
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= N) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= N) continue;
        const dx = (i + 0.5) * this.cell - HALF - x, dz = (j + 0.5) * this.cell - HALF - z;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        this.h[j * N + i] = Math.max(0, this.h[j * N + i] + amount * (1 - d / radius));
      }
    }
  }

  /** Radial impulse on the surface — explosions, heavy objects landing. */
  splash(x: number, z: number, radius: number, speed: number) {
    const N = this.N;
    const r = Math.max(1, Math.ceil(radius / this.cell));
    const ci = Math.floor((x + HALF) / this.cell), cj = Math.floor((z + HALF) / this.cell);
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= N) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= N) continue;
        const k = j * N + i;
        if (this.h[k] < 0.05) continue;
        const dx = (i + 0.5) * this.cell - HALF - x, dz = (j + 0.5) * this.cell - HALF - z;
        const d = Math.hypot(dx, dz) || 1e-3;
        if (d > radius) continue;
        const f = (1 - d / radius) * speed;
        this.vx[k] += (dx / d) * f;
        this.vz[k] += (dz / d) * f;
      }
    }
  }

  update(dt: number) {
    this.time += dt;
    this.acc += dt;
    const step = 1 / 20;
    let guard = 0;
    while (this.acc >= step && guard++ < 3) {
      this.acc -= step;
      this.simulate(step);
    }
    this.uploadTexture();
    this.syncSkirt();
  }

  private simulate(dt: number) {
    const { N, h, g, vx, vz, dh, cell } = this;
    const n = N * N;

    // --- sources -----------------------------------------------------------
    if (this.rainRate > 0) {
      const add = this.rainRate * dt;
      for (let k = 0; k < n; k++) h[k] += add * this.openMask[k];
    }
    // storm drains, until they are overwhelmed or blocked
    const drain = this.drainRate * this.drainHealth * dt;
    if (drain > 0) {
      for (let k = 0; k < n; k++) {
        if (this.roadMask[k] && h[k] > 0) h[k] = Math.max(0, h[k] - drain);
      }
    }
    // river inflow at the western end of the channel
    if (this.riverSwell > 0) {
      const jz = Math.floor((RIVER_Z + HALF) / cell);
      for (let j = jz - 4; j <= jz + 4; j++) {
        if (j < 0 || j >= N) continue;
        for (let i = 0; i < 3; i++) {
          const k = j * N + i;
          h[k] += this.riverSwell * dt * 7;
          vx[k] += 1.4 * dt * this.riverSwell;
        }
      }
    }
    // The bay: a Dirichlet boundary the tsunami drives.
    const seaTop = this.seaLevel + this.surge;
    const jShore = Math.floor((SHORE_Z + HALF) / cell);
    for (let j = Math.max(0, jShore); j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const want = Math.max(0, seaTop - g[k]);
        h[k] = lerp(h[k], want, 0.55);
        if (this.surgeVel !== 0) vz[k] = this.surgeVel;
      }
    }

    // --- velocities from the surface gradient -------------------------------
    const a = (GRAV / cell) * dt;
    const fric = Math.exp(-dt * 1.35);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N - 1; i++) {
        const k = j * N + i, k2 = k + 1;
        const hL = h[k], hR = h[k2];
        if (hL < 0.004 && hR < 0.004) { vx[k] = 0; continue; }
        const dH = (g[k2] + hR) - (g[k] + hL);
        // Water cannot climb dry ground it has no depth to reach over.
        let v = vx[k] - a * dH;
        v *= fric;
        vx[k] = clamp(v, -13, 13);
      }
      vx[j * N + N - 1] *= 0.5;
    }
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, k2 = k + N;
        const hD = h[k], hU = h[k2];
        if (hD < 0.004 && hU < 0.004) { vz[k] = 0; continue; }
        const dH = (g[k2] + hU) - (g[k] + hD);
        let v = vz[k] - a * dH;
        v *= fric;
        vz[k] = clamp(v, -13, 13);
      }
    }

    // --- transport ----------------------------------------------------------
    dh.fill(0);
    const lim = (cell / dt) * 0.22;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N - 1; i++) {
        const k = j * N + i, k2 = k + 1;
        const v = vx[k];
        if (v === 0) continue;
        const src = v > 0 ? h[k] : h[k2];
        let flow = clamp(v, -lim, lim) * src * (dt / cell);
        if (flow > 0) flow = Math.min(flow, h[k] * 0.42);
        else flow = -Math.min(-flow, h[k2] * 0.42);
        dh[k] -= flow; dh[k2] += flow;
      }
    }
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, k2 = k + N;
        const v = vz[k];
        if (v === 0) continue;
        const src = v > 0 ? h[k] : h[k2];
        let flow = clamp(v, -lim, lim) * src * (dt / cell);
        if (flow > 0) flow = Math.min(flow, h[k] * 0.42);
        else flow = -Math.min(-flow, h[k2] * 0.42);
        dh[k] -= flow; dh[k2] += flow;
      }
    }
    let maxD = 0, flooded = 0;
    for (let k = 0; k < n; k++) {
      const nv = h[k] + dh[k];
      h[k] = nv > 0 ? nv : 0;
      if (h[k] > maxD) maxD = h[k];
      if (h[k] > 0.12 && this.g[k] > this.seaLevel + 0.3) flooded++;
    }
    // open edges: let water leave the map
    for (let i = 0; i < N; i++) {
      h[i] *= 0.985;
      h[(N - 1) * N + i] *= 0.999;
      h[i * N] *= 0.985;
      h[i * N + N - 1] *= 0.985;
    }
    this.maxDepth = maxD;
    this.floodedFraction = flooded / n;
  }

  // ---------------------------------------------------------------- rendering
  build(scene: THREE.Scene, renderSeg = 176) {
    const N = this.N;
    this.texData = new Float32Array(N * N * 4) as Float32Array<ArrayBuffer>;
    this.tex = new THREE.DataTexture(this.texData, N, N, THREE.RGBAFormat, THREE.FloatType);
    // RGBA32F is not guaranteed to be linearly filterable in WebGL2, and a
    // garbage fetch here paints a translucent sheet over the whole world.
    // Sample it nearest and smooth the result ourselves.
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(MAP, MAP, renderSeg, renderSeg);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        ...G,
        uField: { value: this.tex },
        uMap: { value: MAP },
        uSeaLevel: { value: this.seaLevel },
        uTexel: { value: new THREE.Vector2(1 / N, 1 / N) },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'water';
    scene.add(this.mesh);

    // The bay has to reach the horizon, so a wide skirt continues south of the
    // simulated grid at whatever level the sea boundary currently sits.
    const skirtGeo = new THREE.PlaneGeometry(MAP * 8, 2200, 48, 12);
    skirtGeo.rotateX(-Math.PI / 2);
    skirtGeo.translate(0, 0, MAP / 2 + 1100 - 1);
    this.skirt = new THREE.Mesh(skirtGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { ...G, uLevel: { value: this.seaLevel } },
      vertexShader: SKIRT_VERT, fragmentShader: SKIRT_FRAG,
    }));
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 5;
    scene.add(this.skirt);
  }
  skirt!: THREE.Mesh;

  /** Keep the open sea in step with the boundary condition. */
  syncSkirt() {
    if (!this.skirt) return;
    (this.skirt.material as THREE.ShaderMaterial).uniforms.uLevel.value = this.seaLevel + this.surge;
  }

  private uploadTexture() {
    if (!this.tex) return;
    const { N, h, g, vx, vz, texData } = this;
    for (let k = 0, o = 0; k < N * N; k++, o += 4) {
      texData[o] = g[k] + h[k];
      texData[o + 1] = h[k];
      texData[o + 2] = vx[k];
      texData[o + 3] = vz[k];
    }
    this.tex.needsUpdate = true;
  }

  dispose(scene: THREE.Scene) {
    if (this.skirt) { scene.remove(this.skirt); this.skirt.geometry.dispose(); (this.skirt.material as THREE.Material).dispose(); }
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }

  /** Used by the HUD / director to describe the situation. */
  stats() {
    return { maxDepth: this.maxDepth, flooded: this.floodedFraction, surge: this.surge };
  }
  static clamp01 = clamp01;
}

const WATER_VERT = /* glsl */`
uniform sampler2D uField;
uniform float uMap;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec2  uTexel;
varying vec3 vWorldPos;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vNrm;

vec4 fieldAt(vec2 uv) { return texture2D(uField, clamp(uv, uTexel * 0.5, 1.0 - uTexel * 0.5)); }

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 uv = wp.xz / uMap + 0.5;
  vec4 f = fieldAt(uv);
  float surf = f.r;
  float depth = f.g;
  vDepth = depth;
  vFlow = f.ba;

  // Surface normal from the neighbouring cells, computed here because the
  // field is point-sampled.
  float hl = fieldAt(uv - vec2(uTexel.x, 0.0)).r;
  float hr = fieldAt(uv + vec2(uTexel.x, 0.0)).r;
  float hd = fieldAt(uv - vec2(0.0, uTexel.y)).r;
  float hu = fieldAt(uv + vec2(0.0, uTexel.y)).r;
  float step2 = uMap * uTexel.x * 2.0;
  vNrm = normalize(vec3((hl - hr) / step2, 1.0, (hd - hu) / step2));

  // Dry cells sink far below the ground so they are never visible.
  wp.y = depth > 0.022 ? surf : surf - 8.0;
  float agitation = clamp(length(f.ba) * 0.34 + depth * 0.02, 0.0, 1.4);
  if (depth > 0.022) {
    float t = uTime;
    wp.y += sin(wp.x * 0.85 + t * 2.1) * 0.016 * agitation;
    wp.y += sin(wp.z * 0.62 - t * 1.7) * 0.020 * agitation;
    wp.y += sin((wp.x + wp.z) * 1.9 + t * 3.4) * 0.008 * agitation;
  }
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uField;
uniform float uMap;
uniform float uSeaLevel;
${SHARED_DECL}
varying vec3 vWorldPos;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vNrm;

float h21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
float n21(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
}
float fbm(vec2 p){
  float s=0.0,a=0.5;
  for(int i=0;i<4;i++){ s+=a*n21(p); a*=0.5; p=p*2.07+vec2(3.1,7.7); }
  return s;
}

void main() {
  if (vDepth < 0.024) discard;
  vec3 n = normalize(vNrm);

  vec2 flowUV = vWorldPos.xz * 0.30 - vFlow * uTime * 0.28;
  float agit = clamp(length(vFlow) * 0.30, 0.0, 1.3) + 0.55 + uWetness * 0.35;
  float r1 = fbm(flowUV * 1.0 + uTime * 0.25);
  float r2 = fbm(flowUV * 2.7 - uTime * 0.42);
  float dx = fbm(flowUV * 1.0 + vec2(0.11,0.0) + uTime * 0.25) - r1;
  float dz = fbm(flowUV * 1.0 + vec2(0.0,0.11) + uTime * 0.25) - r1;
  n = normalize(n + vec3(dx, 0.0, dz) * 9.0 * agit + vec3(r2 - 0.5, 0.0, r1 - 0.5) * 0.55 * agit);

  vec3 V = normalize(uCamPos - vWorldPos);
  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);
  // Real water never becomes a perfect mirror, and a perfect mirror of an
  // overcast sky reads as blank haze.
  fres = mix(0.075, 0.90, fres);

  vec3 R = reflect(-V, n);
  vec3 sky = skyLook(R);

  // Depth tint: shallow water shows the ground, deep water goes green-black.
  float dv = clamp(vDepth / 3.2, 0.0, 1.0);
  vec3 shallow = vec3(0.17, 0.27, 0.28);
  vec3 deep = vec3(0.030, 0.085, 0.105);
  vec3 body = mix(shallow, deep, dv);
  body = mix(body, vec3(0.13,0.11,0.085), clamp(uAsh * 0.9 + uSmoke * 0.4, 0.0, 0.8));

  vec3 col = mix(body, sky, fres);

  // Sun glitter
  vec3 H = normalize(normalize(uSunDir) + V);
  float spec = pow(max(dot(n, H), 0.0), 220.0);
  col += uSunColor * spec * 1.6 * (1.0 - uAsh * 0.6);

  // Foam: where the flow is fast, where it is shallow, and at the shoreline.
  float shoreFoam = smoothstep(0.34, 0.06, vDepth);
  float flowFoam = smoothstep(0.35, 1.5, length(vFlow));
  float churn = fbm(vWorldPos.xz * 1.6 - vFlow * uTime * 0.5);
  float foam = clamp(max(shoreFoam * 0.85, flowFoam) * (0.45 + churn * 0.9), 0.0, 1.0);
  col = mix(col, vec3(0.86, 0.90, 0.92), foam * 0.85);

  // Rain stippling the surface
  float rain = clamp(uWetness, 0.0, 1.0);
  if (rain > 0.02) {
    float rr = n21(vWorldPos.xz * 22.0 + floor(uTime * 14.0));
    col += vec3(0.16) * step(0.988 - rain * 0.006, rr) * rain;
  }

  col += uFlashColor * uFlash * 0.6;

  // A second, larger swell so open water is never a flat sheet.
  float swell = fbm(vWorldPos.xz * 0.055 + uTime * 0.06);
  col *= 0.86 + 0.28 * swell;

  float alpha = clamp(0.52 + dv * 0.46 + fres * 0.42 + foam * 0.5, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`.replace('#include <fog_fragment>', FOG_FRAG);

const SKIRT_VERT = /* glsl */`
uniform float uLevel;
uniform float uTime;
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y = uLevel
    + sin(wp.x * 0.012 + uTime * 0.6) * 0.22
    + sin(wp.z * 0.009 - uTime * 0.45) * 0.28;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKIRT_FRAG = /* glsl */`
precision highp float;
${SHARED_DECL}
varying vec3 vWorldPos;
float sh21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
float sn21(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(sh21(i),sh21(i+vec2(1,0)),f.x), mix(sh21(i+vec2(0,1)),sh21(i+vec2(1,1)),f.x), f.y); }
void main() {
  vec3 V = normalize(uCamPos - vWorldPos);
  vec2 q = vWorldPos.xz * 0.22 + uTime * 0.12;
  float n0 = sn21(q), nx = sn21(q + vec2(0.12, 0.0)), nz = sn21(q + vec2(0.0, 0.12));
  vec3 n = normalize(vec3((n0 - nx) * 1.6, 1.0, (n0 - nz) * 1.6));
  float fres = mix(0.03, 0.70, pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0));
  vec3 sky = skyLook(reflect(-V, n));
  vec3 body = vec3(0.012, 0.042, 0.058);
  vec3 col = mix(body, sky, fres);
  vec3 H = normalize(normalize(uSunDir) + V);
  col += uSunColor * pow(max(dot(n, H), 0.0), 190.0) * 1.3;
  col += uFlashColor * uFlash * 0.5;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`.replace('#include <fog_fragment>', FOG_FRAG);

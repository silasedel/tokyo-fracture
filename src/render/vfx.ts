import * as THREE from 'three';
import { G, SHARED_DECL } from './globals';
import { Particles, P } from './particles';
import { Rng, clamp, clamp01, damp, lerp } from '../util/math';
import type { Entity } from '../physics/entity';
import type { Vortex } from '../sim/wind';

// ---------------------------------------------------------------------------
// Rain: one instanced draw, entirely GPU-driven. The volume follows the camera
// and wraps, so there is no per-drop CPU work at any density.
// ---------------------------------------------------------------------------
const RAIN_VERT = /* glsl */`
attribute vec4 aSeed;     // xyz in 0..1 within the volume, w = density gate
uniform vec3  uBox;
uniform vec3  uWindV;
uniform float uFall;
uniform float uDensity;
uniform float uShelter;
uniform float uTime;
uniform vec3  uCamPos;
varying float vAlpha;
varying vec2  vUv;
varying vec3  vWorldPos;
void main() {
  if (aSeed.w > uDensity) { gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
  vec3 base = aSeed.xyz * uBox;
  vec3 v = vec3(uWindV.x, -uFall, uWindV.z);
  vec3 p = base + v * uTime;
  p = mod(p - uCamPos + uBox * 0.5, uBox) + uCamPos - uBox * 0.5;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 dv = normalize((viewMatrix * vec4(v, 0.0)).xyz + vec3(1e-5));
  vec2 d2 = normalize(dv.xy + vec2(1e-5));
  vec2 perp = vec2(-d2.y, d2.x);
  // Width grows with depth so a streak covers a constant few pixels; anything
  // thinner than that vanishes into the anti-aliasing and the storm looks dry.
  float len = (0.30 + length(v) * 0.075) * (0.7 + aSeed.w * 0.6);
  float wid = max(0.022, -mv.z * 0.0042);
  mv.xy += d2 * position.y * len + perp * position.x * wid;

  float dist = length(mv.xyz);
  vAlpha = smoothstep(0.45, 2.0, dist) * smoothstep(uBox.x * 0.58, uBox.x * 0.26, dist) * uShelter
           * (0.10 + uDensity * 0.34);
  vUv = uv;
  vWorldPos = p;
  gl_Position = projectionMatrix * mv;
}
`;
const RAIN_FRAG = /* glsl */`
precision highp float;
varying float vAlpha;
varying vec2 vUv;
varying vec3 vWorldPos;
${SHARED_DECL}
void main() {
  // Taper the ends so a drop is a streak, not a bar.
  float a = vAlpha * smoothstep(0.5, 0.06, abs(vUv.x - 0.5))
                   * smoothstep(0.5, 0.18, abs(vUv.y - 0.5));
  if (a < 0.004) discard;
  // Keep a floor under the colour so rain still reads against a night city.
  vec3 col = max(mix(vec3(0.70, 0.78, 0.90), uFogColor, 0.45) * (0.9 + uFlash * 3.0), vec3(0.20, 0.24, 0.30));
  gl_FragColor = vec4(col, a);
}
`;

export class Rain {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  density = 0;
  constructor(scene: THREE.Scene, count: number, radius = 22, height = 26) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    const seeds = new Float32Array(count * 4);
    const rng = new Rng(4711);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = rng.next(); seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next(); seeds[i * 4 + 3] = rng.next();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      // The quad is rebuilt in view space along the fall direction, which flips
      // its winding whenever the drops fall downward — i.e. always. Culling
      // backfaces here silently removes every drop in the storm.
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        ...G,
        uBox: { value: new THREE.Vector3(radius * 2, height, radius * 2) },
        uWindV: { value: new THREE.Vector3() },
        uFall: { value: 12 },
        uDensity: { value: 0 },
        uShelter: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }
  update(density: number, wind: THREE.Vector3, shelter: number) {
    this.density = density;
    this.mat.uniforms.uDensity.value = clamp01(density);
    this.mat.uniforms.uShelter.value = shelter;
    (this.mat.uniforms.uWindV.value as THREE.Vector3).copy(wind).multiplyScalar(0.7);
    this.mat.uniforms.uFall.value = 11 + density * 9;
    this.mesh.visible = density > 0.005;
  }
  dispose(scene: THREE.Scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------
// Tornado funnel
// ---------------------------------------------------------------------------
const FUNNEL_VERT = /* glsl */`
varying vec3 vLocal;
varying vec3 vWorldPos;
varying float vH;
uniform float uTime2;
uniform float uWobble;
void main() {
  vLocal = position;
  vH = uv.y;
  vec3 p = position;
  float s = sin(uv.y * 5.0 + uTime2 * 1.2) * uWobble * uv.y;
  float c = cos(uv.y * 4.1 + uTime2 * 0.9) * uWobble * uv.y;
  p.x += s; p.z += c;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FUNNEL_FRAG = /* glsl */`
precision highp float;
varying vec3 vLocal;
varying vec3 vWorldPos;
varying float vH;
uniform float uTime2;
uniform float uIntensity;
${SHARED_DECL}
float h21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
float n21(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*n21(p); a*=0.5; p=p*2.1+vec2(4.7,1.3);} return s; }
void main() {
  float ang = atan(vLocal.z, vLocal.x);
  vec2 uv = vec2(ang / 6.2831 * 5.0 + uTime2 * 0.85, vH * 2.2 - uTime2 * 0.55);
  float n = fbm(uv * 3.0) * 0.6 + fbm(uv * 8.0) * 0.4;
  float shell = smoothstep(0.18, 0.72, n);
  float edge = 1.0 - abs(vH - 0.5) * 0.4;
  float a = shell * edge * uIntensity * (0.55 + 0.45 * (1.0 - vH));
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.20,0.19,0.18), vec3(0.42,0.40,0.38), n);
  col = mix(col, uFogColor * 0.8, 0.35);
  col += uFlashColor * uFlash * 0.5;
  gl_FragColor = vec4(col, a * 0.82);
}
`;

export class Funnel {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(1, 0.34, 1, 26, 12, true);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { ...G, uTime2: { value: 0 }, uIntensity: { value: 0 }, uWobble: { value: 0.06 } },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    scene.add(this.mesh);
  }
  update(dt: number, v: Vortex | null, groundY: number) {
    this.mat.uniforms.uTime2.value += dt;
    if (!v || v.intensity < 0.02) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    this.mesh.position.set(v.x, groundY - 2, v.z);
    this.mesh.scale.set(v.radius * 1.5, v.height * 0.92, v.radius * 1.5);
    this.mat.uniforms.uIntensity.value = clamp01(v.intensity * 1.1);
    this.mat.uniforms.uWobble.value = 0.05 + v.intensity * 0.06;
  }
  dispose(scene: THREE.Scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------
// Lightning bolt
// ---------------------------------------------------------------------------
export class Bolt {
  mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  life = 0;
  constructor(scene: THREE.Scene) {
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xdfeaff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }
  strike(from: THREE.Vector3, to: THREE.Vector3, rng: Rng) {
    const pts: THREE.Vector3[] = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = from.clone().lerp(to, t);
      const jitter = Math.sin(t * Math.PI) * 18;
      p.x += rng.range(-1, 1) * jitter;
      p.z += rng.range(-1, 1) * jitter;
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 48, 0.55, 5, false);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mesh.visible = true;
    this.life = 0.42;
  }
  update(dt: number) {
    if (this.life <= 0) { if (this.mesh.visible) this.mesh.visible = false; return; }
    this.life -= dt;
    const t = clamp01(this.life / 0.42);
    this.mat.opacity = t * (0.55 + 0.45 * Math.sin(this.life * 90));
    if (this.life <= 0) this.mesh.visible = false;
  }
  dispose(scene: THREE.Scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------
export class Vfx {
  particles: Particles;
  glow: Particles;
  rain: Rain;
  funnel: Funnel;
  bolt: Bolt;
  fireLights: THREE.PointLight[] = [];
  private rng = new Rng(2024);
  private splashTimer = 0;
  private ashTimer = 0;
  private flameTimer = 0;
  private dustColor = new THREE.Color(0.55, 0.52, 0.48);
  private smokeColor = new THREE.Color(0.14, 0.135, 0.13);
  private steamColor = new THREE.Color(0.78, 0.80, 0.82);
  volcanoGlow: THREE.PointLight | null = null;

  constructor(public scene: THREE.Scene, budget: number, rainCount: number) {
    this.particles = new Particles(scene, budget, false);
    this.glow = new Particles(scene, Math.floor(budget * 0.6), true);
    this.rain = new Rain(scene, rainCount);
    this.funnel = new Funnel(scene);
    this.bolt = new Bolt(scene);
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 26, 2);
      l.castShadow = false;
      // Never hidden: the number of *visible* lights is part of every material's
      // shader signature, so toggling one recompiles the entire city.
      l.visible = true;
      scene.add(l);
      this.fireLights.push(l);
    }
  }

  // --- event hooks --------------------------------------------------------

  impactDust(pos: THREE.Vector3, energy: number, color?: THREE.Color) {
    const n = clamp(Math.round(Math.log10(Math.max(10, energy)) * 3.2), 2, 26);
    this.particles.burst(pos, n, P.Dust, clamp(energy / 4200, 0.7, 7), 1.5,
      0.28, clamp(energy / 6000, 0.7, 4.5), color ?? this.dustColor, 1.1, 0.5);
  }

  debrisChips(pos: THREE.Vector3, n: number, color: THREE.Color, speed = 5) {
    this.particles.burst(pos, n, P.Chip, speed, 1.2, 0.07, 0.05, color, 1.4, 0.55);
  }

  collapseDust(pos: THREE.Vector3, volume: number) {
    const n = clamp(Math.round(4 + volume * 2.2), 4, 30);
    this.particles.burst(pos, n, P.Dust, 2.4, 3.4, 0.9, clamp(1.6 + volume * 0.5, 2, 9),
      this.dustColor, 1.3, 0.55);
  }

  glassBurst(pos: THREE.Vector3, size: number) {
    this.glow.burst(pos, clamp(Math.round(size * 7), 5, 26), P.Chip, 5.5, 1.1, 0.045, 0.03,
      new THREE.Color(0.75, 0.88, 0.95), 1.5, 0.5);
  }

  sparks(pos: THREE.Vector3, n: number, speed = 8) {
    this.glow.burst(pos, n, P.Spark, speed, 0.8, 0.05, 0.02, new THREE.Color(1, 0.7, 0.3), 1.6, 0.6);
  }

  splash(pos: THREE.Vector3, energy: number) {
    const n = clamp(Math.round(energy / 900), 3, 26);
    this.particles.burst(pos, n, P.Splash, clamp(energy / 2200, 1.4, 8), 1.0, 0.1, 0.05,
      this.steamColor, 1.0, 0.85);
  }

  explosion(pos: THREE.Vector3, energy: number, radius: number) {
    const n = clamp(Math.round(radius * 4), 10, 60);
    this.glow.burst(pos, n, P.Flame, radius * 1.6, 0.85, 0.9, radius * 0.8,
      new THREE.Color(1, 0.6, 0.2), 1.6, 0.6);
    this.glow.burst(pos, Math.round(n * 0.8), P.Spark, radius * 3.2, 1.3, 0.06, 0.03,
      new THREE.Color(1, 0.8, 0.4), 1.7, 0.5);
    this.particles.burst(pos, Math.round(n * 0.9), P.Smoke, radius * 0.9, 4.5, radius * 0.4, radius * 2.2,
      this.smokeColor, 1.4, 0.7);
    this.particles.burst(pos, Math.round(n * 0.6), P.Dust, radius * 1.4, 2.6, 0.5, radius * 1.2,
      this.dustColor, 1.5, 0.2);
    void energy;
  }

  digPuff(pos: THREE.Vector3, power: number, color: THREE.Color) {
    this.particles.burst(pos, clamp(Math.round(power * 3), 2, 10), P.Dust, 1.6, 0.9, 0.12, 0.5, color, 1.2, 0.6);
  }

  // --- per-frame ----------------------------------------------------------

  update(dt: number, camera: THREE.PerspectiveCamera, opts: {
    rain: number; wind: THREE.Vector3; shelter: number; ash: number;
    burning: Entity[]; groundY: number; vortex: Vortex | null; waterTop: number;
    smoke: number;
  }) {
    this.rain.update(opts.rain, opts.wind, opts.shelter);
    this.particles.setWind(opts.wind);
    this.glow.setWind(opts.wind);
    this.funnel.update(dt, opts.vortex, opts.groundY);
    this.bolt.update(dt);

    const cam = camera.position;

    // Rain hitting surfaces: a few splashes per frame where the player can see.
    if (opts.rain > 0.06) {
      this.splashTimer -= dt;
      if (this.splashTimer <= 0) {
        this.splashTimer = 0.024;
        const n = Math.round(clamp(opts.rain * 9, 1, 12));
        for (let i = 0; i < n; i++) {
          const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(1.5, 17);
          const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
          const y = opts.waterTop > -1e8 && opts.waterTop > opts.groundY ? opts.waterTop : opts.groundY;
          this.particles.emit(x, y + 0.02, z,
            this.rng.range(-0.5, 0.5), this.rng.range(0.9, 2.4), this.rng.range(-0.5, 0.5),
            0.32, 0.035, 0.11, P.Splash, 0.75, 0.83, 0.88);
        }
      }
    }

    // Ash drifting through the air.
    if (opts.ash > 0.02) {
      this.ashTimer -= dt;
      if (this.ashTimer <= 0) {
        this.ashTimer = 0.05;
        const n = Math.round(clamp(opts.ash * 10, 1, 10));
        for (let i = 0; i < n; i++) {
          const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(2, 26);
          this.particles.emit(
            cam.x + Math.cos(a) * r, cam.y + this.rng.range(4, 22), cam.z + Math.sin(a) * r,
            this.rng.range(-0.4, 0.4), this.rng.range(-0.5, -0.1), this.rng.range(-0.4, 0.4),
            this.rng.range(5, 11), this.rng.range(0.03, 0.09), 0.02, P.Ash, 0.4, 0.39, 0.38);
        }
      }
    }

    // Flames and smoke from whatever is actually burning.
    this.flameTimer -= dt;
    const doFire = this.flameTimer <= 0;
    if (doFire) this.flameTimer = 0.05;
    let lightIdx = 0;
    for (let i = 0; i < opts.burning.length; i++) {
      const e = opts.burning[i];
      const d2 = e.pos.distanceToSquared(cam);
      if (d2 > 160 * 160) continue;
      if (doFire && d2 < 90 * 90) {
        const s = clamp(e.radius * 0.8, 0.25, 2.6);
        this.glow.emit(
          e.pos.x + this.rng.range(-e.hx, e.hx), e.pos.y + this.rng.range(-e.hy * 0.4, e.hy),
          e.pos.z + this.rng.range(-e.hz, e.hz),
          this.rng.range(-0.4, 0.4), this.rng.range(1.2, 3.2), this.rng.range(-0.4, 0.4),
          this.rng.range(0.5, 1.1), s * 0.7, s * 0.25, P.Flame, 1, 0.6, 0.2);
        if (this.rng.bool(0.42)) {
          this.particles.emit(
            e.pos.x + this.rng.range(-e.hx, e.hx), e.pos.y + e.hy * 0.6, e.pos.z + this.rng.range(-e.hz, e.hz),
            this.rng.range(-0.3, 0.3), this.rng.range(1.4, 3.0), this.rng.range(-0.3, 0.3),
            this.rng.range(3.5, 7.5), s * 0.9, s * 4.2, P.Smoke, 0.13, 0.125, 0.12);
        }
        if (this.rng.bool(0.22)) {
          this.glow.emit(
            e.pos.x, e.pos.y + e.hy * 0.5, e.pos.z,
            this.rng.range(-1.2, 1.2), this.rng.range(1.8, 4.5), this.rng.range(-1.2, 1.2),
            this.rng.range(1.4, 3.4), 0.05, 0.02, P.Ember, 1, 0.5, 0.15);
        }
      }
      if (lightIdx < this.fireLights.length && d2 < 55 * 55) {
        const l = this.fireLights[lightIdx++];
        l.position.set(e.pos.x, e.pos.y + e.hy * 0.7, e.pos.z);
        const flick = 0.72 + 0.28 * Math.sin(G.uTime.value * 17 + e.id);
        l.intensity = clamp(9 + e.radius * 10, 5, 34) * flick;
        l.distance = clamp(11 + e.radius * 7, 10, 34);
        l.color.setRGB(1, 0.44 + 0.12 * flick, 0.14);
      }
    }
    for (let i = lightIdx; i < this.fireLights.length; i++) this.fireLights[i].intensity = 0;

    G.uSmoke.value = lerp(G.uSmoke.value, opts.smoke, 1 - Math.exp(-dt * 0.8));

    this.particles.flush();
    this.glow.flush();
  }

  dispose(scene: THREE.Scene) {
    this.particles.dispose(scene);
    this.glow.dispose(scene);
    this.rain.dispose(scene);
    this.funnel.dispose(scene);
    this.bolt.dispose(scene);
    for (const l of this.fireLights) scene.remove(l);
    if (this.volcanoGlow) scene.remove(this.volcanoGlow);
  }
}

/**
 * A handful of real point lights that follow the player around the city,
 * snapping to whichever street lamps are nearest. Eight lights is enough to
 * make a night street feel lit without paying for four hundred of them.
 */
export class StreetLights {
  private lights: THREE.PointLight[] = [];
  private spots: THREE.Vector3[] = [];
  private assigned: number[] = [];
  private timer = 0;
  intensity = 0;

  constructor(scene: THREE.Scene, spots: THREE.Vector3[], count = 8) {
    this.spots = spots;
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 26, 1.9);
      // Always visible, intensity 0 when unused — see the note on fire lights.
      l.visible = true;
      scene.add(l);
      this.lights.push(l);
      this.assigned.push(-1);
    }
  }

  update(dt: number, cam: THREE.Vector3, night: number, power: number) {
    const want = clamp01(night * 1.3) * power;
    this.intensity = damp(this.intensity, want, 2.5, dt);
    const on = this.intensity > 0.02;
    this.timer -= dt;
    if (on && this.timer <= 0) {
      this.timer = 0.45;
      // Nearest-first assignment. Cheap enough at a few hundred candidates.
      const near: { i: number; d: number }[] = [];
      for (let i = 0; i < this.spots.length; i++) {
        const d = this.spots[i].distanceToSquared(cam);
        if (d < 3000) near.push({ i, d });
      }
      near.sort((a, b) => a.d - b.d);
      for (let k = 0; k < this.lights.length; k++) {
        const pick = near[k];
        this.assigned[k] = pick ? pick.i : -1;
        if (pick) this.lights[k].position.copy(this.spots[pick.i]);
      }
    }
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      const has = this.assigned[k] >= 0;
      // A little flicker keeps a sodium lamp from looking like a light probe.
      const f = 0.94 + 0.06 * Math.sin(performance.now() * 0.004 + k * 2.3);
      l.intensity = on && has ? this.intensity * 9.5 * f : 0;
    }
  }

  dispose(scene: THREE.Scene) { for (const l of this.lights) scene.remove(l); }
}

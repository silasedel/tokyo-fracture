import * as THREE from 'three';
import { G } from './globals';
import { clamp01, lerp, smoothstep } from '../util/math';

/**
 * Procedural sky: a gradient driven by sun elevation, three parallaxed cloud
 * shells that thicken into a storm, rain haze, city glow on the horizon and
 * lightning that lights the cloud deck from inside. It also feeds the PMREM
 * environment map, so reflections and ambient light always match the weather.
 */

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always on the far plane
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uCloud;      // 0..1 cover
uniform float uStorm;      // 0..1 darkness + turbulence
uniform float uTime;
uniform float uFlash;
uniform vec3  uFlashDir;
uniform float uNight;      // 0..1
uniform float uAshSky;     // volcanic haze
uniform float uCityGlow;
uniform float uWind;       // cloud drift speed
uniform vec3  uHorizon;
uniform vec3  uZenith;

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i=0;i<7;i++){
    if (i>=oct) break;
    s += a*vnoise(p); n += a; a *= 0.52; p = p*2.03 + vec2(17.1, 9.7);
  }
  return s/n;
}

// One cloud shell: project the view ray onto a plane at height h and sample FBM.
vec2 shellUV(vec3 d, float h, float drift){
  float t = h / max(d.y, 0.035);
  return d.xz * t * 0.0016 + vec2(uTime * drift * uWind, uTime * drift * 0.42 * uWind);
}

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  vec3 sun = normalize(uSunDir);
  float sunDot = max(dot(d, sun), 0.0);

  // --- base sky ---------------------------------------------------------
  float h = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.55);
  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.42, 0.95, h));
  // Mie-ish forward scatter near the sun
  float mie = pow(sunDot, 7.0) * 0.55 + pow(sunDot, 2.0) * 0.14;
  sky += uSunColor * mie * (1.0 - uStorm * 0.72) * (1.0 - uNight * 0.8);
  // Warm band at the horizon opposite the storm
  sky += uSunColor * 0.16 * pow(1.0 - abs(up), 8.0) * (1.0 - uNight);

  // stars
  if (uNight > 0.02 && up > 0.0) {
    vec2 sp = d.xz / max(d.y, 0.05) * 22.0;
    float st = pow(vnoise(floor(sp*12.0)), 42.0) * 6.0;
    sky += vec3(0.85, 0.9, 1.0) * st * uNight * (1.0 - uCloud * 0.96);
  }

  // --- clouds: three shells at different altitudes -----------------------
  float cover = uCloud;
  float turb = 1.0 + uStorm * 1.6;

  vec2 u1 = shellUV(d, 2600.0, 0.0065);
  vec2 u2 = shellUV(d, 1500.0, 0.0125);
  vec2 u3 = shellUV(d, 700.0,  0.0260);

  float n1 = fbm(u1 * 1.0 * turb, 5);
  float n2 = fbm(u2 * 1.9 * turb + n1 * 0.45, 5);
  float n3 = fbm(u3 * 3.6 * turb + n2 * 0.6, 4);

  float thr = mix(0.78, 0.08, cover);
  float c1 = smoothstep(thr, thr + 0.24, n1);
  float c2 = smoothstep(thr + 0.02, thr + 0.28, n2);
  float c3 = smoothstep(thr + 0.10, thr + 0.34, n3) * smoothstep(0.02, 0.25, up);

  // horizon fade so shells do not streak at grazing angles
  float hf = smoothstep(-0.02, 0.22, up);
  c1 *= hf; c2 *= hf; c3 *= hf;

  float dens = clamp(c1 * 0.55 + c2 * 0.72 + c3 * 0.5, 0.0, 1.0);
  // A solid overcast base so a storm reads as a lid, not as scattered cloud.
  dens = max(dens, cover * cover * (0.55 + uStorm * 0.42) * hf);

  // Lighting the deck: thin edges glow, thick cores go slate.
  float thickness = clamp((n1 + n2 * 1.15 + n3 * 0.6) / 2.4 + uStorm * 0.22, 0.0, 1.0);
  float silver = pow(sunDot, 5.0) * (1.0 - thickness) * 1.4;
  vec3 lit   = mix(vec3(0.80, 0.83, 0.88), uSunColor * 1.05, 0.42)
             * (1.0 - uNight * 0.88) * (1.0 - uStorm * 0.42);
  vec3 shade = mix(vec3(0.24, 0.27, 0.32), vec3(0.055, 0.062, 0.082), uStorm);
  shade *= (1.0 - uNight * 0.86);
  vec3 cloudCol = mix(lit, shade, clamp(thickness * (0.5 + uStorm * 0.75), 0.0, 1.0));
  cloudCol += uSunColor * silver * (1.0 - uStorm * 0.6);
  cloudCol = mix(cloudCol, cloudCol * vec3(1.05, 0.92, 0.78), uAshSky * 0.8);

  // Lightning lights the cloud from inside, strongest toward the bolt.
  float bolt = pow(max(dot(d, normalize(uFlashDir)), 0.0), 3.0);
  cloudCol += vec3(0.80, 0.86, 1.0) * uFlash * (0.35 + bolt * 2.2) * (0.35 + dens);

  vec3 col = mix(sky, cloudCol, dens * mix(0.82, 0.99, uStorm));

  // rain veil near the horizon under heavy storm
  float veil = uStorm * smoothstep(0.42, -0.05, up) * 0.55;
  col = mix(col, mix(vec3(0.34,0.38,0.44), vec3(0.10,0.11,0.14), uNight) * (1.0 + uFlash), veil);

  // city glow bounced off the cloud base
  col += vec3(1.0, 0.62, 0.34) * uCityGlow * smoothstep(0.30, -0.08, up) * (0.25 + dens * 0.75);

  // volcanic haze tint
  col = mix(col, vec3(0.30, 0.20, 0.17), uAshSky * smoothstep(0.55, -0.1, up) * 0.75);

  col += vec3(0.8, 0.86, 1.0) * uFlash * 0.22;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export interface SkyState {
  /** 0..1 — 0 is late afternoon, 1 is full night. */
  night: number;
  cloud: number;
  storm: number;
  ash: number;
  wind: number;
  cityGlow: number;
}

export class Sky {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  sun = new THREE.DirectionalLight(0xffffff, 3.0);
  fill = new THREE.HemisphereLight(0x9fb8d0, 0x3a3b38, 0.9);
  flashLight = new THREE.DirectionalLight(0xbfd4ff, 0);
  /** Scene used only for capturing the environment map. */
  private envScene = new THREE.Scene();
  private envMesh: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private rt: THREE.WebGLRenderTarget | null = null;
  envTexture: THREE.Texture | null = null;
  private envTimer = 0;
  sunDir = new THREE.Vector3(0.35, 0.42, -0.8).normalize();
  state: SkyState = { night: 0, cloud: 0.72, storm: 0.22, ash: 0, wind: 1, cityGlow: 0.06 };

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(1, 40, 24);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide,
      depthWrite: false, depthTest: false, fog: false, toneMapped: true,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uSunColor: { value: new THREE.Color(1, 0.93, 0.82) },
        uCloud: { value: 0.72 },
        uStorm: { value: 0.22 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uFlashDir: { value: new THREE.Vector3(0, 1, 0) },
        uNight: { value: 0 },
        uAshSky: { value: 0 },
        uCityGlow: { value: 0.05 },
        uWind: { value: 1 },
        uHorizon: { value: new THREE.Color(0.52, 0.58, 0.66) },
        uZenith: { value: new THREE.Color(0.18, 0.30, 0.48) },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    scene.add(this.mesh);

    this.envMesh = new THREE.Mesh(geo, this.mat);
    this.envMesh.frustumCulled = false;
    this.envScene.add(this.envMesh);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0007;
    this.sun.shadow.normalBias = 0.035;
    const c = this.sun.shadow.camera;
    c.left = -95; c.right = 95; c.top = 95; c.bottom = -95;
    c.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.fill);
    this.flashLight.position.set(0, 1, 0);
    scene.add(this.flashLight);
    scene.add(this.flashLight.target);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  setShadowRadius(size: number, mapSize: number) {
    const c = this.sun.shadow.camera;
    c.left = -size; c.right = size; c.top = size; c.bottom = -size;
    c.updateProjectionMatrix();
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  /** `t01` runs 0 (late afternoon) to 1 (night). */
  update(dt: number, camPos: THREE.Vector3, s: Partial<SkyState>, flash: number, flashDir: THREE.Vector3) {
    Object.assign(this.state, s);
    const st = this.state;
    const u = this.mat.uniforms;
    u.uTime.value += dt;
    u.uCloud.value = st.cloud;
    u.uStorm.value = st.storm;
    u.uNight.value = st.night;
    u.uAshSky.value = st.ash;
    u.uWind.value = st.wind;
    u.uCityGlow.value = st.cityGlow;
    u.uFlash.value = flash;
    (u.uFlashDir.value as THREE.Vector3).copy(flashDir);

    // Sun path: high-ish and warm, sinking below the horizon as night falls.
    // A properly high sun in fair weather: a 12-degree sun leaves every vertical
    // face in shadow and the whole city reads as dusk.
    const elev = lerp(0.62, -0.16, st.night) - st.storm * 0.10;
    const azim = lerp(-0.55, -1.25, st.night);
    this.sunDir.set(Math.cos(azim) * Math.cos(elev), Math.sin(elev), Math.sin(azim) * Math.cos(elev)).normalize();
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);

    // Colour grading of the light by elevation and storm thickness.
    const warm = smoothstep(0.30, -0.06, elev);
    const sunCol = new THREE.Color().setRGB(1, lerp(0.95, 0.60, warm), lerp(0.88, 0.34, warm));
    (u.uSunColor.value as THREE.Color).copy(sunCol);

    const dayMask = clamp01(smoothstep(-0.10, 0.06, elev));
    const cloudBlock = lerp(1, 0.045, clamp01(st.cloud * 0.5 + st.storm * 0.72));
    const sunI = 3.6 * dayMask * cloudBlock * lerp(1, 0.5, st.ash);
    this.sun.intensity = sunI;
    this.sun.color.copy(sunCol);
    this.sun.position.copy(camPos).addScaledVector(this.sunDir, 160);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();

    // Ambient fill drifts from cool daylight to a sodium-lit night.
    const ambDay = new THREE.Color(0.55, 0.64, 0.78);
    const ambNight = new THREE.Color(0.075, 0.095, 0.15);
    const gc = new THREE.Color(0.20, 0.17, 0.14).lerp(new THREE.Color(0.32, 0.20, 0.13), st.cityGlow);
    this.fill.color.copy(ambDay).lerp(ambNight, st.night);
    this.fill.groundColor.copy(gc);
    this.fill.intensity = lerp(0.72, 0.12, st.night) * lerp(1, 0.62, st.storm) + st.cityGlow * 0.3;

    this.flashLight.intensity = flash * 9.0;
    this.flashLight.position.copy(camPos).addScaledVector(flashDir, 120);
    this.flashLight.target.position.copy(camPos);
    this.flashLight.target.updateMatrixWorld();

    // Sky gradient colours
    const hz = new THREE.Color().setRGB(
      lerp(0.52, 0.040, st.night), lerp(0.58, 0.050, st.night), lerp(0.70, 0.080, st.night));
    const zn = new THREE.Color().setRGB(
      lerp(0.115, 0.012, st.night), lerp(0.225, 0.021, st.night), lerp(0.46, 0.046, st.night));
    hz.lerp(new THREE.Color(0.155, 0.165, 0.190), st.storm * 0.7);
    zn.lerp(new THREE.Color(0.052, 0.058, 0.072), st.storm * 0.72);
    hz.lerp(new THREE.Color(0.24, 0.13, 0.10), st.ash * 0.65);
    (u.uHorizon.value as THREE.Color).copy(hz);
    (u.uZenith.value as THREE.Color).copy(zn);
    G.uSkyHorizon.value.copy(hz);
    G.uSkyZenith.value.copy(zn);

    // Shared fog follows the sky so distant geometry dissolves into it.
    G.uFogColor.value.copy(hz).lerp(zn, 0.22).multiplyScalar(lerp(1.0, 0.85, st.storm));
    G.uSunDir.value.copy(this.sunDir);
    G.uSunColor.value.copy(sunCol);

    this.mesh.position.copy(camPos);
    this.mesh.scale.setScalar(4000);
    this.envTimer -= dt;
  }

  /** Cheap enough at 128px to refresh a couple of times a second. */
  maybeRefreshEnv(renderer: THREE.WebGLRenderer, force = false) {
    if (!force && this.envTimer > 0) return false;
    this.envTimer = 1.4;
    const prev = this.rt;
    this.envMesh.scale.setScalar(100);
    this.envMesh.position.set(0, 0, 0);
    this.rt = this.pmrem.fromScene(this.envScene, 0.0, 0.5, 200);
    this.envTexture = this.rt.texture;
    if (prev) prev.dispose();
    void renderer;
    return true;
  }

  dispose() {
    this.rt?.dispose();
    this.pmrem.dispose();
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}

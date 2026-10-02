import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Draws a second scene on top of the first with a fresh depth buffer. This is
 * what keeps the first-person arms out of walls: they are near-field geometry
 * that must never be depth-tested against the world.
 *
 * Three's own RenderPass clears depth before binding the target, which clears
 * the wrong buffer, so this does the two steps in the right order.
 */
class OverlayPass extends Pass {
  constructor(public oScene: THREE.Scene, public oCamera: THREE.Camera) {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }
  render(renderer: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.oScene, this.oCamera);
    renderer.autoClear = autoClear;
  }
}

// ---------------------------------------------------------------------------
// Screen-space distortion: heat shimmer above fires, underwater wobble and
// water running down the lens. Runs in HDR before tone mapping.
// ---------------------------------------------------------------------------
const LensShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1.7778 },
    uUnderwater: { value: 0 },
    uRain: { value: 0 },
    uHeat: { value: new Array(6).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0)) },
    uShake: { value: new THREE.Vector2(0, 0) },
    uBlast: { value: 0 },
    uFx: { value: 0.35 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uUnderwater, uRain, uBlast, uFx;
    uniform vec4 uHeat[6];
    uniform vec2 uShake;

    float h21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
    float n21(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
    }

    // Beads of water clinging to the glass. Deliberately small: the effect is
    // meant to read as a few droplets, never as a warped picture.
    vec2 rainLens(vec2 uv, float amt){
      if (amt < 0.004) return vec2(0.0);
      vec2 g = vec2(uv.x * 9.0, uv.y * 3.4 - uTime * 0.30);
      vec2 id = floor(g);
      vec2 f = fract(g);
      float r = h21(id);
      float speed = 0.35 + r * 0.9;
      float y = fract(f.y - uTime * speed * 0.55 - r * 7.0);
      float w = 0.5 + 0.5 * sin(r * 30.0);
      float drop = smoothstep(0.26, 0.0, length(vec2((f.x - 0.5) * 1.9, (y - 0.5) * 0.55)));
      float trail = smoothstep(0.10, 0.0, abs(f.x - 0.5)) * smoothstep(0.0, 0.55, y) * 0.35;
      float m = (drop + trail) * w * amt;
      vec2 dir = normalize(vec2((f.x - 0.5), (y - 0.5) * 0.4) + 1e-5);
      return dir * m * 0.0055;
    }

    void main(){
      vec2 uv = vUv + uShake;
      vec2 c = uv - 0.5; c.x *= uAspect;

      // heat shimmer from nearby fires
      vec2 off = vec2(0.0);
      for (int i=0;i<6;i++){
        vec4 hs = uHeat[i];
        if (hs.w <= 0.0) continue;
        vec2 d = uv - hs.xy; d.x *= uAspect;
        float m = smoothstep(hs.z, 0.0, length(d)) * hs.w;
        if (m <= 0.0) continue;
        float n = n21(uv * vec2(28.0, 12.0) + vec2(0.0, -uTime * 2.2) + float(i) * 13.0);
        float n2 = n21(uv * vec2(55.0, 21.0) + vec2(uTime * 0.8, -uTime * 3.4));
        off += vec2((n - 0.5) * 1.0, (n2 - 0.5) * 1.6) * m * 0.016;
      }

      if (uUnderwater > 0.001){
        float w1 = sin(uv.y * 34.0 + uTime * 2.4) * 0.0018;
        float w2 = sin(uv.x * 25.0 - uTime * 1.7) * 0.0016;
        off += vec2(w1, w2) * uUnderwater * 2.2;
      }

      off += rainLens(uv, uRain * uFx);

      // shockwave ripple
      if (uBlast > 0.001){
        float r = length(c);
        off += normalize(c + 1e-5) * sin(r * 26.0 - uTime * 14.0) * 0.010 * uBlast * smoothstep(1.2, 0.0, r);
      }

      vec2 suv = clamp(uv + off, 0.0, 1.0);
      vec3 col = texture2D(tDiffuse, suv).rgb;

      if (uUnderwater > 0.001){
        vec3 tint = vec3(0.42, 0.78, 0.86);
        col = mix(col, col * tint, uUnderwater * 0.7);
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------
// Final grade in LDR: filmic contrast, vignette, damage, grain, aberration.
// ---------------------------------------------------------------------------
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.17 },
    uDamage: { value: 0 },
    uGrain: { value: 0.008 },
    uAberration: { value: 0.0 },
    uSaturation: { value: 1.16 },
    uContrast: { value: 1.12 },
    uLift: { value: new THREE.Vector3(0.002, 0.005, 0.013) },
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.982) },
    uAspect: { value: 1.7778 },
    uFade: { value: 0 },
    uDesat: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uDamage, uGrain, uAberration, uSaturation, uContrast, uAspect, uFade, uDesat;
    uniform vec3 uLift, uGain;

    float h21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5; c.x *= uAspect;
      float r2 = dot(c, c);

      // Aberration is off unless the player is actually hurt: a permanent
      // colour fringe just makes the whole picture look soft and wrong.
      float ab = (uAberration + uDamage * 0.0016) * (0.25 + r2 * 2.2);
      vec3 col;
      if (ab > 0.00002) {
        vec2 dir = normalize(c + 1e-6);
        col.r = texture2D(tDiffuse, uv - dir * ab).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv + dir * ab).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // Filmic S-curve first, then lift / gain / saturation. The toe keeps the
      // shadows from turning to mud and the shoulder holds the highlights.
      col = clamp(col, 0.0, 1.0);
      col = col * col * (3.0 - 2.0 * col) * 0.34 + col * 0.66;
      col = col * uGain + uLift;
      col = (col - 0.44) * uContrast + 0.44;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = mix(vec3(l), col, 1.0 - uDesat);

      // vignette
      float vig = 1.0 - uVignette * smoothstep(0.30, 1.45, r2);
      col *= vig;

      // injury: blood-red edge pulse
      if (uDamage > 0.001){
        float d = smoothstep(0.06, 0.95, r2);
        col = mix(col, mix(col, vec3(0.62, 0.04, 0.02), 0.85), d * uDamage);
        col *= 1.0 - 0.18 * uDamage;
      }

      // film grain, slightly stronger in shadow
      float g = h21(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.15 - l * 0.7);

      col *= (1.0 - uFade);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface PostOptions {
  ao: boolean;
  bloom: boolean;
  smaa: boolean;
  resolutionScale: number;
}

export class Post {
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  lens: ShaderPass;
  grade: ShaderPass;
  smaa: SMAAPass;
  output: OutputPass;
  gtao: GTAOPass | null = null;
  overlay: OverlayPass | null = null;
  private w = 1; private h = 1;
  opts: PostOptions;

  constructor(
    public renderer: THREE.WebGLRenderer,
    public scene: THREE.Scene,
    public camera: THREE.PerspectiveCamera,
    opts: Partial<PostOptions> = {},
  ) {
    this.opts = { ao: true, bloom: true, smaa: true, resolutionScale: 1, ...opts };
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (this.opts.ao) {
      this.gtao = new GTAOPass(scene, camera, size.x, size.y);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.updateGtaoMaterial({
        radius: 0.62, distanceExponent: 1.4, thickness: 0.9, scale: 1.05,
        samples: 14, distanceFallOff: 0.9, screenSpaceRadius: false,
      });
      this.gtao.blendIntensity = 1.0;
      this.composer.addPass(this.gtao);
    }

    this.overlay = new OverlayPass(scene, camera);
    this.composer.addPass(this.overlay);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.30, 0.62, 0.94);
    this.bloom.enabled = this.opts.bloom;
    this.composer.addPass(this.bloom);

    this.lens = new ShaderPass(LensShader as unknown as THREE.ShaderMaterialParameters);
    this.composer.addPass(this.lens);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.grade = new ShaderPass(GradeShader as unknown as THREE.ShaderMaterialParameters);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass(size.x, size.y);
    this.smaa.enabled = this.opts.smaa;
    this.composer.addPass(this.smaa);
  }

  /** Point the overlay at the view-model scene (or disable it with null). */
  setOverlay(scene: THREE.Scene | null, camera: THREE.Camera | null) {
    if (!this.overlay) return;
    if (scene && camera) {
      this.overlay.oScene = scene;
      this.overlay.oCamera = camera;
      this.overlay.enabled = true;
    } else this.overlay.enabled = false;
  }

  setSize(w: number, h: number) {
    this.w = w; this.h = h;
    this.composer.setSize(w, h);
    this.gtao?.setSize(w, h);
    this.bloom.setSize(w, h);
    this.smaa.setSize(w, h);
    this.lens.uniforms.uAspect.value = w / h;
    this.grade.uniforms.uAspect.value = w / h;
  }

  setQuality(o: Partial<PostOptions>) {
    Object.assign(this.opts, o);
    this.bloom.enabled = this.opts.bloom;
    this.smaa.enabled = this.opts.smaa;
    if (this.gtao) this.gtao.enabled = this.opts.ao;
  }

  get size() { return { w: this.w, h: this.h }; }

  /**
   * Master strength for the "camera artefact" layer — rain on the lens, grain,
   * colour fringing, vignette. At 0 the image is completely clean.
   */
  setLensFx(v: number) {
    const k = Math.max(0, Math.min(1, v));
    this.lens.uniforms.uFx.value = k;
    this.grade.uniforms.uGrain.value = 0.022 * k;
    this.grade.uniforms.uVignette.value = 0.10 + 0.24 * k;
    this.grade.uniforms.uAberration.value = 0.0011 * k * k;
  }

  render(dt: number) {
    this.lens.uniforms.uTime.value += dt;
    this.grade.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }

  dispose() { this.composer.dispose(); }
}

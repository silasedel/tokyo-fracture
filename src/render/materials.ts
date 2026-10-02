import * as THREE from 'three';
import type { Mat } from '../physics/materials';
import { G, SHARED_DECL, FOG_FRAG } from './globals';

// ---------------------------------------------------------------------------
// One patched PBR material per (substance, usage). The patch wires in the
// shared world uniforms plus a per-instance state vector so a single instanced
// draw can contain objects that are charred, glowing, freshly wet or tinted.
//
//   aState.x  char      0..1  blackening from fire
//   aState.y  burnGlow  0..1  active flame emission
//   aState.z  variation 0..1  stable per-object hue/brightness jitter
//   aState.w  emissive  gain  (1 = as authored, 0 = dark sign)
// ---------------------------------------------------------------------------

export interface MatOptions {
  instanced?: boolean;
  vary?: number;        // 0..1 amount of per-instance tint variation
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  colorOverride?: number;
  roughOverride?: number;
  metalOverride?: number;
  flatShading?: boolean;
  wetResponse?: number;
  /** Reduce how strongly ash settles (e.g. vertical signage). */
  ashScale?: number;
  /**
   * Mains-powered light: neon, shop signs, vending machines. Dim in daylight,
   * bright after dark, and dead the moment the grid fails.
   */
  signage?: boolean;
  alphaTest?: number;
  map?: THREE.Texture | null;
  envIntensity?: number;
  /**
   * Draw a world-space chamfer on the edges of a unit-cube instance. Lets the
   * whole city share one box geometry without the bevel stretching.
   */
  chamfer?: boolean;
  chamferSize?: number;
  /**
   * Draw a whole storey of facade — windows, mullions, sills, shopfront,
   * interior lights — procedurally in world units on a plain unit box. One
   * material covers every panel size in the city.
   */
  facade?: { style: 'office' | 'apartment' | 'shophouse' | 'warehouse'; ground: boolean };
}

const bank = new Map<string, THREE.MeshStandardMaterial>();
const patched: THREE.MeshStandardMaterial[] = [];

function key(m: Mat, o: MatOptions) {
  return [m.id, o.instanced ? 1 : 0, o.vary ?? 0, o.emissive ?? m.emissive ?? -1,
    o.emissiveIntensity ?? m.emissiveIntensity ?? 0, o.transparent ? 1 : 0, o.opacity ?? 1,
    o.side ?? 0, o.colorOverride ?? -1, o.roughOverride ?? -1, o.metalOverride ?? -1,
    o.flatShading ? 1 : 0, o.ashScale ?? 1, o.alphaTest ?? 0, o.envIntensity ?? 1,
    o.chamfer ? 1 : 0, o.chamferSize ?? 0.05, o.signage ? 1 : 0,
    o.facade ? `${o.facade.style}${o.facade.ground ? 'G' : ''}` : '',
    o.map ? o.map.uuid : ''].join('|');
}

export function makeMaterial(m: Mat, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const k = key(m, o);
  const hit = bank.get(k);
  if (hit) return hit;

  const mat = new THREE.MeshStandardMaterial({
    color: o.colorOverride ?? m.color,
    roughness: o.roughOverride ?? m.roughness,
    metalness: o.metalOverride ?? m.metalness,
    transparent: o.transparent ?? m.transparent ?? false,
    opacity: o.opacity ?? m.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    flatShading: o.flatShading ?? false,
    emissive: new THREE.Color(o.emissive ?? m.emissive ?? 0x000000),
    emissiveIntensity: o.emissiveIntensity ?? m.emissiveIntensity ?? 1,
    map: o.map ?? null,
    alphaTest: o.alphaTest ?? 0,
    envMapIntensity: o.envIntensity ?? 1,
  });
  mat.name = `${m.id}${o.instanced ? '/i' : ''}`;
  if (mat.transparent) { mat.depthWrite = false; }

  const instanced = !!o.instanced;
  const chamfer = !!o.chamfer || !!o.facade;
  const fac = o.facade;
  const facStyle = fac ? ({ office: 0, apartment: 1, shophouse: 2, warehouse: 3 })[fac.style] : -1;
  const chamferSize = o.chamferSize ?? 0.05;
  const vary = o.vary ?? 0;
  const wetResp = o.wetResponse ?? m.wetResponse;
  const ashScale = o.ashScale ?? 1;
  const signage = !!o.signage;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G);
    shader.uniforms.uWetResp = { value: wetResp };
    shader.uniforms.uVary = { value: vary };
    shader.uniforms.uAshScale = { value: ashScale };
    if (chamfer) shader.uniforms.uChamfer = { value: chamferSize };
    if (fac) { shader.uniforms.uFacStyle = { value: facStyle }; shader.uniforms.uFacGround = { value: fac.ground ? 1 : 0 }; }

    shader.vertexShader = `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec4 vState;
      uniform float uTime;
      uniform vec4  uQuake;
      ${chamfer ? 'varying vec3 vLocal;\nvarying vec3 vBoxScale;\nvarying vec3 vAxX;\nvarying vec3 vAxY;' : ''}
      ${instanced ? 'attribute vec4 aState;' : ''}
    ` + shader.vertexShader;

    // Seismic sway: a travelling wave through the city whose amplitude grows
    // with height. The CPU mirrors this exactly for the building the player is
    // standing in, so its colliders move with what you see.
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 _mv = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        _mv = instanceMatrix * _mv;
      #endif
      vec4 _world = modelMatrix * _mv;
      float _hgt = max(0.0, _world.y);
      float _swp = sin(uTime * uQuake.z - (_world.x * 0.026 + _world.z * 0.019));
      float _swk = pow(min(_hgt, 90.0) / 30.0, 1.35);
      _world.x += uQuake.x * _swk * _swp;
      _world.z += uQuake.y * _swk * _swp;
      vec4 mvPosition = viewMatrix * _world;
      gl_Position = projectionMatrix * mvPosition;
    `);

    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `
      vec3 _n  = objectNormal;
      #ifdef USE_INSTANCING
        _n  = mat3(instanceMatrix) * _n;
      #endif
      vWorldPos = _world.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * _n);
      ${instanced ? 'vState = aState;' : 'vState = vec4(0.0, 0.0, 0.5, 1.0);'}
      ${chamfer ? `
      mat3 _im = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        _im = _im * mat3(instanceMatrix);
      #endif
      vBoxScale = vec3(length(_im[0]), length(_im[1]), length(_im[2]));
      vAxX = _im[0] / max(vBoxScale.x, 1e-5);
      vAxY = _im[1] / max(vBoxScale.y, 1e-5);
      vLocal = position;
      ` : ''}
    `);

    shader.fragmentShader = `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec4 vState;
      uniform float uWetResp;
      uniform float uVary;
      uniform float uAshScale;
      ${chamfer ? 'varying vec3 vLocal;\nvarying vec3 vBoxScale;\nvarying vec3 vAxX;\nvarying vec3 vAxY;\nuniform float uChamfer;' : ''}
      ${fac ? 'uniform float uFacStyle;\nuniform float uFacGround;' : ''}
      ${SHARED_DECL}
    ` + shader.fragmentShader;

    // Albedo: charring, per-instance tint, wet darkening, settled ash.
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float _char = vState.x;
      float _wet  = clamp(uWetness * uWetResp, 0.0, 1.0);
      float _up   = clamp(vWorldNormal.y, 0.0, 1.0);
      float _ash  = clamp(uAsh * uAshScale, 0.0, 1.0) * pow(_up, 1.5) * (1.0 - _wet * 0.55);
      diffuseColor.rgb *= (1.0 - uVary * 0.5 + uVary * vState.z);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.040, 0.036, 0.033), _char * 0.93);
      diffuseColor.rgb *= mix(1.0, 0.58, _wet);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.315, 0.305, 0.295), _ash * 0.88);
    `);

    if (chamfer) {
      // Edges get a real chamfer's shading without any extra geometry: the
      // normal rolls toward the neighbouring face within uChamfer metres.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        {
          vec3 _dd = (vec3(0.5) - abs(vLocal)) * vBoxScale;
          vec3 _azv = cross(vAxX, vAxY);
          float _r = uChamfer;
          vec3 _wn = normalize(vWorldNormal);
          vec3 _add = vec3(0.0);
          if (abs(dot(_wn, vAxX)) < 0.86) _add += vAxX * sign(vLocal.x) * (1.0 - smoothstep(0.0, _r, _dd.x));
          if (abs(dot(_wn, vAxY)) < 0.86) _add += vAxY * sign(vLocal.y) * (1.0 - smoothstep(0.0, _r, _dd.y));
          if (abs(dot(_wn, _azv)) < 0.86) _add += _azv * sign(vLocal.z) * (1.0 - smoothstep(0.0, _r, _dd.z));
          normal = normalize(normal + mat3(viewMatrix) * _add * 1.15);
        }
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        {
          vec3 _dd2 = (vec3(0.5) - abs(vLocal)) * vBoxScale;
          float _edge = min(min(_dd2.x, _dd2.y), _dd2.z);
          // a hairline of grime in the corner, and a lighter worn arris
          diffuseColor.rgb *= mix(1.0, 0.72, 1.0 - smoothstep(0.0, uChamfer * 0.55, _edge));
          diffuseColor.rgb *= mix(1.0, 1.14, smoothstep(uChamfer * 1.6, uChamfer * 0.7, _edge) * step(uChamfer * 0.6, _edge));
        }
      `);
    }


    if (fac) {
      // One shader draws every wall in the city: single-storey panels, whole
      // shell buildings and the distant skyline. Everything is laid out in
      // metres taken from the instance's own scale, so nothing stretches, and
      // the openings are shaded as real reveals — a head shadow at the top of
      // the glass, a proud sill, grime washing down from it — because that
      // depth is what separates a building from a painted box.
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        float _fWin = 0.0, _fGlass = 0.0, _fLit = 0.0, _fFrame = 0.0, _fSign = 0.0;
        vec2 _fGrad = vec2(0.0);
        vec3 _fSignCol = vec3(0.0);
        {
          vec3 _wn2 = normalize(vWorldNormal);
          vec3 _azf = cross(vAxX, vAxY);
          float _ax = abs(dot(_wn2, vAxX));
          float _ay = abs(dot(_wn2, vAxY));
          float _az = abs(dot(_wn2, _azf));
          if (_ay < 0.6) {
            float W = (_az >= _ax) ? vBoxScale.x : vBoxScale.z;
            float u = (_az >= _ax) ? vLocal.x * W : vLocal.z * W;
            float H = vBoxScale.y;
            float vy = vLocal.y * H;
            float seed = vState.z;
            float st = uFacStyle;

            float storeyH = (H <= 5.6) ? H : (st < 0.5 ? 3.55 : st > 2.5 ? 4.6 : 3.25);
            float nSt = max(1.0, floor(H / storeyH + 0.02));
            if (H > 5.6) storeyH = H / nSt;
            float sIdx = floor((vy + H * 0.5) / storeyH);
            float py = (vy + H * 0.5) - (sIdx + 0.5) * storeyH;
            float fy = py + storeyH * 0.5;                    // metres above this floor
            float ground = max(uFacGround, (H > 5.6 && sIdx < 0.5) ? 1.0 : 0.0);
            float top = (H > 5.6 && sIdx > nSt - 1.5) ? 1.0 : 0.0;
            float hs = fract(sin(seed * 91.7 + sIdx * 37.719) * 43758.5453);

            // ---------------------------------------------------- cladding
            // Panel joints, a plinth at pavement level and a string course
            // where the shopfront meets the floors above.
            float jointW = (st < 0.5) ? 1.45 : (st > 2.5 ? 0.90 : 1.15);
            float jv = smoothstep(0.030, 0.006, abs(fract(u / jointW + 0.5) - 0.5) * jointW);
            float jh = smoothstep(0.030, 0.006, abs(fract(fy / jointW + 0.5) - 0.5) * jointW);
            diffuseColor.rgb *= 1.0 - (jv * 0.10 + jh * 0.07);
            if (st > 2.5) {
              float rib = smoothstep(0.40, 0.5, abs(fract(u / 0.62) - 0.5));
              diffuseColor.rgb *= 0.90 + rib * 0.20;
            }
            // corner pilasters catch the light
            float corner = smoothstep(0.42, 0.10, (W * 0.5 - abs(u)));
            diffuseColor.rgb *= 1.0 + corner * 0.10;

            float plinth = ground * smoothstep(0.62, 0.50, fy);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.196, 0.19), plinth * 0.78);
            float course = ground * smoothstep(0.13, 0.03, abs(fy - (storeyH - 0.12)));
            diffuseColor.rgb *= 1.0 + course * 0.22;
            float coping = top * smoothstep(0.12, 0.02, abs(fy - (storeyH - 0.10)));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.41), coping * 0.55);

            // ---------------------------------------------------- openings
            if (W > 0.7 && storeyH > 1.4) {
              float bayW = (st < 0.5) ? 1.95 : (st < 1.5 ? 2.70 : (st < 2.5 ? 2.45 : 3.6));
              float nx = max(1.0, floor(W / bayW + 0.35));
              float cw = W / nx;
              float idx = floor((u + W * 0.5) / cw);
              float lx = mod(u + W * 0.5, cw) - cw * 0.5;
              float bh = fract(sin(idx * 12.9898 + seed * 78.233 + sIdx * 37.719) * 43758.5453);

              float ww, wh, wcy, mull = 0.0, doorM = 0.0, signBand = 0.0;
              bool shopfront = (st > 1.5 && st < 2.5 && ground > 0.5) || (st < 0.5 && ground > 0.5);

              if (shopfront) {
                // A real shopfront: stallriser, tall glazing, sign band above,
                // and one bay of the run given over to the entrance doors.
                signBand = smoothstep(storeyH - 0.98, storeyH - 0.86, fy);
                float gTop = storeyH - 1.08;
                float riser = 0.34;
                float doorIdx = floor(fract(sin(seed * 33.13 + 7.7) * 43758.5453) * nx);
                doorM = (abs(idx - doorIdx) < 0.5) ? 1.0 : 0.0;
                float base = mix(riser, 0.04, doorM);
                ww = cw - 0.20;
                wh = gTop - base;
                wcy = -storeyH * 0.5 + base + wh * 0.5;
                // vertical mullions every ~1.1m, plus the meeting stile of the doors
                float mstep = mix(1.10, cw * 0.5, doorM);
                mull = smoothstep(0.035, 0.012, abs(fract(lx / mstep + 0.5) - 0.5) * mstep);
              } else if (st < 0.5) {
                ww = cw * 0.90; wh = storeyH - 1.12; wcy = -storeyH * 0.5 + 0.70 + wh * 0.5;
                mull = smoothstep(0.030, 0.010, abs(lx));
              } else if (st < 1.5) {
                ww = min(1.62, cw * 0.62); wh = min(1.58, storeyH - 1.45);
                wcy = -storeyH * 0.5 + 0.92 + wh * 0.5;
                mull = smoothstep(0.026, 0.008, abs(lx)) + smoothstep(0.024, 0.008, abs(py - wcy));
              } else if (st < 2.5) {
                ww = min(1.42, cw * 0.58); wh = min(1.45, storeyH - 1.30);
                wcy = -storeyH * 0.5 + 0.86 + wh * 0.5;
                mull = smoothstep(0.024, 0.008, abs(lx));
              } else {
                ww = W * 0.88; wh = 0.95; wcy = storeyH * 0.5 - 1.15; lx = u; idx = 0.0;
                mull = smoothstep(0.036, 0.012, abs(fract(u / 1.8 + 0.5) - 0.5) * 1.8);
              }

              float ex = ww * 0.5 - abs(lx);
              float ey = wh * 0.5 - abs(py - wcy);
              float e = min(ex, ey);
              _fWin = smoothstep(-0.012, 0.018, e);
              float frameT = shopfront ? 0.060 : 0.055;
              _fGlass = smoothstep(frameT, frameT + 0.032, e) * (1.0 - clamp(mull, 0.0, 1.0));
              _fFrame = _fWin - _fGlass;
              _fGrad = vec2(ex < ey ? -sign(lx) : 0.0, ey <= ex ? -sign(py - wcy) : 0.0)
                       * (1.0 - smoothstep(0.0, 0.10, abs(e)));

              // --- reveal: the head of the opening shades the top of the glass
              float head = smoothstep(0.0, 0.30, (wcy + wh * 0.5) - py);
              float jamb = smoothstep(0.0, 0.16, ex);
              float reveal = mix(0.34, 1.0, head * 0.65 + 0.35) * mix(0.72, 1.0, jamb);

              // --- sill, proud below the opening, with its own drip shadow
              float sillY = wcy - wh * 0.5;
              float sill = smoothstep(0.075, 0.020, abs(py - (sillY - 0.055))) * step(abs(lx), ww * 0.60);
              float underSill = smoothstep(0.30, 0.0, (sillY - 0.10) - py) * step(abs(lx), ww * 0.60)
                                * step(py, sillY - 0.10);
              diffuseColor.rgb *= 1.0 + sill * 0.20 - underSill * 0.12;

              // --- grime washing down from the sill
              float streak = fract(sin(floor(u * 5.3) * 45.23 + seed * 11.0) * 43758.5453);
              float wash = clamp((sillY - py) / max(1.0, storeyH), 0.0, 1.0);
              float grime = (1.0 - _fWin) * step(abs(lx), ww * 0.70)
                            * smoothstep(0.0, 0.35, wash) * (1.0 - smoothstep(0.55, 1.0, wash))
                            * (0.35 + streak * 0.65) * 0.16;
              diffuseColor.rgb *= 1.0 - grime;

              // --- glass
              // Dark where it looks into a room, lighter where it mirrors the
              // sky; the reflection strengthens with height like a real tower.
              float skyMix = clamp(0.18 + (vWorldPos.y) * 0.010, 0.0, 0.72);
              vec3 glassCol = mix(vec3(0.028, 0.038, 0.050), vec3(0.16, 0.20, 0.25), skyMix);
              glassCol = mix(glassCol, vec3(0.055, 0.075, 0.070), fract(seed * 5.7) * 0.5);
              glassCol *= reveal;
              // blinds and curtains in a share of the rooms
              float blindAmt = step(0.62, bh) * (0.35 + fract(bh * 7.3) * 0.5);
              float blindTop = step(py - wcy, wh * (0.5 - blindAmt * 0.9));
              float blinds = (1.0 - blindTop) * step(0.62, bh) * (1.0 - float(shopfront));
              float slat = 0.85 + 0.15 * step(0.5, fract((py - wcy) / 0.075));
              glassCol = mix(glassCol, vec3(0.46, 0.44, 0.40) * slat, blinds * 0.85);

              diffuseColor.rgb = mix(diffuseColor.rgb, glassCol, _fGlass * vState.w);
              // frame and mullions: dark anodised metal, lighter on the sunward side
              vec3 frameCol = (st < 0.5) ? vec3(0.13, 0.135, 0.145) : vec3(0.26, 0.235, 0.205);
              diffuseColor.rgb = mix(diffuseColor.rgb, frameCol, min(1.0, _fFrame + mull * _fWin) * 0.9);
              // broken-out glazing reads as a black hole
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012), _fGlass * (1.0 - vState.w));

              // --- shopfront sign band
              if (shopfront) {
                float sb = signBand * (1.0 - smoothstep(storeyH - 0.10, storeyH - 0.02, fy));
                vec3 sc = vec3(0.86, 0.22, 0.20);
                float ph2 = fract(seed * 13.7);
                sc = ph2 < 0.25 ? vec3(0.88, 0.24, 0.20)
                   : ph2 < 0.50 ? vec3(0.10, 0.26, 0.52)
                   : ph2 < 0.72 ? vec3(0.94, 0.80, 0.22)
                   : ph2 < 0.88 ? vec3(0.10, 0.42, 0.30) : vec3(0.92, 0.92, 0.90);
                diffuseColor.rgb = mix(diffuseColor.rgb, sc * 0.55, sb);
                // characters suggested by a rhythm of blocks along the band
                float ch = step(0.42, fract(u * 1.9 + seed * 3.0)) * step(abs(fy - (storeyH - 0.55)), 0.17);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96), sb * ch * 0.8);
                _fSign = sb * uPower * clamp(uNightLights * 1.3, 0.0, 1.0) * vState.w;
                _fSignCol = sc;
                // door furniture: a push bar across the entrance leaves
                float bar = doorM * step(abs(py - (wcy - wh * 0.5 + 1.04)), 0.026)
                            * step(abs(lx), ww * 0.44) * _fGlass;
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.63, 0.66), bar);
              }

              // --- lit rooms at night
              float on = step(1.0 - clamp(uNightLights, 0.0, 1.0) * 0.78, bh) * uPower;
              _fLit = _fGlass * on * clamp(uNightLights, 0.0, 1.0) * vState.w
                      * (0.30 + bh * 0.90) * mix(1.0, 0.45, blinds);
            }

            // floor line between storeys
            float band = smoothstep(0.14, 0.0, abs(abs(py) - storeyH * 0.5));
            diffuseColor.rgb *= mix(1.0, 0.90, band * step(5.6, H));
            // general soiling: the higher and the more sheltered, the cleaner
            diffuseColor.rgb *= 1.0 - (1.0 - _fWin) * 0.05 * fract(seed * 17.3);
          }
        }
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.035, _fGlass * vState.w);
        roughnessFactor = mix(roughnessFactor, 0.34, _fFrame);
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `
        #include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.42, _fGlass * vState.w);
        metalnessFactor = mix(metalnessFactor, 0.55, _fFrame * 0.6);
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        normal = normalize(normal + mat3(viewMatrix) * (vAxX * _fGrad.x + vAxY * _fGrad.y) * 0.75);
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        totalEmissiveRadiance += mix(vec3(1.0, 0.74, 0.46), vec3(0.66, 0.82, 1.0), fract(vState.z * 7.1))
          * _fLit * 0.70;
        totalEmissiveRadiance += _fSignCol * _fSign * 1.15;
      `);
    }

    // Surface response: wet = mirror-smooth, ash = matte, char = rough.
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.050, _wet * 0.88);
      roughnessFactor = mix(roughnessFactor, 0.94,  _ash * 0.92);
      roughnessFactor = mix(roughnessFactor, 0.86,  _char * 0.75);
      roughnessFactor = clamp(roughnessFactor, 0.02, 1.0);
    `);

    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      totalEmissiveRadiance *= vState.w;
      ${signage ? `
      // Signage runs off the grid: it lifts as the light goes and dies with the
      // power. A blackout should take the neon with it, not leave it hanging.
      totalEmissiveRadiance *= uPower * (0.34 + clamp(uNightLights, 0.0, 1.0) * 2.1);
      ` : ''}
      float _fl = 0.55 + 0.45 * sin(uTime * 11.0 + vState.z * 53.0)
                       * (0.6 + 0.4 * sin(uTime * 27.0 + vState.z * 17.0));
      totalEmissiveRadiance += vec3(1.0, 0.33, 0.055) * vState.y * (0.35 + _fl) * 2.6;
    `);

    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', FOG_FRAG);
  };
  mat.customProgramCacheKey = () => k;

  bank.set(k, mat);
  patched.push(mat);
  return mat;
}

/** Flat colour helper for decorative bits that still want world fog + wetness. */
export function simpleMaterial(color: number, rough = 0.8, metal = 0.0, o: MatOptions = {}) {
  const fake: Mat = {
    id: `c${color.toString(16)}`, density: 1000, toughness: 1000, strength: 1, hardness: 0.5,
    brittleness: 0.4, friction: 0.7, restitution: 0.2, flammability: 0, ignitionTemp: 9999,
    burnRate: 0, heatCapacity: 1000, conductivity: 0.3, eConductivity: 0.1, absorbency: 0.2,
    drag: 1.05, heatWeakening: 1, color, roughness: rough, metalness: metal, wetResponse: 0.7,
  };
  return makeMaterial(fake, o);
}

export function setEnvironment(env: THREE.Texture | null) {
  for (const m of patched) { m.envMap = env; m.needsUpdate = false; }
}

export function disposeMaterials() {
  for (const m of patched) m.dispose();
  bank.clear(); patched.length = 0;
}

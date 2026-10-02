import * as THREE from 'three';
import { CityPlan, MAP, HALF, groundHeight, RIVER_Z, RIVER_HALF, SHORE_Z } from './cityplan';
import { G, SHARED_DECL, FOG_FRAG } from '../render/globals';
import { Rng, clamp, clamp01 } from '../util/math';
import type { PhysWorld } from '../physics/physworld';
import { RAPIER } from '../physics/physworld';
import { MATERIALS } from '../physics/materials';
import { Kind, GROUP, MOVING, interactionGroups } from '../physics/entity';

const SEG = 192;                     // collider + mesh resolution (~2.7 m cells)
const N = SEG + 1;

export class Terrain {
  heights = new Float32Array(N * N);
  mesh!: THREE.Mesh;
  mat!: THREE.MeshStandardMaterial;
  groundTex!: THREE.CanvasTexture;
  surfTex!: THREE.CanvasTexture;
  body: RAPIER.RigidBody | null = null;

  constructor(public plan: CityPlan) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i / SEG - 0.5) * MAP;
        const z = (j / SEG - 0.5) * MAP;
        this.heights[j * N + i] = groundHeight(x, z);
      }
    }
    // Flatten anywhere a road runs so streets are drivable and readable.
    this.flattenRoads();
  }

  private flattenRoads() {
    const sm = new Float32Array(this.heights);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
        const x = (i / SEG - 0.5) * MAP, z = (j / SEG - 0.5) * MAP;
        if (!this.plan.isRoad(x, z)) continue;
        if (Math.abs(z - RIVER_Z) < RIVER_HALF + 3) continue;
        const k = j * N + i;
        sm[k] = (this.heights[k - 1] + this.heights[k + 1] + this.heights[k - N] + this.heights[k + N]) * 0.25;
      }
      this.heights.set(sm);
    }
  }

  heightAt(x: number, z: number): number {
    const fx = clamp(((x + HALF) / MAP) * SEG, 0, SEG - 0.0001);
    const fz = clamp(((z + HALF) / MAP) * SEG, 0, SEG - 0.0001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h = this.heights;
    const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3) {
    const e = 1.5;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  build(phys: PhysWorld, scene: THREE.Scene, quality: { groundTex: number }) {
    // --- collider ----------------------------------------------------------
    // parry indexes a heightfield as [xIndex * (n + 1) + zIndex] while `heights`
    // is stored the other way round, so it is transposed on the way in.
    const cm = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) cm[i * N + j] = this.heights[j * N + i];
    const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    this.body = phys.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.heightfield(SEG, SEG, cm, { x: MAP, y: 1, z: MAP });
    cd.setFriction(0.92);
    cd.setRestitution(0.02);
    cd.setCollisionGroups(interactionGroups(GROUP.TERRAIN, MOVING));
    const col = phys.world.createCollider(cd, this.body);
    const ent = phys.spawn({
      kind: Kind.Terrain, mat: MATERIALS.asphalt, pos: new THREE.Vector3(0, -900, 0),
      half: new THREE.Vector3(1, 1, 1), body: 'fixed', parts: [], label: 'terrain',
    });
    ent.set(1 << 4); // NO_DESPAWN
    phys.byCollider.set(col.handle, ent);

    // --- mesh --------------------------------------------------------------
    const geo = new THREE.PlaneGeometry(MAP, MAP, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      pos.setY(j * N + i, this.heights[j * N + i]);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    this.groundTex = paintGround(this.plan, quality.groundTex);
    this.surfTex = paintSurface(this.plan, 512);
    this.mat = makeTerrainMaterial(this.groundTex, this.surfTex);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    scene.add(this.mesh);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.groundTex.dispose();
    this.surfTex.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ground atlas. One canvas painted with the whole street layout: asphalt,
// kerbs, sidewalk slabs, tactile paving, lane markings, crossings, drains.
// ---------------------------------------------------------------------------
function paintGround(plan: CityPlan, size: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const S = size / MAP;                      // pixels per metre
  const X = (x: number) => (x + HALF) * S;
  const Z = (z: number) => (z + HALF) * S;
  const rng = new Rng(20240);

  // base ground: damp concrete/dirt
  g.fillStyle = '#4a4741';
  g.fillRect(0, 0, size, size);
  // mottling
  for (let i = 0; i < 2600; i++) {
    const x = rng.range(0, size), y = rng.range(0, size), r = rng.range(3, 46);
    g.fillStyle = `rgba(${rng.int(52, 96)},${rng.int(50, 92)},${rng.int(46, 86)},${rng.range(0.05, 0.2)})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  // --- block interiors ---------------------------------------------------
  for (const b of plan.blocks) {
    const x = X(b.x0), y = Z(b.z0), w = (b.x1 - b.x0) * S, h = (b.z1 - b.z0) * S;
    let col = '#57534c';
    if (b.type === 'park') col = '#3c5432';
    else if (b.type === 'construction') col = '#6b5a42';
    else if (b.type === 'plaza') col = '#75736c';
    else if (b.type === 'parking') col = '#3e3f42';
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
    if (b.type === 'park') {
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `rgba(${rng.int(46, 92)},${rng.int(74, 122)},${rng.int(38, 70)},0.5)`;
        g.beginPath(); g.arc(x + rng.range(0, w), y + rng.range(0, h), rng.range(2, 14), 0, 6.3); g.fill();
      }
    }
    if (b.type === 'construction') {
      for (let i = 0; i < 140; i++) {
        g.fillStyle = `rgba(${rng.int(70, 120)},${rng.int(58, 100)},${rng.int(40, 76)},0.55)`;
        g.beginPath(); g.arc(x + rng.range(0, w), y + rng.range(0, h), rng.range(3, 18), 0, 6.3); g.fill();
      }
    }
  }

  // --- sidewalks: a kerb band around every road ---------------------------
  const walk = 2.6;
  const drawWalk = (x0: number, z0: number, x1: number, z1: number) => {
    g.fillStyle = '#9d9a92';
    g.fillRect(X(x0), Z(z0), (x1 - x0) * S, (z1 - z0) * S);
  };
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    drawWalk(l.pos - l.width / 2 - walk, -HALF, l.pos - l.width / 2, HALF);
    drawWalk(l.pos + l.width / 2, -HALF, l.pos + l.width / 2 + walk, HALF);
  }
  for (const l of plan.hLines) {
    if (l.kind === 'alley') continue;
    drawWalk(-HALF, l.pos - l.width / 2 - walk, HALF, l.pos - l.width / 2);
    drawWalk(-HALF, l.pos + l.width / 2, HALF, l.pos + l.width / 2 + walk);
  }

  // --- road surfaces ------------------------------------------------------
  const paveV = (l: { pos: number; width: number; kind: string }) => {
    const x = X(l.pos - l.width / 2), w = l.width * S;
    g.fillStyle = l.kind === 'alley' ? '#4d4e51' : '#474a4e';
    g.fillRect(x, 0, w, size);
    // worn wheel tracks
    if (l.kind !== 'alley') {
      g.fillStyle = 'rgba(120,120,126,0.16)';
      g.fillRect(x + w * 0.20, 0, w * 0.14, size);
      g.fillRect(x + w * 0.66, 0, w * 0.14, size);
    }
  };
  const paveH = (l: { pos: number; width: number; kind: string }) => {
    const y = Z(l.pos - l.width / 2), h = l.width * S;
    g.fillStyle = l.kind === 'alley' ? '#4d4e51' : '#474a4e';
    g.fillRect(0, y, size, h);
    if (l.kind !== 'alley') {
      g.fillStyle = 'rgba(120,120,126,0.16)';
      g.fillRect(0, y + h * 0.20, size, h * 0.14);
      g.fillRect(0, y + h * 0.66, size, h * 0.14);
    }
  };
  for (const l of plan.vLines) paveV(l);
  for (const l of plan.hLines) paveH(l);

  // patches and stains on the asphalt
  for (let i = 0; i < 900; i++) {
    const x = rng.range(-HALF, HALF), z = rng.range(-HALF, HALF);
    if (!plan.isRoad(x, z)) continue;
    g.fillStyle = `rgba(${rng.int(40, 82)},${rng.int(40, 82)},${rng.int(42, 86)},${rng.range(0.12, 0.33)})`;
    g.beginPath(); g.ellipse(X(x), Z(z), rng.range(2, 16) * S / 4, rng.range(2, 14) * S / 4, rng.range(0, 3), 0, 6.3); g.fill();
  }

  // --- lane markings ------------------------------------------------------
  g.lineCap = 'butt';
  const dash = (vertical: boolean, at: number, from: number, to: number, w: number, colr: string, pattern: number[]) => {
    g.strokeStyle = colr; g.lineWidth = Math.max(1.2, w * S);
    g.setLineDash(pattern.map((p) => p * S));
    g.beginPath();
    if (vertical) { g.moveTo(X(at), Z(from)); g.lineTo(X(at), Z(to)); }
    else { g.moveTo(X(from), Z(at)); g.lineTo(X(to), Z(at)); }
    g.stroke(); g.setLineDash([]);
  };
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    if (l.kind === 'avenue') {
      dash(true, l.pos, -HALF, HALF, 0.36, 'rgba(226,214,140,0.72)', [0, 0]);
      dash(true, l.pos - l.width * 0.25, -HALF, HALF, 0.28, 'rgba(226,228,232,0.5)', [4, 6]);
      dash(true, l.pos + l.width * 0.25, -HALF, HALF, 0.28, 'rgba(226,228,232,0.5)', [4, 6]);
    } else {
      dash(true, l.pos, -HALF, HALF, 0.28, 'rgba(226,228,232,0.46)', [3, 5]);
    }
    dash(true, l.pos - l.width / 2 + 0.45, -HALF, HALF, 0.22, 'rgba(210,212,216,0.34)', [0, 0]);
    dash(true, l.pos + l.width / 2 - 0.45, -HALF, HALF, 0.22, 'rgba(210,212,216,0.34)', [0, 0]);
  }
  for (const l of plan.hLines) {
    if (l.kind === 'alley') continue;
    if (l.kind === 'avenue') {
      dash(false, l.pos, -HALF, HALF, 0.36, 'rgba(226,214,140,0.72)', [0, 0]);
      dash(false, l.pos - l.width * 0.25, -HALF, HALF, 0.28, 'rgba(226,228,232,0.5)', [4, 6]);
      dash(false, l.pos + l.width * 0.25, -HALF, HALF, 0.28, 'rgba(226,228,232,0.5)', [4, 6]);
    } else {
      dash(false, l.pos, -HALF, HALF, 0.28, 'rgba(226,228,232,0.46)', [3, 5]);
    }
    dash(false, l.pos - l.width / 2 + 0.45, -HALF, HALF, 0.22, 'rgba(210,212,216,0.34)', [0, 0]);
    dash(false, l.pos + l.width / 2 - 0.45, -HALF, HALF, 0.22, 'rgba(210,212,216,0.34)', [0, 0]);
  }

  // --- intersections: repaint asphalt, then crossings and stop bars -------
  for (const v of plan.vLines) {
    for (const h of plan.hLines) {
      if (v.kind === 'alley' || h.kind === 'alley') continue;
      const x0 = v.pos - v.width / 2, x1 = v.pos + v.width / 2;
      const z0 = h.pos - h.width / 2, z1 = h.pos + h.width / 2;
      g.fillStyle = '#474a4e';
      g.fillRect(X(x0), Z(z0), (x1 - x0) * S, (z1 - z0) * S);
      const major = v.kind === 'avenue' || h.kind === 'avenue';
      if (!major && rng.bool(0.45)) continue;
      // zebra crossings on all four approaches
      const stripe = 0.45, gap = 0.55, band = 2.9;
      g.fillStyle = 'rgba(232,234,236,0.82)';
      for (let x = x0 + 0.5; x < x1 - 0.5; x += stripe + gap) {
        g.fillRect(X(x), Z(z0 - band - 0.7), stripe * S, band * S);
        g.fillRect(X(x), Z(z1 + 0.7), stripe * S, band * S);
      }
      for (let z = z0 + 0.5; z < z1 - 0.5; z += stripe + gap) {
        g.fillRect(X(x0 - band - 0.7), Z(z), band * S, stripe * S);
        g.fillRect(X(x1 + 0.7), Z(z), band * S, stripe * S);
      }
      // stop bars
      g.fillStyle = 'rgba(236,238,240,0.8)';
      g.fillRect(X(v.pos), Z(z0 - band - 1.5), (v.width / 2 - 0.5) * S, 0.42 * S);
      g.fillRect(X(v.pos - v.width / 2 + 0.5), Z(z1 + band + 1.1), (v.width / 2 - 0.5) * S, 0.42 * S);
    }
  }

  // --- tactile paving strips along kerbs ---------------------------------
  g.fillStyle = 'rgba(214,176,52,0.62)';
  const tact = (vertical: boolean, at: number) => {
    if (vertical) for (let z = -HALF; z < HALF; z += 0.62) g.fillRect(X(at), Z(z), 0.32 * S, 0.34 * S);
    else for (let x = -HALF; x < HALF; x += 0.62) g.fillRect(X(x), Z(at), 0.34 * S, 0.32 * S);
  };
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    tact(true, l.pos - l.width / 2 - 1.0); tact(true, l.pos + l.width / 2 + 0.7);
  }
  for (const l of plan.hLines) {
    if (l.kind === 'alley') continue;
    tact(false, l.pos - l.width / 2 - 1.0); tact(false, l.pos + l.width / 2 + 0.7);
  }

  // --- drains and manholes ------------------------------------------------
  for (let i = 0; i < 520; i++) {
    const x = rng.range(-HALF, HALF), z = rng.range(-HALF, HALF);
    if (!plan.isRoad(x, z)) continue;
    if (rng.bool(0.55)) {
      g.fillStyle = '#26282b';
      g.beginPath(); g.arc(X(x), Z(z), 0.36 * S, 0, 6.3); g.fill();
      g.strokeStyle = 'rgba(120,120,124,0.35)'; g.lineWidth = Math.max(1, 0.06 * S);
      g.beginPath(); g.arc(X(x), Z(z), 0.29 * S, 0, 6.3); g.stroke();
    } else {
      g.fillStyle = '#1e2022';
      g.fillRect(X(x - 0.34), Z(z - 0.18), 0.68 * S, 0.36 * S);
      g.strokeStyle = 'rgba(140,140,146,0.28)'; g.lineWidth = Math.max(1, 0.05 * S);
      for (let k = 0; k < 4; k++) {
        g.beginPath(); g.moveTo(X(x - 0.3 + k * 0.2), Z(z - 0.16)); g.lineTo(X(x - 0.3 + k * 0.2), Z(z + 0.16)); g.stroke();
      }
    }
  }

  // --- building footprints: dark plinth ----------------------------------
  for (const lot of plan.lots) {
    g.fillStyle = 'rgba(30,30,32,0.55)';
    g.fillRect(X(lot.x0), Z(lot.z0), (lot.x1 - lot.x0) * S, (lot.z1 - lot.z0) * S);
  }

  // --- riverbed and shore -------------------------------------------------
  g.fillStyle = '#3b4441';
  g.fillRect(0, Z(RIVER_Z - RIVER_HALF - 3), size, (RIVER_HALF * 2 + 6) * S);
  g.fillStyle = '#5d5b52';
  g.fillRect(0, Z(SHORE_Z - 8), size, (HALF - SHORE_Z + 8) * S);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** R = road, G = sidewalk, B = puddle-prone, A = loose ground. */
function paintSurface(plan: CityPlan, size: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const S = size / MAP;
  const X = (x: number) => (x + HALF) * S, Z = (z: number) => (z + HALF) * S;
  const rng = new Rng(777);
  g.fillStyle = 'rgb(0,0,60)'; g.fillRect(0, 0, size, size);
  for (const b of plan.blocks) {
    if (b.type === 'park' || b.type === 'construction') {
      g.fillStyle = 'rgb(0,0,30)';
      g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * S, (b.z1 - b.z0) * S);
    }
  }
  const walk = 2.6;
  g.fillStyle = 'rgb(0,230,90)';
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    g.fillRect(X(l.pos - l.width / 2 - walk), 0, walk * S, size);
    g.fillRect(X(l.pos + l.width / 2), 0, walk * S, size);
  }
  for (const l of plan.hLines) {
    if (l.kind === 'alley') continue;
    g.fillRect(0, Z(l.pos - l.width / 2 - walk), size, walk * S);
    g.fillRect(0, Z(l.pos + l.width / 2), size, walk * S);
  }
  g.fillStyle = 'rgb(240,0,150)';
  for (const l of plan.vLines) g.fillRect(X(l.pos - l.width / 2), 0, l.width * S, size);
  for (const l of plan.hLines) g.fillRect(0, Z(l.pos - l.width / 2), size, l.width * S);
  // puddle blobs pooling toward kerbs and dips
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 1400; i++) {
    const x = rng.range(-HALF, HALF), z = rng.range(-HALF, HALF);
    if (!plan.isRoad(x, z)) continue;
    const r = rng.range(0.6, 5.5);
    const grad = g.createRadialGradient(X(x), Z(z), 0, X(x), Z(z), r * S);
    grad.addColorStop(0, 'rgba(0,0,200,0.85)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(X(x), Z(z), r * S, 0, 6.3); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeTerrainMaterial(groundTex: THREE.Texture, surfTex: THREE.Texture) {
  const mat = new THREE.MeshStandardMaterial({
    map: groundTex, roughness: 0.94, metalness: 0.0, color: 0xffffff,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G);
    shader.uniforms.uSurf = { value: surfTex };
    shader.uniforms.uMapSize = { value: MAP };
    shader.vertexShader = `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec4 vState;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `
      vec4 _wp = modelMatrix * vec4(transformed, 1.0);
      vWorldPos = _wp.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      vState = vec4(0.0, 0.0, 0.5, 1.0);
    `);
    shader.fragmentShader = `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec4 vState;
      uniform sampler2D uSurf;
      uniform float uMapSize;
      ${SHARED_DECL}
      float th21(vec2 p){ p = fract(p*vec2(233.34,451.21)); p += dot(p,p+23.45); return fract(p.x*p.y); }
      float tn21(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(th21(i),th21(i+vec2(1,0)),f.x), mix(th21(i+vec2(0,1)),th21(i+vec2(1,1)),f.x), f.y);
      }
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 suv = vWorldPos.xz / uMapSize + 0.5;
      vec4 surf = texture2D(uSurf, suv);
      float isRoad = surf.r, isWalk = surf.g, puddleMask = surf.b, loose = surf.a;

      // High-frequency detail computed in world space so it stays crisp up close.
      // It has to fade out with distance: at a grazing angle a 6-per-metre noise
      // is far below the pixel rate and turns the road into moire stripes.
      float _camD = distance(vWorldPos, uCamPos);
      float _near = 1.0 - smoothstep(8.0, 34.0, _camD);
      float _mid  = 1.0 - smoothstep(22.0, 90.0, _camD);
      float grain = tn21(vWorldPos.xz * 7.0) * 0.5 + tn21(vWorldPos.xz * 23.0) * 0.5;
      diffuseColor.rgb *= 1.0 + (0.28 * grain - 0.14) * _mid;

      // Sidewalk slabs: 90 cm tiles with darker joints.
      vec2 tile = fract(vWorldPos.xz / 0.9);
      float joint = min(smoothstep(0.0, 0.045, tile.x) * smoothstep(1.0, 0.955, tile.x),
                        smoothstep(0.0, 0.045, tile.y) * smoothstep(1.0, 0.955, tile.y));
      diffuseColor.rgb *= mix(1.0, mix(0.68, 1.04, joint), isWalk * 0.9 * _mid);

      float _wet = clamp(uWetness, 0.0, 1.0);
      float _up = clamp(vWorldNormal.y, 0.0, 1.0);
      float _ash = clamp(uAsh, 0.0, 1.0) * pow(_up, 1.2) * (1.0 - _wet * 0.4);

      // Standing water collects in the painted lows once things are wet enough.
      float pud = clamp(puddleMask * 1.15 - 0.16, 0.0, 1.0) * smoothstep(0.28, 0.85, _wet);
      pud *= 0.25 + 0.75 * smoothstep(0.70, 0.97, _up);
      diffuseColor.rgb *= mix(1.0, 0.52, _wet * 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.34, pud);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.315,0.305,0.295), _ash * 0.9);
      diffuseColor.rgb *= mix(1.0, 0.9, loose);
    `);

    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.085, _wet * 0.85);
      roughnessFactor = mix(roughnessFactor, 0.022, pud);
      roughnessFactor = mix(roughnessFactor, 0.95, _ash * 0.9);
    `);

    // Micro-normals: asphalt grain, plus ripples on standing water while it rains.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
      #include <normal_fragment_maps>
      {
        float e = 0.22;
        float n0 = tn21(vWorldPos.xz * 6.0);
        float nx = tn21((vWorldPos.xz + vec2(e,0.0)) * 6.0);
        float nz = tn21((vWorldPos.xz + vec2(0.0,e)) * 6.0);
        vec3 bump = normalize(vec3((n0-nx) * 0.9, 1.0, (n0-nz) * 0.9));
        normal = normalize(mix(normal, normalize(normal + bump * 0.22), 0.5 * _near * (1.0 - pud)));
        if (pud > 0.02) {
          float t = uTime * 2.1;
          float r1 = sin(vWorldPos.x * 15.0 + t * 3.1) * cos(vWorldPos.z * 13.0 - t * 2.4);
          float r2 = sin((vWorldPos.x + vWorldPos.z) * 24.0 - t * 5.0);
          vec3 rip = normalize(vec3(r1 * 0.035, 1.0, r2 * 0.030));
          normal = normalize(mix(normal, rip, pud * 0.30 * _near * clamp(uWetness, 0.0, 1.0)));
        }
      }
    `);

    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', FOG_FRAG);
  };
  mat.customProgramCacheKey = () => 'terrain-v2';
  return mat;
}

export function isOverWater(_x: number, z: number) {
  return z > SHORE_Z - 6 || Math.abs(z - RIVER_Z) < RIVER_HALF;
}
export { clamp01 };

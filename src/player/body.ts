import * as THREE from 'three';

/**
 * The player's body, generated rather than modelled.
 *
 * One skeleton drives a handful of skinned meshes — skin, jacket, trousers,
 * shoes, hair and eyes. Each surface is swept as rings of vertices along the
 * bones in their rest pose and weighted to them, blending across every joint,
 * so an elbow or a knuckle bends as one continuous surface instead of two
 * boxes meeting at a ball.
 *
 * The bones keep the names and conventions the animator already drives: every
 * limb segment runs along its bone's local -Z. In a leg that means +Y is the
 * front of the knee; in a hand, -Y is the palm, and the thumb is on the -X side
 * of a right hand and the +X side of a left — so a right hand laid palm-down
 * with its fingers forward has its thumb on the left, as a real one does.
 */

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

const C = (hex: number) => new THREE.Color(hex);
const PAL = {
  skin: C(0xcca38c), skinShade: C(0xb68b74), skinPalm: C(0xd9b3a0), knuckle: C(0xc0907c),
  nail: C(0xe6cbc2), lip: C(0xb57d70), ear: C(0xc7937b),
  jacket: C(0x3e6176), jacketHi: C(0x4c7288), jacketDark: C(0x2a4353), seam: C(0x355468),
  zip: C(0x1a1d20), pull: C(0xb0b5ba),
  trouser: C(0x565b63), trouserHi: C(0x626770), trouserDark: C(0x40444b),
  sole: C(0xe2ded6), soleDark: C(0x5d5a55), upper: C(0x33363d), upperHi: C(0x474b53),
  accent: C(0xc4492f), lace: C(0xdcd7ce),
  hair: C(0x2a201b), hairHi: C(0x3d3029), brow: C(0x2b211c),
  eyeWhite: C(0xe9e5de), iris: C(0x5a3d27), pupil: C(0x0b0908),
};

// ---------------------------------------------------------------------------
// skinned geometry under construction
// ---------------------------------------------------------------------------

/** Bone influences: [bone index, weight] pairs. Normalised on write. */
type Infl = [number, number][];

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Blend two influence sets; the same bone in both is merged. */
function mix(a: Infl, b: Infl, t: number): Infl {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const m = new Map<number, number>();
  for (const [i, w] of a) m.set(i, (m.get(i) ?? 0) + w * (1 - t));
  for (const [i, w] of b) m.set(i, (m.get(i) ?? 0) + w * t);
  return [...m.entries()];
}
const one = (i: number): Infl => [[i, 1]];

class SkinGeo {
  private p: number[] = [];
  private c: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private ix: number[] = [];
  n = 0;

  v(x: number, y: number, z: number, col: THREE.Color, w: Infl) {
    this.p.push(x, y, z);
    this.c.push(col.r, col.g, col.b);
    const top = w.length > 4 ? [...w].sort((a, b) => b[1] - a[1]).slice(0, 4) : w;
    let s = 0;
    for (const t of top) s += t[1];
    for (let k = 0; k < 4; k++) {
      const t = top[k];
      this.si.push(t ? t[0] : 0);
      this.sw.push(t && s > 0 ? t[1] / s : 0);
    }
    return this.n++;
  }
  t(a: number, b: number, c: number) { this.ix.push(a, b, c); }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.ix);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * One cross-section of a swept surface: a centre, two axes spanning the
 * section, and a radius for every direction around it (0 = +u, PI/2 = +v).
 */
interface Ring {
  c: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  r: (a: number) => number;
  w: Infl | ((a: number) => Infl);
  col: THREE.Color | ((a: number) => THREE.Color);
}

const _P = new THREE.Vector3();
const _T = new THREE.Vector3();

/**
 * Sweep rings into a closed surface. `caps` closes either end with a fan;
 * rounded ends come from rings shrinking toward the tip before the cap.
 * `xf` carries a bone-local definition into the rig's rest-pose space.
 */
function sweep(g: SkinGeo, rings: Ring[], seg: number, caps: [boolean, boolean], xf?: THREE.Matrix4) {
  const base = g.n;
  for (const R of rings) {
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const rr = R.r(a);
      _P.copy(R.c).addScaledVector(R.u, Math.cos(a) * rr).addScaledVector(R.v, Math.sin(a) * rr);
      if (xf) _P.applyMatrix4(xf);
      g.v(_P.x, _P.y, _P.z,
        typeof R.col === 'function' ? R.col(a) : R.col,
        typeof R.w === 'function' ? R.w(a) : R.w);
    }
  }
  // Winding follows the sweep direction so every face points outward.
  _T.copy(rings[rings.length - 1].c).sub(rings[0].c);
  const flip = _P.copy(rings[0].u).cross(rings[0].v).dot(_T) < 0;
  const L = rings.length;
  for (let i = 0; i < L - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = base + i * seg + k, b = base + i * seg + (k + 1) % seg;
      const c = base + (i + 1) * seg + (k + 1) % seg, d = base + (i + 1) * seg + k;
      if (flip) { g.t(a, c, b); g.t(a, d, c); } else { g.t(a, b, c); g.t(a, c, d); }
    }
  }
  const capAt = (ri: number, start: boolean) => {
    const R = rings[ri];
    _P.copy(R.c);
    if (xf) _P.applyMatrix4(xf);
    const ctr = g.v(_P.x, _P.y, _P.z,
      typeof R.col === 'function' ? R.col(0) : R.col,
      typeof R.w === 'function' ? R.w(0) : R.w);
    for (let k = 0; k < seg; k++) {
      const a = base + ri * seg + k, b = base + ri * seg + (k + 1) % seg;
      if (start !== flip) g.t(ctr, b, a); else g.t(ctr, a, b);
    }
  };
  if (caps[0]) capAt(0, true);
  if (caps[1]) capAt(L - 1, false);
}

/** Superellipse radius toward angle a, for half-axes (rx along u, ry along v). */
function supEll(rx: number, ry: number, p: number) {
  return (a: number) => {
    const c = Math.abs(Math.cos(a)) / rx, s = Math.abs(Math.sin(a)) / ry;
    return 1 / Math.pow(Math.pow(c, p) + Math.pow(s, p), 1 / p);
  };
}

/** A single-sided patch laid over a surface: fingernails, pocket flaps. */
function patch(g: SkinGeo, nu: number, nv: number,
               at: (s: number, t: number) => THREE.Vector3, col: THREE.Color, w: Infl, xf?: THREE.Matrix4, flipFaces = false) {
  const base = g.n;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const p = at(i / nu, j / nv);
      if (xf) p.applyMatrix4(xf);
      g.v(p.x, p.y, p.z, col, w);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
      if (flipFaces) { g.t(a, c, b); g.t(a, d, c); } else { g.t(a, b, c); g.t(a, c, d); }
    }
  }
}

/** A closed ellipsoid (UV sphere) with a displacement hook, bone-local. */
function blob(g: SkinGeo, ctr: THREE.Vector3, rx: number, ry: number, rz: number, lat: number, lon: number,
              col: (d: THREE.Vector3, p: THREE.Vector3) => THREE.Color, w: Infl, xf?: THREE.Matrix4,
              shape?: (d: THREE.Vector3, p: THREE.Vector3) => void) {
  const base = g.n;
  const d = new THREE.Vector3();
  for (let j = 0; j <= lat; j++) {
    const phi = (j / lat) * Math.PI;
    for (let i = 0; i < lon; i++) {
      const th = (i / lon) * Math.PI * 2;
      d.set(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      const p = new THREE.Vector3(ctr.x + d.x * rx, ctr.y + d.y * ry, ctr.z + d.z * rz);
      shape?.(d, p);
      const cc = col(d, p);
      if (xf) p.applyMatrix4(xf);
      g.v(p.x, p.y, p.z, cc, w);
    }
  }
  for (let j = 0; j < lat; j++) {
    for (let i = 0; i < lon; i++) {
      const a = base + j * lon + i, b = base + j * lon + (i + 1) % lon;
      const c = base + (j + 1) * lon + (i + 1) % lon, e = base + (j + 1) * lon + i;
      g.t(a, b, c); g.t(a, c, e);
    }
  }
}

// ---------------------------------------------------------------------------
// skeleton
// ---------------------------------------------------------------------------

export interface HandBones {
  wrist: THREE.Bone;
  /** The knuckle row; its children are the four fingers, little to index. */
  fingers: THREE.Bone;
  thumb: THREE.Bone;
}

export interface BodyRig {
  root: THREE.Group;
  hips: THREE.Bone | null;
  chest: THREE.Bone | null;
  head: THREE.Bone | null;
  arms: {
    side: 1 | -1; shoulder: THREE.Bone; elbow: THREE.Bone; hand: HandBones;
    upper: number; fore: number;
  }[];
  legs: { side: 1 | -1; hip: THREE.Bone; knee: THREE.Bone; ankle: THREE.Bone }[] | null;
  /** Height of the hips bone above the soles, standing. */
  hipHeight: number;
  meshes: THREE.SkinnedMesh[];
}

export interface BodyOptions {
  /** Whole body (third person) or arms alone (first person). */
  full: boolean;
  upper: number;
  fore: number;
  /** First-person shoulder positions in camera space. */
  fpShoulders?: [THREE.Vector3, THREE.Vector3];
}

// finger layout, little to index: x across the knuckle row (positive toward the
// thumb, before the hand's own mirroring),
// set-back of the knuckle, base radius, and the three phalanx lengths
const FINGERS = [
  { x: -0.0245, z: 0.011, r: 0.0074, L: [0.032, 0.019, 0.018] },
  { x: -0.0085, z: 0.003, r: 0.0087, L: [0.041, 0.026, 0.020] },
  { x: 0.0080, z: 0.000, r: 0.0092, L: [0.044, 0.027, 0.021] },
  { x: 0.0245, z: 0.004, r: 0.0089, L: [0.040, 0.024, 0.020] },
];
const KNUCKLE_Z = -0.086;
/**
 * Which way a hand's thumb lies along its own X axis. With the palm on -Y and
 * the fingers along -Z, a right hand has its thumb on -X.
 */
export const handSide = (armSide: 1 | -1) => -armSide as 1 | -1;
const THUMB_AT = new THREE.Vector3(0.027, -0.009, -0.018);
const THUMB_L = [0.042, 0.032, 0.028];

// full-body proportions, for a figure a little under 1.8 m
const HIP_H = 0.98;
const CHEST_Y = 0.16;
const HEAD_Y = 0.39;
const SHOULDER = new THREE.Vector3(0.19, 0.325, 0.006);
const HIP_JOINT = new THREE.Vector3(0.092, -0.07, 0.0);
const THIGH = 0.43;
const SHIN = 0.41;

class Builder {
  bones: THREE.Bone[] = [];
  index = new Map<THREE.Bone, number>();

  bone(name: string, parent: THREE.Object3D, x: number, y: number, z: number) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    this.index.set(b, this.bones.length);
    this.bones.push(b);
    return b;
  }
  i(b: THREE.Bone) { return this.index.get(b)!; }
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

export function buildBody(opt: BodyOptions): BodyRig {
  const B = new Builder();
  const root = new THREE.Group();
  root.name = opt.full ? 'body' : 'arms';

  let hips: THREE.Bone | null = null, chest: THREE.Bone | null = null, head: THREE.Bone | null = null;
  const armParents: THREE.Object3D[] = [];
  if (opt.full) {
    hips = B.bone('hips', root, 0, HIP_H, 0);
    chest = B.bone('chest', hips, 0, CHEST_Y, 0);
    head = B.bone('head', chest, 0, HEAD_Y, 0);
    for (const side of [-1, 1] as const) {
      // The clavicle carries the arm a little out from the ribs; without it a
      // hanging arm can only swing forward and back, straight through the jacket.
      const clav = B.bone(side < 0 ? 'clavicleL' : 'clavicleR', chest, SHOULDER.x * side, SHOULDER.y, SHOULDER.z);
      clav.rotation.set(0, 0, 0.065 * side);
      armParents.push(clav);
    }
  } else {
    armParents.push(root, root);
  }

  const arms: BodyRig['arms'] = [];
  ([-1, 1] as const).forEach((side, k) => {
    const parent = armParents[k];
    const shoulder = B.bone(side < 0 ? 'shoulderL' : 'shoulderR', parent, 0, 0, 0);
    if (!opt.full && opt.fpShoulders) shoulder.position.copy(opt.fpShoulders[k]);
    const elbow = B.bone('elbow', shoulder, 0, 0, -opt.upper);
    const wrist = B.bone('wrist', elbow, 0, 0, -opt.fore);
    const fingers = B.bone('knuckles', wrist, 0, 0.002, KNUCKLE_Z);
    const hs = handSide(side);
    for (const f of FINGERS) {
      const fb = B.bone('finger', fingers, f.x * hs, 0, f.z);
      const tip = B.bone('fingerMid', fb, 0, 0, -f.L[0]);
      const dist = B.bone('fingerTip', tip, 0, 0, -f.L[1]);
      fb.userData.tip = tip;
      fb.userData.dist = dist;
    }
    const thumb = B.bone('thumb', wrist, THUMB_AT.x * hs, THUMB_AT.y, THUMB_AT.z);
    const ttip = B.bone('thumbMid', thumb, 0, 0, -THUMB_L[0]);
    const tdist = B.bone('thumbTip', ttip, 0, 0, -THUMB_L[1]);
    thumb.userData.tip = ttip;
    thumb.userData.dist = tdist;
    thumb.rotation.set(-0.30, -0.45 * hs, 0.25 * hs, 'YXZ');
    // Rest pose for binding: arms hanging (full body) or reaching forward (arms).
    if (opt.full) shoulder.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
    arms.push({ side, shoulder, elbow, hand: { wrist, fingers, thumb }, upper: opt.upper, fore: opt.fore });
  });

  let legs: BodyRig['legs'] = null;
  if (opt.full && hips) {
    legs = [];
    for (const side of [-1, 1] as const) {
      const hip = B.bone(side < 0 ? 'hipL' : 'hipR', hips, HIP_JOINT.x * side, HIP_JOINT.y, HIP_JOINT.z);
      hip.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
      const knee = B.bone('knee', hip, 0, 0, -THIGH);
      const ankle = B.bone('ankle', knee, 0, 0, -SHIN);
      legs.push({ side, hip, knee, ankle });
    }
  }

  root.updateMatrixWorld(true);
  const M = (b: THREE.Bone) => b.matrixWorld.clone();

  const skin = new SkinGeo();
  const jacket = new SkinGeo();
  const trousers = new SkinGeo();
  const shoes = new SkinGeo();
  const hair = new SkinGeo();
  const eyes = new SkinGeo();

  for (const a of arms) {
    const clav = opt.full ? B.i(a.shoulder.parent as THREE.Bone) : -1;
    buildArm(B, jacket, skin, a, clav, chest ? B.i(chest) : -1, opt.full, M);
    buildHand(B, skin, a.hand, a.side, B.i(a.elbow), M);
  }
  if (opt.full && hips && chest && head && legs) {
    const shoulderIdx: [number, number] = [B.i(arms[0].shoulder), B.i(arms[1].shoulder)];
    buildTorso(jacket, B.i(hips), B.i(chest), shoulderIdx, M(hips));
    buildCollar(jacket, B.i(chest), B.i(head), M(chest));
    buildPelvis(trousers, B.i(hips), M(hips));
    for (const l of legs) {
      buildLeg(trousers, B.i(hips), B.i(l.hip), B.i(l.knee), B.i(l.ankle), M(l.hip));
      buildShoe(shoes, B.i(l.ankle), l.side, M(l.ankle));
    }
    buildNeck(skin, B.i(chest), B.i(head), M(chest));
    buildHead(skin, hair, eyes, B.i(head), M(head));
  }

  const skeleton = new THREE.Skeleton(B.bones);
  const meshes: THREE.SkinnedMesh[] = [];
  const add = (g: SkinGeo, rough: number, metal = 0, name = '') => {
    if (!g.n) return;
    const m = new THREE.SkinnedMesh(g.build(), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: rough, metalness: metal,
    }));
    m.name = name;
    // Posed limbs leave the rest-pose bounds; one character is not worth culling.
    m.frustumCulled = false;
    root.add(m);
    m.bind(skeleton);
    meshes.push(m);
  };
  add(skin, 0.56, 0, 'skin');
  add(jacket, 0.84, 0.02, 'jacket');
  add(trousers, 0.9, 0, 'trousers');
  add(shoes, 0.62, 0.02, 'shoes');
  add(hair, 0.66, 0, 'hair');
  add(eyes, 0.16, 0, 'eyes');

  return { root, hips, chest, head, arms, legs, hipHeight: HIP_H, meshes };
}

// ---------------------------------------------------------------------------
// arms and hands
// ---------------------------------------------------------------------------

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The jacket sleeve, from inside the shoulder to a ribbed cuff that stops
 * short of the wrist, and the bare forearm running on inside it.
 */
function buildArm(B: Builder, jacket: SkinGeo, _skin: SkinGeo, a: BodyRig['arms'][number],
                  clav: number, chest: number, full: boolean, M: (b: THREE.Bone) => THREE.Matrix4) {
  const u = a.upper, f = a.fore;
  const sh = B.i(a.shoulder), el = B.i(a.elbow), wr = B.i(a.hand.wrist);
  const xf = M(a.shoulder);
  const s = a.side;
  const cuffEnd = -(u + f - 0.036);

  // Weights down the sleeve: shoulder, a soft elbow, and the cuff riding a
  // little with the wrist so it twists with the hand.
  const wAt = (z: number): Infl => {
    let w: Infl = one(sh);
    if (full && z > -0.05) w = mix(mix(one(clav), one(chest), 0.35), w, sstep(0.03, -0.05, z));
    w = mix(w, one(el), sstep(-u + 0.055, -u - 0.05, z));
    w = mix(w, one(wr), 0.3 * sstep(cuffEnd + 0.06, cuffEnd, z));
    return w;
  };
  // Cloth: loose over the shoulder, gathered at the elbow, ribbed at the cuff.
  const radius = (z: number) => {
    const k = [
      [0.028, 0.022], [0.02, 0.04], [0.008, 0.051], [-0.01, 0.057], [-0.05, 0.059], [-0.11, 0.057], [-0.2, 0.056],
      [-u + 0.03, 0.057], [-u, 0.058], [-u - 0.04, 0.058], [-u - 0.1, 0.056],
      [-u - 0.17, 0.053], [cuffEnd + 0.035, 0.050], [cuffEnd + 0.028, 0.047], [cuffEnd, 0.046],
    ];
    for (let i = 0; i < k.length - 1; i++) {
      const [z0, r0] = k[i], [z1, r1] = k[i + 1];
      if (z <= z0 && z >= z1) return lerpN(r0, r1, sstep(0, 1, (z0 - z) / (z0 - z1)));
    }
    return z > 0 ? k[0][1] : k[k.length - 1][1];
  };
  const rings: Ring[] = [];
  const zs: number[] = [];
  zs.push(0.028, 0.02, 0.008);
  for (let z = -0.01; z > cuffEnd + 0.03; z -= 0.02) zs.push(z);
  for (let z = cuffEnd + 0.03; z >= cuffEnd - 1e-4; z -= 0.005) zs.push(z);
  for (const z of zs) {
    const r0 = radius(z);
    const elbowBunch = Math.exp(-(((z + u) / 0.055) ** 2));
    const inCuff = z < cuffEnd + 0.028;
    rings.push({
      c: V(0, 0, z), u: X, v: Y,
      r: (ang) => {
        let r = r0 * (1 + 0.035 * Math.sin(ang * 2) * 0.3);      // slightly flattened
        r *= 1 + 0.045 * elbowBunch * Math.sin(ang * 3 + z * 60);   // folds at the elbow
        r *= 1 + 0.018 * Math.sin(ang * 5 - z * 35) * (1 - elbowBunch) * 0.6;
        if (inCuff) r *= 1 + 0.03 * Math.cos(ang * 14);            // rib
        return r;
      },
      w: wAt(z),
      col: (ang) => {
        if (inCuff) return Math.cos(ang * 14) > 0 ? PAL.jacketDark : PAL.seam;
        // a seam down the outside of the arm
        const outside = Math.cos(ang - (s > 0 ? 0 : Math.PI));
        return outside > 0.985 ? PAL.seam : PAL.jacket;
      },
    });
  }
  // Turn the cuff in on itself so the opening has a thickness.
  const lipW = wAt(cuffEnd);
  for (const [dz, r] of [[-0.002, 0.042], [0.006, 0.0405], [0.03, 0.0395]] as const) {
    rings.push({ c: V(0, 0, cuffEnd + dz), u: X, v: Y, r: () => r, w: lipW, col: PAL.jacketDark });
  }
  sweep(jacket, rings, 22, [true, false], xf);
}

/**
 * Forearm, wrist and palm as one surface, then four three-jointed fingers and
 * a thumb, each with a nail. Built in the wrist's frame.
 */
function buildHand(B: Builder, skin: SkinGeo, h: HandBones, side: 1 | -1, elbow: number, M: (b: THREE.Bone) => THREE.Matrix4) {
  const wr = B.i(h.wrist), kn = B.i(h.fingers);
  const xf = M(h.wrist);
  const s = handSide(side);

  // ---- forearm → wrist → palm -------------------------------------------
  // [z, half-width, half-thickness, dorsal offset]
  const prof: [number, number, number, number][] = [
    [0.090, 0.040, 0.034, 0.002], [0.060, 0.037, 0.029, 0.001], [0.030, 0.033, 0.023, 0],
    [0.008, 0.031, 0.019, 0], [-0.008, 0.034, 0.020, 0.001], [-0.026, 0.039, 0.021, 0.001],
    [-0.046, 0.042, 0.019, 0.002], [-0.066, 0.044, 0.017, 0.003], [-0.080, 0.0445, 0.016, 0.003],
    [-0.090, 0.041, 0.014, 0.003], [-0.096, 0.032, 0.011, 0.002], [-0.099, 0.018, 0.007, 0.002],
  ];
  const rings: Ring[] = [];
  for (const [z, hw, ht, dy] of prof) {
    const wAt: Infl = mix(one(elbow), one(wr), sstep(0.03, 0.0, z));
    const palmZone = sstep(0.0, -0.02, z) * sstep(-0.1, -0.07, z);
    rings.push({
      c: V(0, dy, z), u: X, v: Y,
      r: (a) => {
        const cx = Math.cos(a), sy = Math.sin(a);
        let r = supEll(hw, ht, 2.6)(a);
        // The palm is not flat: the thumb and little-finger pads stand proud
        // of it, and the back of the hand arches over the tendons.
        if (sy < 0) {
          const thenar = Math.exp(-(((cx * s - 0.55) / 0.35) ** 2)) * sstep(0.004, -0.02, z) * sstep(-0.075, -0.045, z);
          const hypo = Math.exp(-(((cx * s + 0.7) / 0.3) ** 2)) * palmZone;
          r += (thenar * 0.0065 + hypo * 0.003) * -sy;
        } else {
          r += 0.0015 * sy * palmZone;
        }
        // knuckles
        if (z < -0.074 && sy > 0) {
          for (const fg of FINGERS) {
            r += 0.0022 * Math.exp(-(((cx * hw - fg.x * s) / 0.007) ** 2)) * sy;
          }
        }
        return r;
      },
      w: wAt,
      col: (a) => {
        const sy = Math.sin(a);
        if (sy < -0.35 && z < -0.004) return PAL.skinPalm;
        if (z < -0.074 && sy > 0.4) return PAL.knuckle;
        return PAL.skin;
      },
    });
  }
  sweep(skin, rings, 20, [true, true], xf);

  // ---- fingers -----------------------------------------------------------
  h.fingers.children.forEach((fb, i) => {
    const F = FINGERS[i];
    const bone = fb as THREE.Bone;
    const tip = bone.userData.tip as THREE.Bone, dist = bone.userData.dist as THREE.Bone;
    const fi = B.i(bone), ti = B.i(tip), di = B.i(dist);
    const [L1, L2, L3] = F.L;
    const R = F.r;
    const fxf = M(bone);
    // [z, radius scale]
    const zr: [number, number][] = [
      [0.016, 0.95], [0.006, 1.0], [0.0, 1.03], [-0.3 * L1, 0.95], [-0.75 * L1, 0.9],
      [-L1, 0.92], [-L1 - 0.5 * L2, 0.84], [-L1 - L2, 0.83], [-L1 - L2 - 0.4 * L3, 0.8],
      [-L1 - L2 - 0.72 * L3, 0.74], [-L1 - L2 - 0.9 * L3, 0.56], [-L1 - L2 - L3, 0.24],
    ];
    const fr: Ring[] = zr.map(([z, k]) => {
      let w: Infl = mix(one(wr), one(kn), sstep(0.02, 0.004, z));
      w = mix(w, one(fi), sstep(0.004, -0.004, z));
      w = mix(w, one(ti), sstep(-L1 + 0.006, -L1 - 0.004, z));
      w = mix(w, one(di), sstep(-L1 - L2 + 0.004, -L1 - L2 - 0.003, z));
      const joint = Math.abs(z + L1) < 0.004 || Math.abs(z + L1 + L2) < 0.003;
      return {
        c: V(0, 0, z), u: X, v: Y,
        r: (a) => {
          let r = supEll(R * k * 1.05, R * k * 0.9, 2.2)(a);
          // fingertip pad: fuller on the palm side
          if (Math.sin(a) < 0 && z < -L1 - L2 - 0.3 * L3) r *= 1 + 0.08 * -Math.sin(a);
          return r;
        },
        w,
        col: (a) => (joint && Math.sin(a) > 0.5 ? PAL.knuckle : Math.sin(a) < -0.4 ? PAL.skinPalm : PAL.skin),
      };
    });
    sweep(skin, fr, 12, [false, true], fxf);
    nail(skin, R * 0.74 * 1.05, R * 0.74 * 0.9, -L1 - L2 - 0.3 * L3, -L1 - L2 - 0.93 * L3, di, fxf);
  });

  // ---- thumb -------------------------------------------------------------
  const th = h.thumb, ttip = th.userData.tip as THREE.Bone, tdist = th.userData.dist as THREE.Bone;
  const ti0 = B.i(th), ti1 = B.i(ttip), ti2 = B.i(tdist);
  const [T1, T2, T3] = THUMB_L;
  const txf = M(th);
  const tz: [number, number][] = [
    [0.014, 0.0165], [0.0, 0.0172], [-0.016, 0.015], [-0.03, 0.0128], [-T1, 0.0118],
    [-T1 - 0.5 * T2, 0.011], [-T1 - T2, 0.0106], [-T1 - T2 - 0.4 * T3, 0.0102],
    [-T1 - T2 - 0.75 * T3, 0.0088], [-T1 - T2 - 0.92 * T3, 0.0062], [-T1 - T2 - T3, 0.0025],
  ];
  const tr: Ring[] = tz.map(([z, r]) => {
    // The ball of the thumb stays with the palm; the thumb proper is its own.
    let w: Infl = mix(one(wr), one(ti0), 0.4 + 0.6 * sstep(-0.012, -0.028, z));
    w = mix(w, one(ti1), sstep(-T1 + 0.005, -T1 - 0.005, z));
    w = mix(w, one(ti2), sstep(-T1 - T2 + 0.004, -T1 - T2 - 0.004, z));
    return {
      c: V(0, 0, z), u: X, v: Y, r: supEll(r * 1.1, r * 0.9, 2.2), w,
      col: (a) => (Math.sin(a) < -0.4 ? PAL.skinPalm : PAL.skin),
    };
  });
  sweep(skin, tr, 12, [true, true], txf);
  nail(skin, 0.0102 * 0.78 * 1.1, 0.0102 * 0.78 * 0.9, -T1 - T2 - 0.3 * T3, -T1 - T2 - 0.93 * T3, ti2, txf);
}

/** A nail: a thin curved plate lying on the back of a fingertip. */
function nail(g: SkinGeo, rx: number, ry: number, z0: number, z1: number, bone: number, xf: THREE.Matrix4) {
  const w = rx * 0.78;
  patch(g, 4, 5, (s, t) => {
    const x = (s * 2 - 1) * w;
    const z = lerpN(z0, z1, t);
    // taper the free end round
    const taper = t > 0.75 ? Math.sqrt(Math.max(0, 1 - ((t - 0.75) / 0.25) ** 2)) : 1;
    const xx = x * (0.4 + 0.6 * taper);
    const y = ry * Math.sqrt(Math.max(0, 1 - (xx / rx) ** 2)) + 0.0007;
    return V(xx, y, z);
  }, PAL.nail, one(bone), xf);
}

// ---------------------------------------------------------------------------
// torso, collar, neck
// ---------------------------------------------------------------------------

/** The jacket body: hem to shoulders, with yoke, zip, pockets and seams. */
function buildTorso(g: SkinGeo, hips: number, chest: number, sh: [number, number], xf: THREE.Matrix4) {
  // [y (hips frame), half-width, half-depth, forward offset of the centre]
  const prof: [number, number, number, number][] = [
    [-0.085, 0.172, 0.123, 0.0], [-0.07, 0.171, 0.122, 0.0], [-0.05, 0.168, 0.12, 0.0],
    [0.0, 0.165, 0.118, 0.0], [0.07, 0.160, 0.114, 0.0], [0.14, 0.158, 0.113, 0.0],
    [0.22, 0.164, 0.118, -0.002], [0.3, 0.171, 0.124, -0.004], [0.37, 0.176, 0.127, -0.005],
    [0.43, 0.172, 0.121, -0.004], [0.462, 0.168, 0.115, -0.002], [0.49, 0.155, 0.107, 0.0],
    [0.512, 0.136, 0.097, 0.002], [0.53, 0.113, 0.086, 0.003], [0.545, 0.09, 0.075, 0.004],
    [0.556, 0.07, 0.065, 0.005],
  ];
  const rings: Ring[] = prof.map(([y, hw, hd, fz]) => {
    const wBase = mix(one(hips), one(chest), sstep(0.1, 0.24, y));
    const hem = y < -0.045;
    const pocket = y > -0.03 && y < 0.1;
    return {
      c: V(0, y, fz), u: X, v: new THREE.Vector3(0, 0, -1),     // v = forward
      r: (a) => {
        const cx = Math.cos(a), sf = Math.sin(a);       // sf > 0 is the front
        let r = supEll(hw, hd, 2.5)(a);
        // chest in front, shoulder blades behind
        r += 0.006 * Math.max(0, sf) * sstep(0.26, 0.36, y) * sstep(0.47, 0.4, y);
        r += 0.005 * Math.max(0, -sf) * Math.exp(-(((Math.abs(cx) - 0.45) / 0.25) ** 2)) * sstep(0.34, 0.42, y) * sstep(0.5, 0.45, y);
        // the zip runs down the front, a little proud of the cloth
        if (sf > 0.996) r += 0.003;
        if (hem) r *= 1 + 0.012 * Math.cos(a * 22);
        return r;
      },
      w: (a) => {
        const cx = Math.cos(a);
        // the shoulders of the jacket ride up with the arms
        const k = 0.28 * sstep(0.43, 0.5, y) * sstep(0.35, 0.8, Math.abs(cx));
        return k > 0 ? mix(wBase, one(cx < 0 ? sh[0] : sh[1]), k) : wBase;
      },
      col: (a) => {
        const cx = Math.cos(a), sf = Math.sin(a);
        if (sf > 0.994) return PAL.zip;
        if (hem) return PAL.jacketDark;
        if (y > 0.455) return PAL.jacketHi;                       // yoke
        if (Math.abs(cx) > 0.985) return PAL.seam;                // side seams
        if (pocket && sf > 0.35 && Math.abs(cx) > 0.3 && Math.abs(cx) < 0.8) {
          return y > 0.085 ? PAL.jacketDark : PAL.seam;           // pocket and its flap edge
        }
        return PAL.jacket;
      },
    };
  });
  sweep(g, rings, 40, [true, true], xf);

  // zip pull, just under the collar
  const pull: Ring[] = [0, 1].map((t) => ({
    c: V(0, 0.46 - t * 0.022, -0.1265), u: X, v: new THREE.Vector3(0, 0, -1),
    r: supEll(0.0055, 0.0018, 4), w: one(chest), col: PAL.pull,
  }));
  sweep(g, pull, 8, [true, true], xf);
}

/** A stand-up collar with a real thickness, and the hood rolled behind it. */
function buildCollar(g: SkinGeo, chest: number, head: number, xf: THREE.Matrix4) {
  const w = (y: number) => mix(one(chest), one(head), 0.25 * sstep(0.4, 0.45, y));
  // A collar sits low at the throat and high at the nape: each ring is tipped
  // forward, so it clears the chin and still stands up behind the neck.
  const tip = new THREE.Vector3(0, -0.36, -1).normalize();
  const seq: [number, number, number, THREE.Color][] = [
    [0.345, 0.084, 0.074, PAL.jacket], [0.385, 0.08, 0.071, PAL.jacket], [0.418, 0.076, 0.067, PAL.jacketDark],
    [0.422, 0.07, 0.062, PAL.jacketDark], [0.41, 0.066, 0.059, PAL.jacketDark], [0.37, 0.063, 0.057, PAL.jacketDark],
  ];
  const rings: Ring[] = seq.map(([y, rx, rz, col]) => ({
    c: V(0, y, 0.01), u: X, v: tip, r: supEll(rx, rz, 2.2), w: w(y),
    col: (a: number) => (Math.sin(a) > 0.994 ? PAL.zip : col),
  }));
  sweep(g, rings, 28, [false, false], xf);

  // Hood, rolled and resting on the yoke.
  const hood: Ring[] = [];
  const n = 13;
  for (let i = 0; i <= n; i++) {
    const t = -1.95 + (i / n) * 3.9;                    // radians around the neck, 0 = straight back
    const cx = Math.sin(t) * 0.1, cz = Math.cos(t) * 0.1 + 0.03;
    const tang = new THREE.Vector3(Math.cos(t), 0, -Math.sin(t));
    const out = new THREE.Vector3(Math.sin(t), 0, Math.cos(t));
    const fall = 1 - Math.abs(t) / 1.95;
    const r = 0.018 + 0.017 * Math.sqrt(Math.max(0, fall));
    hood.push({
      c: V(cx, 0.405 + 0.01 * fall, cz), u: out, v: Y.clone(),
      r: supEll(r * 1.15, r * 0.8, 2.2), w: one(chest),
      col: (a: number) => (Math.cos(a) > 0.8 ? PAL.jacketHi : PAL.jacket),
    });
    void tang;
  }
  sweep(g, hood, 12, [true, true], xf);
}

function buildNeck(g: SkinGeo, chest: number, head: number, xf: THREE.Matrix4) {
  const rings: Ring[] = [0.3, 0.36, 0.41, 0.46, 0.5, 0.53].map((y) => ({
    c: V(0, y, 0.006), u: X, v: new THREE.Vector3(0, 0, -1),
    r: supEll(0.051, 0.054, 2.2),
    w: mix(one(chest), one(head), sstep(0.38, 0.47, y)),
    col: PAL.skin,
  }));
  sweep(g, rings, 16, [true, true], xf);
}

// ---------------------------------------------------------------------------
// pelvis, legs, shoes
// ---------------------------------------------------------------------------

function buildPelvis(g: SkinGeo, hips: number, xf: THREE.Matrix4) {
  const prof: [number, number, number][] = [
    [0.03, 0.158, 0.111], [-0.02, 0.162, 0.113], [-0.08, 0.164, 0.114],
    [-0.13, 0.158, 0.11], [-0.17, 0.132, 0.098], [-0.2, 0.08, 0.075], [-0.212, 0.03, 0.03],
  ];
  const rings: Ring[] = prof.map(([y, hw, hd]) => ({
    c: V(0, y, 0.004), u: X, v: new THREE.Vector3(0, 0, -1),
    r: supEll(hw, hd, 2.4), w: one(hips),
    col: (a: number) => (Math.abs(Math.cos(a)) > 0.99 ? PAL.trouserDark : PAL.trouser),
  }));
  sweep(g, rings, 32, [true, true], xf);
}

function buildLeg(g: SkinGeo, hips: number, hip: number, knee: number, ankle: number, xf: THREE.Matrix4) {
  const bottom = -(THIGH + SHIN) + 0.016;
  // [z, half-width, half-depth]
  const prof: [number, number, number][] = [
    [0.08, 0.086, 0.088], [0.03, 0.09, 0.094], [-0.06, 0.087, 0.09], [-0.16, 0.081, 0.083],
    [-0.28, 0.073, 0.074], [-0.37, 0.066, 0.067], [-THIGH, 0.064, 0.069], [-THIGH - 0.06, 0.063, 0.067],
    [-THIGH - 0.13, 0.062, 0.064], [-THIGH - 0.23, 0.058, 0.06], [bottom + 0.06, 0.058, 0.06],
    [bottom + 0.02, 0.06, 0.063], [bottom, 0.061, 0.064],
  ];
  const w = (z: number): Infl => {
    let r: Infl = mix(one(hips), one(hip), 0.5 + 0.5 * sstep(0.06, -0.04, z));
    r = mix(r, one(knee), sstep(-THIGH + 0.06, -THIGH - 0.05, z));
    r = mix(r, one(ankle), 0.3 * sstep(bottom + 0.08, bottom, z));
    return r;
  };
  const rings: Ring[] = [];
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, w0, d0] = prof[i], [z1, w1, d1] = prof[i + 1];
    const steps = Math.max(1, Math.round((z0 - z1) / 0.03));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const z = lerpN(z0, z1, t), hw = lerpN(w0, w1, sstep(0, 1, t)), hd = lerpN(d0, d1, sstep(0, 1, t));
      const kneeBunch = Math.exp(-(((z + THIGH) / 0.06) ** 2));
      const hemBunch = sstep(bottom + 0.12, bottom + 0.02, z);
      rings.push({
        c: V(0, 0, z), u: X, v: Y,                               // +Y is the front of the leg
        r: (a) => {
          let r = supEll(hw, hd, 2.2)(a);
          r *= 1 + 0.03 * kneeBunch * Math.sin(a * 4 + z * 50);
          r *= 1 + 0.035 * hemBunch * Math.sin(a * 3 - z * 70);
          r *= 1 + 0.008 * Math.sin(a * 6 + z * 23);
          return r;
        },
        w: w(z),
        col: (a) => {
          const sf = Math.sin(a);
          if (Math.abs(Math.cos(a)) > 0.99) return PAL.trouserDark;       // outer and inner seams
          if (sf > 0.992) return PAL.trouserHi;                          // pressed crease
          return PAL.trouser;
        },
      });
    }
  }
  const [zb, wb, db] = prof[prof.length - 1];
  rings.push({ c: V(0, 0, zb), u: X, v: Y, r: supEll(wb, db, 2.2), w: w(zb), col: PAL.trouserDark });
  rings.push({ c: V(0, 0, zb - 0.003), u: X, v: Y, r: supEll(wb - 0.006, db - 0.006, 2.2), w: w(zb), col: PAL.trouserDark });
  rings.push({ c: V(0, 0, zb + 0.03), u: X, v: Y, r: supEll(wb - 0.009, db - 0.009, 2.2), w: w(zb), col: PAL.trouserDark });
  sweep(g, rings, 24, [true, false], xf);
}

/**
 * A trainer, built in the ankle's frame: the foot runs along +Y, the sole
 * lies 8 cm below the joint. A cupped sole with toe spring, a padded upper,
 * a heel counter, a stripe down each side and laces over the tongue.
 */
function buildShoe(g: SkinGeo, ankle: number, side: 1 | -1, xf: THREE.Matrix4) {
  const soleBot = -0.071, soleTop = -0.049;
  // [y along the foot, half-width, upper height above the sole, inward shift]
  const prof: [number, number, number, number][] = [
    [-0.066, 0.02, 0.05, 0.0], [-0.06, 0.03, 0.075, 0.0], [-0.045, 0.036, 0.085, 0.0],
    [-0.02, 0.038, 0.086, 0.002], [0.02, 0.04, 0.078, 0.004], [0.06, 0.044, 0.06, 0.004],
    [0.1, 0.049, 0.046, 0.003], [0.135, 0.05, 0.038, 0.002], [0.162, 0.046, 0.033, 0.001],
    [0.182, 0.038, 0.027, 0.0], [0.196, 0.026, 0.02, 0.0], [0.204, 0.012, 0.012, 0.0],
  ];
  const toeRise = (y: number) => 0.012 * sstep(0.12, 0.205, y);
  const w = one(ankle);
  const up = new THREE.Vector3(0, 0, 1);
  // upper
  const upperRings: Ring[] = prof.map(([y, hw, ht, sh]) => {
    const cz = soleTop + ht * 0.5 + toeRise(y);
    return {
      c: V(-sh * side, y, cz), u: X, v: up,
      r: (a) => {
        const top = Math.sin(a) > 0;
        return supEll(hw, ht * 0.5, top ? 2.3 : 7)(a);
      },
      w,
      col: (a) => {
        const s = Math.sin(a), c = Math.cos(a);
        if (y < -0.035) return PAL.upperHi;                                  // heel counter
        if (y > 0.16) return PAL.upperHi;                                    // toe cap
        if (Math.abs(s) < 0.45 && Math.abs(c) > 0.85 && y > -0.02 && y < 0.12) return PAL.accent;
        return PAL.upper;
      },
    };
  });
  sweep(g, upperRings, 20, [true, true], xf);

  // sole: slightly wider than the upper, with a darker tread underneath
  const soleRings: Ring[] = prof.map(([y, hw, , sh]) => ({
    c: V(-sh * side, y, (soleBot + soleTop) / 2 + toeRise(y) * 0.8), u: X, v: up,
    r: supEll(hw + 0.005, (soleTop - soleBot) / 2, 6),
    w,
    col: (a: number) => (Math.sin(a) < -0.6 ? PAL.soleDark : PAL.sole),
  }));
  sweep(g, soleRings, 20, [true, true], xf);

  // laces across the tongue
  for (let i = 0; i < 5; i++) {
    const y = 0.022 + i * 0.019;
    const p = prof.findIndex((q) => q[0] > y);
    const [y0, , h0] = prof[p - 1], [y1, , h1] = prof[p];
    const ht = lerpN(h0, h1, (y - y0) / (y1 - y0));
    const cz = soleTop + ht + toeRise(y) + 0.0015;
    const lace: Ring[] = [-1, 1].map((sx) => ({
      c: V(sx * 0.017, y, cz - Math.abs(sx) * 0.004), u: Y, v: up,
      r: supEll(0.0028, 0.0016, 2), w, col: PAL.lace,
    }));
    sweep(g, lace, 6, [true, true], xf);
  }
}

// ---------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------

/**
 * A sculpted head in the head bone's frame (origin at the base of the neck,
 * -Z forward): a skull shaped into brow, cheekbones, jaw and chin, a nose and
 * lips, eyes set in their sockets, ears, eyebrows and a short cut of hair.
 */
function buildHead(skin: SkinGeo, hair: SkinGeo, eyes: SkinGeo, head: number, xf: THREE.Matrix4) {
  const S = V(0, 0.15, 0.012);
  const A = 0.077, Bv = 0.1, Cz = 0.1;
  const w = one(head);
  const eyeL = V(-0.031, 0.136, -0.0725), eyeR = V(0.031, 0.136, -0.0725);
  const gauss = (x: number, y: number, sx: number, sy: number) => Math.exp(-((x / sx) ** 2 + (y / sy) ** 2));

  /** Head surface point for a direction from the skull centre. */
  const surface = (d: THREE.Vector3, p: THREE.Vector3) => {
    const front = sstep(0.25, -0.65, d.z);
    // the face hangs below the cranium: jaw and chin
    if (d.y < 0) p.y = S.y + d.y * (Bv + 0.027 * front);
    // the jaw narrows to the chin, the back of the skull tucks into the neck
    const low = sstep(-0.25, -1.0, d.y);
    p.x = S.x + (p.x - S.x) * (1 - 0.34 * low * front);
    if (d.z > 0) p.z = S.z + (p.z - S.z) * (1 - 0.18 * sstep(0.0, -0.9, d.y));
    // a flatter face than a sphere
    if (d.z < 0) p.z = S.z + (p.z - S.z) * (1 - 0.08 * sstep(-0.4, -0.95, d.z));
    const lx = p.x, ly = p.y;
    if (d.z < -0.35) {
      let dz = 0;
      dz += 0.0045 * gauss(lx, ly - 0.162, 0.05, 0.008);                     // brow ridge
      dz -= 0.0065 * gauss(Math.abs(lx) - 0.031, ly - 0.137, 0.015, 0.011);   // eye sockets
      dz += 0.0035 * gauss(Math.abs(lx) - 0.047, ly - 0.113, 0.016, 0.012);   // cheekbones
      dz += 0.0035 * gauss(lx, ly - 0.058, 0.019, 0.0055);                   // lips
      dz -= 0.0022 * gauss(lx, ly - 0.058, 0.016, 0.0018);                    // the line between them
      dz += 0.0045 * gauss(lx, ly - 0.032, 0.019, 0.012);                    // chin
      p.z -= dz;                                                               // -Z is forward
    }
  };
  const cheek = C(0xcd9d89), under = C(0xba8e7a);
  const skinCol = (d: THREE.Vector3, p: THREE.Vector3) => {
    if (d.z < -0.5) {
      const ax = Math.abs(p.x);
      // lips, darker along the line where they meet
      const lipBand = Math.abs(p.y - 0.057);
      if (ax < 0.0185 - lipBand * 1.2 && lipBand < 0.0052) return lipBand < 0.0011 ? PAL.skinShade : PAL.lip;
      if (gauss(ax - 0.045, p.y - 0.104, 0.015, 0.014) > 0.7) return cheek;
      if (gauss(ax - 0.031, p.y - 0.124, 0.014, 0.005) > 0.6) return under;
    }
    if (d.y < -0.55) return PAL.skinShade;                       // under the jaw
    return PAL.skin;
  };
  blob(skin, S, A, Bv, Cz, 40, 48, skinCol, w, xf, surface);

  // nose: a ridge from between the eyes to the tip, and the wings of the nostrils
  const nose: Ring[] = [];
  const np: [number, number, number, number][] = [
    // y, centre z (forward is -), half-width, half-depth
    [0.15, -0.081, 0.005, 0.0035], [0.135, -0.0855, 0.0053, 0.0045], [0.12, -0.0895, 0.006, 0.0058],
    [0.107, -0.0915, 0.0071, 0.007], [0.098, -0.0925, 0.0084, 0.0076], [0.0915, -0.0905, 0.0092, 0.006],
    [0.0875, -0.0865, 0.0086, 0.0042], [0.0865, -0.081, 0.0072, 0.0028],
  ];
  for (const [y, z, hw, hh] of np) {
    nose.push({ c: V(0, y, z), u: X, v: new THREE.Vector3(0, 0, -1), r: supEll(hw, hh, 2.3), w, col: PAL.skin });
  }
  sweep(skin, nose, 10, [true, true], xf);
  for (const sx of [-1, 1]) {
    blob(skin, V(sx * 0.0094, 0.0905, -0.0875), 0.0058, 0.0046, 0.0055, 6, 10, () => PAL.skin, w, xf);
  }

  // ears
  for (const sx of [-1, 1]) {
    const m = new THREE.Matrix4().makeRotationY(sx * 0.35).multiply(new THREE.Matrix4().makeRotationZ(sx * -0.12));
    m.setPosition(sx * 0.077, 0.124, 0.014);
    const ex = xf.clone().multiply(m);
    blob(skin, V(0, 0, 0), 0.008, 0.029, 0.019, 8, 14, () => PAL.ear, w, ex, (d, p) => {
      // the rim stands off the head; the bowl behind it is shallower
      if (d.x * sx < 0) p.x *= 0.4;
    });
  }

  // eyes: white, iris and pupil painted by direction, set just behind the lids
  for (const e of [eyeL, eyeR]) {
    blob(eyes, e, 0.0102, 0.0102, 0.0102, 12, 16, (d) => {
      if (d.z < -0.95) return PAL.pupil;
      if (d.z < -0.74) return PAL.iris;
      return PAL.eyeWhite;
    }, w, xf);
    // upper lid: skin closing over the top of the eyeball
    blob(skin, e, 0.0114, 0.0114, 0.0114, 6, 12, () => PAL.skinShade, w, xf, (d, p) => {
      if (d.y < 0.42) { p.y = e.y + 0.42 * 0.0114; }
    });
  }

  // eyebrows
  for (const sx of [-1, 1]) {
    const brow: Ring[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = sx * lerpN(0.012, 0.052, t);
      const y = 0.158 + 0.006 * Math.sin(t * Math.PI) - 0.004 * t;
      const z = -0.093 + 0.02 * t * t;
      brow.push({
        c: V(x, y, z), u: Y, v: new THREE.Vector3(0, 0, -1),
        r: supEll(0.0042 * (1 - 0.45 * t), 0.0022, 2), w, col: PAL.brow,
      });
    }
    sweep(hair, brow, 6, [true, true], xf);
  }

  // Hair: close-cropped at the back and sides, fuller on top with a fringe
  // swept across the brow. The hairline is ragged, drops into sideburns in
  // front of the ears and down to the nape behind.
  const lineAt = (az: number) => {
    const a = Math.abs(az);                         // 0 = front, PI = back
    const pts: [number, number][] = [
      [0, 0.183], [0.5, 0.182], [0.9, 0.17], [1.22, 0.158], [1.34, 0.128], [1.43, 0.122],
      [1.52, 0.148], [1.66, 0.15], [1.95, 0.115], [2.5, 0.085], [Math.PI, 0.074],
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      if (a <= pts[i + 1][0]) return lerpN(pts[i][1], pts[i + 1][1], sstep(pts[i][0], pts[i + 1][0], a));
    }
    return pts[pts.length - 1][1];
  };
  // strands radiate from a crown behind the top of the head
  const strand = (d: THREE.Vector3) => {
    const az = Math.atan2(d.x, d.z - 0.35);
    return Math.sin(az * 26 + d.y * 6);
  };
  blob(hair, S, A, Bv, Cz, 40, 56, (d) => (strand(d) > 0.5 ? PAL.hairHi : PAL.hair), w, xf, (d, p) => {
    surface(d, p);
    const az = Math.atan2(p.x - S.x, -(p.z - S.z));
    const jag = 0.0035 * Math.sin(az * 11) + 0.002 * Math.sin(az * 23 + 1.3);
    const over = p.y - (lineAt(az) + jag);
    const cover = sstep(-0.003, 0.011, over);
    const top = Math.max(0, d.y);
    const front = Math.max(0, -d.z);
    const swept = 0.5 + 0.5 * Math.tanh((d.x + 0.15) * 3);     // the fringe falls to one side
    const clump = 0.0035 * Math.sin(az * 9 + d.y * 14) * Math.sin(d.y * 19 - az * 3);
    const thick = cover * (0.0075 + 0.019 * top * top + 0.011 * top * front * (0.5 + swept)
      + clump * (0.35 + top)) - (1 - cover) * 0.002;
    const n = new THREE.Vector3(d.x / A, d.y / Bv, d.z / Cz).normalize();
    p.addScaledVector(n, thick);
    // the fringe lifts off the brow and falls forward over it
    if (front > 0.45 && cover > 0.2) {
      const k = front * cover * sstep(0.62, 0.3, d.y);
      p.y -= 0.009 * k;
      p.z -= 0.005 * k;
    }
  });
}

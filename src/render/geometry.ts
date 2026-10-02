import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../util/math';

// ---------------------------------------------------------------------------
// Geometry factory + cache.
//
// Instanced rendering wants few distinct geometries, but non-uniform instance
// scaling ruins a bevel (a 6 x 0.25 x 6 slab made from a scaled unit cube gets
// a 0.5m chamfer on one axis and 0.02m on another). So sizes are quantized into
// buckets and each bucket gets a real, correctly-proportioned geometry; the
// instance only carries the small residual scale. Chamfers stay believable and
// the draw-call count stays sane.
// ---------------------------------------------------------------------------

const cache = new Map<string, THREE.BufferGeometry>();
export function geoStats() { return { count: cache.size }; }

const q = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);

/** Quantize a box size to a bucket. Returns bucket dims + the residual scale to apply per-instance. */
export function boxBucket(w: number, h: number, d: number, step = 0.25) {
  const bw = q(w, step), bh = q(h, step), bd = q(d, step);
  return { bw, bh, bd, sx: w / bw, sy: h / bh, sz: d / bd };
}

/** A box with a real chamfer. Bevel is clamped so thin panels still look right. */
export function beveledBox(w: number, h: number, d: number, bevel = 0.035, seg = 2): THREE.BufferGeometry {
  const b = Math.min(bevel, Math.min(w, h, d) * 0.34);
  const key = `bb:${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${b.toFixed(3)},${seg}`;
  let g = cache.get(key);
  if (!g) {
    g = b < 0.004
      ? new THREE.BoxGeometry(w, h, d)
      : new RoundedBoxGeometry(w, h, d, seg, b);
    g.computeBoundingSphere();
    cache.set(key, g);
  }
  return g;
}

/**
 * The single unit cube every box-shaped object instances. Its chamfer is drawn
 * by the shader in world units so non-uniform instance scaling stays correct.
 */
let _unit: THREE.BufferGeometry | null = null;
export function unitBox(): THREE.BufferGeometry {
  if (!_unit) { _unit = new THREE.BoxGeometry(1, 1, 1); _unit.computeBoundingSphere(); }
  return _unit;
}

/** Cylinder with cached buckets. */
export function cylinder(r: number, h: number, seg = 12, rTop = r): THREE.BufferGeometry {
  const key = `cy:${r.toFixed(3)},${h.toFixed(3)},${seg},${rTop.toFixed(3)}`;
  let g = cache.get(key);
  if (!g) { g = new THREE.CylinderGeometry(rTop, r, h, seg, 1, false); g.computeBoundingSphere(); cache.set(key, g); }
  return g;
}

/** A ring — wheel rims, hoops, pipe collars, the lip of a bin. */
export function torus(r: number, tube: number, radial = 8, tubular = 12): THREE.BufferGeometry {
  const key = `to:${r.toFixed(3)},${tube.toFixed(3)},${radial},${tubular}`;
  let g = cache.get(key);
  if (!g) { g = new THREE.TorusGeometry(r, tube, radial, tubular); g.computeBoundingSphere(); cache.set(key, g); }
  return g;
}

/**
 * A cone or truncated cone standing on its base. Traffic cones, bin bodies,
 * lamp shades, planters — anything that tapers.
 */
export function taper(rBottom: number, rTop: number, h: number, seg = 10, capped = true): THREE.BufferGeometry {
  const key = `tp:${rBottom.toFixed(3)},${rTop.toFixed(3)},${h.toFixed(3)},${seg},${capped ? 1 : 0}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, !capped);
    g.computeBoundingSphere();
    cache.set(key, g);
  }
  return g;
}

export function sphere(r: number, seg = 12): THREE.BufferGeometry {
  const key = `sp:${r.toFixed(3)},${seg}`;
  let g = cache.get(key);
  if (!g) { g = new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)); g.computeBoundingSphere(); cache.set(key, g); }
  return g;
}

/** Flat panel with slightly rounded corners — signs, boards, shutters. */
export function panel(w: number, h: number, t = 0.05): THREE.BufferGeometry {
  return beveledBox(w, h, t, Math.min(0.02, t * 0.4), 1);
}

// --- Irregular solids ------------------------------------------------------

/**
 * A convex, irregular chunk. Used for concrete rubble, broken stone, volcanic
 * ejecta. Eight variants is enough that a rubble pile never looks tiled.
 */
export function chunk(variant: number): THREE.BufferGeometry {
  const key = `ch:${variant}`;
  let g = cache.get(key);
  if (g) return g;
  const rng = new Rng(9001 + variant * 7717);
  const base = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = base.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Push vertices onto a jittered, flattened, faceted shape.
  const sx = rng.range(0.7, 1.35), sy = rng.range(0.42, 1.0), sz = rng.range(0.7, 1.35);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = 0.62 + 0.38 * Math.abs(Math.sin(v.x * 7.3 + v.y * 5.1 + v.z * 6.7 + variant));
    v.multiply(new THREE.Vector3(sx, sy, sz)).multiplyScalar(n * rng.range(0.86, 1.14));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  base.computeVertexNormals();
  g = mergeVertices(base, 1e-4);
  g.deleteAttribute('uv');
  g.computeVertexNormals();     // faceted look reads as fractured concrete
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

/** Thin triangular-ish shard for shattered glass and ceramic. */
export function shard(variant: number): THREE.BufferGeometry {
  const key = `sh:${variant}`;
  let g = cache.get(key);
  if (g) return g;
  const rng = new Rng(4242 + variant * 331);
  const pts: number[] = [];
  const n = 3 + (variant % 3);
  const ang: number[] = [];
  for (let i = 0; i < n; i++) ang.push((i / n) * Math.PI * 2 + rng.range(-0.4, 0.4));
  const rad = ang.map(() => rng.range(0.22, 0.5));
  const t = 0.012;
  // Two fans, front and back, plus a rim.
  const front: number[] = [], back: number[] = [];
  for (let i = 0; i < n; i++) { front.push(Math.cos(ang[i]) * rad[i], Math.sin(ang[i]) * rad[i], t); back.push(Math.cos(ang[i]) * rad[i], Math.sin(ang[i]) * rad[i], -t); }
  for (let i = 1; i < n - 1; i++) {
    pts.push(front[0], front[1], front[2], front[i * 3], front[i * 3 + 1], front[i * 3 + 2], front[(i + 1) * 3], front[(i + 1) * 3 + 1], front[(i + 1) * 3 + 2]);
    pts.push(back[0], back[1], back[2], back[(i + 1) * 3], back[(i + 1) * 3 + 1], back[(i + 1) * 3 + 2], back[i * 3], back[i * 3 + 1], back[i * 3 + 2]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    pts.push(front[i * 3], front[i * 3 + 1], front[i * 3 + 2], back[i * 3], back[i * 3 + 1], back[i * 3 + 2], front[j * 3], front[j * 3 + 1], front[j * 3 + 2]);
    pts.push(back[i * 3], back[i * 3 + 1], back[i * 3 + 2], back[j * 3], back[j * 3 + 1], back[j * 3 + 2], front[j * 3], front[j * 3 + 1], front[j * 3 + 2]);
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

/** Splintered plank — wood debris. */
export function splinter(variant: number): THREE.BufferGeometry {
  const key = `spl:${variant}`;
  let g = cache.get(key);
  if (g) return g;
  const rng = new Rng(777 + variant * 91);
  const len = rng.range(0.7, 1.0), w = rng.range(0.1, 0.2), t = rng.range(0.03, 0.07);
  const b = new THREE.BoxGeometry(len, t, w, 3, 1, 1);
  const pos = b.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (Math.abs(x) > len * 0.4) {
      // taper + jag at the broken ends
      pos.setY(i, pos.getY(i) * rng.range(0.15, 0.8));
      pos.setZ(i, pos.getZ(i) * rng.range(0.4, 1.0));
      pos.setX(i, x * rng.range(0.85, 1.05));
    }
  }
  b.computeVertexNormals();
  g = b; g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

// --- Composite helpers -----------------------------------------------------

export function translated(g: THREE.BufferGeometry, x: number, y: number, z: number) {
  const c = g.clone(); c.translate(x, y, z); return c;
}
export function transformed(g: THREE.BufferGeometry, m: THREE.Matrix4) {
  const c = g.clone(); c.applyMatrix4(m); return c;
}
/**
 * Concatenate geometries into one non-indexed buffer. Done by hand because the
 * inputs are a mix of indexed primitives and hand-built solids, and they must
 * end up with exactly the same attribute set.
 */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  const parts: { pos: Float32Array; nrm: Float32Array; uv: Float32Array; n: number }[] = [];
  for (const src of list) {
    if (!src) continue;
    const g = src.index ? src.toNonIndexed() : src;
    const pa = g.attributes.position as THREE.BufferAttribute | undefined;
    if (!pa) continue;
    const n = pa.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    const na = g.attributes.normal as THREE.BufferAttribute;
    const ua = g.attributes.uv as THREE.BufferAttribute | undefined;
    parts.push({
      pos: pa.array as Float32Array,
      nrm: na.array as Float32Array,
      uv: (ua?.array as Float32Array) ?? new Float32Array(n * 2),
      n,
    });
    total += n;
    if (g !== src) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  if (!total) return out;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o3 = 0, o2 = 0;
  for (const p of parts) {
    pos.set(p.pos.subarray(0, p.n * 3), o3);
    nrm.set(p.nrm.subarray(0, p.n * 3), o3);
    uv.set(p.uv.subarray(0, p.n * 2), o2);
    o3 += p.n * 3; o2 += p.n * 2;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** Cache an expensive composite geometry under a name. */
const composites = new Map<string, THREE.BufferGeometry>();
export function composite(name: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = composites.get(name);
  if (!g) { g = build(); g.computeBoundingSphere(); composites.set(name, g); }
  return g;
}

/** A tube built from a path — pipes, cables, handrails. */
export function tube(points: THREE.Vector3[], radius: number, radialSeg = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
  const g = new THREE.TubeGeometry(curve, Math.max(2, points.length * 3), radius, radialSeg, false);
  g.computeBoundingSphere();
  return g;
}

/** A hollow rectangular frame (window frames, door frames, crates). */
export function frame(w: number, h: number, t: number, depth: number): THREE.BufferGeometry {
  return composite(`fr:${w},${h},${t},${depth}`, () => merge([
    translated(new THREE.BoxGeometry(w, t, depth), 0, h / 2 - t / 2, 0),
    translated(new THREE.BoxGeometry(w, t, depth), 0, -h / 2 + t / 2, 0),
    translated(new THREE.BoxGeometry(t, h - t * 2, depth), -w / 2 + t / 2, 0, 0),
    translated(new THREE.BoxGeometry(t, h - t * 2, depth), w / 2 - t / 2, 0, 0),
  ]));
}

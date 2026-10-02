import * as THREE from 'three';
import type { Spawner } from './spawn';
import type { Terrain } from './terrain';
import { RIVER_Z, RIVER_HALF, SHORE_Z, type CityPlan } from './cityplan';
import { ST, type Building } from './building';
import type { FacadeStyle } from './facade';
import { SCAF } from './detail';
import type { Rng } from '../util/math';
import type { Entity } from '../physics/entity';
import { footSamples, type Footprints, type Foot } from './footprints';
import { propSpec, placeSpec, type PropKind, type PropSpec } from './props';

/**
 * The things people leave lying about.
 *
 * A street with nothing in it but what the council bolted down reads as a
 * film set. This is the layer on top: bottle crates stacked by the shop doors,
 * bicycles against the walls, rubbish bags heaped at the collection point,
 * and at every building under repair a yard of boards, tubes, blocks and
 * sheets waiting to go up. Every piece is a real object — it can be carried
 * off, thrown, stacked, or built into a shelter.
 *
 * Nothing is dropped at random. Each group is laid out as it would have been
 * set down, each piece resting squarely on the one below, and the whole group
 * is recorded as one footprint before anything else is placed. Two things set
 * down inside each other cost nothing while they sleep and burst apart the
 * moment the player walks up.
 */
export interface ClutterCtx { spawn: Spawner; rng: Rng; terrain: Terrain; plan: CityPlan; fp: Footprints }
type Ctx = ClutterCtx;

/** Where a scaffold stands, as `facadeScaffold` reports it. */
export interface ScaffoldSite { base: THREE.Vector3; along: THREE.Vector3; out: THREE.Vector3; width: number }

/** Air left between things stacked on one another, so nothing starts inside anything. */
const GAP = 0.003;

// ------------------------------------------------------------------ geometry

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();

/**
 * Plan footprint of a box turned any way at all: the rectangle, square to the
 * box's longest plan axis, that holds its shadow, and the heights it spans. A
 * pitched stair flight reaches the pavement at its foot although its middle
 * is two metres up.
 */
export function boxFoot(x: number, y: number, z: number, q: THREE.Quaternion,
                        hx: number, hy: number, hz: number): Foot {
  const m = _m.makeRotationFromQuaternion(q).elements;
  const axes = [[m[0], m[1], m[2], hx], [m[4], m[5], m[6], hy], [m[8], m[9], m[10], hz]];
  let ux = 1, uz = 0, best = -1;
  for (const [ax, , az, h] of axes) {
    const l = Math.hypot(ax, az);
    if (l * h > best + 1e-6 && l > 1e-4) { best = l * h; ux = ax / l; uz = az / l; }
  }
  let hu = 0, hw = 0, hv = 0;
  for (const [ax, ay, az, h] of axes) {
    hu += h * Math.abs(ax * ux + az * uz);
    hw += h * Math.abs(-ax * uz + az * ux);
    hv += h * Math.abs(ay);
  }
  return { x, z, hx: hu, hz: hw, rot: Math.atan2(-uz, ux), y0: y - hv, y1: y + hv };
}

/** Every collider an entity carries, as plan footprints; its box if it has none. */
export function feetOf(e: Entity): Foot[] {
  if (!e.colliders.length) return [boxFoot(e.pos.x, e.pos.y, e.pos.z, e.quat, e.hx, e.hy, e.hz)];
  const out: Foot[] = [];
  for (const c of e.colliders) {
    const t = c.translation(), r = c.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const sh = c.shape as unknown as {
      halfExtents?: { x: number; y: number; z: number }; radius?: number; halfHeight?: number; vertices?: Float32Array;
    };
    if (sh.halfExtents) {
      out.push(boxFoot(t.x, t.y, t.z, _q, sh.halfExtents.x, sh.halfExtents.y, sh.halfExtents.z));
    } else if (sh.halfHeight !== undefined) {
      const rad = sh.radius ?? e.hx;
      out.push(boxFoot(t.x, t.y, t.z, _q, rad, sh.halfHeight, rad));
    } else if (sh.vertices) {
      const v = sh.vertices;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < v.length; i += 3) {
        x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
        y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]);
        z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]);
      }
      _p.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).applyQuaternion(_q);
      out.push(boxFoot(t.x + _p.x, t.y + _p.y, t.z + _p.z, _q, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2));
    } else {
      const rad = sh.radius ?? e.hx;
      out.push(boxFoot(t.x, t.y, t.z, _q, rad, rad, rad));
    }
  }
  return out;
}

/** Which face of a building an outward normal belongs to: 0=+z 1=+x 2=-z 3=-x. */
export function sideOf(nx: number, nz: number) {
  return Math.abs(nz) > Math.abs(nx) ? (nz > 0 ? 0 : 2) : (nx > 0 ? 1 : 3);
}
const SIDE_N: readonly (readonly [number, number])[] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

function insideShell(b: Building, f: Foot, margin: number) {
  const c = Math.abs(Math.cos(f.rot)), s = Math.abs(Math.sin(f.rot));
  const ex = f.hx * c + f.hz * s, ez = f.hx * s + f.hz * c;
  return Math.abs(f.x - b.cx) + ex < b.w / 2 - margin && Math.abs(f.z - b.cz) + ez < b.d / 2 - margin;
}

// ------------------------------------------------------------- what is there

/**
 * The ways into a building, and the ground in front of them that has to stay
 * clear: the open bay under the entrance header, the glazed doorset with its
 * step, and the foot of the fire escape. `inward` extends the open bay into the
 * building too, so the fit-out does not park a sofa across it.
 */
export function doorways(b: Building, terrain: Terrain, outward = 1.8, inward = 0): Foot[] {
  const out: Foot[] = [];
  const gy = b.floorY[0];
  for (const e of b.elements) {
    if (e.label === 'lintel' && e.level === 0 && e.structType === ST.Facade) {
      const dx = (e.pos.x - b.cx) / (b.w / 2), dz = (e.pos.z - b.cz) / (b.d / 2);
      const runsX = Math.abs(dz) > Math.abs(dx);
      const sgn = runsX ? Math.sign(dz) : Math.sign(dx);
      const half = Math.max(e.hx, e.hz);
      const uc = (outward - inward) / 2, uh = (outward + inward) / 2;
      out.push(runsX
        ? { x: e.pos.x, z: e.pos.z + sgn * uc, hx: half, hz: uh, rot: 0, y0: gy - 0.5, y1: gy + 2.6 }
        : { x: e.pos.x + sgn * uc, z: e.pos.z, hx: uh, hz: half, rot: 0, y0: gy - 0.5, y1: gy + 2.6 });
    } else if (e.label === 'door step') {
      const ax = _p.set(1, 0, 0).applyQuaternion(e.quat);
      const rot = Math.atan2(-ax.z, ax.x);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(e.quat);
      const cx = e.pos.x + n.x * (e.hz + outward / 2), cz = e.pos.z + n.z * (e.hz + outward / 2);
      out.push({ x: cx, z: cz, hx: e.hx, hz: outward / 2, rot, y0: gy - 0.5, y1: gy + 2.6 });
    } else if (e.label === 'fire escape stair' && e.level === 1) {
      // Keep the bottom of the first flight clear so it can be climbed.
      const zAx = _p.set(0, 0, 1).applyQuaternion(e.quat);
      const l = Math.hypot(zAx.x, zAx.z) || 1;
      const dx = zAx.x / l, dz = zAx.z / l;
      const fx = e.pos.x - zAx.x * e.hz - dx * 0.7, fz = e.pos.z - zAx.z * e.hz - dz * 0.7;
      const sy = terrain.heightAt(fx, fz);
      out.push({ x: fx, z: fz, hx: 0.7, hz: 0.6, rot: Math.atan2(-dz, dx), y0: sy - 0.5, y1: sy + 2.4 });
    }
  }
  return out;
}

/**
 * Record everything a building puts at street level — its walls, the trim and
 * doorsets standing proud of them, the fire escape's first flight, signs hung
 * low enough to walk into — and keep its doorways clear, so nothing that comes
 * after is set down inside any of it.
 */
export function registerStreetLevel(ctx: Ctx, buildings: Building[]) {
  const { fp, terrain } = ctx;
  for (const b of buildings) {
    const gy = b.floorY[0];
    if (b.shell) {
      fp.add({ x: b.cx, z: b.cz, hx: b.w / 2 + 0.05, hz: b.d / 2 + 0.05, rot: 0, y0: gy - 1, y1: b.top + 1 });
      continue;
    }
    const seen = new Set<Entity>();
    const reg = (e: Entity) => {
      if (seen.has(e)) return;
      seen.add(e);
      // Cheap reject first: whole storeys up, nothing at street level can meet it.
      if (e.pos.y - Math.max(e.hx, e.hy, e.hz) > gy + 5) return;
      for (const f of feetOf(e)) {
        if (f.y0 > terrain.heightAt(f.x, f.z) + 3.2) continue;   // overhead: awnings, signs, balconies
        if (insideShell(b, f, 0.3)) continue;                      // indoors: the fit-out has its own plan
        fp.add(f);
      }
    };
    for (const e of b.elements) {
      reg(e);
      for (const s of e.supports) reg(s);                          // hung on it: signs, pipes, ladders
    }
    for (const f of doorways(b, terrain)) fp.add(f);
  }
}

/**
 * Room in front of one face of a building for a scaffold and its yard: road
 * the whole way out, with nobody else's building in it.
 */
export function scaffoldRoom(plan: CityPlan, b: Building, side: number): boolean {
  const [nx, nz] = SIDE_N[side];
  const ax = -nz, az = nx;
  const face = side % 2 === 0 ? b.w : b.d;
  const wx = b.cx + nx * b.w / 2, wz = b.cz + nz * b.d / 2;
  for (const u of [1.0, 3.0, 5.6]) {
    for (let k = -2; k <= 2; k++) {
      const v = (k / 2) * (face / 2 - 0.5);
      const x = wx + nx * u + ax * v, z = wz + nz * u + az * v;
      if (!plan.isRoad(x, z)) return false;
      if (u > 2 && plan.isBuilt(x, z)) return false;
      if (Math.abs(z - RIVER_Z) < RIVER_HALF + 5 || z > SHORE_Z - 12) return false;
    }
  }
  return true;
}

/** The scaffold's own ground, and the way in to its ladder, kept clear. */
export function fenceScaffold(ctx: Ctx, s: ScaffoldSite) {
  const { along, out, width } = s;
  const gy = s.base.y;
  const wall = s.base.clone().addScaledVector(out, -(SCAF.outer + 1.6));
  const rot = Math.atan2(-along.z, along.x);
  const mid = wall.clone().addScaledVector(out, (SCAF.inner + SCAF.outer) / 2);
  ctx.fp.add({ x: mid.x, z: mid.z, hx: width / 2 + 0.2, hz: (SCAF.outer - SCAF.inner) / 2 + 0.24, rot, y0: gy - 0.5, y1: gy + 40 });
  // The first bay is the one the ladder comes down through.
  const a = wall.clone().addScaledVector(out, SCAF.outer + 0.85).addScaledVector(along, -width / 2 + SCAF.bay / 2);
  ctx.fp.add({ x: a.x, z: a.z, hx: SCAF.bay / 2, hz: 0.75, rot, y0: gy - 0.5, y1: gy + 2.5 });
}

// -------------------------------------------------------------- laying down

/** One piece of a group, in the group's own frame, `ly` above the ground. */
interface Piece { spec: PropSpec; kind: PropKind; lx: number; ly: number; lz: number; turn?: number }
/** Pieces set down together, with the half extents and height they fill. */
interface Group { pieces: Piece[]; hx: number; hz: number; h: number }

function groundUnder(ctx: Ctx, f: Foot) {
  let y = ctx.terrain.heightAt(f.x, f.z);
  for (const [x, z] of footSamples(f)) y = Math.max(y, ctx.terrain.heightAt(x, z));
  return y;
}

/**
 * Set a group down with its centre at (x, z), turned by `rot`, if its
 * footprint is clear; record it if it goes down. Returns what was placed.
 */
function lay(ctx: Ctx, x: number, z: number, rot: number, g: Group, pad = 0.04): Entity[] {
  if (!g.pieces.length) return [];
  const f: Foot = { x, z, hx: g.hx, hz: g.hz, rot, y0: 0, y1: 0 };
  const gy = groundUnder(ctx, f);
  f.y0 = gy; f.y1 = gy + g.h;
  if (ctx.fp.hits(f, pad)) return [];
  ctx.fp.add(f);
  const c = Math.cos(rot), s = Math.sin(rot);
  return g.pieces.map((p) => placeSpec(ctx.spawn, p.spec, p.kind,
    x + p.lx * c + p.lz * s,
    gy + p.ly + (p.spec.centred ? p.spec.half.y : 0) + GAP,
    z - p.lx * s + p.lz * c,
    rot + (p.turn ?? 0)));
}

/** Plan reach of a spec along its group's X and Z when turned by `turn` within it. */
const reachX = (p: PropSpec, turn: number) => p.half.x * Math.abs(Math.cos(turn)) + p.half.z * Math.abs(Math.sin(turn));
const reachZ = (p: PropSpec, turn: number) => p.half.x * Math.abs(Math.sin(turn)) + p.half.z * Math.abs(Math.cos(turn));

/** Specs stacked one on another at (lx, lz), each squarely on the one below. */
function tower(rng: Rng, kind: PropKind, specs: PropSpec[], lx = 0, lz = 0, turn = 0, base = 0) {
  const pieces: Piece[] = [];
  let y = base;
  for (const spec of specs) {
    pieces.push({ spec, kind, lx, ly: y, lz, turn: turn + (pieces.length ? rng.range(-0.025, 0.025) : 0) });
    y += spec.half.y * 2 + GAP;
  }
  return { pieces, top: y };
}

/** `n` specs of one kind: all alike, or each drawn afresh (a stack of mixed colours). */
function specs(ctx: Ctx, kind: PropKind, n: number, alike = true): PropSpec[] {
  const first = propSpec(kind, ctx.rng);
  const out = [first];
  for (let i = 1; i < n; i++) out.push(alike ? first : propSpec(kind, ctx.rng));
  return out;
}

/** Stacks standing side by side along the group's own X. */
function abreast(ctx: Ctx, stacks: { kind: PropKind; specs: PropSpec[]; turn?: number }[], gap = 0.05): Group {
  if (!stacks.length) return { pieces: [], hx: 0, hz: 0, h: 0 };
  const widths = stacks.map((s) => Math.max(...s.specs.map((p) => reachX(p, s.turn ?? 0))) * 2);
  const depth = Math.max(...stacks.map((s) => Math.max(...s.specs.map((p) => reachZ(p, s.turn ?? 0)))));
  const total = widths.reduce((a, w) => a + w, 0) + gap * (stacks.length - 1);
  const pieces: Piece[] = [];
  let x = -total / 2, h = 0;
  stacks.forEach((s, i) => {
    const t = tower(ctx.rng, s.kind, s.specs, x + widths[i] / 2, 0, s.turn ?? 0);
    pieces.push(...t.pieces);
    h = Math.max(h, t.top);
    x += widths[i] + gap;
  });
  return { pieces, hx: total / 2 + 0.02, hz: depth + 0.02, h };
}

// ------------------------------------------------------------ stock in piles

/** Scaffold boards, a stack or two of them. */
function boards(ctx: Ctx): Group {
  const { rng } = ctx;
  const m = rng.int(1, 2);
  const pieces: Piece[] = [];
  let h = 0;
  for (let j = 0; j < m; j++) {
    const t = tower(rng, 'scaffoldBoard', specs(ctx, 'scaffoldBoard', rng.int(4, 10)), 0, (j - (m - 1) / 2) * 0.26);
    pieces.push(...t.pieces);
    h = Math.max(h, t.top);
  }
  return { pieces, hx: 1.97, hz: m * 0.13 + 0.01, h };
}

/**
 * Scaffold tubes laid side by side, couplers at alternate ends so they do not
 * foul one another.
 */
function tubes(ctx: Ctx): Group {
  const { rng } = ctx;
  const spec = propSpec('scaffoldPole', rng);
  const n = rng.int(4, 9), step = 0.082;
  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    pieces.push({ spec, kind: 'scaffoldPole', lx: 0, ly: 0, lz: (i - (n - 1) / 2) * step, turn: i % 2 ? Math.PI : 0 });
  }
  return { pieces, hx: spec.half.x + 0.01, hz: (n - 1) * step / 2 + 0.06, h: 0.075 };
}

/** Sheets of ply, as they came off the lorry. */
function plySheets(ctx: Ctx): Group {
  const t = tower(ctx.rng, 'plywood', specs(ctx, 'plywood', ctx.rng.int(3, 9)));
  return { pieces: t.pieces, hx: 1.23, hz: 0.62, h: t.top };
}

/** Corrugated sheet, the stuff every improvised roof is made of. */
function tin(ctx: Ctx): Group {
  const t = tower(ctx.rng, 'corrugated', specs(ctx, 'corrugated', ctx.rng.int(3, 7)));
  return { pieces: t.pieces, hx: 1.21, hz: 0.46, h: t.top };
}

/** Sawn posts, a layer or two of three or four. */
function posts(ctx: Ctx): Group {
  const { rng } = ctx;
  const spec = propSpec('timberPost', rng);
  const across = rng.int(3, 4), layers = rng.int(1, 2);
  const pieces: Piece[] = [];
  for (let l = 0; l < layers; l++) {
    for (let i = 0; i < across; i++) {
      pieces.push({ spec, kind: 'timberPost', lx: 0, ly: l * (0.09 + GAP), lz: (i - (across - 1) / 2) * 0.1, turn: rng.range(-0.01, 0.01) });
    }
  }
  return { pieces, hx: spec.half.x + 0.02, hz: across * 0.05 + 0.02, h: layers * 0.093 };
}

/** A pallet of cinder blocks, stacked three by three. */
function blockPallet(ctx: Ctx): Group {
  const { rng } = ctx;
  const pallet = propSpec('pallet', rng);
  const block = propSpec('cinderBlock', rng);
  const pieces: Piece[] = [{ spec: pallet, kind: 'pallet', lx: 0, ly: 0, lz: 0 }];
  const top = pallet.half.y * 2 + GAP;
  const layers = rng.int(1, 3);
  for (let l = 0; l < layers; l++) {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        pieces.push({ spec: block, kind: 'cinderBlock', lx: i * 0.4, ly: top + l * (0.19 + GAP), lz: j * 0.2 });
      }
    }
  }
  return { pieces, hx: 0.61, hz: 0.51, h: top + layers * 0.193 };
}

/** Empty pallets stacked. */
function pallets(ctx: Ctx): Group {
  const t = tower(ctx.rng, 'pallet', specs(ctx, 'pallet', ctx.rng.int(2, 6)));
  return { pieces: t.pieces, hx: 0.61, hz: 0.51, h: t.top };
}

/** Sandbags laid as a low wall, the second course bonded over the first. */
function sandbagWall(ctx: Ctx): Group {
  const { rng } = ctx;
  const spec = propSpec('sandbag', rng);
  const n = rng.int(2, 4), pitch = 0.64;
  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) pieces.push({ spec, kind: 'sandbag', lx: (i - (n - 1) / 2) * pitch, ly: 0, lz: 0 });
  const courses = n > 2 && rng.bool(0.6) ? 2 : 1;
  if (courses === 2) {
    for (let i = 0; i < n - 1; i++) pieces.push({ spec, kind: 'sandbag', lx: (i - (n - 2) / 2) * pitch, ly: 0.3 + GAP, lz: 0 });
  }
  return { pieces, hx: n * pitch / 2, hz: 0.22, h: courses * 0.303 };
}

function tyres(ctx: Ctx): Group {
  const { rng } = ctx;
  const m = rng.int(1, 2);
  return abreast(ctx, Array.from({ length: m }, () => ({ kind: 'tyre' as PropKind, specs: specs(ctx, 'tyre', rng.int(1, 4)) })), 0.04);
}

/** Toolbox, fuel and a bucket: somebody's kit, left where the work is. */
function kit(ctx: Ctx): Group {
  const { rng } = ctx;
  const parts: PropKind[] = ['toolbox', 'jerryCan'];
  if (rng.bool(0.6)) parts.push('bucket');
  if (rng.bool(0.4)) parts.push('jerryCan');
  return abreast(ctx, rng.shuffle(parts).map((kind) => ({ kind, specs: [propSpec(kind, rng)] })), 0.08);
}

function barrels(ctx: Ctx): Group {
  return abreast(ctx, Array.from({ length: ctx.rng.int(1, 3) }, () => ({ kind: 'barrel' as PropKind, specs: [propSpec('barrel', ctx.rng)] })), 0.05);
}

function single(ctx: Ctx, kind: PropKind, turn = 0): Group {
  return abreast(ctx, [{ kind, specs: [propSpec(kind, ctx.rng)], turn }]);
}

/** Bottle crates, stacked two to five high, the colours mixed. */
function crates(ctx: Ctx, stacks: number): Group {
  const { rng } = ctx;
  return abreast(ctx, Array.from({ length: stacks }, () => ({
    kind: 'plasticCrate' as PropKind, specs: specs(ctx, 'plasticCrate', rng.int(2, 5), false),
  })), 0.04);
}

/** Cartons, the big ones at the bottom. */
function cartons(ctx: Ctx, stacks: number): Group {
  const { rng } = ctx;
  return abreast(ctx, Array.from({ length: stacks }, () => ({
    kind: 'cardboardBox' as PropKind,
    specs: specs(ctx, 'cardboardBox', rng.int(1, 3), false).sort((a, b) => b.half.x - a.half.x),
    turn: rng.range(-0.08, 0.08),
  })), 0.05);
}

/** Rubbish bags, one row or two. */
function bags(ctx: Ctx, n: number): Group {
  const { rng } = ctx;
  const rows = n > 4 ? 2 : 1;
  const per = Math.ceil(n / rows);
  const pitch = 0.56, depth = 0.5;
  const pieces: Piece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < per && r * per + i < n; i++) {
      pieces.push({
        spec: propSpec('trashBag', rng), kind: 'trashBag',
        lx: (i - (per - 1) / 2) * pitch + (r ? pitch * 0.25 : 0), ly: 0, lz: (r - (rows - 1) / 2) * depth,
        turn: rng.range(-0.1, 0.1) + (rng.bool() ? Math.PI : 0),
      });
    }
  }
  return { pieces, hx: per * pitch / 2 + pitch * 0.25 * (rows - 1) + 0.02, hz: rows * depth / 2 + 0.02, h: 0.5 };
}

/** Bicycles parked side by side, noses to the wall. */
function bikeRack(ctx: Ctx, n: number): Group {
  const { rng } = ctx;
  return abreast(ctx, Array.from({ length: n }, () => ({
    kind: 'bicycle' as PropKind, specs: [propSpec('bicycle', rng)],
    turn: (rng.bool() ? Math.PI / 2 : -Math.PI / 2) + rng.range(-0.04, 0.04),
  })), 0.18);
}

// ------------------------------------------------------------- against walls

interface Wall {
  /** The wall's outer face at the middle of the panel. */
  x: number; z: number;
  /** Outward normal and along-wall direction in plan. */
  nx: number; nz: number; ax: number; az: number;
  /** Turns a prop's +Z outward and its +X along the wall. */
  rot: number;
  half: number;
}

function wallOf(e: Entity): Wall {
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(e.quat);
  const a = new THREE.Vector3(1, 0, 0).applyQuaternion(e.quat);
  return { x: e.pos.x + n.x * e.hz, z: e.pos.z + n.z * e.hz, nx: n.x, nz: n.z, ax: a.x, az: a.z, rot: Math.atan2(n.x, n.z), half: e.hx };
}

/**
 * Set a group down against a wall, `v` along it, as close in as the wall's own
 * trim allows: in front of a pilaster or a threshold rather than inside it.
 */
function againstWall(ctx: Ctx, w: Wall, v: number, g: Group, turn = 0): Entity[] {
  if (!g.pieces.length) return [];
  const rot = w.rot + turn;
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = g.hx * Math.abs(c * w.nx - s * w.nz) + g.hz * Math.abs(s * w.nx + c * w.nz);
  const side = g.hx * Math.abs(c * w.ax - s * w.az) + g.hz * Math.abs(s * w.ax + c * w.az);
  const lim = w.half - side - 0.03;
  if (lim < 0) return [];
  const vv = Math.max(-lim, Math.min(lim, v));
  for (const gap of [0.06, 0.16, 0.3, 0.48, 0.7]) {
    const u = out + gap;
    const x = w.x + w.nx * u + w.ax * vv, z = w.z + w.nz * u + w.az * vv;
    if (!ctx.plan.isRoad(x, z)) return [];
    const got = lay(ctx, x, z, rot, g);
    if (got.length) return got;
  }
  return [];
}

/** A proper street out there, not an alley: room to leave a bike sticking out. */
function roomy(ctx: Ctx, w: Wall) {
  const x = w.x + w.nx * 5.5, z = w.z + w.nz * 5.5;
  return ctx.plan.isRoad(x, z) && !ctx.plan.isBuilt(x, z);
}

type Cluster = 'crates' | 'cartons' | 'bikes' | 'bags' | 'kit' | 'plant' | 'aBoard' | 'vending'
  | 'tyres' | 'pallets' | 'barrels' | 'skip' | 'bucket';

const MIX: Record<FacadeStyle, Partial<Record<Cluster, number>>> = {
  shophouse: { crates: 3, cartons: 2.6, bikes: 1.7, bags: 1.2, bucket: 1, plant: 1, aBoard: 0.9, vending: 0.7, tyres: 0.2 },
  apartment: { bikes: 3.4, plant: 1.6, bags: 1, cartons: 0.7, bucket: 0.5, vending: 0.35 },
  office: { bikes: 1.2, plant: 1.6, cartons: 0.5, vending: 1, aBoard: 0.4 },
  warehouse: { pallets: 2, crates: 1.4, cartons: 1.4, tyres: 1.4, barrels: 1.1, kit: 1, bags: 0.6, skip: 0.7 },
};
const BUSY: Record<FacadeStyle, number> = { shophouse: 0.92, apartment: 0.8, office: 0.4, warehouse: 0.8 };

function clusterFor(ctx: Ctx, kind: Cluster, wide: boolean): Group {
  const { rng } = ctx;
  const row = (k: PropKind, n: number, gap: number, turn = () => 0) =>
    abreast(ctx, Array.from({ length: n }, () => ({ kind: k, specs: [propSpec(k, rng)], turn: turn() })), gap);
  switch (kind) {
    case 'crates': return crates(ctx, rng.int(1, 3));
    case 'cartons': return cartons(ctx, rng.int(1, 3));
    case 'bikes':
      // A rack of them nose-in where the street is wide enough; one or two
      // along the wall where it is not.
      if (wide && rng.bool(0.65)) return bikeRack(ctx, rng.int(2, 5));
      return row('bicycle', rng.int(1, 2), 0.12, () => (rng.bool() ? 0 : Math.PI));
    case 'bags': return bags(ctx, rng.int(2, 4));
    case 'kit': return kit(ctx);
    case 'bucket':
      return abreast(ctx, [
        { kind: 'bucket', specs: [propSpec('bucket', rng)] },
        ...(rng.bool(0.5) ? [{ kind: 'plasticCrate' as PropKind, specs: specs(ctx, 'plasticCrate', rng.int(1, 2), false) }] : []),
      ], 0.08);
    case 'plant': return row('planter', rng.int(1, 2), 0.1);
    case 'aBoard': return single(ctx, 'aBoard');
    case 'vending': return row('vending', rng.int(1, 2), 0.03);
    case 'tyres': return tyres(ctx);
    case 'pallets': return rng.bool(0.5) ? pallets(ctx) : blockPallet(ctx);
    case 'barrels': return barrels(ctx);
    case 'skip': return single(ctx, 'dumpster');
  }
}

/**
 * Along every open shop and house front: stacked bottle crates, cartons
 * waiting to go in, bicycles, buckets and plants, a vending machine humming
 * against the wall.
 */
export function shopfronts(ctx: Ctx, buildings: Building[]) {
  const { rng } = ctx;
  for (const b of buildings) {
    if (b.shell || !b.lot) continue;
    const open = b.lot.openSides;
    const mix = MIX[b.style];
    const kinds = Object.keys(mix) as Cluster[];
    for (const e of b.elements) {
      if (e.label !== 'facade' || e.level !== 0 || e.hx < 0.8) continue;
      const w = wallOf(e);
      const side = sideOf(w.nx, w.nz);
      if (!open[side] || side === b.scaffoldSide) continue;
      if (!rng.bool(BUSY[b.style])) continue;
      const wide = roomy(ctx, w);
      // Roughly one group every three or four metres of frontage.
      const n = 1 + (w.half > 2.2 && rng.bool(0.8) ? 1 : 0) + (w.half > 3.6 && rng.bool(0.7) ? 1 : 0)
        + (w.half > 5 && rng.bool(0.6) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const kind = rng.weighted(kinds, (k) => mix[k] ?? 0);
        againstWall(ctx, w, rng.range(-w.half, w.half), clusterFor(ctx, kind, wide));
      }
    }
  }
}

// ---------------------------------------------------------- collection points

/**
 * Rubbish bags heaped at the roadside on collection day, the way every Tokyo
 * street has them at intervals along the kerb.
 */
export function garbagePoints(ctx: Ctx, core: number) {
  const { plan, rng } = ctx;
  const lines = [
    ...plan.vLines.map((l) => ({ l, alongZ: true, cross: plan.hLines })),
    ...plan.hLines.map((l) => ({ l, alongZ: false, cross: plan.vLines })),
  ];
  for (const { l, alongZ, cross } of lines) {
    if (Math.abs(l.pos) > core + 10) continue;
    const [lo, hi] = l.kind === 'alley' ? [55, 100] : [32, 58];
    for (let t = -core + rng.range(0, 24); t < core; t += rng.range(lo, hi)) {
      if (cross.some((c) => Math.abs(t - c.pos) < c.width / 2 + 3)) continue;   // not in a junction
      const g = bags(ctx, rng.int(3, 8));
      const sgn = rng.bool() ? 1 : -1;
      const rot = alongZ ? Math.PI / 2 : 0;                   // the heap's own X runs along the road
      for (let u = g.hz - 0.12; u < g.hz + 1.2; u += 0.14) {  // how far in from the road's edge
        const off = l.width / 2 - u;
        const x = alongZ ? l.pos + sgn * off : t;
        const z = alongZ ? t : l.pos + sgn * off;
        if (Math.abs(z - RIVER_Z) < RIVER_HALF + 4 || z > SHORE_Z - 12 || z < -core || !plan.isRoad(x, z)) break;
        if (lay(ctx, x, z, rot, g).length) break;
      }
    }
  }
}

// --------------------------------------------------------------- work yards

/**
 * The yard at the foot of a scaffold: boards and tubes waiting to go up,
 * blocks on a pallet, ply and tin sheet, a skip, and cones round the lot. It
 * is where a player looking to build something goes shopping.
 */
export function workYard(ctx: Ctx, s: ScaffoldSite) {
  const { rng, plan } = ctx;
  const { along, out, width } = s;
  const wall = s.base.clone().addScaledVector(out, -(SCAF.outer + 1.6));
  // A group's +X runs along the wall and its +Z points out from it.
  const rot = Math.atan2(out.x, out.z);
  const ax = Math.cos(rot), az = -Math.sin(rot);
  const at = (u: number, v: number) => [wall.x + out.x * u + ax * v, wall.z + out.z * u + az * v] as const;
  const put = (u: number, v: number, g: Group) => {
    const [x, z] = at(u, v);
    if (!plan.isRoad(x, z)) return false;
    return lay(ctx, x, z, rot, g, 0.08).length > 0;
  };
  // The ladder comes down through the bay at the `along` = -width/2 end; keep
  // the stock clear of its approach, whichever way the group frame runs.
  const ladderEnd = Math.sign(ax * along.x + az * along.z) || 1;
  const start = -width / 2 + (ladderEnd > 0 ? SCAF.bay + 0.2 : 0.2);
  const end = width / 2 - (ladderEnd > 0 ? 0.2 : SCAF.bay + 0.2);

  // Nearest the scaffold, the long stuff, laid along the wall.
  const rowA = SCAF.outer + 0.34;
  const longs = rng.shuffle([boards, tubes, plySheets, tin, posts, boards, plySheets, tubes]);
  let v = start, depthA = 0;
  for (const make of longs) {
    const g = make(ctx);
    if (v + g.hx * 2 > end) continue;
    if (put(rowA + g.hz, v + g.hx, g)) depthA = Math.max(depthA, g.hz * 2);
    v += g.hx * 2 + 0.3;
  }

  // Beyond it, the heavy and the bulky.
  const rowB = rowA + Math.max(depthA, 0.5) + 0.45;
  const bulk = rng.shuffle([blockPallet, blockPallet, sandbagWall, tyres, kit, pallets, barrels,
    (c: Ctx) => single(c, 'dumpster'), (c: Ctx) => single(c, 'portaloo'), sandbagWall]);
  v = start;
  let depthB = 0;
  for (const make of bulk) {
    const g = make(ctx);
    if (v + g.hx * 2 > end) continue;
    if (put(rowB + g.hz, v + g.hx, g)) depthB = Math.max(depthB, g.hz * 2);
    v += g.hx * 2 + 0.4;
  }

  // Cones round the outside of it all.
  const rowC = rowB + Math.max(depthB, 0.6) + 0.6;
  for (let cv = -width / 2 + 0.4; cv < width / 2; cv += rng.range(1.6, 2.4)) put(rowC, cv, single(ctx, 'cone'));
}

/** The same stock, in piles across an open building site. */
export function stockSite(ctx: Ctx, x0: number, z0: number, x1: number, z1: number) {
  const { rng } = ctx;
  const makers = [boards, tubes, plySheets, tin, posts, blockPallet, blockPallet, pallets, tyres, sandbagWall, kit, boards, plySheets];
  const n = Math.round(((x1 - x0) * (z1 - z0)) / 150);
  for (let i = 0; i < n; i++) {
    const g = rng.pick(makers)(ctx);
    for (let t = 0; t < 4; t++) {
      const x = rng.range(x0 + 3, x1 - 3), z = rng.range(z0 + 3, z1 - 3);
      const r = (rng.bool() ? 0 : Math.PI / 2) + rng.range(-0.2, 0.2);
      if (lay(ctx, x, z, r, g, 0.35).length) break;
    }
  }
}

/** Stock on a shop floor: crates and cartons, stacked. */
export function shopStock(ctx: Ctx, x: number, z: number, rot: number): Entity[] {
  const { rng } = ctx;
  const g = rng.bool(0.5) ? crates(ctx, rng.int(1, 3)) : cartons(ctx, rng.int(1, 3));
  return lay(ctx, x, z, rot, g, 0.08);
}

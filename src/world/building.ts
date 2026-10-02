import * as THREE from 'three';
import { Entity, F, Kind, GROUP, interactionGroups } from '../physics/entity';
import { MATERIALS, type Mat } from '../physics/materials';
import type { Spawner } from './spawn';
import type { Lot } from './cityplan';
import { Rng, clamp } from '../util/math';
import { RAPIER } from '../physics/physworld';
import * as GEO from '../render/geometry';
import { makeMaterial } from '../render/materials';
import { snapTo, FLOOR_H, type FacadeStyle } from './facade';

/** Wall colours used across the city; per-instance variation does the rest. */
export const FACADE_TONES = [
  0x8d8880,  // grey concrete
  0x6f6c68,  // dark concrete
  0xb0a48c,  // beige tile
  0x5d6166,  // slate
  0x9a7f63,  // brown tile
  0x6c7a74,  // green-grey
  0xa8a096,  // pale render
  0x54585e,  // charcoal panel
  0x8a6e58,  // terracotta
  0x77808a,  // blue-grey
];

export const enum ST { Column = 1, Slab = 2, Facade = 3, Wall = 4, Stair = 5, Parapet = 6, Glass = 7, Shell = 8, Beam = 9 }

/** How many intact supports an element needs before it lets go. */
export const MIN_SUPPORT: Record<number, number> = {
  [ST.Column]: 1, [ST.Slab]: 2, [ST.Facade]: 1, [ST.Wall]: 1,
  [ST.Stair]: 1, [ST.Parapet]: 1, [ST.Glass]: 1, [ST.Shell]: 1, [ST.Beam]: 1,
};

export interface RoofSpot { x: number; y: number; z: number; w: number; d: number; }

export class Building {
  id = 0;
  elements: Entity[] = [];
  floorY: number[] = [];
  nx = 1; nz = 1;
  cx = 0; cz = 0; w = 1; d = 1;
  floors = 1;
  style: FacadeStyle = 'office';
  /** Slab cells per level: slabs[level][ix*nz+iz] */
  slabs: (Entity | null)[][] = [];
  cols: (Entity | null)[][] = [];
  roofSpots: RoofSpot[] = [];
  /** Interior floor plates the player can be standing on. */
  swayAmp = 0;
  swayPhase = 0;
  swayActive = false;
  collapsedFrac = 0;
  destroyedCount = 0;
  baseIntegrity = 1;
  lot: Lot | null = null;
  shell = false;
  /** Side under repair and wrapped in scaffolding (0=+z 1=+x 2=-z 3=-x), or -1. */
  scaffoldSide = -1;
  /** One fixed body carries every intact element's collider. */
  body: RAPIER.RigidBody | null = null;
  swayBase = 0;
  /** Build quality, 0.6 (shoddy) to 1.5 (engineered). Decides who survives. */
  quality = 1;
  /** Timber-framed: weaker, and it burns. */
  timber = false;

  get top() { return this.floorY[this.floorY.length - 1]; }
  contains(x: number, z: number, pad = 0) {
    return x > this.cx - this.w / 2 - pad && x < this.cx + this.w / 2 + pad &&
           z > this.cz - this.d / 2 - pad && z < this.cz + this.d / 2 + pad;
  }
}

export interface BuildParams {
  spawn: Spawner;
  lot: Lot;
  rng: Rng;
  groundY: number;
  id: number;
  /** Shell buildings skip the structural graph — used far from the core. */
  shell?: boolean;
  budget?: { used: number; max: number };
}

const COL_MAT: Record<string, Mat> = {
  office: MATERIALS.rebarConcrete, tower: MATERIALS.steel, apartment: MATERIALS.rebarConcrete,
  shophouse: MATERIALS.concrete, warehouse: MATERIALS.steel, parking: MATERIALS.rebarConcrete,
  lowrise: MATERIALS.concrete,
};

/**
 * A good share of the older, low-rise stock is timber-framed. Those blocks are
 * weaker in a quake and — far more importantly — they burn, which is what turns
 * a single ignition into a district fire.
 */
function isTimber(type: string, rng: Rng) {
  return (type === 'shophouse' || type === 'lowrise') && rng.bool(0.45);
}

export function buildBuilding(p: BuildParams): Building {
  const { spawn, lot, rng } = p;
  const b = new Building();
  b.id = p.id;
  b.lot = lot;
  const margin = 0.3;
  const x0 = lot.x0 + margin, x1 = lot.x1 - margin;
  const z0 = lot.z0 + margin, z1 = lot.z1 - margin;
  b.w = x1 - x0; b.d = z1 - z0;
  b.cx = (x0 + x1) / 2; b.cz = (z0 + z1) / 2;
  b.floors = lot.floors;

  // A single fixed body holds all of this building's colliders while it stands.
  const body = spawn.phys.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  b.body = body;

  const type = lot.type;
  // Newer, taller, steel-framed buildings are better built than old shophouses.
  b.quality = clamp(
    (type === 'tower' || type === 'office' ? 1.25 : type === 'apartment' ? 1.0 : type === 'shophouse' ? 0.76 : 0.88)
    * rng.range(0.78, 1.28), 0.55, 1.75);
  b.style = type === 'office' || type === 'tower' ? 'office'
    : type === 'apartment' ? 'apartment'
    : type === 'warehouse' || type === 'parking' ? 'warehouse'
    : 'shophouse';

  // --- storey heights -----------------------------------------------------
  const groundH = snapTo(type === 'shophouse' || type === 'office' || type === 'tower' ? 4.2 : 3.6, FLOOR_H);
  const upperH = snapTo(type === 'office' || type === 'tower' ? 3.6 : type === 'warehouse' ? 5.0 : 3.2, FLOOR_H);
  let y = p.groundY;
  b.floorY.push(y);
  for (let l = 0; l < b.floors; l++) { y += l === 0 ? groundH : upperH; b.floorY.push(y); }

  if (p.shell) { buildShell(spawn, b, rng, p.groundY); b.shell = true; return b; }
  b.swayBase = p.groundY;

  // --- structural grid ----------------------------------------------------
  b.nx = clamp(Math.round(b.w / 11), 1, 3);
  b.nz = clamp(Math.round(b.d / 11), 1, 3);
  const cellW = b.w / b.nx, cellD = b.d / b.nz;
  const timber = isTimber(type, rng) && b.floors <= 4;
  const colSize = timber ? 0.34 : b.floors > 10 ? 0.62 : b.floors > 5 ? 0.5 : 0.42;
  const slabT = timber ? 0.22 : 0.26;
  const colMat = timber ? MATERIALS.wood : (COL_MAT[type] ?? MATERIALS.rebarConcrete);
  const slabMat = timber ? MATERIALS.plywood : MATERIALS.rebarConcrete;
  b.timber = timber;
  if (timber) b.quality *= 0.72;
  const tone = rng.int(0, FACADE_TONES.length - 1);

  const nodeX = (i: number) => x0 + (i / b.nx) * b.w;
  const nodeZ = (j: number) => z0 + (j / b.nz) * b.d;

  // stairwell cell: pick an interior-ish cell
  const stairIX = b.nx > 1 ? rng.int(0, b.nx - 1) : 0;
  const stairIZ = b.nz > 1 ? rng.int(0, b.nz - 1) : 0;
  const hasStair = b.floors > 1;

  // entrance bay on the street-facing side
  const entranceSide = lot.openSides.findIndex((s) => s) >= 0
    ? lot.openSides.indexOf(true) : lot.face;
  const entranceBay = rng.int(0, (entranceSide % 2 === 0 ? b.nx : b.nz) - 1);

  for (let L = 0; L < b.floors; L++) {
    const yb = b.floorY[L], yt = b.floorY[L + 1];
    const h = yt - yb;
    const colH = h - slabT;

    // --- columns (span this storey) ---
    const colLevel: (Entity | null)[] = [];
    for (let i = 0; i <= b.nx; i++) {
      for (let j = 0; j <= b.nz; j++) {
        const e = spawn.box({
          pos: new THREE.Vector3(nodeX(i), yb + colH / 2, nodeZ(j)),
          size: new THREE.Vector3(colSize, colH, colSize),
          mat: colMat, body: 'fixed', kind: Kind.Structure,
          matOpts: { instanced: true, vary: 0.1 },
          flags: F.STRUCTURAL | F.BREAKABLE, capacity: 512, attachTo: body,
          group: GROUP.STRUCTURE, label: 'column',
        });
        e.structType = ST.Column; e.buildingId = b.id; e.level = L;
        e.home.copy(e.pos);
        colLevel.push(e);
        b.elements.push(e);
      }
    }
    b.cols.push(colLevel);

    // --- slab that caps this storey ---
    const slabLevel: (Entity | null)[] = [];
    for (let i = 0; i < b.nx; i++) {
      for (let j = 0; j < b.nz; j++) {
        if (hasStair && i === stairIX && j === stairIZ && L < b.floors - 1) { slabLevel.push(null); continue; }
        const e = spawn.box({
          pos: new THREE.Vector3(x0 + (i + 0.5) * cellW, yt - slabT / 2, z0 + (j + 0.5) * cellD),
          size: new THREE.Vector3(cellW, slabT, cellD),
          mat: slabMat, body: 'fixed', kind: Kind.Structure,
          matOpts: { instanced: true, vary: 0.12, colorOverride: timber ? 0x9a7c56 : 0x8b8880 },
          flags: F.STRUCTURAL | F.BREAKABLE, capacity: 512, attachTo: body,
          group: GROUP.STRUCTURE, label: 'slab',
        });
        e.structType = ST.Slab; e.buildingId = b.id; e.level = L;
        e.home.copy(e.pos);
        slabLevel.push(e);
        b.elements.push(e);
      }
    }
    b.slabs.push(slabLevel);

    // --- facade panels ---
    const panelH = h;
    for (let side = 0; side < 4; side++) {
      const n = side % 2 === 0 ? b.nx : b.nz;
      for (let k = 0; k < n; k++) {
        if (L === 0 && side === entranceSide && k === entranceBay) {
          // real opening: only a header beam above the doorway
          const bw = side % 2 === 0 ? cellW : cellD;
          const hh = Math.max(0.6, h - 2.55 - slabT);
          const cxp = side % 2 === 0 ? x0 + (k + 0.5) * cellW : (side === 1 ? x1 : x0);
          const czp = side % 2 === 0 ? (side === 0 ? z1 : z0) : z0 + (k + 0.5) * cellD;
          const sz = side % 2 === 0 ? new THREE.Vector3(bw, hh, 0.24) : new THREE.Vector3(0.24, hh, bw);
          const e = spawn.box({
            pos: new THREE.Vector3(cxp, yt - slabT - hh / 2, czp),
            size: sz, mat: MATERIALS.concrete, body: 'fixed', kind: Kind.Structure,
            matOpts: { instanced: true, vary: 0.15 }, flags: F.STRUCTURAL | F.BREAKABLE,
            capacity: 256, attachTo: body, group: GROUP.STRUCTURE, label: 'lintel',
          });
          e.structType = ST.Facade; e.buildingId = b.id; e.level = L;
          e.home.copy(e.pos);
          b.elements.push(e);
          continue;
        }
        const bw = side % 2 === 0 ? cellW : cellD;
        let px = 0, pz = 0, rotY = 0;
        if (side === 0) { px = x0 + (k + 0.5) * cellW; pz = z1; rotY = 0; }
        else if (side === 1) { px = x1; pz = z0 + (k + 0.5) * cellD; rotY = Math.PI / 2; }
        else if (side === 2) { px = x0 + (k + 0.5) * cellW; pz = z0; rotY = Math.PI; }
        else { px = x0; pz = z0 + (k + 0.5) * cellD; rotY = -Math.PI / 2; }
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
        const e = spawn.box({
          pos: new THREE.Vector3(px, yb + panelH / 2, pz), quat,
          size: new THREE.Vector3(bw, panelH, 0.26),
          mat: MATERIALS.concrete, body: 'fixed', kind: Kind.Structure,
          matOpts: {
            instanced: true, vary: 0.24, colorOverride: FACADE_TONES[tone],
            facade: { style: b.style, ground: L === 0 },
            roughOverride: b.style === 'warehouse' ? 0.6 : 0.87,
            metalOverride: b.style === 'warehouse' ? 0.35 : 0.02,
          },
          flags: F.STRUCTURAL | F.BREAKABLE | F.GLASS, attachTo: body,
          capacity: 1024, group: GROUP.STRUCTURE, label: 'facade',
        });
        e.structType = ST.Facade; e.buildingId = b.id; e.level = L;
        e.home.copy(e.pos);
        b.elements.push(e);
      }
    }

    // --- interior partitions ---
    const nWalls = b.nx * b.nz > 1 ? rng.int(0, 2) : rng.int(0, 1);
    for (let k = 0; k < nWalls; k++) {
      const vertical = rng.bool();
      const i = rng.int(1, vertical ? b.nx - 1 : b.nz - 1);
      if ((vertical && b.nx < 2) || (!vertical && b.nz < 2)) continue;
      const wh = h - slabT - 0.05;
      const size = vertical
        ? new THREE.Vector3(0.16, wh, cellD * rng.range(0.55, 1.0))
        : new THREE.Vector3(cellW * rng.range(0.55, 1.0), wh, 0.16);
      const pos = vertical
        ? new THREE.Vector3(nodeX(i), yb + wh / 2, z0 + (rng.int(0, b.nz - 1) + 0.5) * cellD)
        : new THREE.Vector3(x0 + (rng.int(0, b.nx - 1) + 0.5) * cellW, yb + wh / 2, nodeZ(i));
      const e = spawn.box({
        pos, size, mat: MATERIALS.plaster, body: 'fixed', kind: Kind.Structure,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0xd8d4c9 },
        flags: F.STRUCTURAL | F.BREAKABLE, capacity: 256, attachTo: body,
        group: GROUP.STRUCTURE, label: 'partition',
      });
      e.structType = ST.Wall; e.buildingId = b.id; e.level = L;
      e.home.copy(e.pos);
      b.elements.push(e);
    }

    // --- stair from this storey to the next ---
    if (hasStair && L < b.floors - 1) {
      const sx = x0 + (stairIX + 0.5) * cellW;
      const sz = z0 + (stairIZ + 0.5) * cellD;
      const run = Math.min(cellD * 0.86, 5.0);
      const rise = h;
      const ang = Math.atan2(rise, run);
      const len = Math.hypot(rise, run);
      // Steps are modelled in the ramp's own frame: X across, Y up, Z along the run.
      const stairGeo = GEO.composite(`stair${run.toFixed(1)}_${rise.toFixed(1)}`, () => {
        const g: THREE.BufferGeometry[] = [];
        const n = Math.max(8, Math.round(rise / 0.18));
        for (let s = 0; s < n; s++) {
          const zLocal = ((s + 0.5) / n - 0.5) * len;
          g.push(GEO.translated(new THREE.BoxGeometry(1.25, 0.15, (len / n) * 1.04), 0, 0.10, zLocal));
        }
        g.push(GEO.translated(new THREE.BoxGeometry(1.35, 0.14, len), 0, -0.02, 0));
        g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.9, len), 0.66, 0.52, 0));
        return GEO.merge(g);
      });
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -ang);
      const e = spawn.prop({
        geoKey: `stair${run.toFixed(1)}_${rise.toFixed(1)}`,
        geometry: stairGeo, material: makeMaterial(MATERIALS.concrete, { instanced: true, vary: 0.1 }),
        pos: new THREE.Vector3(sx, yb + rise / 2, sz), quat,
        half: new THREE.Vector3(0.7, 0.16, len / 2), mat: MATERIALS.rebarConcrete,
        body: 'fixed', kind: Kind.Structure,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.68, 0.10, len / 2) }],
        flags: F.STRUCTURAL | F.BREAKABLE, capacity: 96, attachTo: body,
        group: GROUP.STRUCTURE, label: 'stair',
      });
      e.structType = ST.Stair; e.buildingId = b.id; e.level = L;
      e.home.copy(e.pos);
      b.elements.push(e);
    }
  }

  // --- roof parapet -------------------------------------------------------
  const topY = b.floorY[b.floors];
  const ph = 1.05;
  for (let side = 0; side < 4; side++) {
    const horiz = side % 2 === 0;
    const size = horiz ? new THREE.Vector3(b.w, ph, 0.22) : new THREE.Vector3(0.22, ph, b.d);
    const pos = new THREE.Vector3(
      horiz ? b.cx : (side === 1 ? x1 : x0), topY + ph / 2,
      horiz ? (side === 0 ? z1 : z0) : b.cz);
    const e = spawn.box({
      pos, size, mat: MATERIALS.concrete, body: 'fixed', kind: Kind.Structure,
      matOpts: { instanced: true, vary: 0.14 }, flags: F.STRUCTURAL | F.BREAKABLE,
      capacity: 256, attachTo: body, group: GROUP.STRUCTURE, label: 'parapet',
    });
    e.structType = ST.Parapet; e.buildingId = b.id; e.level = b.floors;
    e.home.copy(e.pos);
    b.elements.push(e);
  }
  b.roofSpots.push({ x: b.cx, y: topY, z: b.cz, w: b.w - 1.6, d: b.d - 1.6 });

  wireSupports(b);
  return b;
}

/** A simple massive block used outside the simulated core. Still breakable. */
function buildShell(spawn: Spawner, b: Building, rng: Rng, groundY: number) {
  const full = b.floorY[b.floors] - groundY;
  // Taller blocks step back as they rise, which is what stops the skyline from
  // reading as a row of identical shoeboxes.
  const steps = full > 42 ? rng.int(1, 3) : full > 24 ? rng.int(0, 2) : 0;
  const h = steps ? full * rng.range(0.52, 0.74) : full;
  const tone = rng.int(0, FACADE_TONES.length - 1);
  // Outside the simulated core a building is one massive block; the facade
  // shader still gives it storeys, windows and lit rooms.
  const core = spawn.box({
    pos: new THREE.Vector3(b.cx, groundY + h / 2, b.cz),
    size: new THREE.Vector3(b.w, h, b.d),
    mat: MATERIALS.rebarConcrete, body: 'fixed', kind: Kind.Structure,
    matOpts: {
      instanced: true, vary: 0.26, colorOverride: FACADE_TONES[tone],
      facade: { style: b.style, ground: false },
      roughOverride: b.style === 'warehouse' ? 0.6 : 0.87,
      metalOverride: b.style === 'warehouse' ? 0.35 : 0.02,
    },
    flags: F.STRUCTURAL | F.BREAKABLE | F.GLASS | F.NO_DESPAWN,
    capacity: 512, attachTo: b.body, group: GROUP.STRUCTURE, label: 'shell',
  });
  core.structType = ST.Shell; core.buildingId = b.id; core.home.copy(core.pos);
  core.grounded = true;
  b.elements.push(core);

  let y = groundY + h, sw = b.w, sd = b.d, prev = core;
  for (let i = 0; i < steps; i++) {
    const t = rng.range(0.62, 0.84);
    sw *= t; sd *= t;
    const sh = (full - (y - groundY)) * (i === steps - 1 ? 1 : rng.range(0.45, 0.72));
    if (sh < 3 || sw < 5 || sd < 5) break;
    const ox = rng.range(-1, 1) * (b.w - sw) * 0.22;
    const oz = rng.range(-1, 1) * (b.d - sd) * 0.22;
    const step = spawn.box({
      pos: new THREE.Vector3(b.cx + ox, y + sh / 2, b.cz + oz),
      size: new THREE.Vector3(sw, sh, sd),
      mat: MATERIALS.rebarConcrete, body: 'fixed', kind: Kind.Structure,
      matOpts: {
        instanced: true, vary: 0.26, colorOverride: FACADE_TONES[tone],
        facade: { style: b.style, ground: false },
        roughOverride: b.style === 'warehouse' ? 0.6 : 0.87,
        metalOverride: b.style === 'warehouse' ? 0.35 : 0.02,
      },
      flags: F.STRUCTURAL | F.BREAKABLE | F.GLASS | F.NO_DESPAWN,
      capacity: 512, attachTo: b.body, group: GROUP.STRUCTURE, label: 'shell',
    });
    step.structType = ST.Shell; step.buildingId = b.id; step.home.copy(step.pos);
    step.supportedBy.push(prev); prev.supports.push(step);
    b.elements.push(step);
    prev = step;
    y += sh;
  }
  b.roofSpots.push({ x: b.cx, y, z: b.cz, w: Math.max(2, sw - 2), d: Math.max(2, sd - 2) });
}

/** Link every element to the pieces that hold it up. */
function wireSupports(b: Building) {
  const link = (child: Entity, parent: Entity | null) => {
    if (!parent || !child) return;
    child.supportedBy.push(parent);
    parent.supports.push(child);
  };
  const colAt = (L: number, i: number, j: number) =>
    (L < 0 || L >= b.cols.length) ? null : b.cols[L][i * (b.nz + 1) + j] ?? null;
  const slabAt = (L: number, i: number, j: number) =>
    (L < 0 || L >= b.slabs.length) ? null : b.slabs[L][i * b.nz + j] ?? null;

  for (let L = 0; L < b.floors; L++) {
    // columns stand on the columns below; the ground floor stands on the earth
    for (let i = 0; i <= b.nx; i++) for (let j = 0; j <= b.nz; j++) {
      const c = colAt(L, i, j);
      if (!c) continue;
      if (L === 0) { c.grounded = true; }
      else {
        link(c, colAt(L - 1, i, j));
        // a column can also perch on the slab corners around it
        for (const [di, dj] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
          const s = slabAt(L - 1, i + di, j + dj);
          if (s) link(c, s);
        }
      }
    }
    // slabs rest on the four columns of their cell
    for (let i = 0; i < b.nx; i++) for (let j = 0; j < b.nz; j++) {
      const s = slabAt(L, i, j);
      if (!s) continue;
      link(s, colAt(L, i, j)); link(s, colAt(L, i + 1, j));
      link(s, colAt(L, i, j + 1)); link(s, colAt(L, i + 1, j + 1));
    }
  }

  // facades, partitions, stairs and parapets hang off whatever is adjacent
  for (const e of b.elements) {
    if (e.structType === ST.Facade) {
      const L = e.level;
      let best: Entity[] = [];
      for (let i = 0; i <= b.nx; i++) for (let j = 0; j <= b.nz; j++) {
        const c = colAt(L, i, j);
        if (!c) continue;
        const dx = c.home.x - e.home.x, dz = c.home.z - e.home.z;
        if (dx * dx + dz * dz < 36) best.push(c);
      }
      best.sort((a, c) => a.home.distanceToSquared(e.home) - c.home.distanceToSquared(e.home));
      best = best.slice(0, 3);
      for (const c of best) link(e, c);
      if (best.length === 0) {
        for (const s of b.slabs[L] ?? []) if (s) { link(e, s); break; }
      }
    } else if (e.structType === ST.Wall || e.structType === ST.Stair) {
      const L = e.level;
      const below = L === 0 ? null : b.slabs[L - 1];
      let picked = false;
      if (below) {
        for (const s of below) {
          if (s && Math.abs(s.home.x - e.home.x) < b.w / b.nx && Math.abs(s.home.z - e.home.z) < b.d / b.nz) {
            link(e, s); picked = true;
          }
        }
      }
      if (!picked) {
        for (let i = 0; i <= b.nx; i++) for (let j = 0; j <= b.nz; j++) {
          const c = colAt(L, i, j);
          if (c && c.home.distanceToSquared(e.home) < 64) { link(e, c); picked = true; }
        }
      }
      if (e.structType === ST.Stair) { const above = b.slabs[L]; if (above) for (const s of above) if (s) { link(e, s); break; } }
      if (!picked && L === 0) e.grounded = true;
    } else if (e.structType === ST.Parapet) {
      const topSlabs = b.slabs[b.floors - 1] ?? [];
      let n = 0;
      for (const s of topSlabs) if (s && n < 3) { link(e, s); n++; }
      if (n === 0) e.grounded = true;
    }
  }
}

export { interactionGroups };

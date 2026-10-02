import * as THREE from 'three';
import { F, Kind, GROUP } from '../physics/entity';
import type { Entity } from '../physics/entity';
import { MATERIALS, type Mat } from '../physics/materials';
import type { Spawner } from './spawn';
import type { Building } from './building';
import { ST } from './building';
import { Rng } from '../util/math';
import * as GEO from '../render/geometry';
import { makeMaterial } from '../render/materials';
import { placeProp } from './props';

/**
 * Architectural detail.
 *
 * The structural pass raises a building; this pass makes it a *place* — a
 * shopfront you can shelter under, a cornice that throws a shadow line, a
 * balcony you can climb onto, a fire escape that actually goes to the roof.
 *
 * Everything here is real: it has a collider, a mass and a material, it is
 * wired into the support graph of the wall it hangs on, and it comes down with
 * that wall. Nothing is decoration painted on a box.
 */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Awning canvas colours seen on every Tokyo shopping street. */
const AWNING = [0x2f4f3f, 0x7a2b2b, 0x1f3550, 0x6a5a2a, 0x40404a, 0x86502c];
const SIGN_TONE = [0xd23c2e, 0x1a4f8c, 0xe3b422, 0x1d6b4a, 0xe8e6e1, 0x8b2f7a];

interface Ctx { spawn: Spawner; rng: Rng; }

/**
 * Trim comes in a handful of finishes, not one per piece. Every distinct
 * combination of colour, roughness and chamfer is another instanced pool and
 * another compiled shader, and the city already has hundreds.
 */
const FINISH = {
  render:  { mat: MATERIALS.concrete,     color: 0x918c84, rough: 0.82, metal: 0.02, chamfer: 0.03 },
  cast:    { mat: MATERIALS.rebarConcrete, color: 0x8b867e, rough: 0.84, metal: 0.02, chamfer: 0.03 },
  stone:   { mat: MATERIALS.stone,        color: 0x55524d, rough: 0.70, metal: 0.04, chamfer: 0.03 },
  steel:   { mat: MATERIALS.paintedSteel, color: 0x4b4e52, rough: 0.45, metal: 0.80, chamfer: 0.03 },
} as const;
type Finish = keyof typeof FINISH;

/** Local frame of a facade panel: outward normal, along-wall axis, rotation. */
function frameOf(e: Entity) {
  const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(e.quat);
  const along = new THREE.Vector3(1, 0, 0).applyQuaternion(e.quat);
  const rotY = Math.atan2(outward.x, outward.z);
  return { outward, along, rotY };
}

function link(child: Entity, parent: Entity) {
  child.supportedBy.push(parent);
  parent.supports.push(child);
}

/**
 * A piece of trim welded to a wall: real collider, real mass, fails with its
 * host. `structType` Parapet means it needs only one support, so it comes off
 * whole rather than fracturing.
 */
function trim(ctx: Ctx, b: Building, host: Entity, opts: {
  pos: THREE.Vector3; size: THREE.Vector3; rotY: number; label: string;
  finish?: Finish;
  /**
   * Shallow trim — a cornice band, a window head, a pilaster — carries no
   * collider while it is part of the wall. There is nothing you could do with a
   * 12 cm ledge, and every collider in the city is paid for in the broadphase
   * on every step. It becomes solid the instant it breaks off.
   */
  flat?: boolean;
  mat?: Mat; color?: number; rough?: number; metal?: number;
  emissive?: number; emissiveIntensity?: number; capacity?: number; chamfer?: number;
  transparent?: boolean; opacity?: number;
}): Entity {
  const f = FINISH[opts.finish ?? 'render'];
  _q.setFromAxisAngle(_v.set(0, 1, 0), opts.rotY);
  const e = ctx.spawn.box({
    pos: opts.pos, quat: _q, size: opts.size, mat: opts.mat ?? f.mat,
    body: 'fixed', kind: Kind.Structure,
    matOpts: {
      instanced: true, vary: 0.14, colorOverride: opts.color ?? f.color,
      roughOverride: opts.rough ?? f.rough, metalOverride: opts.metal ?? f.metal,
      emissive: opts.emissive, emissiveIntensity: opts.emissiveIntensity,
      signage: opts.emissive !== undefined,
      transparent: opts.transparent, opacity: opts.opacity,
      chamfer: true, chamferSize: opts.chamfer ?? f.chamfer,
    },
    flags: F.STRUCTURAL | F.BREAKABLE,
    capacity: opts.capacity ?? 512, attachTo: b.body,
    group: GROUP.STRUCTURE, label: opts.label,
    visualOnly: opts.flat,
  });
  e.structType = ST.Parapet;
  e.buildingId = b.id;
  e.level = host.level;
  e.home.copy(e.pos);
  link(e, host);
  b.elements.push(e);
  return e;
}

/**
 * A way in. A building with a sealed glass skin at pavement level reads as a
 * prop; this gives it a recessed reveal, two glazed leaves with push bars, a
 * transom over the head and a step up off the street. The frame is welded to
 * the wall it sits in, so the whole doorset comes down with that wall.
 */
function entrance(ctx: Ctx, b: Building, host: Entity, grand: boolean) {
  const { outward, along, rotY } = frameOf(host);
  const groundY = b.floorY[0];
  const wide = host.hx * 2;
  const dw = Math.min(wide * 0.55, grand ? 3.2 : 2.10);
  const dh = Math.min(host.hy * 2 - 0.55, grand ? 2.70 : 2.25);
  if (dw < 1.2 || dh < 1.8) return;
  // Position relative to the panel: u out from the wall, v along it, y off the
  // ground floor.
  const at = (u: number, v: number, y: number) => new THREE.Vector3()
    .copy(host.pos).addScaledVector(outward, u).addScaledVector(along, v).setY(groundY + y);
  const sz = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Reveal: jambs and head, standing proud of the glazing line.
  for (const s of [-1, 1]) {
    trim(ctx, b, host, {
      pos: at(0.13, s * (dw / 2 + 0.10), dh / 2), size: sz(0.20, dh + 0.20, 0.38),
      rotY, finish: 'stone', color: 0x736e66, label: 'door jamb',
    });
  }
  trim(ctx, b, host, {
    pos: at(0.13, 0, dh + 0.12), size: sz(dw + 0.40, 0.24, 0.38),
    rotY, finish: 'stone', color: 0x736e66, label: 'door head', flat: true,
  });
  // Transom light over the head.
  trim(ctx, b, host, {
    pos: at(0.02, 0, dh + 0.52), size: sz(dw - 0.06, 0.52, 0.05),
    rotY, mat: MATERIALS.glass, color: 0x2a3138, rough: 0.06, metal: 0.1,
    transparent: true, opacity: 0.34, label: 'transom', flat: true, chamfer: 0.012,
  });
  // Two leaves, each a glazed panel in an aluminium frame.
  const lw = dw / 2 - 0.04;
  for (const s of [-1, 1]) {
    const cx = s * dw / 4;
    trim(ctx, b, host, {
      pos: at(0.03, cx, dh / 2), size: sz(lw - 0.10, dh - 0.24, 0.045),
      rotY, mat: MATERIALS.glass, color: 0x2a3138, rough: 0.06, metal: 0.1,
      transparent: true, opacity: 0.30, label: 'door leaf', flat: true, chamfer: 0.012,
    });
    // stiles and rails
    for (const t of [-1, 1]) {
      trim(ctx, b, host, {
        pos: at(0.05, cx + t * (lw / 2 - 0.045), dh / 2), size: sz(0.09, dh - 0.10, 0.07),
        rotY, finish: 'steel', color: 0x8d9298, metal: 0.85, rough: 0.34,
        label: 'door stile', flat: true, chamfer: 0.012,
      });
    }
    trim(ctx, b, host, {
      pos: at(0.05, cx, 0.16), size: sz(lw, 0.30, 0.07),
      rotY, finish: 'steel', color: 0x8d9298, metal: 0.85, rough: 0.34,
      label: 'door rail', flat: true, chamfer: 0.012,
    });
    trim(ctx, b, host, {
      pos: at(0.05, cx, dh - 0.12), size: sz(lw, 0.16, 0.07),
      rotY, finish: 'steel', color: 0x8d9298, metal: 0.85, rough: 0.34,
      label: 'door rail', flat: true, chamfer: 0.012,
    });
    // push bar on the meeting stile
    trim(ctx, b, host, {
      pos: at(0.12, cx - s * (lw / 2 - 0.16), 1.06), size: sz(0.05, 0.96, 0.05),
      rotY, finish: 'steel', color: 0xb9bec4, metal: 0.95, rough: 0.22,
      label: 'push bar', flat: true, chamfer: 0.012,
    });
  }
  // A step up off the pavement, and this one you can actually stand on.
  trim(ctx, b, host, {
    pos: at(0.34, 0, 0.07), size: sz(dw + 0.80, 0.14, 0.66),
    rotY, finish: 'stone', color: 0x736e66, label: 'door step',
  });
  // Name plate beside the opening.
  if (grand) {
    trim(ctx, b, host, {
      pos: at(0.09, dw / 2 + 0.46, 1.52), size: sz(0.30, 0.44, 0.05),
      rotY, finish: 'steel', color: 0x2b2f34, metal: 0.6, rough: 0.35,
      label: 'name plate', flat: true, chamfer: 0.012,
    });
  }
}

/** Runs once per building, after the structure is up. */
export function detailBuilding(ctx: Ctx, b: Building) {
  if (b.shell || !b.body) return;
  const { rng } = ctx;
  const lot = b.lot;
  const open = lot?.openSides ?? [true, true, true, true];
  const topY = b.floorY[b.floors];
  const groundY = b.floorY[0];
  const tone = SIGN_TONE[rng.int(0, SIGN_TONE.length - 1)];
  const awn = AWNING[rng.int(0, AWNING.length - 1)];
  const commercial = b.style === 'shophouse' || b.style === 'office';

  // Which wall faces the street? side 0=+z, 1=+x, 2=-z, 3=-x.
  const streetSide = open.findIndex((s) => s) >= 0 ? open.indexOf(true) : (lot?.face ?? 0);

  const facades = b.elements.filter((e) => e.label === 'facade');
  const perSideGround = new Map<number, Entity[]>();

  for (const e of facades) {
    const { outward, along, rotY } = frameOf(e);
    // Recover which of the four sides this panel is on from its normal.
    const side = Math.abs(outward.z) > Math.abs(outward.x)
      ? (outward.z > 0 ? 0 : 2) : (outward.x > 0 ? 1 : 3);
    const street = open[side] || side === streetSide;
    const wide = e.hx * 2;
    const half = e.hy;
    const wrapped = side === b.scaffoldSide;

    if (e.level === 0) {
      const arr = perSideGround.get(side) ?? [];
      arr.push(e);
      perSideGround.set(side, arr);
    }

    // ------------------------------------------------------------ shopfront
    if (e.level === 0 && street && commercial && wide > 2.2 && !wrapped) {
      const headY = e.pos.y + half - 1.28;
      // Awning: a real ledge. Things land on it, water runs off it, a strong
      // enough gust takes it away.
      if (rng.bool(0.62)) {
        const depth = rng.range(0.85, 1.35);
        const a = trim(ctx, b, e, {
          pos: _v.clone().copy(e.pos).addScaledVector(outward, depth * 0.5 + 0.16)
            .setY(headY + 0.20),
          size: new THREE.Vector3(wide * 0.94, 0.09, depth),
          rotY, mat: MATERIALS.fabric, color: awn, rough: 0.92, metal: 0,
          label: 'awning', chamfer: 0.018,
        });
        a.attachStrength = rng.range(900, 2600);
        // valance hanging off the front edge
        trim(ctx, b, a, {
          pos: _v.clone().copy(e.pos).addScaledVector(outward, depth + 0.14).setY(headY + 0.02),
          size: new THREE.Vector3(wide * 0.94, 0.34, 0.06),
          rotY, mat: MATERIALS.fabric, color: awn, rough: 0.92, metal: 0,
          label: 'valance', chamfer: 0.018,
        });
      }
      // Sign board over the glazing, lit at night.
      if (rng.bool(0.78)) {
        trim(ctx, b, e, {
          pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.24).setY(headY + 0.85),
          size: new THREE.Vector3(wide * 0.9, 0.62, 0.14),
          rotY, mat: MATERIALS.plastic, color: tone, rough: 0.42, metal: 0.05,
          emissive: tone, emissiveIntensity: 1.7, label: 'sign board', chamfer: 0.03,
        });
      }
      // Pilasters framing the bay, and a threshold you actually step up.
      for (const s of [-1, 1]) {
        trim(ctx, b, e, {
          pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.13)
            .addScaledVector(along, s * (e.hx - 0.14)),
          size: new THREE.Vector3(0.28, half * 2 - 0.1, 0.16),
          rotY, finish: 'stone', label: 'pilaster',
        });
      }
      trim(ctx, b, e, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.36)
          .setY(e.pos.y - half + 0.07),
        size: new THREE.Vector3(wide * 0.8, 0.14, 0.62),
        rotY, finish: 'stone', label: 'threshold',
      });
    }

    // ------------------------------------------------- cornice / string course
    if (e.level === 0 && wide > 1.5) {
      trim(ctx, b, e, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.16).setY(e.pos.y + half - 0.06),
        size: new THREE.Vector3(wide, 0.24, 0.28),
        rotY, finish: 'render', label: 'cornice', flat: true,
      });
    }
    if (e.level === b.floors - 1 && wide > 1.5) {
      trim(ctx, b, e, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.20).setY(e.pos.y + half - 0.14),
        size: new THREE.Vector3(wide, 0.30, 0.36),
        rotY, finish: 'render', label: 'cornice', flat: true,
      });
    }

    // --------------------------------------------------------------- balcony
    // Residential blocks get a balcony you can stand on, climb onto from the
    // street furniture below, or shelter behind.
    if (b.style === 'apartment' && e.level > 0 && street && !wrapped && wide > 2.4 && rng.bool(0.82)) {
      const dep = rng.range(1.05, 1.5);
      const y = e.pos.y - half + 0.08;
      const slab = trim(ctx, b, e, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, dep * 0.5 + 0.13).setY(y),
        size: new THREE.Vector3(wide * 0.92, 0.16, dep),
        rotY, finish: 'cast', label: 'balcony',
      });
      // Balustrade: solid panel on the front, open at the sides.
      trim(ctx, b, slab, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, dep + 0.10).setY(y + 0.55),
        size: new THREE.Vector3(wide * 0.92, 1.02, 0.09),
        rotY, finish: 'render', label: 'balustrade',
      });
      for (const s of [-1, 1]) {
        trim(ctx, b, slab, {
          pos: _v.clone().copy(e.pos).addScaledVector(outward, dep * 0.5 + 0.13)
            .addScaledVector(along, s * wide * 0.46).setY(y + 0.55),
          size: new THREE.Vector3(0.09, 1.02, dep),
          rotY, finish: 'render', label: 'balustrade',
        });
      }
    }

    // ----------------------------------------------------------- window heads
    // One lintel band per storey reads as a row of window heads and gives the
    // wall a shadow line at grazing sun angles.
    if (e.level > 0 && wide > 1.5 && b.style !== 'warehouse') {
      const headOff = b.style === 'office' ? 0.42 : 0.55;
      trim(ctx, b, e, {
        pos: _v.clone().copy(e.pos).addScaledVector(outward, 0.10).setY(e.pos.y + half - headOff),
        size: new THREE.Vector3(wide * 0.98, 0.12, 0.16),
        rotY, finish: 'render', label: 'lintel', flat: true,
      });
    }
  }

  // -------------------------------------------------------------- entrances
  // Every building that meets the street gets a way in, and office and
  // apartment blocks get a canopy on posts over theirs.
  const grand = (b.style === 'office' || b.style === 'apartment') && b.floors > 2;
  // A building whose nominal street side has no ground panel still needs a
  // door; take whichever side does.
  // Never behind the scaffold: nobody would put the way in where the yard is.
  const doorSide = perSideGround.has(streetSide) ? streetSide
    : [...perSideGround.keys()].find((k) => k !== b.scaffoldSide && (perSideGround.get(k)?.length ?? 0) > 0) ?? streetSide;
  {
    const ground = perSideGround.get(doorSide);
    if (ground && ground.length) {
      const mid = Math.floor(ground.length / 2);
      entrance(ctx, b, ground[mid], grand);
      // A long frontage is more than one shop, so it has more than one door.
      if (ground.length >= 3 && rng.bool(0.55)) {
        entrance(ctx, b, ground[rng.bool(0.5) ? 0 : ground.length - 1], false);
      }
    }
  }
  if (grand) {
    const ground = perSideGround.get(streetSide);
    if (ground && ground.length) {
      const host = ground[Math.floor(ground.length / 2)];
      const { outward, rotY } = frameOf(host);
      const y = groundY + 3.1;
      const cw = Math.min(host.hx * 2 * 1.1, 4.6);
      const canopy = trim(ctx, b, host, {
        pos: _v.clone().copy(host.pos).addScaledVector(outward, 1.15).setY(y),
        size: new THREE.Vector3(cw, 0.22, 2.1),
        rotY, finish: 'cast', label: 'canopy',
      });
      for (const s of [-1, 1]) {
        const along = new THREE.Vector3(1, 0, 0).applyQuaternion(host.quat);
        trim(ctx, b, canopy, {
          pos: _v.clone().copy(host.pos).addScaledVector(outward, 2.0)
            .addScaledVector(along, s * (cw * 0.5 - 0.22)).setY(groundY + 1.55),
          size: new THREE.Vector3(0.18, 3.1, 0.18),
          rotY, finish: 'steel', label: 'canopy post',
        });
      }
    }
  }

  // ------------------------------------------------------------ roof furniture
  // A stair bulkhead gives the roof a silhouette and a reason to exist.
  if (b.floors > 2 && rng.bool(0.8)) {
    const bw = Math.min(3.0, b.w * 0.32), bd = Math.min(3.0, b.d * 0.32);
    const bx = b.cx + rng.range(-1, 1) * (b.w * 0.5 - bw * 0.7);
    const bz = b.cz + rng.range(-1, 1) * (b.d * 0.5 - bd * 0.7);
    const host = b.elements.find((e) => e.structType === ST.Slab && e.level === b.floors - 1)
      ?? b.elements[b.elements.length - 1];
    if (host) {
      const bulk = trim(ctx, b, host, {
        pos: new THREE.Vector3(bx, topY + 1.35, bz),
        size: new THREE.Vector3(bw, 2.7, bd),
        rotY: 0, finish: 'render', label: 'stair housing',
      });
      trim(ctx, b, bulk, {
        pos: new THREE.Vector3(bx, topY + 2.78, bz),
        size: new THREE.Vector3(bw + 0.3, 0.16, bd + 0.3),
        rotY: 0, finish: 'stone', label: 'roof cap',
      });
    }
  }

  // ----------------------------------------------------------- parapet coping
  // Snapshot: trim() appends to b.elements, and walking a list while it grows is
  // a trap waiting for the first piece whose label happens to match.
  for (const e of b.elements.slice()) {
    if (e.structType !== ST.Parapet || e.label !== 'parapet') continue;
    const { rotY } = frameOf(e);
    trim(ctx, b, e, {
      pos: _v.clone().copy(e.pos).setY(e.pos.y + e.hy + 0.05),
      size: new THREE.Vector3(e.hx * 2 + 0.22, 0.12, e.hz * 2 + 0.22),
      rotY, finish: 'stone', label: 'coping',
    });
  }
}

/** Standing clear of the wall, a scaffold's two lines of tubes and its deck. */
export const SCAF = { inner: 0.32, outer: 1.12, bay: 1.8 };

/**
 * Scaffolding up one face of a building under repair: two lines of standards,
 * a boarded deck with ledgers, toe boards and guard rails at every floor,
 * bracing across the face, ladders between the decks and debris netting
 * over the front. It is tied into the wall it stands against and comes down
 * with it; you can walk its decks and climb its ladders. Returns where its
 * foot is, so the yard around it can be stocked.
 */
export function facadeScaffold(ctx: Ctx, b: Building):
  { base: THREE.Vector3; along: THREE.Vector3; out: THREE.Vector3; width: number } | null {
  const side = b.scaffoldSide;
  if (side < 0 || b.shell || !b.body || b.floors < 2) return null;
  const { rng } = ctx;
  const nrm = side === 0 ? new THREE.Vector3(0, 0, 1) : side === 1 ? new THREE.Vector3(1, 0, 0)
    : side === 2 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
  const along = new THREE.Vector3(-nrm.z, 0, nrm.x);
  const rotY = Math.atan2(nrm.x, nrm.z);
  const face = side % 2 === 0 ? b.w : b.d;
  const bays = Math.floor((face - 0.6) / SCAF.bay);
  if (bays < 2) return null;
  const width = bays * SCAF.bay;
  const hw = b.w / 2, hd = b.d / 2;
  const wall = new THREE.Vector3(b.cx + nrm.x * hw, 0, b.cz + nrm.z * hd);
  const host = b.elements.filter((e) => e.label === 'facade' && e.level === 0)
    .sort((a, c) => a.pos.distanceTo(wall) - c.pos.distanceTo(wall))[0];
  if (!host) return null;
  const ground = b.floorY[0] + 0.25;
  const top = Math.min(b.floors - 1, 5);
  const topY = b.floorY[top];
  const at = (u: number, v: number, y: number) =>
    new THREE.Vector3().copy(wall).addScaledVector(nrm, u).addScaledVector(along, v).setY(y);
  const tube = { finish: 'steel' as Finish, color: 0x9aa0a4, rough: 0.5, metal: 0.8, chamfer: 0.008 };
  const timber = { mat: MATERIALS.wood, color: 0x9a8a70, rough: 0.9, metal: 0, chamfer: 0.006 };

  // standards, full height, in both lines
  const standH = topY + 1.1 - ground;
  for (let i = 0; i <= bays; i++) {
    const v = -width / 2 + i * SCAF.bay;
    for (const u of [SCAF.inner, SCAF.outer]) {
      trim(ctx, b, host, { pos: at(u, v, ground + standH / 2), size: new THREE.Vector3(0.05, standH, 0.05), rotY, label: 'scaffold standard', ...tube });
    }
    // base plate on its sole board
    trim(ctx, b, host, { pos: at((SCAF.inner + SCAF.outer) / 2, v, ground + 0.02), size: new THREE.Vector3(0.22, 0.04, SCAF.outer - SCAF.inner + 0.3), rotY, label: 'sole board', ...timber });
  }
  const mid = (SCAF.inner + SCAF.outer) / 2, depth = SCAF.outer - SCAF.inner;
  for (let L = 1; L <= top; L++) {
    const y = b.floorY[L];
    // the first bay is left open for the ladder coming up through it
    const deckW = width - SCAF.bay, deckV = SCAF.bay / 2;
    trim(ctx, b, host, { pos: at(mid, deckV, y - 0.025), size: new THREE.Vector3(deckW, 0.05, depth + 0.02), rotY, label: 'scaffold deck', ...timber });
    for (const u of [SCAF.inner, SCAF.outer]) {
      trim(ctx, b, host, { pos: at(u, 0, y - 0.08), size: new THREE.Vector3(width, 0.05, 0.05), rotY, label: 'ledger', ...tube });
    }
    trim(ctx, b, host, { pos: at(SCAF.outer - 0.03, deckV, y + 0.075), size: new THREE.Vector3(deckW, 0.15, 0.03), rotY, label: 'toe board', ...timber });
    for (const h of [0.52, 1.02]) {
      trim(ctx, b, host, { pos: at(SCAF.outer, 0, y + h), size: new THREE.Vector3(width, 0.045, 0.045), rotY, label: 'guard rail', ...tube });
    }
    // a ladder up through the open bay to this deck
    const foot = L === 1 ? ground : b.floorY[L - 1];
    const lp = at(mid, -width / 2 + SCAF.bay / 2, foot);
    const lad = placeProp(ctx.spawn, 'scaffoldLadder', rng, lp.x, foot, lp.z, rotY, { body: 'fixed', attachTo: b.body });
    lad.buildingId = b.id;
    link(lad, host);
  }
  // face bracing, alternating hand, one brace every other bay per lift
  const steel = MATERIALS.paintedSteel;
  for (let L = 0; L < top; L++) {
    const y0 = L === 0 ? ground : b.floorY[L], y1 = b.floorY[L + 1];
    for (let i = 0; i + 1 < bays; i += 2) {
      const v0 = -width / 2 + i * SCAF.bay, v1 = v0 + SCAF.bay * 2;
      const hand = (i / 2 + L) % 2 === 0;
      const a = at(SCAF.outer + 0.05, hand ? v0 : v1, y0), c = at(SCAF.outer + 0.05, hand ? v1 : v0, y1);
      const len = a.distanceTo(c);
      const mq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), c.clone().sub(a).normalize());
      const e = ctx.spawn.box({
        pos: a.clone().add(c).multiplyScalar(0.5), quat: mq, size: new THREE.Vector3(len, 0.045, 0.045),
        mat: steel, body: 'fixed', kind: Kind.Structure,
        matOpts: { instanced: true, vary: 0.12, colorOverride: 0x9aa0a4, roughOverride: 0.5, metalOverride: 0.8 },
        flags: F.STRUCTURAL | F.BREAKABLE, capacity: 512, attachTo: b.body, group: GROUP.STRUCTURE, label: 'scaffold brace',
        visualOnly: true,
      });
      e.structType = ST.Parapet; e.buildingId = b.id; e.home.copy(e.pos);
      link(e, host);
      b.elements.push(e);
    }
  }
  // debris netting over the front, from above head height to the top rail
  if (rng.bool(0.75)) {
    const netCol = rng.pick([0xb8c4c9, 0x9cb8a4, 0xc9c9c0]);
    const h0 = ground + 2.4, h1 = topY + 1.05;
    trim(ctx, b, host, {
      pos: at(SCAF.outer + 0.09, 0, (h0 + h1) / 2), size: new THREE.Vector3(width + 0.1, h1 - h0, 0.01), rotY,
      mat: MATERIALS.fabric, color: netCol, rough: 0.95, metal: 0, transparent: true, opacity: 0.42,
      label: 'debris netting', flat: true, chamfer: 0.002,
    });
  }
  return { base: at(SCAF.outer + 1.6, 0, ground), along, out: nrm, width };
}

/**
 * An external steel fire escape: landings at every floor joined by inclined
 * flights. It is a genuine route up the outside of the building, and it is
 * bolted on rather than built in, so a bad enough quake tears it off the wall.
 */
export function fireEscape(ctx: Ctx, b: Building, rng: Rng) {
  if (b.shell || !b.body || b.floors < 3) return;
  const lot = b.lot;
  const open = lot?.openSides ?? [true, false, true, false];
  // Prefer a flank, not the main frontage.
  const sides = [0, 1, 2, 3].filter((s) => open[s] && s !== b.scaffoldSide);
  if (!sides.length) return;
  const side = sides[rng.int(0, sides.length - 1)];

  const hw = b.w / 2, hd = b.d / 2;
  const nrm = side === 0 ? new THREE.Vector3(0, 0, 1) : side === 1 ? new THREE.Vector3(1, 0, 0)
    : side === 2 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
  const along = new THREE.Vector3(-nrm.z, 0, nrm.x);
  const rotY = Math.atan2(nrm.x, nrm.z);
  const wallX = b.cx + nrm.x * hw, wallZ = b.cz + nrm.z * hd;
  const offset = rng.range(-0.3, 0.3) * (side % 2 === 0 ? b.w : b.d) * 0.5;

  const host = b.elements.find((e) => e.label === 'facade' && e.level === 1) ?? b.elements[0];
  if (!host) return;

  const landW = 1.7, landD = 1.25;
  const steel = MATERIALS.paintedSteel;
  const base = new THREE.Vector3(
    wallX + nrm.x * (landD * 0.5 + 0.18) + along.x * offset, 0,
    wallZ + nrm.z * (landD * 0.5 + 0.18) + along.z * offset);

  // A switchback: landings alternate between two points along the wall and the
  // flights run between them, parallel to the facade. Running them out from the
  // wall instead would drive every flight straight through it.
  const runLen = 2.9;
  const uOf = (level: number) => (level % 2 === 0 ? -runLen / 2 : runLen / 2);

  let prev: Entity | null = null;
  const top = Math.min(b.floors, 7);
  for (let L = 1; L <= top; L++) {
    const y = b.floorY[L];
    const lu = uOf(L);
    const landX = base.x + along.x * lu, landZ = base.z + along.z * lu;
    _q.setFromAxisAngle(_v.set(0, 1, 0), rotY);
    const land = ctx.spawn.box({
      pos: new THREE.Vector3(landX, y + 0.06, landZ), quat: _q,
      size: new THREE.Vector3(landW, 0.10, landD),
      mat: steel, body: 'fixed', kind: Kind.Structure,
      matOpts: { instanced: true, vary: 0.14, colorOverride: FINISH.steel.color, roughOverride: FINISH.steel.rough, metalOverride: FINISH.steel.metal, chamfer: true, chamferSize: FINISH.steel.chamfer },
      flags: F.STRUCTURAL | F.BREAKABLE, capacity: 384, attachTo: b.body,
      group: GROUP.STRUCTURE, label: 'fire escape',
    });
    land.structType = ST.Stair; land.buildingId = b.id; land.level = L; land.home.copy(land.pos);
    link(land, host);
    if (prev) link(land, prev);
    b.elements.push(land);

    // guard rail on the outer edge so you can stand on it in a gale
    const rail = ctx.spawn.box({
      pos: new THREE.Vector3(
        landX + nrm.x * (landD * 0.5 - 0.04), y + 0.60, landZ + nrm.z * (landD * 0.5 - 0.04)),
      quat: _q, size: new THREE.Vector3(landW, 1.0, 0.07),
      mat: steel, body: 'fixed', kind: Kind.Structure,
      matOpts: { instanced: true, vary: 0.14, colorOverride: FINISH.steel.color, roughOverride: FINISH.steel.rough, metalOverride: FINISH.steel.metal, chamfer: true, chamferSize: FINISH.steel.chamfer },
      flags: F.STRUCTURAL | F.BREAKABLE, capacity: 384, attachTo: b.body,
      group: GROUP.STRUCTURE, label: 'fire escape rail',
    });
    rail.structType = ST.Parapet; rail.buildingId = b.id; rail.level = L; rail.home.copy(rail.pos);
    link(rail, land);
    b.elements.push(rail);

    // the flight down to the landing below (or to the street)
    const yb = b.floorY[L - 1] + 0.06;
    const rise = y + 0.06 - yb;
    const run = runLen;
    const ang = Math.atan2(rise, run);
    const len = Math.hypot(rise, run);
    const geoKey = `fstair${run.toFixed(1)}_${rise.toFixed(1)}`;
    const geo = GEO.composite(geoKey, () => {
      const g: THREE.BufferGeometry[] = [];
      const n = Math.max(6, Math.round(rise / 0.20));
      for (let s2 = 0; s2 < n; s2++) {
        const zLocal = ((s2 + 0.5) / n - 0.5) * len;
        g.push(GEO.translated(new THREE.BoxGeometry(0.92, 0.05, (len / n) * 0.86), 0, 0.09, zLocal));
      }
      g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.10, len), 0.47, 0, 0));
      g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.10, len), -0.47, 0, 0));
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 0.85, 0.05), 0.47, 0.48, -len * 0.4));
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 0.85, 0.05), 0.47, 0.48, len * 0.4));
      g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.06, len), 0.47, 0.88, 0));
      return GEO.merge(g);
    });
    // The geometry climbs toward its own +Z, so aim +Z from the lower landing to
    // the upper one and then pitch it up by the going.
    const uFrom = uOf(L - 1), uTo = lu;
    const sgn = uTo >= uFrom ? 1 : -1;
    const sq = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.atan2(along.x * sgn, along.z * sgn));
    sq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -ang));
    const um = (uFrom + uTo) / 2;
    const mid = new THREE.Vector3(
      base.x + along.x * um, (yb + y + 0.06) / 2, base.z + along.z * um);
    const flight = ctx.spawn.prop({
      geoKey, geometry: geo,
      material: makeMaterial(steel, { instanced: true, vary: 0.14, colorOverride: FINISH.steel.color, roughOverride: FINISH.steel.rough, metalOverride: FINISH.steel.metal }),
      pos: mid, quat: sq,
      half: new THREE.Vector3(0.5, 0.1, len / 2), mat: steel,
      body: 'fixed', kind: Kind.Structure,
      parts: [{ shape: 'box', half: new THREE.Vector3(0.48, 0.07, len / 2) }],
      flags: F.STRUCTURAL | F.BREAKABLE, capacity: 192, attachTo: b.body,
      group: GROUP.STRUCTURE, label: 'fire escape stair',
    });
    flight.structType = ST.Stair; flight.buildingId = b.id; flight.level = L; flight.home.copy(flight.pos);
    link(flight, land);
    b.elements.push(flight);
    prev = land;
  }
}

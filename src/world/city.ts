import * as THREE from 'three';
import { CityPlan, HALF, RIVER_Z, RIVER_HALF, SHORE_Z, type Block } from './cityplan';
import type { Terrain } from './terrain';
import type { Spawner } from './spawn';
import { buildBuilding, ST, type Building } from './building';
import { detailBuilding, fireEscape, facadeScaffold } from './detail';
import {
  registerStreetLevel, scaffoldRoom, fenceScaffold, workYard, shopfronts, garbagePoints,
  stockSite, shopStock, doorways, sideOf, type ScaffoldSite,
} from './clutter';
import { placeProp, tryPlaceProp, type PropKind, emissiveMat } from './props';
import { Footprints, footSamples, type Foot } from './footprints';
import { spawnVehicle, vehicleSize, VEHICLE_KINDS } from './vehicles';
import { Rng, clamp, clamp01 } from '../util/math';
import { F, Kind, type Entity } from '../physics/entity';
import type { PhysWorld } from '../physics/physworld';
import { MATERIALS } from '../physics/materials';
import * as GEO from '../render/geometry';
import { makeMaterial, simpleMaterial } from '../render/materials';
import { G } from '../render/globals';

export const CORE = 158;     // half-extent of the fully simulated core

export interface CityResult {
  buildings: Building[];
  spawnPoint: THREE.Vector3;
  decorGroup: THREE.Group;
  /** Lamp-head positions, used to place a small pool of real lights. */
  lights: THREE.Vector3[];
}

interface Ctx {
  spawn: Spawner;
  phys: PhysWorld;
  plan: CityPlan;
  terrain: Terrain;
  rng: Rng;
  scene: THREE.Scene;
  onProgress: (p: number, label: string) => void;
  /** Everything standing at street level, so nothing is set down inside it. */
  fp: Footprints;
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/** Set a prop down on the ground here if the spot is clear; a few tries nearby. */
function groundProp(ctx: Ctx, kind: PropKind, x: number, z: number, rot: number, jitter = 0, tries = 1): Entity | null {
  for (let t = 0; t < tries; t++) {
    const px = x + (t ? ctx.rng.range(-jitter, jitter) : 0);
    const pz = z + (t ? ctx.rng.range(-jitter, jitter) : 0);
    const e = tryPlaceProp(ctx.spawn, ctx.fp, kind, ctx.rng, px, ctx.terrain.heightAt(px, pz), pz, rot);
    if (e) return e;
  }
  return null;
}

/** Plan footprint of something already built, from its box and orientation. */
function footOfEntity(e: Entity, grow = 0): Foot {
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(e.quat);
  return { x: e.pos.x, z: e.pos.z, hx: e.hx + grow, hz: e.hz + grow, rot: Math.atan2(-ax.z, ax.x),
    y0: e.pos.y - e.hy, y1: e.pos.y + e.hy };
}

/**
 * A heap of diggable earth, packed as it would settle: whole blocks on a grid,
 * each resting on the one below or on the ground. Blocks dropped at random
 * points sat inside each other and half inside the terrain, and the heap burst
 * apart the moment anyone walked up to it.
 */
function soilHeap(ctx: Ctx, cx: number, cz: number, rx: number, rz: number, peak: number) {
  const S = 0.54, s2 = 0.52;
  const rotQ = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (let gx = -rx; gx <= rx; gx += S) {
    for (let gz = -rz; gz <= rz; gz += S) {
      const d = Math.hypot(gx / rx, gz / rz);
      if (d > 1) continue;
      const x = cx + gx, z = cz + gz;
      const h = peak * (1 - d * d) * ctx.rng.range(0.8, 1.1);
      const layers = Math.max(1, Math.round(h / S));
      const gy = ctx.terrain.heightAt(x, z);
      const f: Foot = { x, z, hx: s2 / 2, hz: s2 / 2, rot: 0, y0: gy, y1: gy + layers * S };
      if (ctx.fp.hits(f, 0.02)) continue;
      ctx.fp.add(f);
      for (let k = 0; k < layers; k++) {
        placeProp(ctx.spawn, 'soilBlock', ctx.rng, x, gy + s2 / 2 + 0.01 + k * S, z, ctx.rng.pick(rotQ));
      }
    }
  }
}

export async function buildCity(input: Omit<Ctx, 'fp'>): Promise<CityResult> {
  const ctx: Ctx = { ...input, fp: new Footprints() };
  const { spawn, plan, terrain, rng, scene } = ctx;
  const buildings: Building[] = [];
  const decorGroup = new THREE.Group();
  decorGroup.name = 'decor';
  scene.add(decorGroup);
  const lights: THREE.Vector3[] = [];

  // ---------------------------------------------------------------- buildings
  const lots = plan.lots;
  let done = 0;
  for (const lot of lots) {
    const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;
    const inCore = Math.abs(cx) < CORE && cz > -CORE && cz < Math.min(CORE, SHORE_Z - 20);
    const gy = terrain.heightAt(cx, cz);
    const b = buildBuilding({
      spawn, lot, rng, groundY: gy - 0.25, id: buildings.length, shell: !inCore,
    });
    buildings.push(b);
    done++;
    if (done % 6 === 0) {
      ctx.onProgress(0.40 + 0.30 * (done / lots.length), `raising buildings ${done}/${lots.length}`);
      await yieldFrame();
    }
  }

  // ------------------------------------------------------------ scaffolding
  // A few buildings are under repair, wrapped in scaffold up one face. The
  // choice is made before the detail pass, which leaves that face bare for it:
  // never the frontage with the way in, and only where there is road enough
  // in front for the scaffold and the yard at its foot.
  for (const b of buildings) {
    if (b.shell || !b.lot || b.floors < 2 || !rng.bool(0.2)) continue;
    const open = b.lot.openSides;
    const street = open.indexOf(true) >= 0 ? open.indexOf(true) : b.lot.face;
    const sides = [0, 1, 2, 3].filter((s) => open[s] && s !== street && scaffoldRoom(plan, b, s));
    if (sides.length) b.scaffoldSide = rng.pick(sides);
  }

  // ------------------------------------------------------------ architecture
  ctx.onProgress(0.70, 'shopfronts and cornices');
  await yieldFrame();
  let dd = 0;
  for (const b of buildings) {
    detailBuilding({ spawn, rng }, b);
    if (!b.shell && b.floors >= 3 && rng.bool(0.34)) fireEscape({ spawn, rng }, b, rng);
    if (++dd % 8 === 0) await yieldFrame();
  }

  // ------------------------------------------------------- facade attachments
  ctx.onProgress(0.73, 'hanging signs and services');
  await yieldFrame();
  attachToFacades(ctx, buildings);
  const scaffolds: ScaffoldSite[] = [];
  for (const b of buildings) {
    const s = facadeScaffold({ spawn, rng }, b);
    if (s) { scaffolds.push(s); fenceScaffold(ctx, s); }
  }
  // Everything the buildings put at street level, and their doorways, goes on
  // record before anything else is set down near them.
  registerStreetLevel(ctx, buildings);
  // The yards at the scaffolds, and what the shops and houses keep out front,
  // are laid out before any of the loose street furniture can wander into them.
  for (const s of scaffolds) workYard(ctx, s);
  shopfronts(ctx, buildings);

  // ------------------------------------------------------------- roof clutter
  ctx.onProgress(0.75, 'rooftop plant');
  await yieldFrame();
  for (const b of buildings) {
    // The stair housing and parapets are already up there.
    const roof = new Footprints(4);
    for (const e of b.elements) {
      if (e.label === 'stair housing' || e.label === 'parapet' || e.label === 'coping') roof.add(footOfEntity(e, 0.1));
    }
    for (const spot of b.roofSpots) {
      const n = clamp(Math.round((spot.w * spot.d) / 150), 1, 3);
      for (let i = 0; i < n; i++) {
        const kind: PropKind = rng.weighted(
          ['waterTank', 'rooftopVent', 'acUnit', 'antenna', 'crate', 'barrel'] as PropKind[],
          (k) => k === 'acUnit' ? 3 : k === 'rooftopVent' ? 2.4 : k === 'waterTank' ? 1.8 : k === 'antenna' ? 1.2 : 0.8);
        for (let t = 0; t < 4; t++) {
          const px = spot.x + rng.range(-spot.w / 2, spot.w / 2) * 0.72;
          const pz = spot.z + rng.range(-spot.d / 2, spot.d / 2) * 0.72;
          if (tryPlaceProp(spawn, roof, kind, rng, px, spot.y, pz, rng.range(0, 6.28))) break;
        }
      }
      if (rng.bool(0.3)) {
        // A rooftop sign stands on steel legs bolted through the roof. It used
        // to hang in the air 2.6 m up and drop the moment anyone came near.
        const sx = spot.x, sz = spot.z + spot.d / 2 - 0.3, top = spot.y + 2.6;
        const f = { x: sx, z: sz, hx: 1.5, hz: 0.25, rot: 0, y0: spot.y, y1: top + 0.4 };
        if (!roof.hits(f)) {
          roof.add(f);
          const deck = b.elements.find((e) => e.structType === ST.Slab && e.level === b.floors - 1);
          const legs: Entity[] = [];
          for (const dx of [-0.5, 0.5]) {
            const leg = spawn.box({
              pos: new THREE.Vector3(sx + dx, spot.y + (top - 0.35 - spot.y) / 2, sz),
              size: new THREE.Vector3(0.09, top - 0.35 - spot.y, 0.09),
              mat: MATERIALS.paintedSteel, body: 'fixed', kind: Kind.Structure, attachTo: b.body,
              matOpts: { instanced: true, vary: 0.1, colorOverride: 0x4b4e52, roughOverride: 0.5, metalOverride: 0.7 },
              flags: F.BREAKABLE, capacity: 256, label: 'sign leg',
            });
            if (deck) { deck.supports.push(leg); leg.supportedBy.push(deck); leg.set(F.ATTACHED); leg.attachedTo = deck; leg.attachStrength = 5000; }
            legs.push(leg);
          }
          const sign = placeProp(spawn, 'boxSign', rng, sx, top, sz, 0, { body: 'fixed', attachTo: b.body });
          sign.set(F.ATTACHED); sign.attachedTo = legs[0]; sign.attachStrength = 2400;
          for (const l of legs) { l.supports.push(sign); sign.supportedBy.push(l); }
        }
      }
    }
  }

  // --------------------------------------------------------- interior fitout
  ctx.onProgress(0.79, 'furnishing interiors');
  await yieldFrame();
  furnishInteriors(ctx, buildings);

  // ---------------------------------------------------------- special blocks
  ctx.onProgress(0.83, 'parks, sites and yards');
  await yieldFrame();
  for (const blk of plan.blocks) {
    if (blk.type === 'park') buildPark(ctx, blk);
    else if (blk.type === 'construction') buildConstruction(ctx, blk);
    else if (blk.type === 'plaza') buildPlaza(ctx, blk);
  }

  // ------------------------------------------------------------ street stuff
  ctx.onProgress(0.87, 'street furniture');
  await yieldFrame();
  garbagePoints(ctx, CORE);
  streetFurniture(ctx, lights);

  ctx.onProgress(0.90, 'traffic');
  await yieldFrame();
  placeVehicles(ctx);

  ctx.onProgress(0.915, 'stringing the overhead lines');
  await yieldFrame();
  buildPowerLines(ctx, decorGroup);

  ctx.onProgress(0.92, 'river and waterfront');
  await yieldFrame();
  buildRiverAndShore(ctx);

  ctx.onProgress(0.94, 'the skyline beyond');
  await yieldFrame();
  buildBackdrop(ctx, decorGroup);

  // Start in the middle of a real street inside the simulated core, with
  // buildings either side and nothing directly overhead.
  let sp = plan.findStreetSpot(rng, CORE);
  for (let t = 0; t < 40; t++) {
    const gy = terrain.heightAt(sp.x, sp.z);
    if (!ctx.fp.hits({ x: sp.x, z: sp.z, hx: 0.5, hz: 0.5, rot: 0, y0: gy, y1: gy + 2 }, 0.6)) break;
    sp = plan.findStreetSpot(rng, CORE);
  }
  const spawnPoint = new THREE.Vector3(sp.x, terrain.heightAt(sp.x, sp.z) + 1.3, sp.z);

  return { buildings, spawnPoint, decorGroup, lights };
}

// ---------------------------------------------------------------------------

function attachToFacades(ctx: Ctx, buildings: Building[]) {
  const { spawn, rng } = ctx;
  for (const b of buildings) {
    if (b.shell) continue;
    for (const e of b.elements) {
      if (e.label !== 'facade') continue;
      const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(e.quat);
      const along = new THREE.Vector3(1, 0, 0).applyQuaternion(e.quat);
      const rotY = Math.atan2(outward.x, outward.z);
      const wide = e.hx;
      // The scaffold stands where the air-con units and signs would hang.
      if (sideOf(outward.x, outward.z) === b.scaffoldSide) continue;

      // air conditioners on residential and commercial walls
      if (e.level > 0 && rng.bool(b.style === 'apartment' ? 0.40 : 0.22)) {
        const p = new THREE.Vector3().copy(e.pos)
          .addScaledVector(outward, 0.36)
          .addScaledVector(along, rng.range(-wide * 0.6, wide * 0.6))
          .add(new THREE.Vector3(0, rng.range(-e.hy * 0.4, e.hy * 0.1), 0));
        const ac = placeProp(spawn, 'acUnit', rng, p.x, p.y, p.z, rotY, { body: 'fixed', attachTo: b.body });
        ac.attachedTo = e; ac.attachStrength = rng.range(1400, 3400); ac.set(F.ATTACHED);
        e.supports.push(ac); ac.supportedBy.push(e);
      }

      // vertical shop signage on the lower floors of street frontages
      if (e.level <= 3 && rng.bool(0.30)) {
        const p = new THREE.Vector3().copy(e.pos)
          .addScaledVector(outward, 0.48)
          .addScaledVector(along, rng.bool() ? wide * 0.72 : -wide * 0.72);
        const s = placeProp(spawn, 'verticalSign', rng, p.x, p.y, p.z, rotY, { body: 'fixed', attachTo: b.body });
        s.attachedTo = e; s.attachStrength = rng.range(900, 2600); s.set(F.ATTACHED);
        e.supports.push(s); s.supportedBy.push(e);
      }
      if (e.level === 0 && rng.bool(0.34)) {
        const p = new THREE.Vector3().copy(e.pos)
          .addScaledVector(outward, 0.4)
          .add(new THREE.Vector3(0, e.hy * 0.55, 0));
        const s = placeProp(spawn, 'boxSign', rng, p.x, p.y, p.z, rotY, { body: 'fixed', attachTo: b.body });
        s.attachedTo = e; s.attachStrength = rng.range(700, 1800); s.set(F.ATTACHED);
        e.supports.push(s); s.supportedBy.push(e);
      }
      // Fire-escape ladders: a real, climbable route onto the roofs.
      if (e.level > 0 && e.level <= 3 && rng.bool(0.13)) {
        const p = new THREE.Vector3().copy(e.pos)
          .addScaledVector(outward, 0.44)
          .addScaledVector(along, wide * 0.55);
        const l = placeProp(spawn, 'ladder', rng, p.x, p.y, p.z, rotY, { body: 'fixed', attachTo: b.body });
        l.attachedTo = e; l.attachStrength = rng.range(5200, 12000); l.set(F.ATTACHED);
        e.supports.push(l); l.supportedBy.push(e);
      }
      // downpipes
      if (e.level > 0 && rng.bool(0.12)) {
        const p = new THREE.Vector3().copy(e.pos)
          .addScaledVector(outward, 0.26)
          .addScaledVector(along, wide * 0.9);
        const s = placeProp(spawn, 'drainPipe', rng, p.x, p.y, p.z, rotY, { body: 'fixed', attachTo: b.body });
        s.attachedTo = e; s.attachStrength = rng.range(400, 1200); s.set(F.ATTACHED);
        e.supports.push(s); s.supportedBy.push(e);
      }
    }
  }
}

function furnishInteriors(ctx: Ctx, buildings: Building[]) {
  const { spawn, rng, terrain } = ctx;
  const furniture: PropKind[] = ['desk', 'shelf', 'chair', 'table', 'locker', 'sofa', 'crate', 'fridge', 'tv', 'mattress', 'plank', 'barrel'];
  // The small stuff that fills a real room, and that a player can carry off.
  const smalls: PropKind[] = ['cardboardBox', 'plasticCrate', 'bucket', 'toolbox', 'jerryCan', 'trashBag'];
  for (const b of buildings) {
    if (b.shell) continue;
    // Columns, walls and the outer skin stand on every floor; the stair takes
    // its whole shaft, since a sofa left over the stairwell would fall down it.
    const room = new Footprints(4);
    const top = b.floorY[b.floors];
    for (const e of b.elements) {
      if (e.structType === ST.Column || e.structType === ST.Wall || e.structType === ST.Facade) room.add(footOfEntity(e));
      else if (e.structType === ST.Stair) room.add({ ...footOfEntity(e, 0.4), y0: b.floorY[0], y1: top });
    }
    // The way in stays clear on the inside too.
    for (const f of doorways(b, terrain, 0.2, 2.2)) room.add(f);
    // The stairwell has no floor on any storey. Anything set down over it fell
    // the height of the building the moment it woke.
    const cw = b.w / b.nx, cd = b.d / b.nz;
    for (const level of b.slabs) {
      for (let i = 0; i < b.nx; i++) {
        for (let j = 0; j < b.nz; j++) {
          if (level[i * b.nz + j]) continue;
          room.add({
            x: b.cx - b.w / 2 + (i + 0.5) * cw, z: b.cz - b.d / 2 + (j + 0.5) * cd,
            hx: cw / 2 + 0.3, hz: cd / 2 + 0.3, rot: 0, y0: b.floorY[0], y1: top,
          });
        }
      }
    }
    // A spot on a floor: somewhere inside the walls, at that floor's height.
    // The ground storey has no slab of its own: its floor is the earth, which
    // follows the lie of the land rather than the building's datum.
    const spot = (L: number, inset: number) => {
      const px = b.cx + rng.range(-b.w / 2 + inset, b.w / 2 - inset);
      const pz = b.cz + rng.range(-b.d / 2 + inset, b.d / 2 - inset);
      if (L > 0) return { px, pz, fy: b.floorY[L] + 0.03 };
      const ty = terrain.heightAt(px, pz);
      if (Math.abs(ty - b.floorY[0]) > 1.2) return null;
      return { px, pz, fy: ty + 0.02 };
    };
    const perFloor = b.style === 'office' ? 4 : 3;
    const maxLevel = Math.min(b.floors, 4);
    const trade = b.style === 'shophouse' || b.style === 'warehouse';
    for (let L = 0; L < maxLevel; L++) {
      for (let i = 0; i < perFloor; i++) {
        if (rng.bool(0.25)) continue;
        const kind = rng.weighted(furniture, (k) =>
          b.style === 'office' ? (k === 'desk' || k === 'chair' || k === 'locker' ? 3 : 1)
          : b.style === 'apartment' ? (k === 'sofa' || k === 'table' || k === 'tv' || k === 'mattress' ? 3 : 1)
          : (k === 'crate' || k === 'shelf' || k === 'barrel' ? 3 : 1));
        for (let t = 0; t < 5; t++) {
          const p = spot(L, 1.2);
          if (p && tryPlaceProp(spawn, room, kind, rng, p.px, p.fy, p.pz, rng.range(0, 6.28))) break;
        }
      }
      const nSmall = rng.int(1, 3) + (trade ? 2 : 0);
      for (let i = 0; i < nSmall; i++) {
        const kind = rng.weighted(smalls, (k) =>
          k === 'cardboardBox' ? 3 : k === 'plasticCrate' ? (trade ? 2.5 : 1) : k === 'trashBag' ? (b.style === 'apartment' ? 1.5 : 0.6)
          : k === 'toolbox' || k === 'jerryCan' ? (b.style === 'warehouse' ? 1.5 : 0.4) : 0.8);
        for (let t = 0; t < 4; t++) {
          const p = spot(L, 0.9);
          if (p && tryPlaceProp(spawn, room, kind, rng, p.px, p.fy, p.pz, rng.range(0, 6.28))) break;
        }
      }
      // Stock on the shop floor, stacked the way it came in.
      if (L === 0 && trade) {
        const shop = { ...ctx, fp: room };
        for (let i = rng.int(1, 3); i > 0; i--) {
          for (let t = 0; t < 4; t++) {
            const p = spot(0, 1.4);
            if (p && shopStock(shop, p.px, p.pz, rng.bool() ? 0 : Math.PI / 2).length) break;
          }
        }
      }
    }
  }
}

function buildPark(ctx: Ctx, blk: Block) {
  const { rng } = ctx;
  const n = Math.round(((blk.x1 - blk.x0) * (blk.z1 - blk.z0)) / 170);
  if (rng.bool(0.4)) {
    const x = (blk.x0 + blk.x1) / 2, z = (blk.z0 + blk.z1) / 2;
    groundProp(ctx, 'torii', x, z, rng.bool() ? 0 : Math.PI / 2);
  }
  for (let i = 0; i < n; i++) {
    const x = rng.range(blk.x0 + 2, blk.x1 - 2), z = rng.range(blk.z0 + 2, blk.z1 - 2);
    groundProp(ctx, 'tree', x, z, rng.range(0, 6.28), 2, 3);
  }
  for (let i = 0; i < Math.max(2, n / 3); i++) {
    const x = rng.range(blk.x0 + 2, blk.x1 - 2), z = rng.range(blk.z0 + 2, blk.z1 - 2);
    groundProp(ctx, rng.pick(['bench', 'planter', 'trashBin'] as PropKind[]), x, z, rng.range(0, 6.28), 2, 3);
  }
}

function buildConstruction(ctx: Ctx, blk: Block) {
  const { spawn, rng, terrain } = ctx;
  const cx = (blk.x0 + blk.x1) / 2, cz = (blk.z0 + blk.z1) / 2;
  const gy = terrain.heightAt(cx, cz);
  const kinds: PropKind[] = ['container', 'scaffold', 'steelBeam', 'rebar', 'pallet', 'crate', 'barrel', 'portaloo', 'cone', 'barrier', 'spool', 'gasCanister', 'sandbag'];
  // The crane goes up first; everything else is set down around its mast.
  if (rng.bool(0.6)) {
    buildCrane(ctx, cx, gy, cz);
    ctx.fp.add({ x: cx, z: cz, hx: 1.2, hz: 1.2, rot: 0, y0: gy, y1: gy + 60 });
  }
  // Spoil heaps: real, diggable earth. Bare hands barely move it, a heavy tool
  // does; and anything trapped underneath stays trapped until it is dug out.
  const mounds = rng.int(1, 2);
  for (let m = 0; m < mounds; m++) {
    soilHeap(ctx, rng.range(blk.x0 + 6, blk.x1 - 6), rng.range(blk.z0 + 6, blk.z1 - 6),
      rng.range(1.7, 2.5), rng.range(1.5, 2.3), rng.range(1.1, 1.7));
  }
  const n = Math.round(((blk.x1 - blk.x0) * (blk.z1 - blk.z0)) / 80);
  for (let i = 0; i < n; i++) {
    const x = rng.range(blk.x0 + 3, blk.x1 - 3), z = rng.range(blk.z0 + 3, blk.z1 - 3);
    const k = rng.weighted(kinds, (t) => t === 'cone' || t === 'pallet' || t === 'crate' ? 3 : t === 'container' ? 1.2 : 1.6);
    groundProp(ctx, k, x, z, rng.range(0, 6.28), 2.5, 3);
  }
  // Building stock in piles: what a player looking to put up a shelter needs.
  stockSite(ctx, blk.x0, blk.z0, blk.x1, blk.z1);
  // hoarding fence around the site
  const fenceMat = makeMaterial(MATERIALS.paintedSteel, { instanced: true, vary: 0.1, colorOverride: 0x3f6fa8, roughOverride: 0.62, metalOverride: 0.35 });
  const fh = 2.4;
  const seg = 3.0;
  const edges: [number, number, number, number][] = [
    [blk.x0, blk.z0, blk.x1, blk.z0], [blk.x0, blk.z1, blk.x1, blk.z1],
    [blk.x0, blk.z0, blk.x0, blk.z1], [blk.x1, blk.z0, blk.x1, blk.z1],
  ];
  for (const [ax, az, bx, bz] of edges) {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(len / seg));
    const horiz = Math.abs(bx - ax) > Math.abs(bz - az);
    for (let s = 0; s < steps; s++) {
      if (rng.bool(0.14)) continue;
      const t = (s + 0.5) / steps;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const gyy = terrain.heightAt(px, pz);
      ctx.fp.add(horiz
        ? { x: px, z: pz, hx: len / steps / 2, hz: 0.04, rot: 0, y0: gyy, y1: gyy + fh }
        : { x: px, z: pz, hx: 0.04, hz: len / steps / 2, rot: 0, y0: gyy, y1: gyy + fh });
      spawn.box({
        pos: new THREE.Vector3(px, gyy + fh / 2, pz),
        size: horiz ? new THREE.Vector3(len / steps, fh, 0.08) : new THREE.Vector3(0.08, fh, len / steps),
        mat: MATERIALS.paintedSteel, body: 'fixed', kind: Kind.Prop, attachTo: spawn.sceneryBody,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x3f6fa8, roughOverride: 0.62, metalOverride: 0.35 },
        flags: F.BREAKABLE | F.CARRYABLE | F.DORMANT, capacity: 256, massOverride: 46,
        label: 'hoarding',
      });
    }
  }
  void fenceMat;
}

function buildCrane(ctx: Ctx, x: number, y: number, z: number) {
  const { spawn, rng } = ctx;
  const H = rng.range(26, 40);
  const jib = rng.range(18, 26);
  const mastGeo = GEO.composite(`crane_mast${H.toFixed(0)}`, () => {
    const g: THREE.BufferGeometry[] = [];
    const s = 0.8;
    for (const [dx, dz] of [[-s, -s], [s, -s], [-s, s], [s, s]] as const) {
      g.push(GEO.translated(GEO.cylinder(0.075, H, 6).clone(), dx, H / 2, dz));
    }
    for (let yy = 1; yy < H; yy += 1.7) {
      g.push(GEO.translated(new THREE.BoxGeometry(s * 2, 0.06, 0.06), 0, yy, -s));
      g.push(GEO.translated(new THREE.BoxGeometry(s * 2, 0.06, 0.06), 0, yy, s));
      g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.06, s * 2), -s, yy, 0));
      g.push(GEO.translated(new THREE.BoxGeometry(0.06, 0.06, s * 2), s, yy, 0));
    }
    return GEO.merge(g);
  });
  const mast = spawn.prop({
    geoKey: `crane_mast${H.toFixed(0)}`, geometry: mastGeo,
    material: makeMaterial(MATERIALS.paintedSteel, { instanced: true, vary: 0.05, colorOverride: 0xe3b91c, roughOverride: 0.55, metalOverride: 0.5 }),
    pos: new THREE.Vector3(x, y, z), half: new THREE.Vector3(0.9, H / 2, 0.9),
    mat: MATERIALS.steel, body: 'fixed', kind: Kind.Structure,
    parts: [{ shape: 'box', half: new THREE.Vector3(0.9, H / 2, 0.9), offset: new THREE.Vector3(0, H / 2, 0) }],
    flags: F.BREAKABLE | F.STRUCTURAL | F.NO_WIND, massOverride: 14000, capacity: 8,
    attachTo: spawn.sceneryBody, label: 'tower crane',
  });
  const jibGeo = GEO.composite(`crane_jib${jib.toFixed(0)}`, () => {
    const g: THREE.BufferGeometry[] = [];
    for (const [dy, dz] of [[0.6, -0.5], [0.6, 0.5], [-0.5, 0]] as const) {
      g.push(GEO.transformed(GEO.cylinder(0.06, jib + 7, 6), new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition((jib - 7) / 2, dy, dz)));
    }
    for (let xx = -6; xx < jib; xx += 1.6) {
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 1.2, 0.05), xx, 0.05, -0.5));
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 1.2, 0.05), xx, 0.05, 0.5));
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 0.05, 1.0), xx, 0.6, 0));
    }
    g.push(GEO.translated(new THREE.BoxGeometry(2.2, 1.4, 1.6), -6.2, 0.2, 0));
    return GEO.merge(g);
  });
  const jibE = spawn.prop({
    geoKey: `crane_jib${jib.toFixed(0)}`, geometry: jibGeo,
    material: makeMaterial(MATERIALS.paintedSteel, { instanced: true, vary: 0.05, colorOverride: 0xe3b91c, roughOverride: 0.55, metalOverride: 0.5 }),
    pos: new THREE.Vector3(x, y + H + 1.2, z),
    quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6.28)),
    half: new THREE.Vector3((jib + 7) / 2, 0.9, 0.8),
    mat: MATERIALS.steel, body: 'fixed', kind: Kind.Structure,
    parts: [{ shape: 'box', half: new THREE.Vector3((jib + 7) / 2, 0.8, 0.7), offset: new THREE.Vector3((jib - 7) / 2, 0.1, 0) }],
    flags: F.BREAKABLE, massOverride: 9000, capacity: 8, attachTo: spawn.sceneryBody, label: 'crane jib',
  });
  jibE.supportedBy.push(mast); mast.supports.push(jibE);
  // A slewing bearing carries the jib's own nine tonnes without noticing. Only a
  // real event — a gale, a quake, the mast itself failing — brings it down.
  jibE.set(F.ATTACHED); jibE.attachedTo = mast; jibE.attachStrength = 620000;
}

function buildPlaza(ctx: Ctx, blk: Block) {
  const { spawn, rng, terrain } = ctx;
  const cx = (blk.x0 + blk.x1) / 2, cz = (blk.z0 + blk.z1) / 2;
  const gy = terrain.heightAt(cx, cz);
  ctx.fp.add({ x: cx, z: cz, hx: 0.9, hz: 0.9, rot: 0, y0: gy, y1: gy + 12 });   // billboard post
  for (let i = 0; i < 8; i++) {
    const x = rng.range(blk.x0 + 3, blk.x1 - 3), z = rng.range(blk.z0 + 3, blk.z1 - 3);
    groundProp(ctx, rng.pick(['planter', 'bench', 'bollard', 'trashBin', 'aBoard'] as PropKind[]), x, z, rng.range(0, 6.28), 2, 3);
  }
  // a big screen / billboard tower
  const bw = 7.5, bh = 4.4;
  const post = spawn.box({
    pos: new THREE.Vector3(cx, gy + 3, cz), size: new THREE.Vector3(0.8, 6, 0.8),
    mat: MATERIALS.steel, body: 'fixed', kind: Kind.Structure,
    matOpts: { instanced: true, vary: 0.05, colorOverride: 0x44484d, metalOverride: 0.7 },
    flags: F.BREAKABLE, capacity: 16, attachTo: spawn.sceneryBody, label: 'billboard post',
  });
  const screenGeo = GEO.composite('bigscreen', () => GEO.merge([
    GEO.beveledBox(bw, bh, 0.45, 0.05, 1).clone(),
  ]));
  const face = GEO.composite('bigscreen_f', () => GEO.translated(new THREE.BoxGeometry(bw - 0.3, bh - 0.3, 0.05), 0, 0, 0.24));
  const scr = spawn.prop({
    geoKey: 'bigscreen', geometry: screenGeo,
    material: makeMaterial(MATERIALS.paintedSteel, { instanced: true, vary: 0.05, colorOverride: 0x1a1d20, metalOverride: 0.4 }),
    pos: new THREE.Vector3(cx, gy + 6 + bh / 2 - 0.5, cz),
    quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6.28)),
    half: new THREE.Vector3(bw / 2, bh / 2, 0.24),
    mat: MATERIALS.paintedSteel, body: 'fixed', kind: Kind.Structure,
    flags: F.BREAKABLE, massOverride: 1800, capacity: 8, attachTo: spawn.sceneryBody, label: 'screen',
    extras: [{ geoKey: 'bigscreen_f', geometry: face, material: emissiveMat(rng.pick([0x3aa0ff, 0xff4d7a, 0xffd23f]), 2.4), capacity: 8 }],
  });
  scr.supportedBy.push(post); post.supports.push(scr);
  scr.set(F.ATTACHED); scr.attachedTo = post; scr.attachStrength = 26000;
}

function streetFurniture(ctx: Ctx, lights: THREE.Vector3[]) {
  const { plan, rng, terrain } = ctx;
  // lamps and signals along every proper road
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    for (let z = -HALF + 14; z < HALF - 14; z += rng.range(24, 34)) {
      if (Math.abs(z - RIVER_Z) < RIVER_HALF + 4) continue;
      if (z > SHORE_Z - 6) continue;
      const side = rng.bool() ? 1 : -1;
      const x = l.pos + side * (l.width / 2 + 1.4);
      if (plan.isBuilt(x, z)) continue;
      const rot = side > 0 ? Math.PI : 0;
      if (groundProp(ctx, 'streetLamp', x, z, rot)) {
        lights.push(new THREE.Vector3(x + Math.sin(rot) * 1.5, terrain.heightAt(x, z) + 5.6, z - Math.cos(rot) * 1.5));
      }
      const nHere = rng.int(1, 2);
      for (let q = 0; q < nHere; q++) {
        const px = l.pos + side * (l.width / 2 + rng.range(1.6, 3.0));
        const pz = z + rng.range(-7, 7);
        if (plan.isBuilt(px, pz)) continue;
        groundProp(ctx, rng.pick(['vending', 'trashBin', 'bicycle', 'aBoard', 'planter', 'bollard', 'cone', 'crate'] as PropKind[]),
          px, pz, rng.range(0, 6.28));
      }
    }
  }
  for (const l of plan.hLines) {
    if (l.kind === 'alley') continue;
    for (let x = -HALF + 14; x < HALF - 14; x += rng.range(26, 36)) {
      if (Math.abs(l.pos - RIVER_Z) < RIVER_HALF + 4) continue;
      if (l.pos > SHORE_Z - 6) continue;
      const side = rng.bool() ? 1 : -1;
      const z = l.pos + side * (l.width / 2 + 1.4);
      if (plan.isBuilt(x, z)) continue;
      const lrot = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      if (groundProp(ctx, 'streetLamp', x, z, lrot)) {
        lights.push(new THREE.Vector3(x + Math.sin(lrot) * 1.5, terrain.heightAt(x, z) + 5.6, z - Math.cos(lrot) * 1.5));
      }
      const nHere = rng.int(1, 2);
      for (let q = 0; q < nHere; q++) {
        const pz = l.pos + side * (l.width / 2 + rng.range(1.6, 3.2));
        const px = x + rng.range(-7, 7);
        if (plan.isBuilt(px, pz)) continue;
        groundProp(ctx, rng.pick(['vending', 'bench', 'bicycle', 'trashBin', 'busStop', 'phoneBooth', 'planter', 'aBoard'] as PropKind[]),
          px, pz, rng.range(0, 6.28));
      }
    }
  }
  // signals + utility poles at intersections
  for (const v of plan.vLines) {
    for (const h of plan.hLines) {
      if (v.kind === 'alley' || h.kind === 'alley') continue;
      if (Math.abs(h.pos - RIVER_Z) < RIVER_HALF + 6 || h.pos > SHORE_Z - 8) continue;
      const corners: [number, number, number][] = [
        [v.pos - v.width / 2 - 1.3, h.pos - h.width / 2 - 1.3, 0],
        [v.pos + v.width / 2 + 1.3, h.pos + h.width / 2 + 1.3, Math.PI],
        [v.pos - v.width / 2 - 1.3, h.pos + h.width / 2 + 1.3, Math.PI / 2],
        [v.pos + v.width / 2 + 1.3, h.pos - h.width / 2 - 1.3, -Math.PI / 2],
      ];
      for (const [x, z, r] of corners) {
        if (rng.bool(0.55)) groundProp(ctx, 'trafficLight', x, z, r);
        else if (rng.bool(0.5)) groundProp(ctx, 'utilityPole', x, z, r);
      }
    }
  }
  // scatter along alleys: bikes, bins, crates
  for (let i = 0; i < 720; i++) {
    const x = rng.range(-HALF + 6, HALF - 6), z = rng.range(-HALF + 6, SHORE_Z - 12);
    if (!plan.isRoad(x, z) || plan.isBuilt(x, z)) continue;
    if (Math.abs(z - RIVER_Z) < RIVER_HALF + 3) continue;
    if (plan.openness(x, z) > 0.70) continue;       // alleys and kerbsides
    groundProp(ctx, rng.pick(['bicycle', 'trashBin', 'crate', 'pallet', 'barrel', 'aBoard', 'dumpster', 'cone',
      'trashBag', 'trashBag', 'cardboardBox', 'plasticCrate', 'tyre', 'bucket', 'jerryCan'] as PropKind[]),
      x, z, rng.range(0, 6.28));
  }
}

function placeVehicles(ctx: Ctx) {
  const { spawn, plan, rng, terrain } = ctx;
  const lines = [
    ...plan.vLines.map((l) => ({ l, alongZ: true })),
    ...plan.hLines.map((l) => ({ l, alongZ: false })),
  ].filter(({ l }) => l.kind !== 'alley');
  if (!lines.length) return;
  let placed = 0;
  for (let attempt = 0; attempt < 2600 && placed < 128; attempt++) {
    const { l, alongZ } = rng.pick(lines);
    const kind = rng.pick(VEHICLE_KINDS);
    const d = vehicleSize(kind);
    // Most were pulled in at the kerb; some were left where they stopped.
    const room = l.width / 2 - d.W / 2 - 0.35;
    if (room < 0) continue;
    const off = (rng.bool() ? 1 : -1) * (rng.bool(0.7) ? room : rng.range(0, room));
    const t = rng.range(-HALF + 12, HALF - 12);
    const x = alongZ ? l.pos + off : t;
    const z = alongZ ? t : l.pos + off;
    if (z < -HALF + 12 || z > SHORE_Z - 16) continue;
    if (Math.abs(z - RIVER_Z) < RIVER_HALF + 6) continue;
    // A vehicle's length runs along its own X, so a road that runs along Z
    // needs it turned a quarter.
    const rot = (alongZ ? Math.PI / 2 : 0) + (rng.bool() ? 0 : Math.PI);
    const gy = terrain.heightAt(x, z);
    const foot: Foot = { x, z, hx: d.L / 2 + 0.3, hz: d.W / 2 + 0.15, rot, y0: gy, y1: gy + d.H };
    // All of it on the road, none of it in a building, and clear of every
    // lamp, pole and parked car already there.
    if (footSamples(foot).some(([px, pz]) => !plan.isRoad(px, pz) || plan.isBuilt(px, pz))) continue;
    if (ctx.fp.hits(foot, 0.2)) continue;
    ctx.fp.add(foot);
    spawnVehicle(spawn, kind, rng, x, gy + 0.02, z, rot);
    placed++;
  }
}

/**
 * Catenaries between the utility poles. Purely visual, but they are what makes
 * a Tokyo back street look like one — and when a pole goes down in a quake the
 * span that hung from it goes with it.
 */
function buildPowerLines(ctx: Ctx, group: THREE.Group) {
  const { phys, rng } = ctx;
  const poles = phys.entities.filter((e) => e.label === 'utility pole');
  if (poles.length < 2) return;
  const strands: THREE.BufferGeometry[] = [];
  const used = new Set<string>();
  for (const a of poles) {
    // connect to the two nearest poles within a plausible span
    const near = poles
      .filter((b) => b !== a)
      .map((b) => ({ b, d: Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) }))
      .filter((r) => r.d > 6 && r.d < 46)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2);
    for (const { b, d } of near) {
      const key = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`;
      if (used.has(key)) continue;
      used.add(key);
      for (let k = 0; k < 3; k++) {
        const h = 8.5 - k * 0.55;
        const off = (k - 1) * 0.55;
        const sag = 0.05 + d * 0.022 + rng.range(0, 0.4);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 5; i++) {
          const t = i / 5;
          const x = a.pos.x + (b.pos.x - a.pos.x) * t;
          const z = a.pos.z + (b.pos.z - a.pos.z) * t;
          const dip = Math.sin(t * Math.PI) * sag;
          const nx = -(b.pos.z - a.pos.z) / d, nz = (b.pos.x - a.pos.x) / d;
          pts.push(new THREE.Vector3(x + nx * off, a.pos.y + h - dip, z + nz * off));
        }
        strands.push(GEO.tube(pts, 0.028, 4));
      }
      if (strands.length > 900) break;
    }
    if (strands.length > 900) break;
  }
  if (!strands.length) return;
  const mesh = new THREE.Mesh(GEO.merge(strands),
    simpleMaterial(0x14161a, 0.85, 0.1, { instanced: false }));
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.name = 'powerlines';
  group.add(mesh);
  for (const g2 of strands) g2.dispose();
}

function buildRiverAndShore(ctx: Ctx) {
  const { spawn, plan, rng, terrain } = ctx;
  // embankment walls along the river
  const wallMatOpts = { instanced: true, vary: 0.12, colorOverride: 0x7c7a73 };
  for (const zSide of [RIVER_Z - RIVER_HALF, RIVER_Z + RIVER_HALF]) {
    for (let x = -HALF + 4; x < HALF - 4; x += 8) {
      const gy = terrain.heightAt(x, zSide);
      spawn.box({
        pos: new THREE.Vector3(x + 4, gy + 1.1, zSide), size: new THREE.Vector3(8, 2.6, 0.6),
        mat: MATERIALS.concrete, body: 'fixed', kind: Kind.Structure, matOpts: wallMatOpts,
        flags: F.BREAKABLE, capacity: 256, attachTo: spawn.sceneryBody, label: 'embankment',
      });
    }
  }
  // Earth banks along the river: diggable, and they slump when saturated.
  for (const side of [-1, 1]) {
    const zb = RIVER_Z + side * (RIVER_HALF + 3.5);
    for (let x = -HALF + 10; x < HALF - 10; x += 9) {
      if (rng.bool(0.45)) continue;
      soilHeap(ctx, x + rng.range(-1.5, 1.5), zb, rng.range(1.2, 2.2), rng.range(0.8, 1.3), rng.range(0.6, 1.1));
    }
  }

  // bridges where avenues cross
  for (const l of plan.vLines) {
    if (l.kind === 'alley') continue;
    buildBridge(ctx, l.pos, l.width);
  }
  // seawall along the bay
  for (let x = -HALF + 4; x < HALF - 4; x += 8) {
    const gy = terrain.heightAt(x, SHORE_Z - 3);
    spawn.box({
      pos: new THREE.Vector3(x + 4, gy + 1.5, SHORE_Z - 3), size: new THREE.Vector3(8, 3.4, 0.9),
      mat: MATERIALS.rebarConcrete, body: 'fixed', kind: Kind.Structure, matOpts: wallMatOpts,
      flags: F.BREAKABLE, capacity: 256, attachTo: spawn.sceneryBody, label: 'seawall',
    });
    if (rng.bool(0.3)) {
      groundProp(ctx, rng.pick(['container', 'crate', 'barrel', 'spool'] as PropKind[]),
        x + rng.range(0, 8), SHORE_Z - rng.range(7, 14), rng.range(0, 6.28), 2, 2);
    }
  }
}

function buildBridge(ctx: Ctx, x: number, width: number) {
  const { spawn, terrain } = ctx;
  const span = RIVER_HALF * 2 + 10;
  const deckY = terrain.heightAt(x, RIVER_Z - RIVER_HALF - 6) + 0.6;
  const segs = 5;
  const prev: Entity[] = [];
  for (let i = 0; i < segs; i++) {
    const z = RIVER_Z - span / 2 + (i + 0.5) * (span / segs);
    const deck = spawn.box({
      pos: new THREE.Vector3(x, deckY, z), size: new THREE.Vector3(width + 3, 0.7, span / segs),
      mat: MATERIALS.rebarConcrete, body: 'fixed', kind: Kind.Structure,
      matOpts: { instanced: true, vary: 0.08, colorOverride: 0x86847d },
      flags: F.BREAKABLE, capacity: 96, attachTo: spawn.sceneryBody, label: 'bridge deck',
    });
    deck.grounded = i === 0 || i === segs - 1;
    deck.set(F.STRUCTURAL);
    for (const p of prev) { deck.supportedBy.push(p); p.supports.push(deck); }
    prev.length = 0; prev.push(deck);
    // piers in the water
    if (i === 1 || i === 3) {
      const pier = spawn.box({
        pos: new THREE.Vector3(x, deckY - 3.6, z), size: new THREE.Vector3(1.6, 7, 1.6),
        mat: MATERIALS.rebarConcrete, body: 'fixed', kind: Kind.Structure,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0x7b7973 },
        flags: F.BREAKABLE, capacity: 96, attachTo: spawn.sceneryBody, label: 'bridge pier',
      });
      pier.grounded = true; pier.set(F.STRUCTURAL);
      deck.supportedBy.push(pier); pier.supports.push(deck);
    }
    // railings
    for (const s of [-1, 1]) {
      spawn.box({
        pos: new THREE.Vector3(x + s * (width / 2 + 1.4), deckY + 0.9, z),
        size: new THREE.Vector3(0.16, 1.1, span / segs),
        mat: MATERIALS.paintedSteel, body: 'fixed', kind: Kind.Structure,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x9aa0a4, metalOverride: 0.6 },
        flags: F.BREAKABLE, capacity: 256, attachTo: spawn.sceneryBody, label: 'railing',
      });
    }
  }
}

/** Non-simulated scenery: distant towers, mountains, and the volcano. */
function buildBackdrop(ctx: Ctx, group: THREE.Group) {
  const { rng, spawn } = ctx;
  // Distant towers go through the same facade shader, so the skyline lights up
  // at night exactly like the city you are standing in.
  const styles: ('office' | 'apartment')[] = ['office', 'apartment'];
  for (let i = 0; i < 1100; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(HALF + 95, HALF + 760);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (z > SHORE_Z + 60) continue;
    const w = rng.range(15, 46), d = rng.range(15, 46);
    const far = clamp01((r - HALF) / 760);
    const h = rng.range(16, 130) * (1.15 - far * 0.35);
    const style = rng.pick(styles);
    const mtl = makeMaterial(MATERIALS.concrete, {
      instanced: true, vary: 0.3,
      colorOverride: rng.pick([0x4e545c, 0x5a6068, 0x474c53, 0x646a71, 0x565b5f]),
      facade: { style, ground: false }, roughOverride: 0.9, metalOverride: 0.02,
    });
    const v = spawn.view(`bd_${style}`, GEO.unitBox(), mtl,
      new THREE.Vector3(w, h, d), 768, { cast: false, receive: false });
    v.pool.setTRS(v.idx,
      new THREE.Vector3(x, h / 2 - 2, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 1.6)),
      v.scale);
  }

  // --- distant hills ---
  const hillGeo = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const hillMat = simpleMaterial(0x39403f, 0.98, 0, { instanced: true, vary: 0.2 });
  const hills = new THREE.InstancedMesh(hillGeo, hillMat, 90);
  let hn = 0;
  for (let i = 0; i < 90; i++) {
    const a = rng.range(Math.PI * 0.55, Math.PI * 2.1);
    const r = rng.range(1100, 1800);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (z > SHORE_Z + 260) continue;
    const sc = rng.range(200, 460);
    hills.setMatrixAt(hn++, new THREE.Matrix4().compose(
      new THREE.Vector3(x, -20, z), new THREE.Quaternion(), new THREE.Vector3(sc, sc * rng.range(0.30, 0.58), sc)));
  }
  hills.count = hn;
  hills.castShadow = hills.receiveShadow = false;
  hills.frustumCulled = false;
  group.add(hills);

  // --- the volcano ---
  const vGeo = new THREE.ConeGeometry(1, 1, 72, 10, true);
  const pos = vGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    const a = Math.atan2(vz, vx);
    const ridge = Math.sin(a * 9) * 0.014 + Math.sin(a * 23 + 1.7) * 0.007;
    const t = clamp01((0.5 - vy) / 1.0);
    pos.setXYZ(i, vx * (1 + ridge * t * 3), vy, vz * (1 + ridge * t * 3));
  }
  vGeo.computeVertexNormals();
  const volcMat = new THREE.MeshStandardMaterial({ color: 0x4b4c52, roughness: 1, metalness: 0 });
  volcMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, G);
    sh.fragmentShader = 'varying vec3 vWP;\nuniform float uAsh;\n' + sh.fragmentShader;
    sh.vertexShader = 'varying vec3 vWP;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', 'vWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float snow = smoothstep(520.0, 700.0, vWP.y) * (1.0 - uAsh * 0.8);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88,0.91,0.95), snow);
      diffuseColor.rgb = mix(diffuseColor.rgb * 0.75, diffuseColor.rgb, smoothstep(-60.0, 320.0, vWP.y));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22,0.19,0.18), uAsh * 0.5);
    `);
  };
  const volcano = new THREE.Mesh(vGeo, volcMat);
  const VD = 2600;
  volcano.position.set(-VD * 0.72, -70, -VD * 0.68);
  volcano.scale.set(1600, 900, 1600);
  volcano.castShadow = volcano.receiveShadow = false;
  volcano.frustumCulled = false;
  volcano.name = 'volcano';
  group.add(volcano);

  // A crater that lights up when the mountain wakes.
  const craterMat = new THREE.MeshBasicMaterial({
    color: 0xff5a18, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  const crater = new THREE.Mesh(new THREE.SphereGeometry(150, 20, 12), craterMat);
  crater.position.set(volcano.position.x, volcano.position.y + 860, volcano.position.z);
  crater.frustumCulled = false;
  crater.name = 'crater';
  crater.renderOrder = 3;
  group.add(crater);
  return group;
}

export { clamp };

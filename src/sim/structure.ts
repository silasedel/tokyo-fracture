import * as THREE from 'three';
import { Entity, F, Kind } from '../physics/entity';
import { MATERIALS, breakEnergy } from '../physics/materials';
import type { PhysWorld } from '../physics/physworld';
import { RAPIER } from '../physics/physworld';
import type { Spawner } from '../world/spawn';
import { Building, ST, MIN_SUPPORT } from '../world/building';
import { Rng, clamp, clamp01 } from '../util/math';
import { G } from '../render/globals';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export interface StructEvents {
  onCollapse?: (e: Entity, pos: THREE.Vector3, volume: number) => void;
  onFracture?: (e: Entity, pos: THREE.Vector3, energy: number) => void;
  onGlassBreak?: (pos: THREE.Vector3, size: number) => void;
}

/**
 * Buildings are not "intact" or "destroyed" — they are a graph of pieces that
 * hold each other up. Break enough of the graph and the rest follows on its
 * own, leaving real geometry behind: sloped slabs, rubble ramps, open floors.
 */
export class StructureSystem {
  buildings: Building[] = [];
  private queue: { e: Entity; at: number }[] = [];
  private rng = new Rng(4242);
  events: StructEvents = {};
  /** Elements currently being tracked for quake stress. */
  quakeStress = 0;
  swayAmp = new THREE.Vector2(0, 0);
  swayOmega = 5.6;
  /** Buildings whose colliders physically sway (the ones the player can touch). */
  private swayBuildings: Building[] = [];
  private swayPhysics = false;
  time = 0;
  collapseCount = 0;

  constructor(public phys: PhysWorld, public spawn: Spawner) {}

  add(b: Building) { this.buildings.push(b); }

  buildingAt(x: number, z: number, pad = 1.5): Building | null {
    for (const b of this.buildings) if (b.contains(x, z, pad)) return b;
    return null;
  }

  // -- damage --------------------------------------------------------------

  /** Generic damage entry point: `amount` is 0..1 of the object's integrity. */
  damage(e: Entity, amount: number) {
    if (e.has(F.DEAD) || amount <= 0) return;
    e.integrity -= amount;
    if (e.view) e.view.pool.setChar(e.view.idx, Math.min(0.85, e.char + (1 - e.integrity) * 0.12));
    if (e.integrity <= 0) this.fail(e, true);
  }

  /** Impact energy in joules; converts to integrity loss via material toughness. */
  impact(e: Entity, energy: number) {
    if (e.has(F.DEAD) || !e.has(F.BREAKABLE)) return;
    const cap = breakEnergy(e.mat, e.volume, 1);
    if (energy < cap * 0.10) return;
    const loss = energy / Math.max(1, cap);
    e.integrity -= loss;
    if (e.integrity <= 0) this.fail(e, true, energy);
    else if (e.view) e.view.pool.setChar(e.view.idx, Math.min(0.8, e.char + (1 - e.integrity) * 0.10));
  }

  /**
   * The element gives way. If it simply lost its supports it falls in one
   * piece; if it was smashed it breaks apart. Either way its dependents get
   * re-checked shortly afterwards, which is what makes collapse cascade.
   */
  fail(e: Entity, shatter: boolean, energy = 0) {
    if (e.has(F.DEAD)) return;
    const wasStructural = e.has(F.STRUCTURAL);
    // notify dependents first, while the graph is still intact
    for (const d of e.supports) {
      if (d.has(F.DEAD) || !d.has(F.STRUCTURAL)) continue;
      this.queue.push({ e: d, at: this.time + this.rng.range(0.03, 0.34) });
    }
    if (wasStructural) {
      this.collapseCount++;
      const b = this.buildings[e.buildingId];
      if (b && b.elements.length) { b.destroyedCount++; b.collapsedFrac = b.destroyedCount / b.elements.length; }
      this.events.onCollapse?.(e, e.pos, e.volume);
    }
    if (e.has(F.GLASS) && e.views) {
      this.events.onGlassBreak?.(e.pos, Math.max(e.hx, e.hy) * 2);
      for (const w of e.views) w.pool.release(w.idx);
      e.views = null;
      this.spawnGlass(e);
    }

    if (shatter && e.integrity <= 0) {
      this.fracture(e, energy);
    } else {
      // detach in one piece: it becomes a real falling slab/column
      e.set(F.STRUCTURAL, false);
      e.grounded = false;
      // clear graph links so nothing keeps referring to it as support
      for (const d of e.supports) { const i = d.supportedBy.indexOf(e); if (i >= 0) d.supportedBy.splice(i, 1); }
      e.supports.length = 0;
      for (const s of e.supportedBy) { const i = s.supports.indexOf(e); if (i >= 0) s.supports.splice(i, 1); }
      e.supportedBy.length = 0;
      e.kind = Kind.Debris;
      this.phys.makeDynamic(e, _v.set(this.rng.range(-0.3, 0.3), -0.1, this.rng.range(-0.3, 0.3)));
      if (e.body) {
        e.body.setAngvel({ x: this.rng.range(-0.5, 0.5), y: this.rng.range(-0.3, 0.3), z: this.rng.range(-0.5, 0.5) }, true);
        e.body.enableCcd(e.mass > 300);
      }
    }
  }

  /** Break an object into physically-real pieces that conserve its momentum. */
  fracture(e: Entity, energy = 0) {
    if (e.has(F.DEAD)) return;
    const m = e.mat;
    const vel = e.body?.isDynamic() ? e.body.linvel() : { x: 0, y: 0, z: 0 };
    _v2.set(vel.x, vel.y, vel.z);
    const pos = e.pos.clone();
    const quat = e.quat.clone();
    const hx = e.hx, hy = e.hy, hz = e.hz;
    this.events.onFracture?.(e, pos, energy);

    // Glass and ceramic shower; wood splits; masonry breaks into chunks.
    if (m.brittleness > 0.9 && m.id === 'glass') {
      this.spawnGlassAt(pos, quat, hx, hz, 10);
      this.phys.destroy(e);
      return;
    }

    const vol = e.volume;
    const pieces = clamp(Math.round(2 + vol * 1.6 * (0.5 + m.brittleness)), 2, 7);
    const boxes = splitBox(hx, hy, hz, pieces, this.rng);
    const canSpawn = this.phys.debris.length < 1400;
    for (const bx of boxes) {
      if (!canSpawn) break;
      _v.set(bx.cx, bx.cy, bx.cz).applyQuaternion(quat).add(pos);
      const size = new THREE.Vector3(bx.hx * 2, bx.hy * 2, bx.hz * 2);
      const outward = _v.clone().sub(pos).normalize().multiplyScalar(this.rng.range(0.4, 1.8) + Math.min(6, energy / 9000));
      const v = _v2.clone().multiplyScalar(0.82).add(outward);
      if (m.id === 'wood' || m.id === 'plywood') {
        this.spawn.splinter(_v, Math.max(0.35, Math.min(1.6, Math.max(size.x, size.z))), m, this.rng.int(0, 5), v);
      } else if (Math.max(size.x, size.y, size.z) > 0.85) {
        // Anything panel-sized breaks into panels: the irregular rubble shape is
        // right at half a metre and reads as a giant glass crystal at three.
        // The pieces are shrunk a little first — splitBox tiles the original
        // exactly, and fragments spawned face to face push each other apart hard
        // enough to break their neighbours, which cascades through the district.
        size.multiplyScalar(0.84);
        const piece = this.spawn.box({
          pos: _v.clone(), quat, size, mat: m, body: 'dynamic', kind: Kind.Debris,
          matOpts: { instanced: true, vary: 0.24, chamfer: true, chamferSize: 0.04 },
          // Not breakable: a fragment is already the result of breaking, and
          // letting the pieces shatter each other cascades without end.
          flags: m.flammability > 0 ? F.FLAMMABLE : 0,
          capacity: 512, linearDamping: 0.06, angularDamping: 0.25,
        });
        piece.char = e.char;
        if (piece.view) piece.view.pool.setChar(piece.view.idx, e.char);
        if (piece.body) piece.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      } else {
        const c = this.spawn.chunk(_v, size, m, this.rng.int(0, 7), { vel: v, quat });
        c.char = e.char;
        if (c.view) c.view.pool.setChar(c.view.idx, e.char);
      }
    }
    this.phys.destroy(e);
  }

  private spawnGlass(e: Entity) {
    this.spawnGlassAt(e.pos, e.quat, e.hx, e.hy, 7);
  }
  private spawnGlassAt(pos: THREE.Vector3, quat: THREE.Quaternion, hx: number, hy: number, n: number) {
    if (this.phys.debris.length > 1100) n = Math.min(n, 3);
    for (let i = 0; i < n; i++) {
      _v.set(this.rng.range(-hx, hx), this.rng.range(-hy, hy), 0).applyQuaternion(quat).add(pos);
      const out = new THREE.Vector3(this.rng.range(-1, 1), this.rng.range(-0.2, 1.4), this.rng.range(-1, 1))
        .normalize().multiplyScalar(this.rng.range(0.6, 3.4));
      const s = this.spawn.shard(_v, this.rng.range(0.28, 0.7), MATERIALS.glass, i, out);
      s.set(F.FRAGMENT);
    }
  }

  // -- support propagation --------------------------------------------------

  private intactSupports(e: Entity) {
    if (e.grounded) return 99;
    let n = 0;
    for (const s of e.supportedBy) if (!s.has(F.DEAD) && s.has(F.STRUCTURAL)) n++;
    return n;
  }

  update(dt: number) {
    this.time += dt;
    if (this.queue.length) {
      let w = 0;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.at > this.time) { this.queue[w++] = q; continue; }
        const e = q.e;
        if (e.has(F.DEAD) || !e.has(F.STRUCTURAL)) continue;
        const need = MIN_SUPPORT[e.structType] ?? 1;
        if (this.intactSupports(e) < need) this.fail(e, false);
      }
      this.queue.length = w;
    }
  }

  // -- earthquake stress ----------------------------------------------------

  /**
   * Shaking loads every element in proportion to its height and mass, and eats
   * into the ones whose material cannot take it. Weak buildings fail first,
   * steel frames ride it out.
   */
  applyShaking(accel: number, dt: number) {
    if (accel < 0.4) return;
    const buildings = this.buildings;
    for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi];
      const els = b.elements;
      // Construction quality varies: some blocks ride out what flattens others.
      const quality = b.quality;
      for (let i = 0; i < els.length; i++) {
        const e = els[i];
        if (e.has(F.DEAD) || !e.has(F.STRUCTURAL)) continue;
        // Upper storeys whip harder than the base.
        const heightFactor = 1 + Math.max(0, e.home.y - b.swayBase) * 0.048;
        const demand = accel * heightFactor;
        const capacity = (2.4 + e.mat.strength * 1.35) * quality
          * (0.55 + 0.45 * e.integrity) * (1 - e.wet * 0.18 * e.mat.absorbency);
        // Damage rises steeply once demand passes capacity: a quake one step
        // stronger is far more than one step worse.
        const ratio = demand / capacity - 0.75;
        if (ratio <= 0) continue;
        e.stress += Math.pow(ratio, 1.6) * 0.09 * dt;
        if (e.stress > 1) {
          e.stress = 0.35;
          this.damage(e, 0.22 + this.rng.range(0, 0.26));
        }
      }
    }
  }

  relaxStress(dt: number) {
    const k = Math.exp(-dt * 0.22);
    for (const b of this.buildings) {
      for (const e of b.elements) if (e.stress > 0) e.stress *= k;
    }
  }

  // -- sway -----------------------------------------------------------------

  /** Must match the GLSL sway in materials.ts exactly. */
  swayOffset(x: number, y: number, z: number, out: THREE.Vector3) {
    const hgt = Math.max(0, y);
    const s = Math.sin(this.time * this.swayOmega - (x * 0.026 + z * 0.019));
    const k = Math.pow(Math.min(hgt, 90) / 30, 1.35);
    return out.set(this.swayAmp.x * k * s, 0, this.swayAmp.y * k * s);
  }

  setShake(ampX: number, ampZ: number, omega: number) {
    this.swayAmp.set(ampX, ampZ);
    this.swayOmega = omega;
    G.uQuake.value.set(ampX, ampZ, omega, 0);
  }

  /**
   * The building the player can actually touch gets its colliders moved to
   * match the visual sway, so standing on a swaying floor feels right.
   */
  updatePhysicalSway(playerPos: THREE.Vector3) {
    const want = this.swayAmp.lengthSq() > 1e-6;
    if (!want) {
      if (this.swayPhysics) {
        for (const b of this.swayBuildings) this.setBuildingKinematic(b, false);
        this.swayBuildings.length = 0;
        this.swayPhysics = false;
      }
      return;
    }
    // pick the building the player is in or next to
    const near = this.buildingAt(playerPos.x, playerPos.z, 6);
    const target = near && !near.shell ? [near] : [];
    if (target[0] !== this.swayBuildings[0]) {
      for (const b of this.swayBuildings) if (!target.includes(b)) this.setBuildingKinematic(b, false);
      for (const b of target) if (!this.swayBuildings.includes(b)) this.setBuildingKinematic(b, true);
      this.swayBuildings = target;
    }
    this.swayPhysics = true;
    for (const b of this.swayBuildings) {
      if (!b.body || b.body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
      // The whole building translates together, sampled at roughly the height a
      // player would be standing, so the floor under their feet matches the view.
      const refY = b.swayBase + Math.min(b.top - b.swayBase, 12);
      this.swayOffset(b.cx, refY, b.cz, _v);
      b.body.setNextKinematicTranslation({ x: _v.x, y: 0, z: _v.z });
    }
  }

  private setBuildingKinematic(b: Building, on: boolean) {
    if (!b.body) return;
    b.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Fixed, false);
    if (!on) b.body.setTranslation({ x: 0, y: 0, z: 0 }, false);
  }

  /** Pull an entire building down from a point — used by the disaster director. */
  triggerCollapse(b: Building, atLevel = 0, severity = 1) {
    if (b.shell) {
      const core = b.elements[0];
      if (core && !core.has(F.DEAD)) { core.integrity = 0; this.fail(core, true, 60000); }
      return;
    }
    let n = 0;
    for (const e of b.elements) {
      if (e.has(F.DEAD) || !e.has(F.STRUCTURAL)) continue;
      if (e.level < atLevel || e.level > atLevel + 1) continue;
      if (e.structType !== ST.Column) continue;
      if (this.rng.next() > 0.35 + 0.5 * severity) continue;
      this.damage(e, 2);
      n++;
    }
    if (n === 0) {
      for (const e of b.elements) {
        if (!e.has(F.DEAD) && e.has(F.STRUCTURAL) && e.structType === ST.Column) { this.damage(e, 2); break; }
      }
    }
  }

  /** Progressive heat weakening — a fire in a steel frame really does drop it. */
  heatWeaken(e: Entity, dt: number) {
    if (!e.has(F.STRUCTURAL)) return;
    const over = e.temp - 220;
    if (over <= 0) return;
    this.damage(e, dt * (over / 900) * e.mat.heatWeakening * 0.06);
  }

  stats() {
    return { buildings: this.buildings.length, collapsed: this.collapseCount, queued: this.queue.length };
  }
}

interface Box { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; }

/** Recursively split a box along its longest axis into roughly `n` pieces. */
function splitBox(hx: number, hy: number, hz: number, n: number, rng: Rng): Box[] {
  let list: Box[] = [{ cx: 0, cy: 0, cz: 0, hx, hy, hz }];
  while (list.length < n) {
    // split the biggest piece
    let bi = 0, bv = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i].hx * list[i].hy * list[i].hz;
      if (v > bv) { bv = v; bi = i; }
    }
    const b = list[bi];
    const axis = b.hx >= b.hy && b.hx >= b.hz ? 0 : b.hy >= b.hz ? 1 : 2;
    const t = rng.range(0.36, 0.64);
    const out: Box[] = [];
    if (axis === 0) {
      const a = b.hx * 2 * t, c = b.hx * 2 - a;
      out.push({ ...b, hx: a / 2, cx: b.cx - b.hx + a / 2 });
      out.push({ ...b, hx: c / 2, cx: b.cx + b.hx - c / 2 });
    } else if (axis === 1) {
      const a = b.hy * 2 * t, c = b.hy * 2 - a;
      out.push({ ...b, hy: a / 2, cy: b.cy - b.hy + a / 2 });
      out.push({ ...b, hy: c / 2, cy: b.cy + b.hy - c / 2 });
    } else {
      const a = b.hz * 2 * t, c = b.hz * 2 - a;
      out.push({ ...b, hz: a / 2, cz: b.cz - b.hz + a / 2 });
      out.push({ ...b, hz: c / 2, cz: b.cz + b.hz - c / 2 });
    }
    list.splice(bi, 1, ...out);
    if (list.length > 24) break;
  }
  return list;
}

export { clamp01, _q };

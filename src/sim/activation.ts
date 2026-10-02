import * as THREE from 'three';
import { Entity, F } from '../physics/entity';
import type { PhysWorld } from '../physics/physworld';
import { HALF, MAP } from '../world/cityplan';

const CELL = 22;
const N = Math.ceil(MAP / CELL) + 2;

/**
 * Most of the city is scenery until something touches it. Dormant props keep
 * their collider on one shared static body — no island, no solver cost — and
 * only get a rigid body of their own when the player, the wind, the water or a
 * disaster actually needs them to move. That is what keeps thousands of
 * physical objects affordable.
 */
export class Activation {
  private grid: (Entity[] | undefined)[] = new Array(N * N);
  /** Bodies that are live but have settled; candidates for freezing. */
  live: Entity[] = [];
  awakeCount = 0;
  frozenCount = 0;
  private timer = 0;
  private cursor = 0;
  // How far out scenery is given a body of its own. Everything beyond this is
  // still solid — it just cannot be pushed until you walk over to it.
  radius = 32;
  /**
   * Further out still, dormant scenery gives up its colliders altogether, and
   * gets them back well before anyone could reach it. A city's worth of
   * crates, bikes and bags would otherwise sit in the broadphase and the query
   * tree on every step, paid for whether anyone is near them or not. Anything
   * that wakes a parked prop — a quake, a flood, a blast, the wind tearing it
   * loose — gives it its colliders back first.
   */
  parkRadius = 110;
  unparkRadius = 88;
  private streamTimer = 0;

  constructor(public phys: PhysWorld) {
    phys.parkedNear = (p, r, out, seen, max) => this.parkedNear(p, r, out, seen, max);
  }

  private key(x: number, z: number) {
    const i = Math.min(N - 1, Math.max(0, Math.floor((x + HALF) / CELL) + 1));
    const j = Math.min(N - 1, Math.max(0, Math.floor((z + HALF) / CELL) + 1));
    return j * N + i;
  }

  index(entities: Entity[]) {
    this.grid.length = 0;
    this.grid.length = N * N;
    for (const e of entities) {
      if (!e.has(F.DORMANT)) continue;
      const k = this.key(e.pos.x, e.pos.z);
      const arr = this.grid[k];
      if (arr) arr.push(e); else this.grid[k] = [e];
    }
  }

  /** Give a dormant object a real body. Safe to call repeatedly. */
  wake(e: Entity): boolean {
    if (!e.has(F.DORMANT) || e.has(F.DEAD)) return false;
    e.set(F.DORMANT, false);
    this.phys.makeDynamic(e);
    if (e.body) {
      e.body.setLinearDamping(0.05);
      e.body.setAngularDamping(0.22);
    }
    this.live.push(e);
    return true;
  }

  /** Wake everything inside a radius. Disasters call this on their footprint. */
  wakeArea(x: number, z: number, r: number, limit = 400): number {
    let n = 0;
    const r2 = r * r;
    const c = Math.ceil(r / CELL);
    const ci = Math.floor((x + HALF) / CELL) + 1;
    const cj = Math.floor((z + HALF) / CELL) + 1;
    for (let j = cj - c; j <= cj + c; j++) {
      if (j < 0 || j >= N) continue;
      for (let i = ci - c; i <= ci + c; i++) {
        if (i < 0 || i >= N) continue;
        const arr = this.grid[j * N + i];
        if (!arr || !arr.length) continue;
        let w = 0;
        for (let k = 0; k < arr.length; k++) {
          const e = arr[k];
          if (e.has(F.DEAD)) continue;
          const dx = e.pos.x - x, dz = e.pos.z - z;
          if (dx * dx + dz * dz <= r2 && n < limit) {
            if (this.wake(e)) { n++; continue; }
          }
          arr[w++] = e;
        }
        arr.length = w;
      }
    }
    return n;
  }

  /**
   * Park dormant scenery beyond `parkRadius` of `p` and restore it inside
   * `unparkRadius`; the gap between the two keeps a prop on the boundary from
   * flickering in and out. `budget` caps the entities changed in one call.
   */
  stream(p: THREE.Vector3, budget = Infinity): number {
    let n = 0;
    const r0 = this.unparkRadius, r1 = this.parkRadius, reach = CELL * 0.71;
    for (let j = 0; j < N && n < budget; j++) {
      for (let i = 0; i < N && n < budget; i++) {
        const arr = this.grid[j * N + i];
        if (!arr || !arr.length) continue;
        const cx = (i - 0.5) * CELL - HALF, cz = (j - 0.5) * CELL - HALF;
        const d = Math.hypot(cx - p.x, cz - p.z);
        if (d - reach > r1) {
          for (const e of arr) {
            if (e.parked || !e.has(F.DORMANT) || e.has(F.DEAD)) continue;
            this.phys.park(e); n++;
          }
        } else if (d + reach < r0) {
          for (const e of arr) {
            if (!e.parked) continue;
            this.phys.unpark(e); n++;
          }
        } else {
          for (const e of arr) {
            const de = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
            if (e.parked) { if (de < r0) { this.phys.unpark(e); n++; } }
            else if (de > r1 && e.has(F.DORMANT) && !e.has(F.DEAD)) { this.phys.park(e); n++; }
          }
        }
      }
    }
    return n;
  }

  /** Parked entities near a point, for queries that must still find them. */
  private parkedNear(p: THREE.Vector3, r: number, out: Entity[], seen: Set<number>, max: number) {
    const c = Math.ceil((r + 4) / CELL);
    const ci = Math.floor((p.x + HALF) / CELL) + 1;
    const cj = Math.floor((p.z + HALF) / CELL) + 1;
    for (let j = cj - c; j <= cj + c; j++) {
      if (j < 0 || j >= N) continue;
      for (let i = ci - c; i <= ci + c; i++) {
        if (i < 0 || i >= N) continue;
        const arr = this.grid[j * N + i];
        if (!arr) continue;
        for (const e of arr) {
          if (!e.parked || e.has(F.DEAD) || seen.has(e.id)) continue;
          const reachE = r + e.radius;
          if ((e.pos.x - p.x) ** 2 + (e.pos.y - p.y) ** 2 + (e.pos.z - p.z) ** 2 > reachE * reachE) continue;
          seen.add(e.id);
          out.push(e);
          if (out.length >= max) return;
        }
      }
    }
  }

  /** Wall-clock gap between sweeps, used to age the "has stopped moving" timer. */
  private sweepDt = 0.18;

  update(dt: number, playerPos: THREE.Vector3) {
    this.streamTimer -= dt;
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.45;
      this.stream(playerPos, 900);
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.sweepDt = Math.min(1.0, 0.18 - this.timer);
      this.timer = 0.18;
      this.wakeArea(playerPos.x, playerPos.z, this.radius, 120);
      this.sweep(playerPos);
    }
  }

  /**
   * Anything that has come to rest a long way from the player is frozen back to
   * a static body. Distant rubble piles stop consuming solver time and stop
   * jittering, but wake again the moment the player returns.
   */
  private sweep(playerPos: THREE.Vector3) {
    const list = this.live;
    if (!list.length) return;
    let awake = 0, frozen = 0;
    const budget = Math.min(list.length, 1400);
    for (let n = 0; n < budget; n++) {
      this.cursor = (this.cursor + 1) % list.length;
      const e = list[this.cursor];
      if (!e || e.has(F.DEAD) || !e.body) continue;
      const d2 = (e.pos.x - playerPos.x) ** 2 + (e.pos.z - playerPos.z) ** 2 + (e.pos.y - playerPos.y) ** 2;
      if (e.has(F.FROZEN)) {
        if (d2 < 30 * 30) this.phys.unfreeze(e);
      } else if (e.body.isDynamic() && !e.has(F.HELD)) {
        // Rapier keeps a whole contact island awake while any one body in it is
        // still twitching, and a rubble pile never quite stops twitching. Put
        // anything that has effectively stopped to sleep explicitly: it keeps
        // its colliders and wakes the instant something touches it. Far from
        // the player it goes further and becomes static again.
        if (e.body.isSleeping()) {
          if (d2 > 38 * 38) this.phys.freeze(e);
          continue;
        }
        const lv = e.body.linvel(), av = e.body.angvel();
        const still = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z < 0.08
          && av.x * av.x + av.y * av.y + av.z * av.z < 0.22;
        if (still) {
          e.stillFor += this.sweepDt;
          if (e.stillFor > 0.9) {
            if (d2 > 38 * 38) this.phys.freeze(e);
            else e.body.sleep();
          }
        } else e.stillFor = 0;
      }
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.has(F.DEAD)) continue;
      if (e.has(F.FROZEN)) frozen++;
      else if (e.body?.isDynamic() && !e.body.isSleeping()) awake++;
    }
    this.awakeCount = awake;
    this.frozenCount = frozen;
    // compact
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].has(F.DEAD)) list[w++] = list[i];
    list.length = w;
  }
}

import * as THREE from 'three';
import { Entity, F, Kind } from '../physics/entity';
import type { PhysWorld } from '../physics/physworld';
import { AMBIENT_TEMP } from '../physics/materials';
import { SpatialHash, clamp, clamp01, Rng } from '../util/math';
import type { Wind } from './wind';
import type { Water } from './water';
import type { StructureSystem } from './structure';
import type { Activation } from './activation';
import type { Player } from '../player/player';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export interface FireEvents {
  onIgnite?: (e: Entity) => void;
  onExtinguish?: (e: Entity) => void;
  onExplosion?: (pos: THREE.Vector3, energy: number, radius: number) => void;
}

/**
 * Fire is a property of objects, not a scripted effect. Heat moves between
 * things that are near each other, biased downwind and upward; anything whose
 * material can take it starts to burn, consumes its own fuel, weakens as it
 * chars, and heats its neighbours in turn. Rain and floodwater put it out.
 */
export class Fire {
  burning: Entity[] = [];
  private hash = new SpatialHash<Entity>(5);
  private hashTimer = 0;
  private tick = 0;
  private scratch: Entity[] = [];
  private blastBuf: Entity[] = [];
  private rng = new Rng(8181);
  events: FireEvents = {};
  /** 0..1 how much of the city is alight — drives smoke, sky glow and grading. */
  intensity = 0;
  totalIgnitions = 0;
  /** Ambient temperature rise near the player, for HUD and damage. */
  playerHeat = 0;

  constructor(
    public phys: PhysWorld,
    public wind: Wind,
    public water: Water,
    public structure: StructureSystem,
    public activation: Activation,
  ) {}

  private rebuildHash() {
    this.hash.clear();
    const es = this.phys.entities;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.has(F.DEAD)) continue;
      if (!e.has(F.FLAMMABLE) && !e.has(F.GAS_SOURCE) && e.mat.heatWeakening < 1.2) continue;
      if (e.fuel <= 0 && !e.has(F.GAS_SOURCE) && e.mat.heatWeakening < 1.2) continue;
      this.hash.insert(e.pos.x, e.pos.z, e);
    }
  }

  ignite(e: Entity, force = false): boolean {
    if (e.has(F.BURNING) || e.has(F.DEAD)) return false;
    if (e.fuel <= 0) return false;
    if (!force && e.wet > 0.82) return false;
    e.set(F.BURNING);
    e.temp = Math.max(e.temp, e.mat.ignitionTemp + 90);
    this.burning.push(e);
    this.totalIgnitions++;
    this.events.onIgnite?.(e);
    return true;
  }

  extinguish(e: Entity) {
    if (!e.has(F.BURNING)) return;
    e.set(F.BURNING, false);
    e.temp = Math.min(e.temp, 180);
    if (e.view) e.view.pool.setGlow(e.view.idx, 0);
    this.events.onExtinguish?.(e);
  }

  /**
   * Find something near a point that could actually catch. Used when a hazard
   * wants to start a fire somewhere the player will see it burn, rather than in
   * the middle of a concrete road.
   */
  findFuel(x: number, z: number, radius: number): Entity | null {
    const found = this.hash.query(x, z, radius, this.scratch);
    let best: Entity | null = null, bestScore = -1;
    for (const e of found) {
      if (e.has(F.DEAD) || e.has(F.BURNING) || e.fuel <= 0) continue;
      if (e.mat.flammability < 0.3 || e.wet > 0.7) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d > radius) continue;
      const score = e.mat.flammability * (1 + e.volume) / (1 + d * 0.25);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /** Start a fire at a point in the world — a spark, a short, a lightning strike. */
  startFire(x: number, y: number, z: number, radius = 2.5, power = 1): number {
    this.activation.wakeArea(x, z, radius + 2, 40);
    const found = this.hash.query(x, z, radius + 4, this.scratch);
    let n = 0;
    for (const e of found) {
      if (e.has(F.DEAD)) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y - y, e.pos.z - z);
      if (d > radius + e.radius) continue;
      e.temp += 420 * power * clamp01(1 - d / (radius + e.radius));
      if (e.temp > e.mat.ignitionTemp && this.ignite(e)) n++;
    }
    return n;
  }

  update(dt: number, player: Player) {
    this.hashTimer -= dt;
    if (this.hashTimer <= 0) { this.hashTimer = 2.2; this.rebuildHash(); }

    this.tick += dt;
    const step = 1 / 9;
    if (this.tick < step) { this.updateVisuals(dt); return; }
    const sdt = this.tick;
    this.tick = 0;

    const rain = this.water.rainRate * 3600;    // mm/h-ish
    let alive = 0;
    let w = 0;
    for (let i = 0; i < this.burning.length; i++) {
      const e = this.burning[i];
      if (e.has(F.DEAD)) continue;

      // --- being put out --------------------------------------------------
      if (e.submerged > 0.25) { this.extinguish(e); continue; }
      if (rain > 0.4) {
        const shelter = clamp01(1 - e.pos.y / 60);
        e.wet = Math.min(1, e.wet + sdt * rain * 0.0016 * shelter);
        if (e.wet > 0.9) { this.extinguish(e); continue; }
      }

      // --- consume fuel ---------------------------------------------------
      const surface = 2 * (e.hx * e.hy + e.hy * e.hz + e.hx * e.hz) * 4;
      const oxy = 1 + clamp(this.wind.atPlayer.length() * 0.02, 0, 0.6);
      const burn = e.mat.burnRate * surface * 0.05 * sdt * oxy * (1 - e.wet * 0.7);
      e.fuel -= burn;
      e.char = Math.min(1, e.char + burn * 0.55 / Math.max(0.1, e.volume * e.mat.density * 0.4));
      e.temp = Math.min(1100, e.temp + sdt * 40);
      this.structure.heatWeaken(e, sdt);
      // Burning eats the object itself; it fails once it is mostly gone.
      if (e.has(F.BREAKABLE)) this.structure.damage(e, sdt * 0.018 * e.mat.heatWeakening);

      if (e.fuel <= 0) {
        this.extinguish(e);
        if (e.has(F.BREAKABLE) && e.integrity > 0) this.structure.damage(e, 2);
        continue;
      }

      // --- radiate to neighbours ------------------------------------------
      // Bigger fires reach further and heat harder; the numbers are tuned so a
      // neighbouring object a couple of metres away catches within seconds and
      // one six metres away may never catch at all.
      const output = clamp(0.5 + e.radius * 0.7, 0.5, 4.0);
      const reach = 3.6 + e.radius * 2.4 + clamp(this.wind.speed * 0.12, 0, 5.5);
      const near = this.hash.query(e.pos.x, e.pos.z, reach, this.scratch);
      this.wind.sample(e.pos.x, e.pos.y, e.pos.z, _v2);
      const cool = Math.exp(-sdt * 0.09);
      for (let k = 0; k < near.length; k++) {
        const o = near[k];
        if (o === e || o.has(F.BURNING) || o.has(F.DEAD)) continue;
        _v.subVectors(o.pos, e.pos);
        const d = _v.length();
        o.temp = AMBIENT_TEMP + (o.temp - AMBIENT_TEMP) * cool;
        if (d > reach + o.radius) continue;
        const nd = d > 1e-3 ? 1 / d : 1;
        // Heat rises, and travels downwind.
        let bias = 0.5 + 0.85 * clamp01(_v.y * nd);
        if (_v2.lengthSq() > 1) bias += 0.9 * clamp01((_v.x * _v2.x + _v.z * _v2.z) * nd / Math.max(1, _v2.length()));
        const q = 260 * output * bias / (1 + d * d * 0.7) * (1 - o.wet * 0.9) / (0.55 + o.volume * 0.4);
        o.temp += q * sdt;
        if (o.temp > o.mat.ignitionTemp) {
          if (o.has(F.GAS_SOURCE) && o.integrity < 0.6) {
            this.explode(o.pos, 220000, 9);
            this.phys.destroy(o);
          } else if (o.has(F.DORMANT)) {
            this.activation.wake(o);
            this.ignite(o);
          } else this.ignite(o);
        } else if (o.mat.heatWeakening > 1.2 && o.temp > 260) {
          this.structure.heatWeaken(o, sdt);
        }
      }
      // Wind-borne embers: a big fire in a gale can jump a street.
      if (this.wind.speed > 7 && e.radius > 0.5 && this.rng.next() < sdt * 0.18) {
        this.wind.sample(e.pos.x, e.pos.y + 2, e.pos.z, _v2);
        const ws = _v2.length();
        if (ws > 6) {
          const reachE = clamp(ws * 1.3, 8, 34);
          _v.copy(_v2).normalize().multiplyScalar(reachE * this.rng.range(0.4, 1));
          const spots = this.hash.query(e.pos.x + _v.x, e.pos.z + _v.z, 5, this.scratch);
          for (const o of spots) {
            if (o.has(F.BURNING) || o.has(F.DEAD) || o.wet > 0.6) continue;
            o.temp += 260;
            if (o.temp > o.mat.ignitionTemp) { this.ignite(o); break; }
          }
        }
      }
      alive++;
      this.burning[w++] = e;
    }
    this.burning.length = w;

    // --- cooling everywhere else ------------------------------------------
    this.intensity = clamp01(alive / 90);

    // player heat
    this.playerHeat = 0;
    const nearP = this.hash.query(player.pos.x, player.pos.z, 12, this.scratch);
    for (const e of nearP) {
      if (!e.has(F.BURNING)) continue;
      const d = Math.max(0.8, player.pos.distanceTo(e.pos));
      this.playerHeat += clamp(28 / (d * d), 0, 4.5);
    }
    if (this.playerHeat > 0.35) {
      player.vitals.heat = clamp01(player.vitals.heat + sdt * this.playerHeat * 0.12);
      if (player.vitals.heat > 0.55) player.hurt(sdt * (player.vitals.heat - 0.5) * 34, 'burned');
    } else {
      player.vitals.heat = Math.max(0, player.vitals.heat - sdt * 0.22);
    }
    this.updateVisuals(dt);
  }

  private updateVisuals(dt: number) {
    void dt;
    for (let i = 0; i < this.burning.length; i++) {
      const e = this.burning[i];
      if (!e.view) continue;
      const glow = clamp01((e.temp - 240) / 520) * clamp01(e.fuel / 8 + 0.35);
      e.view.pool.setGlow(e.view.idx, glow);
      e.view.pool.setChar(e.view.idx, e.char);
    }
  }

  /**
   * A blast: radial impulse scaled by energy and inverse-square distance, plus
   * structural damage, ignition and a shove for anyone standing nearby.
   */
  explode(pos: THREE.Vector3, energy: number, radius: number, player?: Player) {
    this.activation.wakeArea(pos.x, pos.z, radius * 1.4, 260);
    const hit = this.phys.queryBall(pos, radius, this.blastBuf, 400);
    for (let i = 0; i < hit.length; i++) {
      const e = hit[i];
      if (e.has(F.DEAD)) continue;
      _v.subVectors(e.pos, pos);
      const d = Math.max(0.6, _v.length());
      _v.multiplyScalar(1 / d);
      const share = energy / (1 + d * d * 1.6);
      if (e.has(F.DORMANT) && d < radius) this.activation.wake(e);
      if (e.body?.isDynamic()) {
        const imp = clamp(share * 0.0022, 0, e.mass * 22);
        e.body.applyImpulse({ x: _v.x * imp, y: (_v.y * 0.6 + 0.55) * imp, z: _v.z * imp }, true);
        e.body.wakeUp();
      }
      if (e.has(F.FLAMMABLE) && d < radius * 0.8 && this.rng.bool(0.55)) { e.temp += 500; this.ignite(e); }
      if (e.has(F.BREAKABLE)) this.structure.impact(e, share * 0.5);
    }
    if (player) {
      _v.subVectors(player.pos, pos);
      const d = Math.max(0.8, _v.length());
      if (d < radius * 2.2) {
        _v.multiplyScalar(1 / d);
        const share = energy / (1 + d * d * 1.6);
        player.push(_v.multiplyScalar(clamp(share * 0.0016, 0, 1500)));
        player.hurt(clamp(share * 0.00042, 0, 88), 'impact');
        player.addShake(clamp(share * 0.00002, 0.2, 1.9));
      }
    }
    if (this.water.depthAt(pos.x, pos.z) > 0.1) {
      this.water.splash(pos.x, pos.z, radius * 1.6, 5.5);
    }
    this.events.onExplosion?.(pos.clone(), energy, radius);
  }

  /** Burning objects the renderer should draw flames on, nearest first. */
  visibleFires(origin: THREE.Vector3, max: number, out: Entity[]) {
    out.length = 0;
    for (const e of this.burning) {
      if (e.has(F.DEAD)) continue;
      out.push(e);
    }
    out.sort((a, b) => a.pos.distanceToSquared(origin) - b.pos.distanceToSquared(origin));
    if (out.length > max) out.length = max;
    return out;
  }

  reset() {
    for (const e of this.burning) e.set(F.BURNING, false);
    this.burning.length = 0;
    this.intensity = 0;
  }
  static ambient = AMBIENT_TEMP;
  static kindOf(e: Entity) { return e.kind === Kind.Structure; }
}

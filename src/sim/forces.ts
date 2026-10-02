import * as THREE from 'three';
import { Entity, F, Kind } from '../physics/entity';
import type { PhysWorld } from '../physics/physworld';
import { AIR_DENSITY, WATER_DENSITY } from '../physics/materials';
import { Wind } from './wind';
import type { Water, WaterSample } from './water';
import type { Player } from '../player/player';
import type { Activation } from './activation';
import type { StructureSystem } from './structure';
import { clamp, clamp01 } from '../util/math';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sample: WaterSample = { surface: -Infinity, depth: 0, vx: 0, vz: 0 };

/**
 * Acceleration a force has to be worth before it may wake a sleeping body, or
 * keep an awake one from settling: roughly what it takes to slide a resting
 * object against its own friction.
 */
const WAKE_G = 7.0;

/**
 * The coupling layer. Every dynamic object gets the same treatment every step:
 * buoyancy and drag from whatever water it is in, pressure from the wind field,
 * and the inertial load of a shaking ground. Nothing is typed as "floats" or
 * "blows away" — those behaviours fall out of mass, volume, shape and material.
 */
export class Forces {
  /** Ground acceleration from the current earthquake, m/s^2. */
  quakeAccel = new THREE.Vector3();
  /** How much water is sloshing about; used to decide whether to bother. */
  waterActive = false;
  private attachTimer = 0;
  private attached: Entity[] = [];
  private wakeTimer = 0;
  private parity = 0;
  stats = { wetted: 0, floating: 0, blown: 0, tornOff: 0 };
  onTearOff: ((e: Entity, force: number) => void) | null = null;
  onSplash: ((pos: THREE.Vector3, energy: number) => void) | null = null;

  constructor(
    public phys: PhysWorld,
    public wind: Wind,
    public water: Water,
    public activation: Activation,
    public structure: StructureSystem,
  ) {}

  /** Call once after the city is built. */
  indexAttachments(entities: Entity[]) {
    this.attached = entities.filter((e) => e.has(F.ATTACHED) && e.attachStrength > 0);
  }

  update(dt: number, player: Player) {
    this.stats.floating = 0; this.stats.blown = 0; this.stats.wetted = 0;
    // Wind is the most expensive term to evaluate, so each body gets it on
    // alternate steps at double strength. The averaged force is identical.
    this.parity ^= 1;
    const quake = this.quakeAccel.lengthSq() > 1e-6;
    const windy = this.wind.speed > 3.5 || this.wind.vortices.length > 0;
    this.waterActive = this.water.maxDepth > 0.05;

    const bodies = this.phys.active;
    for (let i = 0; i < bodies.length; i++) {
      const e = bodies[i];
      if (e.has(F.DEAD) || e.kind === Kind.Player) continue;
      const body = e.body;
      if (!body || !body.isDynamic()) continue;

      // Rapier's addForce/addTorque are *persistent*: whatever is applied keeps
      // being applied on every later timestep until it is cleared. Every force
      // below is recomputed from scratch each step, so the accumulator has to be
      // wiped first — otherwise a breeze integrates up over a few seconds and
      // throws a crate into orbit.
      body.resetForces(false);
      body.resetTorques(false);

      // A settled body is only worth disturbing if the world around it has
      // actually changed enough to move it. Applying a breeze to every crate in
      // the city with the wake flag set keeps every rubble pile in the solver
      // for the rest of the run, which is where the frame time goes.
      if (body.isSleeping() && !quake) {
        let disturb = false;
        if (this.waterActive) {
          this.water.sample(e.pos.x, e.pos.z, _sample);
          if (_sample.surface > e.pos.y - e.hy * 0.6) disturb = true;
        }
        if (!disturb && windy && !e.has(F.NO_WIND)) {
          this.wind.sample(e.pos.x, e.pos.y, e.pos.z, _v);
          const rel = _v.length();
          const area = 4 * Math.max(e.hx * e.hy, e.hy * e.hz, e.hx * e.hz);
          // It has to beat friction to be worth waking for, not just gravity.
          const f = 0.5 * AIR_DENSITY * e.mat.drag * e.dragBoost * area * rel * rel;
          if (f > e.mass * WAKE_G) disturb = true;
        }
        if (!disturb) continue;
      }

      let fx = 0, fy = 0, fz = 0;
      const lv = body.linvel();

      // ---------------------------------------------------------- water
      let submerged = 0;
      if (this.waterActive) {
        this.water.sample(e.pos.x, e.pos.z, _sample);
        if (_sample.surface > -1e8) {
          const bottom = e.pos.y - e.hy;
          submerged = clamp01((_sample.surface - bottom) / Math.max(0.06, e.hy * 2));
          if (submerged > 0.001) {
            this.stats.floating++;
            const wasWet = e.submerged;
            e.submerged = submerged;
            e.wet = Math.min(1, e.wet + dt * 1.6 * submerged);

            // Sealed volumes slowly take on water and lose their lift.
            if (e.hollow > 0.02) {
              const rate = e.has(F.WATERTIGHT) ? 0.006 : 0.055;
              e.flooded = Math.min(1, e.flooded + dt * rate * submerged);
            }

            const vSub = e.volume * submerged;
            const buoy = WATER_DENSITY * 9.81 * vSub;
            const ballast = e.flooded * e.hollow * e.volume * WATER_DENSITY * 9.81 * submerged;

            // Drag against the local current, using the true projected area.
            _v.set(_sample.vx - lv.x, -lv.y, _sample.vz - lv.z);
            const relSpeed = _v.length();
            if (relSpeed > 0.002) {
              _q.copy(e.quat).invert();
              _v2.copy(_v).normalize().applyQuaternion(_q);
              const area = Wind.boxArea(e.hx, e.hy, e.hz, _v2);
              const cd = e.mat.drag * e.dragBoost;
              const k = 0.5 * WATER_DENSITY * cd * area * relSpeed * submerged;
              fx += _v.x * k; fy += _v.y * k * 0.7; fz += _v.z * k;
            }

            // Buoyancy acts through the centroid of the submerged part, which
            // is what rights a floating object and tips an unbalanced one.
            const cy = -e.hy * (1 - submerged);
            const net = buoy - ballast;
            _v3.set(e.pos.x, e.pos.y + cy, e.pos.z);
            const cap = e.mass * 260;
            const bf = clamp(net, -cap, cap);
            body.addForceAtPoint({ x: 0, y: bf, z: 0 }, { x: _v3.x, y: _v3.y, z: _v3.z }, true);

            // angular drag so debris does not spin forever in the water
            const av = body.angvel();
            const ad = -0.55 * submerged * e.mass * Math.min(4, e.radius);
            body.addTorque({ x: av.x * ad, y: av.y * ad, z: av.z * ad }, true);

            if (wasWet < 0.05 && submerged > 0.2 && Math.abs(lv.y) > 2.4) {
              this.water.splash(e.pos.x, e.pos.z, Math.max(1.2, e.radius * 2), Math.min(4, Math.abs(lv.y) * 0.35));
              this.onSplash?.(e.pos, 0.5 * e.mass * lv.y * lv.y);
            }
          } else e.submerged = 0;
        } else e.submerged = 0;
      }

      // ---------------------------------------------------------- wind
      if (windy && !e.has(F.NO_WIND) && submerged < 0.85 && ((e.id & 1) === this.parity)) {
        this.wind.sample(e.pos.x, e.pos.y, e.pos.z, _v);
        _v.x -= lv.x; _v.y -= lv.y; _v.z -= lv.z;
        const rel = _v.length();
        if (rel > 1.2) {
          _q.copy(e.quat).invert();
          _v2.copy(_v).normalize().applyQuaternion(_q);
          const area = Wind.boxArea(e.hx, e.hy, e.hz, _v2);
          const cd = e.mat.drag * e.dragBoost;
          const k = 0.5 * AIR_DENSITY * cd * area * rel * (1 - submerged * 0.8) * 2;
          const wx = _v.x * k, wy = _v.y * k, wz = _v.z * k;
          fx += wx; fy += wy; fz += wz;
          if ((wx * wx + wy * wy + wz * wz) > (e.mass * 6) ** 2) this.stats.blown++;
          // Off-centre pressure tumbles light, flat things end over end.
          if (e.aspect > 0.45 && e.mass < 220) {
            const off = e.radius * 0.42;
            body.addTorque({
              x: (_v.y * off - _v.z * off) * k * 0.05,
              y: (_v.z * off - _v.x * off) * k * 0.05,
              z: (_v.x * off - _v.y * off) * k * 0.05,
            }, true);
          }
        }
      }

      // ------------------------------------------------- shaking ground
      if (quake) {
        // The ground can only shake what it is holding up. Something already in
        // flight feels gravity and nothing else; driving it with the ground
        // acceleration as well pumps energy into it every step it stays in the
        // air, and a slab ends up leaving the city at seventy metres a second.
        const airborne = clamp01((Math.abs(lv.y) - 2.5) / 4);
        const k = e.mass * (1 - airborne);
        if (k > 0) {
          fx -= this.quakeAccel.x * k;
          fy -= this.quakeAccel.y * k;
          fz -= this.quakeAccel.z * k;
        }
      }

      if (fx !== 0 || fy !== 0 || fz !== 0) {
        const cap = e.mass * 320;
        const mag = Math.hypot(fx, fy, fz);
        if (mag > cap) { const s = cap / mag; fx *= s; fy *= s; fz *= s; }
        // Waking a body resets its sleep timer. A steady breeze is nowhere near
        // enough to shift a crate off the pavement, but flagged as a wake it
        // keeps every settled piece of rubble in the solver for the rest of the
        // run. Anything already awake feels the force either way.
        body.addForce({ x: fx, y: fy, z: fz }, quake || submerged > 0.02 || mag > e.mass * WAKE_G);
      }
    }

    this.updatePlayerForces(dt, player);
    this.attachTimer -= dt;
    if (this.attachTimer <= 0) { this.attachTimer = 0.2; this.checkAttachments(); }

    // Strong weather reaches out and wakes loose objects so they can react.
    this.wakeTimer -= dt;
    if (this.wakeTimer <= 0) {
      this.wakeTimer = 0.3;
      for (const v of this.wind.vortices) {
        if (v.intensity > 0.12) this.activation.wakeArea(v.x, v.z, v.radius * 3.4, 220);
      }
      if (this.wind.speed > 21) this.activation.wakeArea(player.pos.x, player.pos.z, 70, 120);
      if (this.water.maxDepth > 0.35) this.activation.wakeArea(player.pos.x, player.pos.z, 62, 120);
    }
  }

  private updatePlayerForces(dt: number, player: Player) {
    // water
    this.water.sample(player.pos.x, player.pos.z, _sample);
    _v.set(_sample.vx, 0, _sample.vz);
    player.setWater(_sample.surface, _v);

    if (_sample.surface > -1e8 && player.submerged > 0.02) {
      // Moving water shoves a standing person around; deep fast water sweeps them off.
      const rel = _v2.set(_sample.vx - player.vel.x, 0, _sample.vz - player.vel.z);
      const relSpeed = rel.length();
      if (relSpeed > 0.15) {
        const area = 0.62 * (player.crouched ? 0.6 : 1) * Math.min(1, player.submerged * 1.5);
        const k = 0.5 * WATER_DENSITY * 1.15 * area * relSpeed;
        player.externalForce.addScaledVector(rel, k);
      }
      // Being swept into things hurts.
      if (relSpeed > 6 && player.submerged > 0.35) {
        player.hurt(dt * (relSpeed - 6) * 2.2, 'drowned');
      }
    }

    // wind
    this.wind.refreshPlayer(player.pos.x, player.pos.y + 0.8, player.pos.z);
    _v.copy(this.wind.atPlayer);
    _v.x -= player.vel.x; _v.z -= player.vel.z;
    const wRel = _v.length();
    if (wRel > 4) {
      const area = player.crouched ? 0.42 : 0.72;
      const k = 0.5 * AIR_DENSITY * 1.2 * area * wRel;
      player.externalForce.addScaledVector(_v, k);
      if (wRel > 32) {
        // Torn off your feet: violent wind lifts and throws.
        player.externalForce.y += (wRel - 32) * 26;
      }
    }

    // shaking ground
    if (this.quakeAccel.lengthSq() > 1e-6) {
      player.externalForce.addScaledVector(this.quakeAccel, -player.mass * 0.55);
      player.addShake(this.quakeAccel.length() * dt * 0.5);
    }
  }

  /**
   * Bolted-on things have a real breaking strength. Once the pressure on a sign
   * beats the bracket holding it, it becomes a flying object with mass.
   */
  private checkAttachments() {
    let w = 0;
    const list = this.attached;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.has(F.DEAD)) continue;
      if (!e.has(F.ATTACHED) || !e.attachedTo) continue;
      const host = e.attachedTo;
      // A fixing only fails with what it is bolted to: the host being gone, or
      // the host having come loose itself. Testing for a STRUCTURAL flag instead
      // silently drops anything hung on a host that simply is not part of a
      // building — a crane mast, a gantry, a pole.
      if (host.has(F.DEAD) || (host.body !== null && host.body.isDynamic())) {
        this.tearOff(e, 0);
        continue;
      }
      this.wind.sample(e.pos.x, e.pos.y, e.pos.z, _v);
      const rel = _v.length();
      if (rel > 8) {
        _q.copy(e.quat).invert();
        _v2.copy(_v).normalize().applyQuaternion(_q);
        const area = Wind.boxArea(e.hx, e.hy, e.hz, _v2);
        const force = 0.5 * AIR_DENSITY * e.mat.drag * e.dragBoost * area * rel * rel;
        // Fatigue: repeated loading weakens the fixing before it lets go.
        if (force > e.attachStrength * 0.55) e.attachStrength *= 0.988;
        if (force > e.attachStrength) {
          this.tearOff(e, force);
          continue;
        }
      }
      list[w++] = e;
    }
    list.length = w;
  }

  tearOff(e: Entity, force: number) {
    const host = e.attachedTo;
    if (host) {
      const i = host.supports.indexOf(e);
      if (i >= 0) host.supports.splice(i, 1);
    }
    e.attachedTo = null;
    e.set(F.ATTACHED, false);
    e.set(F.DORMANT, false);
    e.supportedBy.length = 0;
    this.phys.makeDynamic(e);
    if (e.body) {
      this.wind.sample(e.pos.x, e.pos.y, e.pos.z, _v);
      e.body.setLinvel({ x: _v.x * 0.35, y: _v.y * 0.35 + 0.6, z: _v.z * 0.35 }, true);
      e.body.setAngvel({ x: (Math.random() - 0.5) * 7, y: (Math.random() - 0.5) * 7, z: (Math.random() - 0.5) * 7 }, true);
    }
    this.stats.tornOff++;
    this.onTearOff?.(e, force);
  }
}

import * as THREE from 'three';
import { Entity, F, Kind, GROUP, MOVING, interactionGroups } from '../physics/entity';
import { PhysWorld, RAPIER } from '../physics/physworld';
import { MATERIALS, GRAVITY } from '../physics/materials';
import type { Input } from '../core/input';
import { clamp, clamp01, damp, lerp, smoothstep } from '../util/math';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export const STAND_HALF = 0.56;   // capsule half-height (excludes the caps)
export const CROUCH_HALF = 0.20;
export const RADIUS = 0.34;
export const EYE_STAND = 0.72;    // eye offset above the capsule centre
export const EYE_CROUCH = 0.40;

/** The same gravity everything else in the city falls under. */
const G = -GRAVITY;
/**
 * Quadratic air drag per unit mass, for a person falling spread out and
 * tumbling: terminal velocity comes out at about 55 m/s, which is what a body
 * reaches after twelve or thirteen seconds of free fall, not what it hits
 * jumping off a car.
 */
const AIR_DRAG = G / (55 * 55);
/** Take-off speed of a jump: about 55 cm of clearance, which is what people manage. */
const JUMP_SPEED = 3.3;
/** A fall onto hard ground starts to injure from about 3 m (7.4 m/s at impact). */
const HURT_SPEED = 7.4;

export type DeathCause =
  | 'crushed' | 'impact' | 'fall' | 'drowned' | 'burned' | 'electrocuted' | 'buried' | 'exposure' | 'debris';

export interface Vitals {
  health: number;
  stamina: number;
  breath: number;
  /** Core temperature stress, 0 = fine, 1 = lethal. */
  heat: number;
  dead: boolean;
  cause: DeathCause | null;
}

export interface GroundInfo {
  grounded: boolean;
  normal: THREE.Vector3;
  entity: Entity | null;
  slope: number;
}

/**
 * A kinematic character that moves through the same world everything else
 * lives in. It walks, climbs, swims, gets shoved by wind and water, and takes
 * damage from the physical energy of whatever hits it — there are no scripted
 * hazards, only forces.
 */
export class Player {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  ent: Entity;

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  crouched = false;
  wantCrouch = false;
  grounded = false;
  groundNormal = new THREE.Vector3(0, 1, 0);
  groundEntity: Entity | null = null;
  coyote = 0;
  jumpBuffer = 0;
  sprinting = false;

  /** 0..1 how much of the capsule is under water. */
  submerged = 0;
  headUnder = false;
  swimming = false;
  climbing: Entity | null = null;
  /** Set by the world each frame: something climbable within arm's reach. */
  nearLadder: Entity | null = null;

  vitals: Vitals = { health: 100, stamina: 100, breath: 100, heat: 0, dead: false, cause: null };

  /** Extra mass being hauled around — slows movement and jumping. */
  carryLoad = 0;
  carryAwkward = 0;

  /** Accumulated view shake from quakes, impacts and blasts. */
  shake = 0;
  shakeDir = new THREE.Vector3();
  private shakeT = 0;
  private bob = 0;
  private bobAmp = 0;
  /** Smoothed look velocity, used to make the arms trail the view. */
  lookVel = new THREE.Vector2();
  /** Movement intent this frame, forwarded to the animation rig. */
  moveInput = new THREE.Vector2();
  private airTime = 0;
  /** How far the knees gave on the last landing; the eye sinks and comes back up. */
  private landDip = 0;
  private landDipV = 0;
  private fallStartY = 0;
  private falling = false;
  private stepTimer = 0;
  private mantleT = 0;
  private mantleFrom = new THREE.Vector3();
  private mantleTo = new THREE.Vector3();
  private platformDelta = new THREE.Vector3();
  /** Set by the world systems each step. */
  externalForce = new THREE.Vector3();
  waterVel = new THREE.Vector3();
  waterTop = -999;
  onFootstep: ((speed: number, ground: Entity | null, water: boolean) => void) | null = null;
  onLand: ((speed: number) => void) | null = null;
  onHurt: ((amount: number, cause: DeathCause) => void) | null = null;
  onDeath: ((cause: DeathCause) => void) | null = null;
  lastDamageAt = -99;

  readonly mass = 78;
  eyeY = EYE_STAND;

  constructor(public phys: PhysWorld, spawn: THREE.Vector3) {
    const bd = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawn.x, spawn.y, spawn.z);
    this.body = phys.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.capsule(STAND_HALF, RADIUS)
      .setFriction(0.0)
      .setRestitution(0)
      .setCollisionGroups(interactionGroups(GROUP.PLAYER, 0xffff))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(900)
      .setDensity(this.mass / (Math.PI * RADIUS * RADIUS * (2 * STAND_HALF + 1.33 * RADIUS)));
    this.collider = phys.world.createCollider(cd, this.body);

    this.controller = phys.world.createCharacterController(0.015);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.46, 0.18, true);
    this.controller.enableSnapToGround(0.42);
    this.controller.setMaxSlopeClimbAngle(54 * Math.PI / 180);
    this.controller.setMinSlopeSlideAngle(56 * Math.PI / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(this.mass);
    this.controller.setSlideEnabled(true);
    this.controller.setNormalNudgeFactor(0.0015);

    this.pos.copy(spawn);

    // An entity record so every other system can treat the player as an object.
    this.ent = phys.spawn({
      kind: Kind.Player, mat: MATERIALS.fabric, pos: spawn,
      half: new THREE.Vector3(RADIUS, STAND_HALF + RADIUS, RADIUS),
      body: 'fixed', parts: [], label: 'player', flags: F.NO_DESPAWN,
    });
    phys.byCollider.set(this.collider.handle, this.ent);
    this.ent.mass = this.mass;
    this.ent.hollow = 0.30;
  }

  get eyePosition() {
    return _v3.set(this.pos.x, this.pos.y + this.eyeY, this.pos.z);
  }
  get halfHeight() { return this.crouched ? CROUCH_HALF : STAND_HALF; }
  get totalHeight() { return (this.halfHeight + RADIUS) * 2; }
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  forward(out: THREE.Vector3) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  right(out: THREE.Vector3) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
  lookDir(out: THREE.Vector3) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -1.52, 1.52);
    this.lookVel.x += dx;
    this.lookVel.y += dy;
  }

  /**
   * Walk-cycle phase. The camera bob, the footstep sounds and the limbs all
   * read the same number, so a footfall lands when the foot lands.
   */
  get stridePhase() { return this.bob; }

  hurt(amount: number, cause: DeathCause) {
    if (this.vitals.dead || amount <= 0) return;
    this.vitals.health -= amount;
    this.lastDamageAt = performance.now() / 1000;
    this.onHurt?.(amount, cause);
    if (this.vitals.health <= 0) {
      this.vitals.health = 0;
      this.vitals.dead = true;
      this.vitals.cause = cause;
      this.onDeath?.(cause);
    }
  }

  addShake(amount: number, dir?: THREE.Vector3) {
    this.shake = Math.min(2.2, this.shake + amount);
    if (dir) this.shakeDir.copy(dir).normalize();
  }

  /** Impulse from an explosion, a wave, or a piece of the city hitting you. */
  push(impulse: THREE.Vector3) {
    this.vel.addScaledVector(impulse, 1 / this.mass);
    if (this.vel.length() > 26) this.vel.setLength(26);
  }

  update(dt: number, input: Input, locked: boolean) {
    const V = this.vitals;
    if (V.dead) { this.updateCameraOnly(dt); return; }

    this.lookVel.multiplyScalar(Math.exp(-11 * dt));
    if (locked) this.look(input.mouse.dx, input.mouse.dy);

    // ------------------------------------------------ intent
    const fwdIn = input.axis('KeyS', 'KeyW');
    const strafeIn = input.axis('KeyA', 'KeyD');
    this.moveInput.set(strafeIn, fwdIn);
    this.wantCrouch = input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyC');
    const wantJump = input.hit('Space');
    if (wantJump) this.jumpBuffer = 0.16;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    // ------------------------------------------------ crouch (with headroom test)
    const shouldCrouch = this.wantCrouch || this.swimming;
    if (shouldCrouch !== this.crouched) {
      if (!shouldCrouch) {
        if (this.hasHeadroom()) this.setCrouch(false);
      } else this.setCrouch(true);
    }

    // A load slows you, but you can always walk off with anything you can lift
    // and still shuffle along with what you can only drag.
    const loadFactor = 1 / (1 + this.carryLoad / 240 + this.carryAwkward * 0.2);

    // Grab a ladder by pushing into it, let go by dropping or jumping off.
    if (this.climbing) {
      if (this.climbing.has(F.DEAD) || !this.nearLadder) this.climbing = null;
    } else if (this.nearLadder && !this.swimming && (fwdIn > 0 || wantJump) && V.stamina > 4) {
      this.climbing = this.nearLadder;
      this.vel.set(0, 0, 0);
      this.jumpBuffer = 0;
    }

    if (this.swimming) this.swimMove(dt, input, fwdIn, strafeIn, loadFactor);
    else if (this.climbing) this.climbMove(dt, input, fwdIn, strafeIn);
    else this.walkMove(dt, input, fwdIn, strafeIn, loadFactor);

    // ------------------------------------------------ integrate through the controller
    this.applyMotion(dt);
    this.updateCamera(dt, fwdIn, strafeIn);
  }

  private setCrouch(on: boolean) {
    this.crouched = on;
    this.collider.setHalfHeight(on ? CROUCH_HALF : STAND_HALF);
  }

  private hasHeadroom(): boolean {
    const shape = new RAPIER.Capsule(STAND_HALF, RADIUS * 0.96);
    const hit = this.phys.world.castShape(
      { x: this.pos.x, y: this.pos.y + (STAND_HALF - CROUCH_HALF), z: this.pos.z },
      { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 1, z: 0 }, shape, 0, 0.02, true,
      undefined, undefined, this.collider, this.body);
    return hit === null;
  }

  private walkMove(dt: number, input: Input, fwdIn: number, strafeIn: number, loadFactor: number) {
    const V = this.vitals;
    const wantSprint = (input.down('ShiftLeft') || input.down('ShiftRight')) && fwdIn > 0 && !this.crouched;
    this.sprinting = wantSprint && V.stamina > 2;

    const base = this.crouched ? 2.05 : this.sprinting ? 6.9 : 4.35;
    const target = base * loadFactor;

    this.forward(_v).multiplyScalar(fwdIn);
    this.right(_v2).multiplyScalar(strafeIn);
    _v.add(_v2);
    if (_v.lengthSq() > 1) _v.normalize();
    _v.multiplyScalar(target);

    // Slopes cost speed; slick ground (ice, wet steel) costs control.
    const friction = this.groundEntity ? this.groundEntity.mat.friction : 0.9;
    const grip = clamp01(friction * 1.15);
    // Once your feet leave the ground there is almost nothing to push against:
    // a little twist and reach, but you keep the speed you jumped with.
    const accel = this.grounded ? 42 * grip : 2.6;
    const decel = this.grounded ? 34 * grip : 0.5;

    const cur = _v3.set(this.vel.x, 0, this.vel.z);
    const dv = _v.clone().sub(cur);
    const rate = _v.lengthSq() > cur.lengthSq() * 0.9 ? accel : decel;
    const maxDelta = rate * dt;
    if (dv.length() > maxDelta) dv.setLength(maxDelta);
    this.vel.x += dv.x; this.vel.z += dv.z;

    // Gravity, and the air pushing back once you are really falling.
    this.vel.y -= G * dt;
    if (this.vel.y < 0) this.vel.y += AIR_DRAG * this.vel.y * this.vel.y * dt;

    // jump / mantle
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0) && V.stamina > 6) {
      const j = JUMP_SPEED * lerp(1, 0.72, clamp01(this.carryLoad / 160));
      this.vel.y = j;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      V.stamina -= 7;
      this.airTime = 0;
    } else if (this.jumpBuffer > 0 && !this.grounded && this.mantleT <= 0) {
      this.tryMantle();
    }

    // stamina
    if (this.sprinting) V.stamina -= dt * 13;
    else V.stamina += dt * (this.grounded ? (this.speed < 0.3 ? 19 : 9) : 4);
    V.stamina = clamp(V.stamina, 0, 100);

    // breath recovers in air
    V.breath = clamp(V.breath + dt * 24, 0, 100);
  }

  private swimMove(dt: number, input: Input, fwdIn: number, strafeIn: number, loadFactor: number) {
    const V = this.vitals;
    const up = (input.down('Space') ? 1 : 0) - (input.down('ControlLeft') ? 1 : 0);
    this.lookDir(_v).multiplyScalar(fwdIn);
    this.right(_v2).multiplyScalar(strafeIn);
    _v.add(_v2);
    _v.y += up * 0.9;
    if (_v.lengthSq() > 1) _v.normalize();
    const sprint = input.down('ShiftLeft') && V.stamina > 2;
    const sp = (sprint ? 3.5 : 2.3) * loadFactor;
    _v.multiplyScalar(sp);
    if (sprint) V.stamina -= dt * 11; else V.stamina += dt * 5;
    V.stamina = clamp(V.stamina, 0, 100);

    // Buoyancy: the body floats to the surface unless actively diving.
    const displaced = 0.082;                       // m^3 of body volume
    const buoy = (1000 * displaced * 9.81 * this.submerged) / this.mass;
    const grav = 9.81 * (1 - clamp01(this.carryLoad / 220));
    this.vel.y += (buoy - grav - (up < 0 ? 5.5 : 0)) * dt;

    // Water drag pulls the swimmer toward the current.
    const k = 3.4 * dt;
    this.vel.x = damp(this.vel.x, _v.x + this.waterVel.x, 3.4, dt);
    this.vel.z = damp(this.vel.z, _v.z + this.waterVel.z, 3.4, dt);
    this.vel.y = damp(this.vel.y, this.vel.y + _v.y, 2.0, dt);
    this.vel.y = clamp(this.vel.y, -6, 6);
    void k;

    if (this.headUnder) {
      V.breath -= dt * 7.2;
      if (V.breath <= 0) {
        V.breath = 0;
        this.hurt(dt * 22, 'drowned');
      }
    } else {
      V.breath = clamp(V.breath + dt * 26, 0, 100);
    }
  }

  private climbMove(dt: number, input: Input, fwdIn: number, strafeIn: number) {
    const V = this.vitals;
    const ladder = this.climbing!;
    this.vel.set(0, 0, 0);
    // Look up to go up: the pitch decides the direction, forward gives the pace.
    const up = fwdIn * (Math.sin(this.pitch) * 1.35 + 0.35)
      + (input.down('Space') ? 0.9 : 0) - (input.down('ControlLeft') ? 0.9 : 0);
    this.vel.y = clamp(up, -1.2, 1.2) * 2.5;
    this.right(_v2).multiplyScalar(strafeIn * 1.1);
    this.vel.x = _v2.x; this.vel.z = _v2.z;
    // Stay pressed against the rungs.
    _v.set(ladder.pos.x - this.pos.x, 0, ladder.pos.z - this.pos.z);
    const d = _v.length();
    if (d > 0.05) { _v.multiplyScalar(1 / d); this.vel.x += _v.x * Math.min(2, (d - 0.55) * 4); this.vel.z += _v.z * Math.min(2, (d - 0.55) * 4); }
    // Topping out: step onto whatever is above the ladder.
    const top = ladder.pos.y + ladder.hy;
    if (this.pos.y > top - 0.2 && up > 0) {
      this.climbing = null;
      this.forward(_v2);
      this.vel.set(_v2.x * 2.2, 3.2, _v2.z * 2.2);
    }
    V.stamina -= dt * 5;
    if (V.stamina <= 0 || input.hit('KeyQ')) { this.climbing = null; this.vel.y = 0; }
    if (input.hit('Space') && input.down('ShiftLeft')) { this.climbing = null; this.forward(_v2); this.vel.set(-_v2.x * 3, 3.5, -_v2.z * 3); }
    V.stamina = clamp(V.stamina, 0, 100);
    V.breath = clamp(V.breath + dt * 24, 0, 100);
  }

  private tryMantle() {
    // Look for a ledge at chest height that has clear space on top.
    this.forward(_v);
    const origin = { x: this.pos.x + _v.x * 0.15, y: this.pos.y + 0.15, z: this.pos.z + _v.z * 0.15 };
    const hit = this.phys.world.castRayAndGetNormal(
      new RAPIER.Ray(origin, { x: _v.x, y: 0, z: _v.z }), 0.85, true,
      undefined, interactionGroups(GROUP.PLAYER, MOVING | GROUP.TERRAIN | GROUP.STRUCTURE | GROUP.DORMANT),
      this.collider, this.body);
    if (!hit) return;
    const wall = _v2.set(hit.normal.x, hit.normal.y, hit.normal.z);
    if (Math.abs(wall.y) > 0.5) return;
    // probe downward from above the wall to find the ledge top
    const ahead = { x: origin.x + _v.x * (hit.timeOfImpact + 0.55), y: this.pos.y + 1.9, z: origin.z + _v.z * (hit.timeOfImpact + 0.55) };
    const down = this.phys.world.castRay(new RAPIER.Ray(ahead, { x: 0, y: -1, z: 0 }), 2.3, true,
      undefined, interactionGroups(GROUP.PLAYER, MOVING | GROUP.TERRAIN | GROUP.STRUCTURE | GROUP.DORMANT),
      this.collider, this.body);
    if (!down) return;
    const topY = ahead.y - down.timeOfImpact;
    const rise = topY - (this.pos.y - this.halfHeight - RADIUS);
    if (rise < 0.35 || rise > 2.05) return;
    if (this.vitals.stamina < 12) return;
    this.vitals.stamina -= 12;
    this.mantleFrom.copy(this.pos);
    this.mantleTo.set(ahead.x, topY + this.halfHeight + RADIUS + 0.06, ahead.z);
    this.mantleT = 0.0001;
    this.vel.set(0, 0, 0);
  }

  private applyMotion(dt: number) {
    // Mantling overrides normal motion with a short, readable arc.
    if (this.mantleT > 0) {
      this.mantleT += dt / 0.42;
      const t = clamp01(this.mantleT);
      const e = t < 0.55 ? smoothstep(0, 0.55, t) : 1;
      const h = smoothstep(0, 1, t);
      this.pos.x = lerp(this.mantleFrom.x, this.mantleTo.x, h);
      this.pos.z = lerp(this.mantleFrom.z, this.mantleTo.z, h);
      this.pos.y = lerp(this.mantleFrom.y, this.mantleTo.y, e);
      this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      if (t >= 1) { this.mantleT = 0; this.grounded = true; }
      this.syncEntity();
      return;
    }

    // Wind, blast and current forces arrive as an acceleration.
    this.vel.addScaledVector(this.externalForce, dt / this.mass);
    this.externalForce.set(0, 0, 0);

    _v.copy(this.vel).multiplyScalar(dt).add(this.platformDelta);
    this.platformDelta.set(0, 0, 0);

    this.controller.computeColliderMovement(this.collider, _v, undefined,
      interactionGroups(GROUP.PLAYER, 0xffff));
    const mv = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    // Recover the velocity actually achieved so running into a wall kills speed.
    if (dt > 0) {
      const ax = mv.x / dt, ay = mv.y / dt, az = mv.z / dt;
      if (Math.abs(ax) < Math.abs(this.vel.x)) this.vel.x = ax;
      if (Math.abs(az) < Math.abs(this.vel.z)) this.vel.z = az;
      // Vertically, only a real obstruction takes speed away: a fall slows by
      // what it actually slid against. This used to keep a fifth of the fall
      // speed whenever the controller came up even a rounding error short —
      // which in free air was every few frames, so every fall was a parachute
      // drop at a metre and a half a second. Nor is a step climbed on the way a
      // launch upward.
      const tol = 0.02 + Math.abs(this.vel.y) * 0.002;
      if (this.vel.y < 0 && ay > this.vel.y + tol) this.vel.y = Math.min(0, ay);
      else if (this.vel.y > 0 && ay < this.vel.y - tol) this.vel.y = Math.max(0, ay);
    }

    this.pos.x += mv.x; this.pos.y += mv.y; this.pos.z += mv.z;

    // Ground contact info, and riding whatever is underfoot.
    this.groundEntity = null;
    this.groundNormal.set(0, 1, 0);
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.controller.computedCollision(i);
      if (!c) continue;
      if (c.normal1.y < -0.4) {
        // something pressed down on the head
        const other = c.collider ? this.phys.entityOf(c.collider.handle) : null;
        if (other && other.body?.isDynamic()) {
          const lv = other.body.linvel();
          const speed = Math.max(0, -lv.y);
          if (speed > 3.5) {
            const energy = 0.5 * other.mass * speed * speed;
            this.hurt(clamp(energy / 420, 0, 95), 'crushed');
            this.addShake(clamp(energy / 9000, 0.1, 1.6));
          }
        }
      }
      if (c.normal1.y > 0.35) {
        this.groundNormal.set(c.normal1.x, c.normal1.y, c.normal1.z);
        const e = c.collider ? this.phys.entityOf(c.collider.handle) : null;
        if (e) this.groundEntity = e;
      }
    }

    if (this.grounded) {
      this.coyote = 0.12;
      if (!wasGrounded && this.falling) {
        const drop = this.fallStartY - this.pos.y;
        const vImpact = Math.min(55, Math.sqrt(Math.max(0, 2 * G * drop)));
        this.onLand?.(vImpact);
        this.landDipV = Math.max(this.landDipV, clamp(vImpact * 0.22, 0, 2.4));
        // Injury above roughly a 3 m fall, scaling with the energy absorbed.
        if (vImpact > HURT_SPEED && !this.swimming) {
          const excess = vImpact - HURT_SPEED;
          this.hurt(excess * excess * 1.25, 'fall');
          this.addShake(clamp(excess * 0.12, 0, 1.2));
        }
        this.falling = false;
      }
      this.fallStartY = this.pos.y;
      this.airTime = 0;
      if (this.vel.y < 0) this.vel.y = 0;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      if (this.vel.y < -0.6) {
        if (!this.falling) { this.falling = true; this.fallStartY = Math.max(this.fallStartY, this.pos.y); }
      } else if (this.vel.y > 0.2) {
        this.fallStartY = this.pos.y;
      }
    }

    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
    this.syncEntity();

    // footsteps
    const sp = this.speed;
    if (this.grounded && sp > 0.9) {
      this.stepTimer -= dt * sp;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.sprinting ? 3.1 : 2.5;
        this.onFootstep?.(sp, this.groundEntity, this.submerged > 0.08);
      }
    } else if (this.swimming && sp > 0.8) {
      this.stepTimer -= dt * sp;
      if (this.stepTimer <= 0) { this.stepTimer = 4.0; this.onFootstep?.(sp, null, true); }
    }
  }

  private syncEntity() {
    this.ent.pos.copy(this.pos);
    this.ent.hy = this.halfHeight + RADIUS;
  }

  /** Called by the water system once it knows the surface here. */
  setWater(topY: number, current: THREE.Vector3) {
    this.waterTop = topY;
    this.waterVel.copy(current);
    const feet = this.pos.y - this.halfHeight - RADIUS;
    const head = this.pos.y + this.halfHeight + RADIUS;
    this.submerged = clamp01((topY - feet) / Math.max(0.35, head - feet));
    this.headUnder = topY > this.pos.y + this.eyeY - 0.06;
    const wasSwimming = this.swimming;
    // You start swimming when your feet leave the bottom, not at a fixed depth.
    this.swimming = this.submerged > 0.72 && !this.grounded
      || this.submerged > 0.92;
    if (this.swimming && !wasSwimming) this.vel.multiplyScalar(0.55);
  }

  /** Riding a moving surface (a swaying floor, a raft, a truck bed). */
  ridePlatform(delta: THREE.Vector3) { this.platformDelta.add(delta); }

  private updateCamera(dt: number, fwdIn: number, strafeIn: number) {
    // head bob scales with actual speed, and stops in the air
    const moving = this.grounded && (Math.abs(fwdIn) + Math.abs(strafeIn)) > 0.01;
    const targetAmp = moving ? (this.sprinting ? 0.055 : this.crouched ? 0.018 : 0.032) : 0;
    this.bobAmp = damp(this.bobAmp, targetAmp, 7, dt);
    this.bob += dt * Math.max(0.6, this.speed) * (this.sprinting ? 2.05 : 2.4) * (moving ? 1 : 0.18);
    const targetEye = this.crouched ? EYE_CROUCH : EYE_STAND;
    this.eyeY = damp(this.eyeY, targetEye, 13, dt);
    // The legs soak up a landing: a quick sink, a slower recovery.
    this.landDipV += (-this.landDip * 170 - this.landDipV * 22) * dt;
    this.landDip = Math.max(0, this.landDip + this.landDipV * dt);
    this.shake = Math.max(0, this.shake - dt * (1.6 + this.shake * 1.1));
    this.shakeT += dt;
  }

  private updateCameraOnly(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 0.9);
    this.eyeY = damp(this.eyeY, 0.22, 2.2, dt);
    this.pitch = damp(this.pitch, -0.35, 1.4, dt);
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  /** Writes the final camera transform, including bob, shake and lean. */
  applyCamera(camera: THREE.PerspectiveCamera, dt: number, shakeScale = 1) {
    const e = this.eyePosition;
    const bobY = Math.sin(this.bob * 2) * this.bobAmp;
    const bobX = Math.cos(this.bob) * this.bobAmp * 0.85;
    this.right(_v2);
    camera.position.set(
      e.x + _v2.x * bobX, e.y + bobY - this.landDip, e.z + _v2.z * bobX);

    if (this.shake > 0.0005) {
      const s = this.shake * this.shake * 0.42 * shakeScale;
      const t = this.shakeT;
      camera.position.x += (Math.sin(t * 47.3) + Math.sin(t * 29.1) * 0.6) * s;
      camera.position.y += (Math.sin(t * 38.7 + 1.7) + Math.sin(t * 61.2) * 0.4) * s;
      camera.position.z += (Math.sin(t * 43.1 + 3.1) + Math.sin(t * 25.7) * 0.7) * s;
    }

    const roll = clamp(-this.vel.dot(this.right(_v)) * 0.008, -0.05, 0.05)
      + (this.shake > 0.001 ? Math.sin(this.shakeT * 31.0) * this.shake * 0.035 * shakeScale : 0);
    _q.setFromEuler(new THREE.Euler(this.pitch, this.yaw, roll, 'YXZ'));
    camera.quaternion.copy(_q);

    // subtle FOV push when sprinting or swept along by water
    const base = camera.userData.baseFov ?? camera.fov;
    camera.userData.baseFov = base;
    const target = base + (this.sprinting ? 6 : 0) + clamp(this.speed - 7, 0, 8) * 0.9;
    if (Math.abs(camera.fov - target) > 0.01) {
      camera.fov = damp(camera.fov, target, 6, dt);
      camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.phys.world.removeCharacterController(this.controller);
    this.phys.world.removeRigidBody(this.body);
  }
}

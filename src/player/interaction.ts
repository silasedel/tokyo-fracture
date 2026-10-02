import * as THREE from 'three';
import { Entity, F, GROUP, interactionGroups } from '../physics/entity';
import { PhysWorld, RAPIER } from '../physics/physworld';
import type { Player } from './player';
import type { Input } from '../core/input';
import type { Activation } from '../sim/activation';
import type { StructureSystem } from '../sim/structure';
import { clamp, clamp01, damp, lerp } from '../util/math';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _tv = new THREE.Vector3();
const _tw = new THREE.Vector3();

/** What a pair of human arms can do. Everything else follows from the physics. */
const GRIP_FORCE = 2600;        // N the hands can apply before an object slips
const LIFT_MASS = 62;           // kg that can be held clear of the ground
const DRAG_MASS = 620;          // kg that can still be shoved along the floor
const THROW_ENERGY = 150;       // J a full-strength throw imparts
const REACH = 3.2;
const STRIKE_REACH = 2.3;       // how far a swing can actually connect
const FIST_MASS = 3.2;          // kg of arm behind a bare punch
const FIST_SPEED = 8.5;         // m/s at the knuckles

export interface HeldInfo {
  entity: Entity | null;
  label: string;
  mass: number;
  dragging: boolean;
  strained: number;   // 0..1 how close to slipping
  material: string;
}

/** What the reticle is currently offering to do. */
export type AimVerb = '' | 'grab' | 'strike' | 'dig' | 'climb' | 'tear';

export class Interaction {
  held: Entity | null = null;
  holdDist = 1.9;
  /** Where the hands wanted the load last step, to know how fast that point moves. */
  private prevTarget = new THREE.Vector3();
  private prevHoldQ = new THREE.Quaternion(0, 0, 0, 0);
  private tracking = false;
  private holdQuat = new THREE.Quaternion();
  private rotating = false;
  private savedGroups = 0;
  private slip = 0;
  /**
   * Seconds since the grab, and how far the load was from the hands when it
   * began. Something taken by its far end — a sheet of ply, a scaffold board —
   * starts well outside the slip limit and has to be drawn in first.
   */
  private grabAge = 0;
  private grabErr = -1;
  private digProgress = new Map<number, number>();
  private digCooldown = 0;
  private digBuf: Entity[] = [];
  aimEntity: Entity | null = null;
  aimPoint = new THREE.Vector3();
  aimDist = 0;
  aimVerb: AimVerb = '';
  /** 0..1 wind-up on a throw, driven by pulling the wheel back. */
  charge = 0;
  private chargeIdle = 0;
  /** Set by the view model so a strike lands on the animation's contact frame. */
  pendingStrike = false;
  info: HeldInfo = { entity: null, label: '', mass: 0, dragging: false, strained: 0, material: '' };
  onDig: ((pos: THREE.Vector3, power: number, material: string) => void) | null = null;
  onGrab: ((e: Entity) => void) | null = null;
  onThrow: ((e: Entity, speed: number) => void) | null = null;
  /** Fired when a swing connects: position, energy in joules, material hit. */
  onStrikeHit: ((pos: THREE.Vector3, energy: number, material: string, broke: boolean) => void) | null = null;
  /** Asks the view model to play a swing of this length. Returns false if busy. */
  requestSwing: ((duration: number) => boolean) | null = null;

  constructor(
    public phys: PhysWorld,
    public player: Player,
    public activation: Activation,
    public structure: StructureSystem,
  ) {}

  /** Ray from the eye, used for both the reticle and grabbing. */
  probe(maxDist = REACH): { ent: Entity | null; point: THREE.Vector3; dist: number; normal: THREE.Vector3 } {
    const eye = this.player.eyePosition.clone();
    this.player.lookDir(_v);
    const hit = this.phys.world.castRayAndGetNormal(
      new RAPIER.Ray(eye, { x: _v.x, y: _v.y, z: _v.z }), maxDist, true,
      undefined, interactionGroups(GROUP.PLAYER, 0xffff),
      this.player.collider, this.player.body,
      (c) => c.handle !== this.held?.colliders[0]?.handle);
    if (!hit) return { ent: null, point: eye.addScaledVector(_v, maxDist), dist: maxDist, normal: new THREE.Vector3(0, 1, 0) };
    const ent = this.phys.entityOf(hit.collider.handle);
    const p = eye.clone().addScaledVector(_v, hit.timeOfImpact);
    return { ent, point: p, dist: hit.timeOfImpact, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) };
  }

  update(dt: number, input: Input) {
    this.digCooldown = Math.max(0, this.digCooldown - dt);
    this.swingCooldown = Math.max(0, this.swingCooldown - dt);

    if (!this.held) {
      const pr = this.probe();
      this.aimEntity = pr.ent;
      this.aimPoint.copy(pr.point);
      this.aimDist = pr.dist;
      this.aimVerb = this.verbFor(pr.ent, pr.dist);
    } else {
      this.aimEntity = this.held;
      this.aimVerb = 'strike';
    }

    // ---------------------------------------------------------------- wheel
    // Pulling the wheel back winds up a throw; pushing it forward lets the
    // wind-up down again, and once it is spent, walks the object away from you.
    const wheel = input.mouse.wheel;
    if (this.held) {
      if (wheel > 0) {
        this.charge = clamp01(this.charge + wheel * 0.24);
        this.chargeIdle = 0;
      } else if (wheel < 0) {
        if (this.charge > 0.001) { this.charge = clamp01(this.charge + wheel * 0.30); this.chargeIdle = 0; }
        else this.holdDist = clamp(this.holdDist - wheel * 0.18, 0.70, 2.6);
      }
      // A wind-up you never release relaxes, but slowly enough to aim with.
      this.chargeIdle += dt;
      if (this.chargeIdle > 0.75) this.charge = Math.max(0, this.charge - dt * 0.34);
      // Holding something far too heavy to throw cannot be wound up at all.
      if (this.held.mass > LIFT_MASS * 1.9) this.charge = 0;
    } else {
      this.charge = 0;
      if (wheel !== 0) this.holdDist = clamp(this.holdDist - wheel * 0.22, 1.1, 3.4);
    }

    // ------------------------------------------------------------- left click
    // Hold to carry. The button going down picks something up, keeping it down
    // keeps hold of it, and letting go lets go — a throw if you wound one up
    // first, otherwise simply dropping it where it is.
    if (input.mouse.leftPressed) {
      if (!this.held) {
        if (this.aimVerb === 'grab' || this.aimVerb === 'tear') {
          this.tryGrab();
          this.heldByButton = !!this.held;
        } else this.beginSwing();
      }
    } else if (input.mouse.left && !this.held && this.canRepeat()) {
      // Keep swinging while the button is down, the way you keep digging.
      this.beginSwing();
    }

    if (input.mouse.leftReleased && this.held && this.heldByButton) {
      if (this.charge > 0.02) this.throwHeld(this.charge);
      else this.release(false);
      this.heldByButton = false;
    }

    // ------------------------------------------------------------ right click
    // Swing whatever is in your hands — or your fists.
    if (input.mouse.rightPressed) this.beginSwing();

    // R + mouse rotates the held object; RMB held steadies it for placing.
    this.rotating = input.down('KeyR') && !!this.held;
    if (this.rotating) {
      _q2.setFromAxisAngle(_v.set(0, 1, 0), -input.mouse.dx * 3.2);
      this.holdQuat.premultiply(_q2);
      this.player.right(_v2);
      _q2.setFromAxisAngle(_v2, -input.mouse.dy * 3.2);
      this.holdQuat.premultiply(_q2);
      // cancel the look change caused by the same mouse motion
      this.player.look(-input.mouse.dx, -input.mouse.dy);
    }

    if (input.down('KeyF')) this.dig(dt, input.down('ShiftLeft'));

    if (this.held) this.driveHeld(dt, input.down('ShiftLeft'));
    this.updateInfo();
  }

  /** What the thing under the reticle invites you to do. */
  private verbFor(e: Entity | null, dist: number): AimVerb {
    if (!e || dist > REACH) return '';
    if (e.has(F.LADDER)) return 'climb';
    if (this.canGrab(e)) return 'grab';
    if (e.has(F.ATTACHED) && e.mass < 90) return 'tear';
    if (e.has(F.DIGGABLE) || e.mat.hardness < 0.3) return 'dig';
    if (e.has(F.BREAKABLE)) return 'strike';
    return '';
  }

  private swingCooldown = 0;
  /** True when the object in hand is being held up by the mouse button. */
  private heldByButton = false;
  private canRepeat() { return this.swingCooldown <= 0; }

  /**
   * A swing is a real movement of a real mass: the arm accelerates whatever is
   * in the hand, and how fast it can do that depends on how heavy that is. The
   * animation and the physics share one clock, so contact happens when the
   * hands reach the target, not on a timer of their own.
   */
  private beginSwing() {
    if (this.swingCooldown > 0) return;
    const m = this.held ? Math.max(0.4, this.held.mass) : FIST_MASS;
    // A 2 kg brick swings almost as fast as a fist; a 40 kg desk barely moves.
    const speed = FIST_SPEED * clamp(Math.sqrt(FIST_MASS / m), 0.20, 1.25);
    const dur = clamp(0.30 + m * 0.012, 0.30, 1.15);
    if (this.requestSwing && !this.requestSwing(dur)) return;
    this.swingCooldown = dur * 1.12;
    this.pendingStrike = true;
    this.swingSpeed = speed;
    this.player.vitals.stamina = Math.max(0, this.player.vitals.stamina - (this.held ? 1.6 + m * 0.03 : 0.8));
  }
  private swingSpeed = FIST_SPEED;

  /** Called by the view model on the animation's contact frame. */
  strike() {
    this.pendingStrike = false;
    const tool = this.held;
    const m = tool ? Math.max(0.4, tool.mass) : FIST_MASS;
    const v = this.swingSpeed * clamp01(0.45 + this.player.vitals.stamina / 120);
    const pr = this.probe(STRIKE_REACH);
    const target = pr.ent;
    if (!target) return;

    // The energy the swing can deliver, discounted by how much of the tool
    // actually concentrates on the contact: a sharp, hard, dense thing bites,
    // a mattress does not.
    const hardness = tool ? tool.mat.hardness : 0.42;
    const energy = 0.5 * m * v * v * (0.28 + hardness * 0.85);
    const before = target.integrity;

    if (target.has(F.DORMANT)) this.activation.wake(target);
    if (target.has(F.FROZEN)) this.phys.unfreeze(target);

    // Push whatever was hit, in proportion to the momentum behind the blow.
    this.player.lookDir(_v);
    if (target.body?.isDynamic()) {
      const imp = Math.min(m * v, 260);
      target.body.applyImpulseAtPoint(
        { x: _v.x * imp, y: _v.y * imp + imp * 0.06, z: _v.z * imp },
        { x: pr.point.x, y: pr.point.y, z: pr.point.z }, true);
      target.body.wakeUp();
    } else if (target.has(F.ATTACHED) && energy > 30) {
      this.breakAttachment(target);
    }

    if (target.has(F.BREAKABLE)) this.structure.impact(target, energy);
    // Soft ground yields to a blow the same way it yields to steady digging.
    if (target.has(F.DIGGABLE) || target.mat.hardness < 0.3) {
      this.digBlow(target, energy);
    }

    // A tool takes its own share of the impact, which is how things get used up.
    if (tool && tool.has(F.BREAKABLE)) {
      this.structure.impact(tool, energy * clamp(0.45 * (1 - tool.mat.hardness + 0.25), 0.1, 0.9));
      if (tool.has(F.DEAD)) {
        this.held = null;
        this.charge = 0;
        this.player.carryLoad = 0;
        this.player.carryAwkward = 0;
      }
    }

    const broke = target.has(F.DEAD) || target.integrity < before - 0.12;
    this.onStrikeHit?.(pr.point, energy, target.mat.id, broke);
  }

  /** A single blow's worth of excavation. */
  private digBlow(e: Entity, energy: number) {
    const key = e.id;
    const need = Math.max(2.2, e.volume * 11 * (0.4 + e.mat.hardness * 2.4));
    const cur = (this.digProgress.get(key) ?? 0) + energy * 0.030;
    if (cur >= need) {
      this.digProgress.delete(key);
      e.integrity = 0;
      this.structure.fail(e, true, 0);
    } else this.digProgress.set(key, cur);
  }

  private updateInfo() {
    const e = this.held;
    this.info.entity = e;
    if (!e) { this.info.label = ''; this.info.mass = 0; this.info.dragging = false; this.info.strained = 0; this.info.material = ''; return; }
    this.info.label = e.label || 'object';
    this.info.mass = e.mass;
    this.info.dragging = e.mass > LIFT_MASS;
    this.info.strained = this.slip;
    this.info.material = e.mat.id;
  }

  canGrab(e: Entity | null): boolean {
    if (!e || e.has(F.DEAD)) return false;
    if (e.has(F.STRUCTURAL) && !e.has(F.DORMANT)) return false;
    if (e.kind === 4 /* Vehicle */) return e.mass <= DRAG_MASS;
    if (e.has(F.DORMANT)) return e.mass <= DRAG_MASS;
    if (!e.body) return false;
    if (e.body.isFixed() && !e.has(F.FROZEN) && !e.has(F.DORMANT)) return false;
    return e.mass <= DRAG_MASS;
  }

  tryGrab() {
    const pr = this.probe();
    let e = pr.ent;
    if (!e) return;
    if (e.has(F.DORMANT)) { this.activation.wake(e); }
    else if (e.has(F.FROZEN)) this.phys.unfreeze(e);
    if (!this.canGrab(e)) {
      // A fixed thing that is merely bolted down can be torn loose if it is light.
      if (e.has(F.ATTACHED) && e.mass < 90) {
        this.breakAttachment(e);
      } else return;
    }
    if (!e.body || !e.body.isDynamic()) return;

    this.held = e;
    e.set(F.HELD);
    e.body.wakeUp();
    // The hands do the damping, relative to where they are going. Damping on
    // the body itself resists its speed over the ground and makes it lag.
    e.body.setLinearDamping(0.05);
    e.body.setAngularDamping(0.8);
    this.tracking = false;
    this.prevHoldQ.set(0, 0, 0, 0);
    this.grabAge = 0;
    this.grabErr = -1;
    e.body.enableCcd(true);
    this.savedGroups = e.colliders[0]?.collisionGroups() ?? 0;
    for (const c of e.colliders) c.setCollisionGroups(interactionGroups(GROUP.DEBRIS, 0xffff & ~GROUP.PLAYER));
    // Close enough that the hands are on it, far enough that it is not in your face.
    this.holdDist = clamp(e.radius * 0.95 + 0.42, 0.70, 1.55);
    // Keep the object's current orientation relative to the camera.
    _q.setFromEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));
    this.holdQuat.copy(_q).invert().multiply(e.quat);
    this.slip = 0;
    this.onGrab?.(e);
  }

  /** Rip something off a wall it was bolted to. */
  breakAttachment(e: Entity) {
    if (!e.attachedTo) return;
    const host = e.attachedTo;
    const i = host.supports.indexOf(e);
    if (i >= 0) host.supports.splice(i, 1);
    const j = e.supportedBy.indexOf(host);
    if (j >= 0) e.supportedBy.splice(j, 1);
    e.attachedTo = null;
    e.set(F.ATTACHED, false);
    e.set(F.DORMANT, false);
    this.phys.makeDynamic(e);
  }

  release(silent: boolean) {
    const e = this.held;
    if (!e) return;
    e.set(F.HELD, false);
    if (e.body) {
      e.body.setLinearDamping(0.06);
      e.body.setAngularDamping(0.22);
      e.body.enableCcd(e.mass > 250);
    }
    for (const c of e.colliders) c.setCollisionGroups(this.savedGroups || interactionGroups(GROUP.DEBRIS, 0xffff));
    this.held = null;
    this.tracking = false;
    this.prevHoldQ.set(0, 0, 0, 0);
    this.charge = 0;
    this.heldByButton = false;
    this.player.carryLoad = 0;
    this.player.carryAwkward = 0;
    void silent;
  }

  throwHeld(power = 1) {
    const e = this.held;
    if (!e || !e.body) return;
    if (power <= 0.02) { this.release(false); return; }
    // Energy-limited throw: light things fly, heavy things barely leave the hands.
    // A full wind-up is worth roughly three times a flick of the wrist.
    const eff = THROW_ENERGY * clamp01(this.player.vitals.stamina / 45)
      * (0.34 + clamp01(power) * 0.66) * (0.34 + clamp01(power) * 0.66) * 2.3;
    this.charge = 0;
    const v = Math.sqrt((2 * eff) / Math.max(0.35, e.mass));
    this.player.lookDir(_v).multiplyScalar(Math.min(v, 22));
    _v.add(_v2.set(this.player.vel.x, 0, this.player.vel.z));
    const speed = _v.length();
    this.release(true);
    e.body.setLinvel({ x: _v.x, y: _v.y, z: _v.z }, true);
    e.body.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 6 }, true);
    this.player.vitals.stamina = Math.max(0, this.player.vitals.stamina - 4 - power * 8);
    this.requestSwing?.(0.34);
    this.onThrow?.(e, speed);
  }

  /**
   * Carrying is a force problem, not a state. The hands pull the object toward
   * a point in front of the eyes with a limited force; heavy things sag to the
   * floor and become a drag, awkward things swing about, and anything that gets
   * wedged or torn away simply slips out of your grip.
   */
  private driveHeld(dt: number, steady: boolean) {
    const e = this.held!;
    if (!e.body || e.has(F.DEAD)) { this.held = null; return; }
    if (e.has(F.FROZEN)) this.phys.unfreeze(e);
    const body = e.body;
    const m = Math.max(0.2, e.mass);
    // Persistent accumulators — see the note in Forces.update. The hands push
    // with a freshly computed force every step, never a running total.
    body.resetForces(false);
    body.resetTorques(false);

    const lift = clamp01((LIFT_MASS * 1.6 - m) / (LIFT_MASS * 1.2));
    const dragging = m > LIFT_MASS;

    const eye = this.player.eyePosition;
    this.player.lookDir(_v);
    const dist = dragging ? clamp(this.holdDist + 0.5, 1.1, 2.2) : this.holdDist;
    _v2.copy(eye).addScaledVector(_v, dist);
    if (dragging) {
      // Too heavy to hold up: the target sinks toward the ground ahead of you.
      const groundY = this.player.pos.y - this.player.halfHeight - 0.34 + e.hy * 0.9;
      _v2.y = lerp(groundY, _v2.y, lift * 0.9);
    }

    // How fast the hold point itself is moving: the player's stride and the
    // turn of the head. The controller damps the load's speed *relative to
    // that*. Damping its speed over the ground instead held every carried thing
    // back by kd·v/kp — well over a metre at a jog, past the point of slipping
    // at a sprint — which is why loads used to trail behind with the arms
    // stretched out after them.
    if (!this.tracking) { this.prevTarget.copy(_v2); this.tracking = true; }
    _tv.copy(_v2).sub(this.prevTarget).divideScalar(Math.max(1e-3, dt));
    this.prevTarget.copy(_v2);
    if (_tv.lengthSq() > 900) _tv.setLength(30);      // the wheel moved the hold point: not motion

    const p = body.translation();
    _v3.set(_v2.x - p.x, _v2.y - p.y, _v2.z - p.z);
    const err = _v3.length();

    // Slip out of the grip if the object is jammed or torn away. Held on long
    // past this, the arms only end up stretched out after something that is
    // plainly stuck.
    // While it is still being drawn in, only let go if it gets further away
    // than it started: that is a snag, not a reach.
    this.grabAge += dt;
    if (this.grabErr < 0) this.grabErr = err;
    const maxErr = dragging ? 1.8 : 1.15;
    const limit = this.grabAge < 0.9 ? Math.max(maxErr, this.grabErr + 0.35) : maxErr;
    if (err > limit) { this.slip = 1; this.release(false); return; }
    this.slip = damp(this.slip, clamp01(err / limit), 8, dt);

    const lv = body.linvel();
    // Near-critically damped: kd ~ 2*sqrt(kp). Underdamping here reads as the
    // object bouncing around in front of your face.
    const kp = dragging ? 17 : 30;
    const kd = dragging ? 9.0 : 11.5;
    _v3.multiplyScalar(kp * m);
    _v3.x += (_tv.x - lv.x) * kd * m;
    _v3.y += (_tv.y - lv.y) * kd * m;
    _v3.z += (_tv.z - lv.z) * kd * m;
    // hold against gravity
    _v3.y += 9.81 * m * (dragging ? 0.35 : 1.0);

    // Cap by both grip strength and a sane acceleration, so a light object is
    // never flung by the controller.
    const maxF = Math.min(
      GRIP_FORCE * (dragging ? 1.5 : 1.0) * clamp01(0.35 + this.player.vitals.stamina / 90),
      m * 55);
    if (_v3.length() > maxF) _v3.setLength(maxF);
    body.addForce({ x: _v3.x, y: _v3.y, z: _v3.z }, true);

    // Orientation: hold it where you put it, fighting its rotational inertia.
    _q.setFromEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));
    _q.multiply(this.holdQuat);
    // angular velocity of the hold orientation itself, so turning carries the load round
    if (this.tracking && this.prevHoldQ.lengthSq() > 0.5) {
      _q2.copy(this.prevHoldQ).invert().premultiply(_q);
      if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
      const a = 2 * Math.acos(clamp(_q2.w, -1, 1));
      const sn = Math.sqrt(Math.max(1e-8, 1 - _q2.w * _q2.w));
      _tw.set(_q2.x / sn, _q2.y / sn, _q2.z / sn).multiplyScalar(Math.min(a / Math.max(1e-3, dt), 12));
    } else _tw.set(0, 0, 0);
    this.prevHoldQ.copy(_q);
    const r = body.rotation();
    _q2.set(r.x, r.y, r.z, r.w).invert().premultiply(_q);
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    const ang = 2 * Math.acos(clamp(_q2.w, -1, 1));
    const s = Math.sqrt(Math.max(1e-8, 1 - _q2.w * _q2.w));
    _v.set(_q2.x / s, _q2.y / s, _q2.z / s).multiplyScalar(ang);
    const av = body.angvel();
    // Large, unbalanced objects resist being aimed. Work in angular velocity so
    // the torque is always proportional to what the object actually needs.
    const control = clamp01(1 - e.awkwardness * 0.55) * (steady ? 1.35 : 1.0);
    const inertia = Math.max(0.02, m * e.radius * e.radius * 0.42);
    const wanted = Math.min(ang * 8, 6.5) * control;
    if (_v.lengthSq() > 1e-8) _v.setLength(wanted); else _v.set(0, 0, 0);
    _v.add(_tw);
    _v.x = (_v.x - av.x) * inertia * 11;
    _v.y = (_v.y - av.y) * inertia * 11;
    _v.z = (_v.z - av.z) * inertia * 11;
    const maxT = inertia * 55 * control;
    if (_v.length() > maxT) _v.setLength(maxT);
    body.addTorque({ x: _v.x, y: _v.y, z: _v.z }, true);

    // Belt and braces: a held object never exceeds a speed a person could give it.
    const sp2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
    if (sp2 > 400) { const k = 20 / Math.sqrt(sp2); body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true); }
    const asp = av.x * av.x + av.y * av.y + av.z * av.z;
    if (asp > 225) { const k = 15 / Math.sqrt(asp); body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true); }

    // The load slows you down and makes jumping harder.
    this.player.carryLoad = m;
    this.player.carryAwkward = e.awkwardness;
    if (!steady && this.player.vitals.stamina > 0) {
      this.player.vitals.stamina -= dt * clamp(m / 55, 0, 3.2);
    }
  }

  /**
   * Digging is the same universal interaction as everything else: push material
   * out of the way. Bare hands barely shift soil; a heavy, hard object in your
   * grip does it far faster. What you dig out becomes real debris.
   */
  private dig(dt: number, hard: boolean) {
    const tool = this.held
      ? clamp(0.45 + (this.held.mass * this.held.mat.hardness) * 0.028, 0.45, 3.4)
      : 0.42;
    const power = tool * (hard ? 1.35 : 1) * dt;

    const pr = this.probe(2.6);
    if (!pr.ent) return;
    const target = pr.point;

    // 1. Shove loose debris out of the way.
    this.player.lookDir(_v);
    let moved = 0;
    const near = this.phys.queryBall(target, 0.72, this.digBuf, 40);
    for (const e of near) {
      if (e === this.held || e.has(F.DEAD) || e.kind === 5 /* Player */) continue;
      if (e.has(F.DORMANT)) this.activation.wake(e);
      if (e.has(F.FROZEN)) this.phys.unfreeze(e);
      if (!e.body?.isDynamic()) continue;
      if (e.mass > 340 * tool) continue;
      const imp = clamp(power * 900 / Math.max(1, e.mass * 0.15), 0, 42) * Math.min(1, 60 / e.mass);
      e.body.applyImpulse({ x: _v.x * imp, y: (Math.abs(_v.y) * 0.5 + 0.45) * imp, z: _v.z * imp }, true);
      e.body.wakeUp();
      if (++moved >= 14) break;
    }

    // 2. Break apart diggable material (soil, rubble) into real loose pieces.
    const e = pr.ent;
    if (e.has(F.DIGGABLE) || e.mat.hardness < 0.3) {
      const key = e.id;
      // Bare hands take several seconds per block; something heavy and hard in
      // your grip cuts that to a fraction.
      const need = Math.max(2.2, e.volume * 11 * (0.4 + e.mat.hardness * 2.4));
      const cur = (this.digProgress.get(key) ?? 0) + power;
      if (cur >= need) {
        this.digProgress.delete(key);
        if (e.has(F.DORMANT)) this.activation.wake(e);
        e.integrity = 0;
        this.structure.fail(e, true, 0);
      } else this.digProgress.set(key, cur);
    }

    if (this.digCooldown <= 0 && (moved > 0 || e.mat.hardness < 0.4)) {
      this.digCooldown = 0.16;
      this.onDig?.(target, tool, e.mat.id);
    }
  }
}

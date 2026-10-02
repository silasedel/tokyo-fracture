import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../util/math';
import { buildBody, handSide } from './body';

/**
 * A procedurally built, procedurally animated character.
 *
 * The same rig serves both views: in first person only the arms are attached to
 * the camera, in third person the whole body stands in the world. There are no
 * animation clips — every pose is computed from what the player is physically
 * doing, so it stays in sync with the simulation even when the simulation does
 * something no animator anticipated (swept off a roof, half submerged, dragging
 * a filing cabinet through a flooded hallway).
 *
 * The body itself is a skinned mesh generated in body.ts. The joints below are
 * its bones, so posing them bends the surface.
 *
 * Bone convention: every segment runs along -Z from its joint, so a rotation
 * of 0 points the limb forward, -PI/2 points it straight down and +PI/2 raises
 * it overhead.
 */

export interface RigParts {
  root: THREE.Group;
  /** Present only on the full body. */
  hips: THREE.Object3D | null;
  chest: THREE.Object3D | null;
  head: THREE.Object3D | null;
  arm: [ArmChain, ArmChain];
  leg: [LegChain, LegChain] | null;
  /** Standing height of the hips joint. */
  hipHeight: number;
}

export interface ArmChain {
  shoulder: THREE.Object3D;
  elbow: THREE.Object3D;
  wrist: THREE.Object3D;
  /** The knuckle row; its children are the fingers, little to index. */
  fingers: THREE.Object3D;
  thumb: THREE.Object3D;
  side: 1 | -1;
  /** Bone lengths, shoulder to elbow and elbow to wrist. */
  upper: number;
  fore: number;
}

export interface LegChain {
  hip: THREE.Object3D;
  knee: THREE.Object3D;
  ankle: THREE.Object3D;
  side: 1 | -1;
}

// First person: slightly longer than life, the way every viewmodel is, so the
// hands can actually reach what the physics is holding in front of you.
const FP_UPPER = 0.32;
const FP_FORE = 0.30;
// Third person: an ordinary adult's arm.
const TP_UPPER = 0.29;
const TP_FORE = 0.265;

export function buildRig(full: boolean): RigParts {
  const body = buildBody({
    full,
    upper: full ? TP_UPPER : FP_UPPER,
    fore: full ? TP_FORE : FP_FORE,
    // Low, wide and a little ahead of the eye: the forearms come in diagonally
    // from the bottom corners rather than standing up in the middle of the view.
    fpShoulders: [new THREE.Vector3(-0.4, -0.45, -0.06), new THREE.Vector3(0.4, -0.45, -0.06)],
  });
  const mkArm = (a: (typeof body.arms)[number]): ArmChain => ({
    shoulder: a.shoulder, elbow: a.elbow, wrist: a.hand.wrist,
    fingers: a.hand.fingers, thumb: a.hand.thumb, side: a.side, upper: a.upper, fore: a.fore,
  });
  const arm: [ArmChain, ArmChain] = [mkArm(body.arms[0]), mkArm(body.arms[1])];
  const L = body.legs;
  const leg: [LegChain, LegChain] | null = L ? [L[0], L[1]] : null;
  for (const m of body.meshes) {
    m.castShadow = full;
    m.receiveShadow = full;
  }
  return { root: body.root, hips: body.hips, chest: body.chest, head: body.head, arm, leg, hipHeight: body.hipHeight };
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/** Everything the animator needs to know about what the player is doing. */
export interface PoseState {
  dt: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** -1..1 strafe lean. */
  strafe: number;
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
  swimming: boolean;
  submerged: number;
  climbing: boolean;
  airTime: number;
  /** 0..1 progress through a swing, or -1 when not swinging. */
  swing: number;
  /** 0..1 throw wind-up. */
  charge: number;
  /** 0..1 how hard the hands are gripping something. */
  grip: number;
  /** Where the hands should be, in the rig's own space. Null = free. */
  holdL: THREE.Vector3 | null;
  holdR: THREE.Vector3 | null;
  /** Something grabbable within reach, in the rig's space: the hand lifts toward it. */
  reach: THREE.Vector3 | null;
  /** Walk cycle phase, shared with the camera bob so footfalls line up. */
  phase: number;
  pitch: number;
  hurt: number;
}

const _tmp = new THREE.Vector3();
const _l = new THREE.Vector3();
const _r = new THREE.Vector3();
const _w = new THREE.Vector3();
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Two-bone IK in the rig's local space. Returns shoulder/elbow angles. */
function solveArm(arm: ArmChain, targetLocal: THREE.Vector3, poleOut: number) {
  const U = arm.upper, F = arm.fore;
  arm.shoulder.updateMatrix();
  // Target relative to the shoulder joint, in the shoulder's parent frame.
  _tmp.copy(targetLocal).sub(arm.shoulder.position);
  const dist = clamp(_tmp.length(), 0.08, U + F - 0.004);
  _tmp.normalize();

  // Elbow angle from the law of cosines.
  const c = clamp((U * U + F * F - dist * dist) / (2 * U * F), -1, 1);
  const elbowBend = Math.PI - Math.acos(c);
  // Shoulder must aim a little off the target to compensate for the bend.
  const c2 = clamp((U * U + dist * dist - F * F) / (2 * U * dist), -1, 1);
  const off = Math.acos(c2);

  // Aim: yaw then pitch, in the -Z forward convention. The shoulder aims BELOW
  // the target and the forearm folds up to meet it, which puts the elbow under
  // the line of the arm — the way a human elbow actually hangs. Solving it the
  // other way up drives the elbow into the camera.
  const yaw = Math.atan2(-_tmp.x, -_tmp.z);
  const pitch = Math.asin(clamp(_tmp.y, -1, 1));
  arm.shoulder.rotation.set(pitch - off, yaw, poleOut * 0.5 * arm.side, 'YXZ');
  arm.elbow.rotation.set(elbowBend, 0, 0);
  return elbowBend;
}

/** Height of the ankle joint above the sole when standing. */
const ANKLE_H = 0.07;
const _foot = new THREE.Vector3();
const _lt = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _lk = new THREE.Vector3();
const _lm = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _FWD = new THREE.Vector3(0, 0, -1);
const _ANKLE_REST = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _XA = new THREE.Vector3(1, 0, 0);

/**
 * Two-bone IK for a leg. The target is the ankle, in the rig root's space; the
 * thigh is aimed so the knee bends forward over the foot.
 */
function solveLeg(l: LegChain, hips: THREE.Object3D, targetRoot: THREE.Vector3) {
  const A = l.knee.position.length(), Bn = l.ankle.position.length();
  hips.updateMatrix();
  _lm.copy(hips.matrix).invert();
  _lt.copy(targetRoot).applyMatrix4(_lm);
  _ld.copy(_lt).sub(l.hip.position);
  const dist = clamp(_ld.length(), 0.15, A + Bn - 0.003);
  _ld.normalize();
  const flex = Math.PI - Math.acos(clamp((A * A + Bn * Bn - dist * dist) / (2 * A * Bn), -1, 1));
  const alpha = Math.acos(clamp((A * A + dist * dist - Bn * Bn) / (2 * A * dist), -1, 1));
  // Knees point forward, and a touch out.
  _lp.copy(_FWD).addScaledVector(_XA, 0.12 * l.side).addScaledVector(_ld, -_FWD.dot(_ld)).normalize();
  _lk.copy(_ld).multiplyScalar(Math.cos(alpha)).addScaledVector(_lp, Math.sin(alpha));
  const x = Math.asin(clamp(_lk.y, -1, 1));
  const y = Math.atan2(-_lk.x, -_lk.z);
  // Roll the thigh so the knee's bend plane contains the pole.
  const upX = Math.sin(y) * Math.sin(x), upY = Math.cos(x), upZ = Math.cos(y) * Math.sin(x);
  const rtX = Math.cos(y), rtZ = -Math.sin(y);
  const z = Math.atan2(-(_lp.x * rtX + _lp.z * rtZ), _lp.x * upX + _lp.y * upY + _lp.z * upZ);
  l.hip.rotation.set(x, y, z, 'YXZ');
  l.knee.rotation.set(-flex, 0, 0);
}

/** Keep a foot level on the ground whatever the leg above it is doing. */
function flatFoot(l: LegChain, hips: THREE.Object3D, pitch: number) {
  // parent orientation of the ankle, relative to the rig root
  _q1.copy(hips.quaternion).multiply(l.hip.quaternion).multiply(l.knee.quaternion);
  _q2.setFromAxisAngle(_XA, pitch);
  l.ankle.quaternion.copy(_q1.invert()).multiply(_ANKLE_REST).multiply(_q2);
}

const _hf = new THREE.Vector3();
const _hd = new THREE.Vector3();
const _hx = new THREE.Vector3();
const _hz = new THREE.Vector3();
const _hm = new THREE.Matrix4();
const _hq = new THREE.Quaternion();
const _hp = new THREE.Quaternion();
const _hw = new THREE.Quaternion();
const _he = new THREE.Euler();
/** Orientation of a hand whose fingers point along `fingers` with its back toward `back`. */
function handFrame(fingers: THREE.Vector3, back: THREE.Vector3, out: THREE.Quaternion) {
  fingers.normalize();
  back.addScaledVector(fingers, -back.dot(fingers)).normalize();
  _hz.copy(fingers).negate();
  _hx.crossVectors(back, _hz);
  _hm.makeBasis(_hx, back, _hz);
  return out.setFromRotationMatrix(_hm);
}

const _pm = new THREE.Matrix4();
/** A point in the rig root's space, re-expressed in the shoulder's parent frame. */
function rootToShoulderParent(rig: RigParts, arm: ArmChain, p: THREE.Vector3, out: THREE.Vector3) {
  const parent = arm.shoulder.parent;
  if (!parent || parent === rig.root) return out.copy(p);
  parent.updateWorldMatrix(true, false);
  _pm.copy(parent.matrixWorld).invert().multiply(rig.root.matrixWorld);
  return out.copy(p).applyMatrix4(_pm);
}

/**
 * Fingers from a relaxed open hand (0) to a fist (1). A resting hand is not a
 * claw: the index is nearly straight and each finger toward the little one is
 * bent a little more; the middle joints bend most, the last joints least; the
 * thumb lies along the index and only swings across the palm as the hand shuts.
 */
function setFingers(arm: ArmChain, curl: number, spread = 0) {
  const hs = handSide(arm.side);
  const c = clamp01(curl);
  arm.fingers.rotation.x = -0.08 * c;                     // the palm cups as it closes
  for (let i = 0; i < arm.fingers.children.length; i++) {
    const f = arm.fingers.children[i];
    const k = 1 + (3 - i) * 0.14;                          // index 1.0 .. little 1.42
    f.rotation.x = -Math.min(1.62, (0.09 + c * 1.38) * k);
    // an open hand fans a little; a closing one gathers its fingers in
    f.rotation.y = (0.035 + spread * 0.05) * (i - 1.5) * -hs * (1 - c);
    const pip = Math.min(1.8, (0.14 + c * 1.5) * (0.92 + (3 - i) * 0.07));
    const tip = f.userData.tip as THREE.Object3D | undefined;
    const dist = f.userData.dist as THREE.Object3D | undefined;
    if (tip) tip.rotation.x = -pip;
    if (dist) dist.rotation.x = -pip * 0.6;
  }
  arm.thumb.rotation.set(-(0.26 + c * 0.55), (-0.38 + c * 0.72) * hs, (0.28 + c * 0.32) * hs, 'YXZ');
  const t = arm.thumb.userData.tip as THREE.Object3D | undefined;
  const td = arm.thumb.userData.dist as THREE.Object3D | undefined;
  if (t) t.rotation.x = -(0.06 + c * 0.6);
  if (td) td.rotation.x = -(0.1 + c * 0.75);
}

/**
 * Smoothed pose channels, kept per rig so transitions never pop.
 *
 * First person drives the hands: every state names where the hands should be in
 * front of the face and the arms are solved to reach there, which is the only
 * way to keep them reliably on screen at any field of view. Third person drives
 * the joints, because at that distance a swing reads better as a whole-body
 * rotation than as a hand trajectory.
 */
export class Poser {
  private sw = 0;
  private lean = 0;
  private breathe = 0;
  private curlL = 0;
  private curlR = 0;
  private bobY = 0;
  private crouchK = 0;
  private tgtL = new THREE.Vector3(-0.3, -0.405, -0.47);
  private tgtR = new THREE.Vector3(0.3, -0.405, -0.47);
  private reachK = 0;
  private reachAt = new THREE.Vector3();
  private hasL = 0;
  private hasR = 0;

  constructor(public rig: RigParts, public firstPerson: boolean) {}

  update(s: PoseState) {
    const dt = Math.min(0.05, s.dt);
    this.breathe += dt * (1.15 + s.speed * 0.13);
    const run = clamp01(s.speed / 6.4);
    this.sw = damp(this.sw, s.grounded && !s.swimming ? run : 0, 7, dt);
    this.lean = damp(this.lean, clamp(s.strafe, -1, 1), 6, dt);
    const [aL, aR] = this.rig.arm;
    const ph = s.phase;
    const breath = Math.sin(this.breathe) * 0.012;

    this.hasL = damp(this.hasL, s.holdL ? 1 : 0, 14, dt);
    this.hasR = damp(this.hasR, s.holdR ? 1 : 0, 14, dt);

    if (this.firstPerson) this.poseHands(s, dt, ph, breath);
    else this.poseJoints(s, dt, ph, breath);

    // ---- fingers ---------------------------------------------------------
    const swing = s.swing;
    const gripT = clamp01(Math.max(s.charge * 0.95, swing >= 0 ? 0.9 : 0));
    // A relaxed hand is mostly open; a running one closes into a loose fist; a
    // climbing one grips the rungs.
    const dash = s.sprinting ? this.sw : 0;
    const idle = (this.firstPerson ? 0.1 : 0.3) + dash * 0.42 + (s.climbing ? 0.6 : 0)
      + Math.sin(this.breathe * 0.7) * 0.025;
    const reachOpen = this.firstPerson ? this.reachK : 0;
    this.curlL = damp(this.curlL, this.hasL > 0.4 ? 0.85 : Math.max(gripT * 0.5, idle), 13, dt);
    this.curlR = damp(this.curlR, this.hasR > 0.4 ? 0.85 : Math.max(gripT, idle * (1 - reachOpen)), 13, dt);
    setFingers(aL, this.curlL, 1 - this.curlL);
    setFingers(aR, this.curlR, 1 - this.curlR + reachOpen);
  }

  // ------------------------------------------------------------ first person

  private poseHands(s: PoseState, dt: number, ph: number, breath: number) {
    const [aL, aR] = this.rig.arm;
    const amp = this.sw * (s.crouched ? 0.6 : 1);
    const dash = s.sprinting ? this.sw : 0;
    const air = s.grounded ? 0 : 1;
    const drop = clamp01(s.airTime) * 0.06;
    // Walking, the hands swing a little against the stride; sprinting, they pump
    // in arcs — forward and up, back and down — as a runner's do.
    const swL = Math.sin(ph), swR = -Math.sin(ph);
    const zL = -swL * (0.045 * amp + 0.07 * dash), zR = -swR * (0.045 * amp + 0.07 * dash);
    const yL = Math.max(0, swL) * 0.07 * dash + Math.sin(ph * 2) * 0.018 * amp;
    const yR = Math.max(0, swR) * 0.07 * dash + Math.sin(ph * 2) * 0.018 * amp;

    // Resting: low in the lower corners of the view, fingers pointing on ahead.
    const restY = -0.405 + breath - (s.crouched ? 0.03 : 0) + drop * air - dash * 0.03;
    const restZ = -0.47;
    _l.set(-0.30 - this.lean * 0.03 + dash * 0.05, restY + yL, restZ + zL);
    _r.set(0.30 - this.lean * 0.03 - dash * 0.05, restY + yR, restZ + zR);

    // Something within reach that could be picked up: the near hand lifts
    // toward it, open, before the grab.
    this.reachK = damp(this.reachK, s.reach && !s.holdR ? 1 : 0, 9, dt);
    if (s.reach) this.reachAt.copy(s.reach);
    if (this.reachK > 0.001) {
      _w.copy(this.reachAt);
      _w.set(lerp(0.3, _w.x, 0.35), lerp(restY, _w.y, 0.3), lerp(restZ, _w.z, 0.25));
      _w.y = Math.min(_w.y, -0.2);
      _r.lerp(_w, this.reachK);
    }

    if (s.swimming) {
      const p = ph * 1.5;
      _l.set(-0.235 - Math.sin(p) * 0.07, -0.10 + Math.cos(p) * 0.12, -0.40 - Math.sin(p) * 0.09);
      _r.set(0.235 + Math.sin(p + Math.PI) * 0.07, -0.10 + Math.cos(p + Math.PI) * 0.12, -0.40 - Math.sin(p + Math.PI) * 0.09);
    } else if (s.climbing) {
      const p = ph * 1.3;
      _l.set(-0.20, 0.06 + Math.sin(p) * 0.16, -0.33);
      _r.set(0.20, 0.06 + Math.sin(p + Math.PI) * 0.16, -0.33);
    }

    // Carrying: both hands go to the object.
    if (s.holdL) _l.lerp(s.holdL, this.hasL);
    if (s.holdR) _r.lerp(s.holdR, this.hasR);

    // Winding up a throw pulls the right hand back past the ear.
    if (s.charge > 0.001) {
      _w.set(0.30, 0.055, 0.075);
      _r.lerp(_w, clamp01(s.charge));
      _w.set(-0.235, -0.055, -0.40);
      _l.lerp(_w, clamp01(s.charge) * 0.7);
    }

    // The swing itself: back, up, then down and across the centre of the view.
    if (s.swing >= 0) {
      const t = clamp01(s.swing);
      const wind = smooth(clamp01(t / 0.34));
      const snap = clamp01((t - 0.30) / 0.22);
      const sn = snap * snap * (3 - 2 * snap);
      const rec = smooth(clamp01((t - 0.52) / 0.48));
      const w = 1 - rec * 0.92;
      // Three-point arc, blended by phase.
      _w.set(
        lerp(lerp(0.27, 0.34, wind), -0.05, sn),
        lerp(lerp(-0.16, 0.19, wind), -0.32, sn),
        lerp(lerp(-0.30, -0.04, wind), -0.52, sn));
      _r.lerp(_w, w);
      _w.set(-0.235, -0.15 + wind * 0.05, -0.33);
      _l.lerp(_w, w * 0.45);
    }

    // Trailing: the hands lag a frame or two behind the view.
    this.tgtL.lerp(_l, 1 - Math.exp(-26 * dt));
    this.tgtR.lerp(_r, 1 - Math.exp(-26 * dt));
    solveArm(aL, this.tgtL, 0.85);
    solveArm(aR, this.tgtR, 0.85);
    // Wrists. A hand is held by where it points in the view, not by joint
    // angles, so it looks right whatever the arm above it had to do to get
    // there: at rest the fingers point forward, a little in and down, with the
    // back of the hand turned up toward the eye; carrying, the palms press onto
    // the load from either side. Swinging or winding up, the wrist locks to
    // the arm instead.
    const busy = Math.max(s.swing >= 0 ? 1 : 0, clamp01(s.charge));
    this.poseWrist(aL, s, this.hasL, busy);
    this.poseWrist(aR, s, this.hasR, busy);
  }

  private poseWrist(a: ArmChain, s: PoseState, hold: number, busy: number) {
    const sd = a.side;
    // Seen from your own eyes a relaxed hand shows its back: palm down, rolled
    // a little onto its outer edge so the thumb rides slightly higher.
    handFrame(_hf.set(-0.08 * sd, -0.3, -1), _hd.set(0.42 * sd, 1, 0.3), _hq);
    if (hold > 0.001) {
      // The back of each hand faces away from the other one.
      const mine = sd > 0 ? s.holdR : s.holdL, other = sd > 0 ? s.holdL : s.holdR;
      if (mine && other && mine.distanceToSquared(other) > 1e-4) _hd.copy(mine).sub(other);
      else _hd.set(sd, 0, 0);
      handFrame(_hf.set(0, -0.28, -1), _hd, _hw);
      _hq.slerp(_hw, clamp01(hold));
    }
    // Into the wrist's own frame: undo everything above it.
    _hp.copy(this.rig.root.quaternion).multiply(a.shoulder.quaternion).multiply(a.elbow.quaternion);
    _hq.premultiply(_hp.invert());
    if (busy > 0.001) {
      _he.set(-0.1, 0, 1.15 * sd, 'XYZ');
      _hw.setFromEuler(_he);
      _hq.slerp(_hw, clamp01(busy));
    }
    a.wrist.quaternion.copy(_hq);
  }

  // ------------------------------------------------------------ third person

  private poseJoints(s: PoseState, dt: number, ph: number, breath: number) {
    const [aL, aR] = this.rig.arm;
    const air = s.grounded ? 0 : 1;

    // ---- body first, so the arms are solved against this frame's torso ----
    if (this.rig.hips && this.rig.chest && this.rig.leg) {
      const hips = this.rig.hips, chest = this.rig.chest;
      const [lL, lR] = this.rig.leg;
      const crouch = s.crouched ? 0.34 : 0;
      this.bobY = damp(this.bobY, -crouch, 10, dt);
      // Weight drops onto each foot as it lands: two dips per stride.
      const bob = -Math.abs(Math.cos(ph)) * 0.035 * this.sw + 0.018 * this.sw;
      const dash = s.sprinting ? this.sw : 0;
      this.crouchK = damp(this.crouchK, s.crouched ? 1 : 0, 10, dt);
      hips.position.y = this.rig.hipHeight + this.bobY + bob - clamp01(s.submerged) * 0.05;
      // Crouching sits the hips back over the heels and folds the chest forward
      // to balance them; sprinting leans the whole body into the run. (A
      // positive pitch on these bones tips the top backward.)
      hips.position.z = this.crouchK * 0.08;
      hips.rotation.set(
        -(this.sw * 0.05 + dash * 0.1 + this.crouchK * 0.3) - (s.swimming ? 1.15 : 0),
        Math.sin(ph) * 0.07 * this.sw, Math.cos(ph) * 0.04 * this.sw + this.lean * 0.09, 'YXZ');
      chest.rotation.set(
        clamp(s.pitch * 0.3, -0.5, 0.5) - (this.sw * 0.06 + dash * 0.12 + this.crouchK * 0.22) + (s.swimming ? 0.4 : 0) - s.hurt * 0.25,
        -Math.sin(ph) * 0.13 * this.sw - this.lean * 0.1, -this.lean * 0.1 - Math.cos(ph) * 0.03 * this.sw, 'YXZ');
      if (this.rig.head) {
        this.rig.head.rotation.set(
          clamp(s.pitch * 0.62, -0.75, 0.75) + (s.swimming ? 0.55 : 0) + this.crouchK * 0.4 + dash * 0.15,
          Math.sin(ph) * 0.05 * this.sw + this.lean * 0.12, -this.lean * 0.05, 'YXZ');
      }

      if (s.swimming) {
        for (const [l, o] of [[lL, 0], [lR, Math.PI]] as const) {
          const k = Math.sin(ph * 1.6 + o) * 0.5;
          // the legs trail straight out behind the body and kick
          l.hip.rotation.set(-Math.PI / 2 + k * 0.4, 0, 0.03 * l.side, 'YXZ');
          l.knee.rotation.x = -(0.2 + Math.max(0, k) * 0.6);
          l.ankle.rotation.x = -0.5;
        }
      } else if (!s.grounded) {
        // Tucked in the air: one knee up, the other trailing.
        lL.hip.rotation.set(-Math.PI / 2 + 0.45, 0, 0.03, 'YXZ');
        lR.hip.rotation.set(-Math.PI / 2 - 0.1, 0, -0.03, 'YXZ');
        lL.knee.rotation.x = -0.95; lR.knee.rotation.x = -0.35;
        lL.ankle.rotation.x = 0.3; lR.ankle.rotation.x = 0.15;
      } else {
        // Feet are placed, not swung: each ankle has a target on the ground
        // and the leg is solved to reach it, so a crouch bends the knees and a
        // stride plants the foot instead of dragging it through the pavement.
        const stride = Math.min(0.4, 0.07 + this.sw * (s.sprinting ? 0.36 : 0.3)) * (s.crouched ? 0.6 : 1) * this.sw;
        const lift = (s.sprinting ? 0.2 : 0.12) * this.sw;
        for (const [l, o] of [[lL, 0], [lR, Math.PI]] as const) {
          const p = ph + o;
          const fwd = Math.sin(p) * stride;
          const up = Math.max(0, Math.cos(p)) * lift;
          _foot.set(
            l.hip.position.x * 1.08 + this.lean * 0.04,
            ANKLE_H + up,
            -fwd);
          solveLeg(l, hips, _foot);
          // Heel strike toe-up, push off toe-down.
          const roll = this.sw * (0.25 * Math.max(0, Math.sin(p)) * Math.max(0, -Math.cos(p)) * 2
            - 0.35 * Math.max(0, -Math.sin(p)) * Math.max(0, Math.cos(p)) * 2);
          flatFoot(l, hips, roll);
        }
      }
    }

    // ---- arms --------------------------------------------------------------
    const amp = this.sw * (s.sprinting ? 1.35 : 1.0) * (s.crouched ? 0.6 : 1);
    const swingL = Math.sin(ph + Math.PI) * amp;   // arms swing against their legs
    const swingR = Math.sin(ph) * amp;
    const crouchTuck = s.crouched ? 0.22 : 0;

    const poseArm = (a: ArmChain, sv: number, has: number, target: THREE.Vector3) => {
      a.shoulder.rotation.set(
        -1.47 + crouchTuck + sv * 0.55 + breath + air * 0.35,
        -this.lean * 0.18 * a.side, (0.1 + breath) * a.side, 'YXZ');
      // A hanging arm is never locked straight; it bends more as it swings forward.
      a.elbow.rotation.set(0.22 + Math.max(0, sv) * 0.55 + (s.sprinting ? 0.9 : 0) * this.sw + air * 0.3, 0, 0);
      a.wrist.rotation.set(0.08, 0, 0);
      if (s.swimming) {
        const p = ph * 0.9 + (a.side > 0 ? 0 : Math.PI);
        const stroke = Math.sin(p);
        a.shoulder.rotation.set(-0.15 + stroke * 1.15, -0.30 * a.side, 0.22 * a.side, 'YXZ');
        a.elbow.rotation.x = 0.55 + Math.max(0, -stroke) * 0.95;
      } else if (s.climbing) {
        const p = ph * 1.1 + (a.side > 0 ? 0 : Math.PI);
        a.shoulder.rotation.set(1.15 + Math.sin(p) * 0.45, -0.12 * a.side, 0.18 * a.side, 'YXZ');
        a.elbow.rotation.x = 0.55 + Math.max(0, Math.sin(p)) * 0.6;
      }
      if (has > 0.01) {
        const kx = a.shoulder.rotation.x, ky = a.shoulder.rotation.y, kz = a.shoulder.rotation.z;
        const ke = a.elbow.rotation.x;
        solveArm(a, rootToShoulderParent(this.rig, a, target, _w), 0.55);
        if (has < 0.999) {
          a.shoulder.rotation.x = lerp(kx, a.shoulder.rotation.x, has);
          a.shoulder.rotation.y = lerp(ky, a.shoulder.rotation.y, has);
          a.shoulder.rotation.z = lerp(kz, a.shoulder.rotation.z, has);
          a.elbow.rotation.x = lerp(ke, a.elbow.rotation.x, has);
        }
      }
    };
    if (s.holdL) this.tgtL.lerp(s.holdL, 1 - Math.exp(-22 * dt));
    if (s.holdR) this.tgtR.lerp(s.holdR, 1 - Math.exp(-22 * dt));
    poseArm(aL, swingL, this.hasL, this.tgtL);
    poseArm(aR, swingR, this.hasR, this.tgtR);

    if (s.charge > 0.001) {
      const c = clamp01(s.charge);
      aR.shoulder.rotation.x = lerp(aR.shoulder.rotation.x, 0.55, c);
      aR.shoulder.rotation.y = lerp(aR.shoulder.rotation.y, 0.50, c);
      aR.elbow.rotation.x = lerp(aR.elbow.rotation.x, 2.1, c);
    }
    if (s.swing >= 0) {
      const t = clamp01(s.swing);
      const wind = smooth(clamp01(t / 0.34));
      const snap = clamp01((t - 0.30) / 0.22);
      const rec = smooth(clamp01((t - 0.52) / 0.48));
      const w = 1 - rec * 0.9;
      aR.shoulder.rotation.x = lerp(aR.shoulder.rotation.x, lerp(lerp(-1.3, 0.9, wind), -1.9, snap), w);
      aR.shoulder.rotation.y = lerp(aR.shoulder.rotation.y, lerp(0.5, -0.45, snap), w);
      aR.elbow.rotation.x = lerp(aR.elbow.rotation.x, lerp(1.6 - wind * 0.4, 0.25, snap), w);
    }
  }
}

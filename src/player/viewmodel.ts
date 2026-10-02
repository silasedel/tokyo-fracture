import * as THREE from 'three';
import { buildRig, Poser, type RigParts, type PoseState } from './character';
import type { Player } from './player';
import type { Interaction } from './interaction';
import { clamp, clamp01, damp, lerp } from '../util/math';
import { RAPIER } from '../physics/physworld';
import type { PhysWorld } from '../physics/physworld';
import { GROUP, interactionGroups } from '../physics/entity';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export type ViewMode = 'first' | 'third';

/**
 * Owns both ways of seeing the player: a pair of arms welded to the camera, and
 * a whole body standing in the world with the camera on a spring arm behind it.
 *
 * The arms live in their own tiny scene rendered on top of the main one, which
 * is the only reliable way to stop them intersecting walls; the body is an
 * ordinary scene object so it casts shadows, is lit by fires and gets wet with
 * everything else.
 */
export class ViewModel {
  mode: ViewMode = 'first';
  fpScene = new THREE.Scene();
  fpCamera = new THREE.PerspectiveCamera(75, 1.777, 0.012, 9);
  private fpRig: RigParts;
  private fpPose: Poser;
  private tpRig: RigParts;
  private tpPose: Poser;
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private fill = new THREE.HemisphereLight(0x9fb8d0, 0x3a3b38, 0.8);
  private rim = new THREE.DirectionalLight(0xbcd2e8, 0.5);

  /** Third-person spring arm. */
  private armLen = 3.0;
  private armCur = 3.0;
  private tpYaw = 0;
  private tpPitch = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  /** Swing animation clock; < 0 when idle. */
  private swingT = -1;
  private swingDur = 0.46;
  swinging = false;
  /** Fires once, at the moment of contact in the swing. */
  onStrike: (() => void) | null = null;
  private struck = false;
  private hurt = 0;

  constructor(private scene: THREE.Scene, private phys: PhysWorld) {
    this.fpRig = buildRig(false);
    this.fpPose = new Poser(this.fpRig, true);
    // The arms scene IS camera space: the camera never moves, so a hand target
    // of (0.2, -0.2, -0.35) means exactly that on screen, at any FOV, with no
    // world transform in between to get wrong.
    this.fpCamera.position.set(0, 0, 0);
    this.fpCamera.rotation.set(0, 0, 0);
    this.fpScene.add(this.fpRig.root);
    // Fixed in view space: a key from the upper left, a rim from behind.
    this.sun.position.set(-0.55, 0.85, 0.35);
    this.rim.position.set(0.45, 0.25, -1);
    // The arms are lit by lights alone. Reaching for the scene's environment map
    // here mixes sampler types inside one program and the draw silently fails.
    this.fpScene.add(this.sun, this.sun.target, this.fill, this.rim, this.rim.target);

    this.tpRig = buildRig(true);
    this.tpPose = new Poser(this.tpRig, false);
    this.tpRig.root.visible = false;
    this.scene.add(this.tpRig.root);
  }

  setMode(m: ViewMode) {
    this.mode = m;
    this.tpRig.root.visible = m === 'third' && !this.hidden;
    this.fpRig.root.visible = m === 'first' && !this.hidden;
  }

  /** Behind the menu the view is the city's, not yours: no arms, no body. */
  hidden = false;
  setHidden(h: boolean) {
    this.hidden = h;
    this.setMode(this.mode);
  }

  /** The body stands in the world, so it takes the world's reflections. */
  setEnvironment(env: THREE.Texture | null) {
    this.tpRig.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || !m.isMeshStandardMaterial) return;
      const first = !m.envMap !== !env;
      m.envMap = env;
      m.envMapIntensity = 0.55;
      if (first) m.needsUpdate = true;
    });
  }

  /** Match the view scene's key light to the world's, so the arms sit in it. */
  setLighting(sunDir: THREE.Vector3, sunColor: THREE.Color, sunI: number, skyC: THREE.Color, groundC: THREE.Color, fillI: number) {
    void sunDir;
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunI * 0.8 + 0.25;
    this.fill.color.copy(skyC);
    this.fill.groundColor.copy(groundC);
    this.fill.intensity = fillI * 1.9 + 0.22;
    this.rim.color.copy(skyC).lerp(sunColor, 0.3);
    this.rim.intensity = 0.35 + fillI * 0.9;
  }

  startSwing(dur = 0.46) {
    if (this.swingT >= 0 && this.swingT < this.swingDur * 0.62) return false;
    this.swingT = 0;
    this.swingDur = dur;
    this.struck = false;
    this.swinging = true;
    return true;
  }

  hit(amount: number) { this.hurt = Math.min(1, this.hurt + amount); }

  /** True during the part of the swing that should actually connect. */
  get swingNorm() { return this.swingT < 0 ? -1 : this.swingT / this.swingDur; }

  update(dt: number, player: Player, inter: Interaction, camera: THREE.PerspectiveCamera,
         input: { fwd: number; strafe: number }, charge: number) {
    this.hurt = Math.max(0, this.hurt - dt * 1.6);
    if (this.swingT >= 0) {
      this.swingT += dt;
      const n = this.swingT / this.swingDur;
      if (!this.struck && n >= 0.42) { this.struck = true; this.onStrike?.(); }
      if (this.swingT >= this.swingDur) { this.swingT = -1; this.swinging = false; }
    }

    const held = inter.held;
    const rig = this.mode === 'first' ? this.fpRig : this.tpRig;
    const poser = this.mode === 'first' ? this.fpPose : this.tpPose;
    const speed = Math.hypot(player.vel.x, player.vel.z);

    // ---- place the rig first, so world -> rig conversions are current -----
    if (this.mode === 'first') {
      if (this.fpCamera.fov !== camera.fov || this.fpCamera.aspect !== camera.aspect) {
        this.fpCamera.fov = camera.fov;
        this.fpCamera.aspect = camera.aspect;
        this.fpCamera.updateProjectionMatrix();
      }
      // Sway: the hands trail the view slightly.
      const swayX = clamp(-player.lookVel.x * 0.05, -0.07, 0.07);
      const swayY = clamp(player.lookVel.y * 0.05, -0.07, 0.07);
      this.fpRig.root.position.set(
        damp(this.fpRig.root.position.x, swayX, 9, dt),
        damp(this.fpRig.root.position.y, swayY - clamp01(speed / 8) * 0.015, 9, dt), 0);
      this.fpRig.root.rotation.set(
        damp(this.fpRig.root.rotation.x, -swayY * 1.1, 9, dt),
        damp(this.fpRig.root.rotation.y, swayX * 1.4, 9, dt),
        damp(this.fpRig.root.rotation.z, swayX * 0.8, 9, dt));
      this.fpRig.root.updateMatrixWorld(true);
    } else {
      const root = this.tpRig.root;
      root.position.set(player.pos.x, player.pos.y - player.halfHeight - 0.34, player.pos.z);
      const d = ((player.yaw - root.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      root.rotation.y = player.yaw - d * Math.exp(-14 * dt);
      root.updateMatrixWorld(true);
    }

    // ---- where the hands need to be --------------------------------------
    let holdL: THREE.Vector3 | null = null;
    let holdR: THREE.Vector3 | null = null;
    let grip = 0;
    if (held) {
      grip = 1;
      // Put the hands on the object's surface, on either side of its centre,
      // in whichever space this rig lives in.
      const objW = _v.copy(held.pos);
      const halfW = clamp(Math.max(held.hx, held.hz), 0.06, 0.34);
      if (this.mode === 'first') {
        // World -> view space, then into the rig's own (swayed) frame.
        _m.copy(camera.matrixWorldInverse);
      } else {
        _m.copy(rig.root.matrixWorld).invert();
      }
      const local = _v2.copy(objW).applyMatrix4(_m);
      if (this.mode === 'first') {
        _m2.copy(this.fpRig.root.matrix).invert();
        local.applyMatrix4(_m2);
      }
      // Approach from the near face rather than the centre.
      const toward = local.length() > 1e-4 ? local.clone().normalize() : new THREE.Vector3(0, 0, -1);
      // Grip the near face, a little below the centre of mass — that is where
      // hands actually go, and it stops the arms pointing up at the sky.
      local.addScaledVector(toward, -Math.min(held.radius * 0.7, 0.34));
      local.y -= Math.min(held.hy * 0.45, 0.10);
      const side = new THREE.Vector3(-toward.z, 0, toward.x).normalize().multiplyScalar(halfW * 0.8 + 0.05);
      holdL = local.clone().sub(side);
      holdR = local.clone().add(side);
    }
    // Something within arm's length that could be picked up: the near hand
    // lifts toward it, open, so a grab reads before it happens.
    let reach: THREE.Vector3 | null = null;
    if (!held && this.mode === 'first' && !this.swinging && inter.aimEntity
        && inter.aimDist < 1.8 && inter.canGrab(inter.aimEntity)) {
      reach = _v3.copy(inter.aimPoint).applyMatrix4(camera.matrixWorldInverse);
      _m2.copy(this.fpRig.root.matrix).invert();
      reach.applyMatrix4(_m2);
    }

    const st: PoseState = {
      dt, speed,
      strafe: clamp(input.strafe, -1, 1),
      grounded: player.grounded,
      crouched: player.crouched,
      sprinting: player.sprinting,
      swimming: player.swimming,
      submerged: player.submerged,
      climbing: !!player.climbing,
      airTime: player.grounded ? 0 : 0.4,
      swing: this.swingNorm,
      charge,
      grip,
      holdL, holdR, reach,
      phase: player.stridePhase,
      pitch: player.pitch,
      hurt: this.hurt,
    };
    void input.fwd;

    poser.update(st);
    if (this.mode === 'first') this.fpRig.root.updateMatrixWorld(true);
    else this.tpRig.root.updateMatrixWorld(true);
  }

  /** Places the camera for third person. Returns true if it moved the camera. */
  placeCamera(camera: THREE.PerspectiveCamera, player: Player, dt: number): boolean {
    if (this.mode !== 'third') return false;
    this.tpYaw = player.yaw;
    this.tpPitch = player.pitch;
    const pivot = _v.set(player.pos.x, player.pos.y + player.eyeY * 0.8 + 0.12, player.pos.z);
    const off = clamp(Math.cos(this.tpPitch), 0.12, 1);
    const dir = _v2.set(
      Math.sin(this.tpYaw) * off, -Math.sin(this.tpPitch), Math.cos(this.tpYaw) * off).normalize();
    // Push the pivot to the shoulder so the body does not sit dead centre.
    const rightX = Math.cos(this.tpYaw), rightZ = -Math.sin(this.tpYaw);
    pivot.x += rightX * 0.38; pivot.z += rightZ * 0.38;

    // Shape-cast back so the camera never ends up inside a wall or a rubble pile.
    let want = this.armLen;
    const hit = this.phys.world.castShape(
      pivot, { x: 0, y: 0, z: 0, w: 1 }, dir, new RAPIER.Ball(0.22), 0, want, true,
      undefined, interactionGroups(GROUP.PLAYER, 0xffff), player.collider, player.body);
    if (hit) want = Math.max(0.55, hit.time_of_impact - 0.12);
    // Snap in fast, ease out slowly: popping closer is fine, popping away is not.
    this.armCur = want < this.armCur ? want : damp(this.armCur, want, 5, dt);

    this.camPos.copy(pivot).addScaledVector(dir, this.armCur);
    this.camPos.y += 0.10 * clamp01(this.armCur / this.armLen);
    camera.position.copy(this.camPos);
    this.camLook.copy(pivot).addScaledVector(dir, -2.0);
    _m.lookAt(camera.position, this.camLook, _v.set(0, 1, 0));
    _q.setFromRotationMatrix(_m);
    camera.quaternion.copy(_q);
    return true;
  }

  render(renderer: THREE.WebGLRenderer) {
    if (this.mode !== 'first' || this.hidden) return;
    renderer.render(this.fpScene, this.fpCamera);
  }

  dispose() {
    this.scene.remove(this.tpRig.root);
    const kill = (o: THREE.Object3D) => o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mm = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mm)) mm.forEach((x) => x.dispose()); else mm.dispose();
      }
    });
    kill(this.tpRig.root);
    kill(this.fpRig.root);
  }
}

export { lerp };

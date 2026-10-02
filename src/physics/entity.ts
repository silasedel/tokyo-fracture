import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Mat } from './materials';
import type { InstancedPool } from '../render/pool';

export const enum Kind {
  Terrain = 0, Structure = 1, Prop = 2, Debris = 3, Vehicle = 4, Player = 5, Sensor = 6, Decor = 7,
}

/** Bit flags. Systems ask "does this object do X?" rather than "what type is it?". */
export const F = {
  CARRYABLE: 1 << 0,
  BREAKABLE: 1 << 1,
  FLAMMABLE: 1 << 2,
  STRUCTURAL: 1 << 3,
  NO_DESPAWN: 1 << 4,
  IN_WATER: 1 << 5,
  ATTACHED: 1 << 6,
  LADDER: 1 << 7,
  DORMANT: 1 << 22,      // parked as a fixed body until something needs it live
  SHARED_BODY: 1 << 23,  // collider lives on a parent body (a whole building)
  DIGGABLE: 1 << 8,
  GLASS: 1 << 9,
  LIVE_WIRE: 1 << 10,
  GAS_SOURCE: 1 << 11,
  BURNING: 1 << 12,
  FROZEN: 1 << 13,
  HELD: 1 << 14,
  SWAY: 1 << 15,
  HOLLOW: 1 << 16,     // sealed air volume: floats far better than its material implies
  NO_WIND: 1 << 17,
  TREE: 1 << 18,
  DEAD: 1 << 19,
  FRAGMENT: 1 << 20,   // small offcut: cheap, despawnable, no self-fracture
  WATERTIGHT: 1 << 21,
} as const;

export const GROUP = {
  TERRAIN: 1 << 0,
  STRUCTURE: 1 << 1,
  DEBRIS: 1 << 2,
  PROP: 1 << 3,
  PLAYER: 1 << 4,
  VEHICLE: 1 << 5,
  SENSOR: 1 << 6,
  /** Static scenery: parked props, dormant vehicles, un-activated clutter. */
  DORMANT: 1 << 7,
} as const;
export const ALL = 0xffff;
/**
 * Everything that can actually move. Static colliders only test against these,
 * which keeps tens of thousands of scenery colliders out of the narrowphase.
 */
export const MOVING = GROUP.DEBRIS | GROUP.PROP | GROUP.PLAYER | GROUP.VEHICLE | GROUP.SENSOR;
export const interactionGroups = (member: number, filter: number = ALL) => ((member << 16) | filter) >>> 0;

export interface View {
  pool: InstancedPool;
  idx: number;
  scale: THREE.Vector3;
  /** Local offset of the visual from the body origin (for compound shapes). */
  offset?: THREE.Vector3;
  rot?: THREE.Quaternion;
}

/**
 * A collider taken out of the world while its owner sleeps far from anyone,
 * with everything needed to put it back exactly as it was.
 */
export interface ParkedCollider {
  shape: 'box' | 'ball' | 'cylinder' | 'hull';
  half: [number, number, number];
  radius: number;
  halfHeight: number;
  points: Float32Array | null;
  /** World transform: parked colliders all belong to the shared scenery body. */
  t: [number, number, number];
  q: [number, number, number, number];
  density: number;
  friction: number;
  restitution: number;
  groups: number;
  sensor: boolean;
}

export class Entity {
  id = 0;
  kind: Kind = Kind.Prop;
  mat!: Mat;
  body: RAPIER.RigidBody | null = null;
  colliders: RAPIER.Collider[] = [];

  /** Representative box half-extents — drives buoyancy, wind area and impact maths. */
  hx = 0.5; hy = 0.5; hz = 0.5;
  volume = 1;
  mass = 1;
  /** Fraction of `volume` that is sealed air. Hollow things float like corks. */
  hollow = 0;
  dragBoost = 1;
  awkwardness = 0;
  aspect = 0;
  radius = 0.9;

  /** 1 = pristine, 0 = fractured. Fire, impacts and structural stress all eat this. */
  integrity = 1;
  /** Accumulated structural stress from shaking; bleeds off slowly. */
  stress = 0;
  /** deg C */
  temp = 17;
  /** kg of combustible mass left. */
  fuel = 0;
  /** 0..1 how soaked; raises mass, lowers flammability, weakens some materials. */
  wet = 0;
  /** 0..1 fraction of the object below the waterline. */
  submerged = 0;
  /** 0..1 char shown on the surface. */
  char = 0;
  /** 0..1 of the sealed air volume that has filled with water. Hollow things sink eventually. */
  flooded = 0;

  flags = 0;
  /** What holds this in place, and the force (N) needed to rip it free. */
  attachedTo: Entity | null = null;
  attachStrength = 0;

  view: View | null = null;
  /** Extra views that ride along with the body (multi-part props). */
  views: View[] | null = null;

  /** Structural bookkeeping — only for F.STRUCTURAL. */
  supports: Entity[] = [];     // things I hold up
  supportedBy: Entity[] = [];  // things holding me up
  buildingId = -1;
  level = 0;
  structType = 0;

  bornAt = 0;
  lastMoveAt = 0;
  /**
   * Linear velocity as of the last sync — which, when the next step's contacts
   * are read, is the velocity going *into* them. That is what a collision
   * sounds like and what it breaks with; the contact force alone cannot tell a
   * crate landing from a crate that is merely being squeezed.
   */
  vel = new THREE.Vector3();
  /** Physics time this entity last got a live dynamic body. */
  liveAt = -1e9;
  /** Physics time this entity last made an impact sound. */
  lastSoundAt = -1e9;
  /** Seconds this body has been effectively motionless. */
  stillFor = 0;
  /** Cached world transform, refreshed once per frame for any awake body. */
  pos = new THREE.Vector3();
  quat = new THREE.Quaternion();
  /** Where a structural element was built — sway and reset work from this. */
  home = new THREE.Vector3();
  /** True when the element rests directly on the earth. */
  grounded = false;
  /** Collider shape description, kept so a shared-body element can be rebuilt. */
  shapeKind: 'box' | 'ball' | 'cylinder' = 'box';
  /** Authored mass, kept so a rebuilt body can restore it. */
  massOverride = 0;
  /** Colliders put away while this sleeps far from the player; see PhysWorld.park. */
  parked: ParkedCollider[] | null = null;
  label = '';

  has(f: number) { return (this.flags & f) !== 0; }
  set(f: number, on = true) { if (on) this.flags |= f; else this.flags &= ~f; }

  get dynamic() { return this.body !== null && this.body.isDynamic(); }

  /** Buoyant volume — hollow objects displace far more water than their solid part. */
  get displaceVolume() { return this.volume; }

  /** Effective density including trapped air and absorbed water. */
  get effDensity() {
    const solid = this.mat.density * (1 - this.hollow);
    const water = this.wet * this.mat.absorbency * 1000 * 0.35;
    return solid + water;
  }
}

/** Reusable scratch vectors — the hot loops must not allocate. */
export const tmp = {
  v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
  q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
  m1: new THREE.Matrix4(), m2: new THREE.Matrix4(),
  e1: new THREE.Euler(),
  v4a: new THREE.Vector4(),
};

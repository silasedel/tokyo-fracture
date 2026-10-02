import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Entity, F, GROUP, Kind, MOVING, ALL, interactionGroups, type View, type ParkedCollider } from './entity';
import { GRAVITY, shapeFactors, type Mat } from './materials';

export type BodyKind = 'dynamic' | 'fixed' | 'kinematic';

export interface ColliderPart {
  shape: 'box' | 'ball' | 'cylinder' | 'hull';
  half?: THREE.Vector3;
  radius?: number;
  halfHeight?: number;
  points?: Float32Array;
  offset?: THREE.Vector3;
  quat?: THREE.Quaternion;
  /** Overrides the entity material's friction/restitution for this part. */
  friction?: number;
  restitution?: number;
  sensor?: boolean;
}

export interface SpawnDesc {
  kind: Kind;
  mat: Mat;
  pos: THREE.Vector3;
  quat?: THREE.Quaternion;
  /** Representative half-extents used by buoyancy / wind / impact. */
  half: THREE.Vector3;
  body: BodyKind;
  parts?: ColliderPart[];
  /** Single-shape shorthand; ignored when `parts` is given. */
  shape?: 'box' | 'ball' | 'cylinder' | 'hull';
  hullPoints?: Float32Array;
  flags?: number;
  hollow?: number;
  massOverride?: number;
  linearDamping?: number;
  angularDamping?: number;
  ccd?: boolean;
  group?: number;
  filter?: number;
  view?: View | null;
  views?: View[] | null;
  label?: string;
  sleeping?: boolean;
  /** Don't emit contact-force damage events (saves work for inert scenery). */
  noImpactEvents?: boolean;
  gravityScale?: number;
  attachedTo?: Entity | null;
  attachStrength?: number;
  /**
   * Put this entity's colliders on an existing body instead of making a new
   * one. An intact building is a single fixed body carrying hundreds of
   * colliders; pieces only get their own body when they come loose.
   */
  attachTo?: RAPIER.RigidBody | null;
}

export interface Impact {
  a: Entity;
  b: Entity | null;
  /** Joules delivered into `a`. */
  energy: number;
  impulse: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /**
   * Closing speed along the contact normal going into this step (m/s). Near
   * zero for anything resting, stacked, or being pushed apart after it was set
   * down overlapping — all of which still report large contact forces.
   */
  approach: number;
  /** Each contact is reported once per side; only one of the two is primary. */
  primary: boolean;
}

const _ZERO = new THREE.Vector3();

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ZERO = new THREE.Vector3();
const IDENT = new THREE.Quaternion();

/**
 * Owns the Rapier world and the entity table. Everything physical in the game
 * is created here so that every system can look any collider up and read the
 * same set of material properties.
 */
export class PhysWorld {
  world: RAPIER.World;
  private eq: RAPIER.EventQueue;
  entities: Entity[] = [];
  byCollider = new Map<number, Entity>();
  byBody = new Map<number, Entity>();
  private nextId = 1;
  private pool: Entity[] = [];
  time = 0;
  /** Bodies that were made dynamic by destruction, oldest first. */
  debris: Entity[] = [];
  onImpact: ((i: Impact) => void)[] = [];
  /** Filled each step: entities whose transform changed. */
  /** Ground height lookup, so the world can tell when something has fallen through it. */
  groundAt: ((x: number, z: number) => number) | null = null;
  private tuned = false;
  active: Entity[] = [];
  stats = { bodies: 0, active: 0, debris: 0, contacts: 0 };

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.integrationParameters.numSolverIterations = 5;
    this.world.integrationParameters.numAdditionalFrictionIterations = 3;
    this.world.integrationParameters.numInternalPgsIterations = 1;
    // Slightly generous so resting stacks settle instead of buzzing.
    this.world.integrationParameters.normalizedAllowedLinearError = 0.0018;
    this.world.integrationParameters.normalizedPredictionDistance = 0.006;
    this.eq = new RAPIER.EventQueue(true);
  }

  setTimestep(dt: number) { this.world.timestep = dt; }

  spawn(d: SpawnDesc): Entity {
    const e = this.pool.pop() ?? new Entity();
    e.id = this.nextId++;
    e.kind = d.kind;
    e.mat = d.mat;
    e.flags = d.flags ?? 0;
    e.integrity = 1; e.stress = 0; e.wet = 0; e.char = 0; e.submerged = 0;
    e.temp = 17;
    e.supports.length = 0; e.supportedBy.length = 0;
    e.attachedTo = d.attachedTo ?? null;
    e.attachStrength = d.attachStrength ?? 0;
    if (e.attachedTo) e.set(F.ATTACHED);
    e.buildingId = -1; e.level = 0; e.structType = 0;
    e.label = d.label ?? '';
    e.bornAt = this.time;
    e.vel.set(0, 0, 0);
    e.liveAt = d.body === 'dynamic' && !d.attachTo ? this.time : -1e9;
    e.lastSoundAt = -1e9;
    e.stillFor = 0;
    e.lastMoveAt = this.time;
    e.view = d.view ?? null;
    e.views = d.views ?? null;
    e.parked = null;

    e.hx = d.half.x; e.hy = d.half.y; e.hz = d.half.z;
    const sf = shapeFactors(e.hx, e.hy, e.hz);
    e.volume = sf.volume;
    e.aspect = sf.aspect;
    e.dragBoost = sf.dragBoost;
    e.awkwardness = sf.awkwardness;
    e.radius = Math.hypot(e.hx, e.hy, e.hz);
    e.hollow = d.hollow ?? 0;
    // Combustible mass, not total mass: a painted steel cabinet has paint and
    // contents to burn, not seven tonnes of steel.
    e.fuel = d.mat.flammability > 0
      ? e.volume * d.mat.density * (1 - e.hollow) * 0.5 * Math.min(1, d.mat.flammability * 1.15)
      : 0;
    if (d.mat.flammability > 0) e.set(F.FLAMMABLE);

    let body: RAPIER.RigidBody;
    if (d.attachTo) {
      body = d.attachTo;
      e.set(F.SHARED_BODY);
    } else {
      const bd = d.body === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic()
        : d.body === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.fixed();
      bd.setTranslation(d.pos.x, d.pos.y, d.pos.z);
      if (d.quat) bd.setRotation({ x: d.quat.x, y: d.quat.y, z: d.quat.z, w: d.quat.w });
      bd.setLinearDamping(d.linearDamping ?? 0.045);
      bd.setAngularDamping(d.angularDamping ?? 0.16);
      bd.setCcdEnabled(d.ccd ?? false);
      if (d.gravityScale !== undefined) bd.setGravityScale(d.gravityScale);
      bd.setSleeping(d.sleeping ?? false);
      body = this.world.createRigidBody(bd);
      body.userData = e.id;
      this.byBody.set(body.handle, e);
    }
    e.body = body;

    // Anything that cannot move this frame is given a membership outside MOVING
    // and a filter of MOVING only, so static-versus-static pairs never form.
    const isStatic = !!d.attachTo || d.body !== 'dynamic';
    const group = d.group ?? (isStatic ? staticGroup(d.kind) : defaultGroup(d.kind));
    const filter = d.filter ?? (isStatic ? MOVING : ALL);
    const ig = interactionGroups(group, filter);

    const parts: ColliderPart[] = d.parts ?? [{
      shape: d.shape ?? 'box', half: d.half, radius: Math.max(d.half.x, d.half.z),
      halfHeight: d.half.y, points: d.hullPoints,
    }];

    e.colliders.length = 0;
    for (const p of parts) {
      let cd: RAPIER.ColliderDesc | null = null;
      switch (p.shape) {
        case 'box': {
          const h = p.half ?? d.half;
          // A 12 mm sheet of ply is 12 mm thick: a coarser floor here made every
          // sheet in a stack overlap the next and weigh two-thirds more.
          cd = RAPIER.ColliderDesc.cuboid(Math.max(0.004, h.x), Math.max(0.004, h.y), Math.max(0.004, h.z));
          break;
        }
        case 'ball': cd = RAPIER.ColliderDesc.ball(Math.max(0.02, p.radius ?? d.half.y)); break;
        case 'cylinder': cd = RAPIER.ColliderDesc.cylinder(Math.max(0.02, p.halfHeight ?? d.half.y), Math.max(0.02, p.radius ?? d.half.x)); break;
        case 'hull': cd = p.points ? RAPIER.ColliderDesc.convexHull(p.points) : null; break;
      }
      if (!cd) { const h = p.half ?? d.half; cd = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z); }
      if (d.attachTo) {
        // Colliders on a shared body carry the element's full world transform.
        _v.copy(p.offset ?? ZERO);
        if (d.quat) _v.applyQuaternion(d.quat);
        _v.add(d.pos);
        cd.setTranslation(_v.x, _v.y, _v.z);
        _q.copy(d.quat ?? IDENT);
        if (p.quat) _q.multiply(p.quat);
        cd.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      } else {
        if (p.offset) cd.setTranslation(p.offset.x, p.offset.y, p.offset.z);
        if (p.quat) cd.setRotation({ x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w });
      }
      // An authored mass is honoured by choosing the density that produces it,
      // so Rapier's inertia tensor stays consistent with what the object weighs.
      cd.setDensity(d.massOverride !== undefined && e.volume > 1e-4
        ? Math.max(1, d.massOverride / e.volume)
        : d.mat.density * (1 - (d.hollow ?? 0) * 0.92));
      cd.setFriction(p.friction ?? d.mat.friction);
      cd.setRestitution(p.restitution ?? d.mat.restitution);
      cd.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
      cd.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
      cd.setCollisionGroups(ig);
      if (p.sensor) cd.setSensor(true);
      e.shapeKind = p.shape === 'ball' ? 'ball' : p.shape === 'cylinder' ? 'cylinder' : 'box';
      const col = this.world.createCollider(cd, body);
      this.byCollider.set(col.handle, e);
      e.colliders.push(col);
    }

    e.massOverride = d.massOverride ?? 0;
    if (d.body === 'dynamic' && !d.attachTo) this.settleMass(e, body);
    e.mass = (d.body === 'dynamic' && !d.attachTo) ? body.mass()
      : (d.massOverride ?? e.volume * d.mat.density * (1 - (d.hollow ?? 0) * 0.92));
    if (e.mass <= 0) e.mass = Math.max(0.05, e.volume * d.mat.density);

    if (d.body === 'dynamic' && !d.attachTo && !d.noImpactEvents) {
      const thr = Math.max(320, e.mass * 26);
      for (const c of e.colliders) {
        c.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        c.setContactForceEventThreshold(thr);
      }
    }

    e.pos.copy(d.pos);
    e.quat.copy(d.quat ?? _q.identity());
    this.entities.push(e);
    if (d.kind === Kind.Debris && d.body === 'dynamic' && !d.attachTo && !(d.flags && (d.flags & F.NO_DESPAWN))) {
      this.debris.push(e);
    }
    if (e.view) this.writeView(e);
    return e;
  }

  /** Re-point a view so it tracks this entity's body transform right now. */
  writeView(e: Entity) {
    const v = e.view;
    if (!v) return;
    if (v.offset || v.rot) {
      _q.copy(e.quat);
      if (v.rot) _q.multiply(v.rot);
      if (v.offset) {
        _v.copy(v.offset).applyQuaternion(e.quat).add(e.pos);
        v.pool.setTRS(v.idx, _v, _q, v.scale);
      } else v.pool.setTRS(v.idx, e.pos, _q, v.scale);
    } else {
      v.pool.setTRS(v.idx, e.pos, e.quat, v.scale);
    }
    if (e.views) {
      for (const w of e.views) {
        _q.copy(e.quat); if (w.rot) _q.multiply(w.rot);
        if (w.offset) _v.copy(w.offset).applyQuaternion(e.quat).add(e.pos);
        else _v.copy(e.pos);
        w.pool.setTRS(w.idx, _v, _q, w.scale);
      }
    }
  }

  /**
   * Convert a fixed/kinematic/shared-body entity into a free dynamic body.
   * Whichever route it takes, it ends up registered as loose debris with
   * contact events enabled.
   */
  makeDynamic(e: Entity, inheritVel?: THREE.Vector3) {
    if (!e.body || e.has(F.DEAD)) return;
    if (e.parked) this.unpark(e);
    const wasLoose = e.body.isDynamic() && !e.has(F.SHARED_BODY);
    if (e.has(F.SHARED_BODY)) {
      this.detachFromSharedBody(e);
    } else if (!e.body.isDynamic()) {
      e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      e.body.setGravityScale(1, true);
      e.mass = e.body.mass() || e.mass;
    }
    if (!e.body) return;
    const thr = Math.max(320, e.mass * 26);
    for (const c of e.colliders) {
      c.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      c.setContactForceEventThreshold(thr);
      c.setCollisionGroups(interactionGroups(GROUP.DEBRIS, ALL));
    }
    if (inheritVel) e.body.setLinvel({ x: inheritVel.x, y: inheritVel.y, z: inheritVel.z }, true);
    e.vel.copy(inheritVel ?? _ZERO);
    e.liveAt = this.time;
    e.set(F.FROZEN, false);
    e.set(F.DORMANT, false);
    e.lastMoveAt = this.time;
    // Only genuine wreckage joins the despawn budget; woken props stay put.
    if (!wasLoose && e.kind === Kind.Debris && !e.has(F.NO_DESPAWN)) this.debris.push(e);
  }

  /**
   * Give a shared-body element a body of its own. The old collider is removed
   * from the parent and an identical one is created on a fresh dynamic body at
   * the element's world transform, so nothing visibly moves.
   */
  private detachFromSharedBody(e: Entity) {
    const parts: ColliderPart[] = [];
    // Trim that was purely visual while it was bolted to the wall becomes a real
    // object the moment it is not: it gets the collider it never needed to carry
    // while it was part of the building.
    if (!e.colliders.length) {
      parts.push({
        shape: 'box', half: new THREE.Vector3(e.hx, e.hy, e.hz),
        offset: new THREE.Vector3(), quat: new THREE.Quaternion(),
      });
    }
    for (const c of e.colliders) {
      const t = c.translation(), r = c.rotation();
      const lp = _v.set(t.x, t.y, t.z).sub(e.pos).applyQuaternion(_q.copy(e.quat).invert());
      const lq = new THREE.Quaternion(r.x, r.y, r.z, r.w).premultiply(_q);
      const sh = c.shape as unknown as { halfExtents?: RAPIER.Vector; radius?: number; halfHeight?: number; vertices?: Float32Array };
      // Each part keeps its own kind of shape: a lamp's lantern stays a box
      // and a tree's canopy a ball when the post they hang from is a cylinder.
      const kind: ColliderPart['shape'] = sh.halfExtents ? 'box'
        : sh.halfHeight !== undefined ? 'cylinder'
        : sh.vertices ? 'hull'
        : sh.radius !== undefined ? 'ball' : e.shapeKind;
      parts.push({
        shape: kind, points: sh.vertices,
        half: sh.halfExtents ? new THREE.Vector3(sh.halfExtents.x, sh.halfExtents.y, sh.halfExtents.z)
          : new THREE.Vector3(e.hx, e.hy, e.hz),
        radius: sh.radius, halfHeight: sh.halfHeight,
        offset: lp.clone(), quat: lq,
        friction: c.friction(), restitution: c.restitution(),
      });
      this.byCollider.delete(c.handle);
      // Wake whatever was resting on this piece: it is about to stop being part
      // of the building, and anything sitting on it has to fall.
      this.world.removeCollider(c, true);
    }
    e.colliders.length = 0;
    e.set(F.SHARED_BODY, false);
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(e.pos.x, e.pos.y, e.pos.z)
      .setRotation({ x: e.quat.x, y: e.quat.y, z: e.quat.z, w: e.quat.w })
      .setLinearDamping(0.05).setAngularDamping(0.2);
    const body = this.world.createRigidBody(bd);
    body.userData = e.id;
    this.byBody.set(body.handle, e);
    e.body = body;
    const ig = interactionGroups(GROUP.DEBRIS, 0xffff);
    for (const p of parts) {
      let cd: RAPIER.ColliderDesc | null = null;
      if (p.shape === 'ball') cd = RAPIER.ColliderDesc.ball(p.radius ?? e.hy);
      else if (p.shape === 'cylinder') cd = RAPIER.ColliderDesc.cylinder(p.halfHeight ?? e.hy, p.radius ?? e.hx);
      else if (p.shape === 'hull' && p.points) cd = RAPIER.ColliderDesc.convexHull(p.points);
      if (!cd) cd = RAPIER.ColliderDesc.cuboid(p.half!.x, p.half!.y, p.half!.z);
      if (p.offset) cd.setTranslation(p.offset.x, p.offset.y, p.offset.z);
      if (p.quat) cd.setRotation({ x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w });
      cd.setDensity(e.massOverride > 0 && e.volume > 1e-4
        ? Math.max(1, e.massOverride / e.volume)
        : e.mat.density * (1 - e.hollow * 0.92));
      cd.setFriction(p.friction ?? e.mat.friction);
      cd.setRestitution(p.restitution ?? e.mat.restitution);
      cd.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
      cd.setCollisionGroups(ig);
      const col = this.world.createCollider(cd, body);
      this.byCollider.set(col.handle, e);
      e.colliders.push(col);
    }
    // Rapier only works out a new body's mass at the next step. Until then an
    // impulse meets zero mass and does nothing, so a blast that woke a crate
    // left it sitting exactly where it was.
    this.settleMass(e, body);
    e.mass = body.mass() || e.mass;
    this.fresh.push(e);
  }

  /**
   * Work out a new body's mass now rather than at the next step — until then
   * an impulse meets zero mass and does nothing, so a blast that woke a crate
   * left it sitting exactly where it was — and make it weigh what it was
   * authored to weigh. The authored mass is spread over the whole bounding box,
   * and the colliders rarely fill it: a bicycle is mostly air, a planter's bush
   * bulges out of its box. Left alone the body weighed a third of a bicycle, or
   * half as much again as a planter, while the hands and the impact maths went
   * on assuming the authored figure.
   */
  private settleMass(e: Entity, body: RAPIER.RigidBody) {
    body.recomputeMassPropertiesFromColliders();
    const m0 = body.mass();
    if (e.massOverride > 0 && m0 > 1e-6 && Math.abs(m0 - e.massOverride) > e.massOverride * 0.05) {
      const k = e.massOverride / m0;
      for (const c of e.colliders) c.setDensity(c.density() * k);
      body.recomputeMassPropertiesFromColliders();
    }
  }

  /** Put a settled body to sleep as a fixed object: kills drift and saves solver time. */
  freeze(e: Entity) {
    if (!e.body || !e.body.isDynamic() || e.has(F.HELD)) return;
    e.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    e.stillFor = 0;
    e.vel.set(0, 0, 0);
    e.set(F.FROZEN);
  }
  unfreeze(e: Entity) {
    if (!e.body || !e.has(F.FROZEN)) return;
    e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    e.set(F.FROZEN, false);
    e.lastMoveAt = this.time;
    e.liveAt = this.time;
  }

  destroy(e: Entity) {
    if (e.has(F.DEAD)) return;
    e.set(F.DEAD);
    if (e.has(F.SHARED_BODY)) {
      for (const c of e.colliders) { this.byCollider.delete(c.handle); this.world.removeCollider(c, true); }
    } else {
      for (const c of e.colliders) this.byCollider.delete(c.handle);
      if (e.body) {
        this.byBody.delete(e.body.handle);
        this.world.removeRigidBody(e.body);
      }
    }
    e.body = null;
    e.colliders.length = 0;
    e.parked = null;
    if (e.view) { e.view.pool.release(e.view.idx); e.view = null; }
    if (e.views) { for (const w of e.views) w.pool.release(w.idx); e.views = null; }
    for (const s of e.supports) {
      const i = s.supportedBy.indexOf(e);
      if (i >= 0) s.supportedBy.splice(i, 1);
    }
    for (const s of e.supportedBy) {
      const i = s.supports.indexOf(e);
      if (i >= 0) s.supports.splice(i, 1);
    }
    e.supports.length = 0; e.supportedBy.length = 0;
    e.attachedTo = null;
  }

  /** Sweep dead entities out of the table. Called once per frame. */
  collect() {
    let w = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.has(F.DEAD)) { this.pool.push(e); continue; }
      this.entities[w++] = e;
    }
    this.entities.length = w;
    w = 0;
    for (let i = 0; i < this.debris.length; i++) {
      const e = this.debris[i];
      if (e.has(F.DEAD)) continue;
      this.debris[w++] = e;
    }
    this.debris.length = w;
  }

  entityOf(handle: number) { return this.byCollider.get(handle) ?? null; }

  private impactBuf: Impact[] = [];

  step(dt: number) {
    this.world.timestep = dt;
    this.time += dt;
    if (!this.tuned) {
      this.tuned = true;
      // A second continuous-collision substep, so a fast piece cannot step past
      // a thin collider. The penetration tolerance is left alone: raising it
      // lets bodies sink into each other, and the contact forces that come back
      // out of that read to the impact system as a building tearing itself apart.
      (this.world.integrationParameters as unknown as { maxCcdSubsteps: number }).maxCcdSubsteps = 2;
    }
    // When the whole city is in motion, trade a little solver accuracy for the
    // frame rate — nobody can tell during a collapse, and stalling can.
    const n = this.stats.active;
    const iters = n > 1100 ? 2 : n > 620 ? 3 : n > 320 ? 4 : 5;
    if (this.world.integrationParameters.numSolverIterations !== iters) {
      this.world.integrationParameters.numSolverIterations = iters;
      this.world.integrationParameters.numAdditionalFrictionIterations = iters > 4 ? 3 : 2;
    }
    this.world.step(this.eq);
    this.fresh.length = 0;
    this.stats.contacts = 0;
    // Impacts are collected first and dispatched afterwards: listeners create
    // and destroy bodies, which must never happen while Rapier is mid-drain.
    const buf = this.impactBuf;
    buf.length = 0;
    this.eq.drainContactForceEvents((ev) => {
      const a = this.byCollider.get(ev.collider1());
      const b = this.byCollider.get(ev.collider2());
      if (!a && !b) return;
      this.stats.contacts++;
      const force = ev.totalForceMagnitude();
      const impulse = force * dt;
      const ma = a?.body?.isDynamic() ? a.mass : Infinity;
      const mb = b?.body?.isDynamic() ? b.mass : Infinity;
      const mEff = (!isFinite(ma) && !isFinite(mb)) ? 1
        : !isFinite(ma) ? mb : !isFinite(mb) ? ma : (ma * mb) / (ma + mb);
      // Energy absorbed at the contact: J^2 / 2m_eff.
      const energy = (impulse * impulse) / (2 * Math.max(0.05, mEff));
      if (energy < 8) return;
      const f = ev.totalForce();
      _v.set(f.x, f.y, f.z);
      const n = _v.lengthSq() > 1e-6 ? _v.clone().normalize() : new THREE.Vector3(0, 1, 0);
      const pt = a?.pos ?? b!.pos;
      const point = pt.clone();
      // Only dynamic bodies have moved into the contact; shared and fixed
      // bodies read as standing still.
      const va = a && a.body?.isDynamic() ? a.vel : _ZERO;
      const vb = b && b.body?.isDynamic() ? b.vel : _ZERO;
      _v.copy(va).sub(vb);
      const approach = Math.abs(_v.dot(n));
      buf.push({ a: a ?? b!, b: a ? b ?? null : null, energy, impulse, point, normal: n, approach, primary: true });
      if (a && b) buf.push({ a: b, b: a, energy, impulse, point, normal: n.clone().negate(), approach, primary: false });
    });
    this.eq.drainCollisionEvents(() => { /* contact-force events carry what we need */ });
    for (let i = 0; i < buf.length; i++) {
      const imp = buf[i];
      if (imp.a.has(F.DEAD)) continue;
      for (const l of this.onImpact) l(imp);
    }
    buf.length = 0;
  }

  /**
   * Collect every entity whose collider overlaps a sphere. Rapier will not
   * tolerate the world being mutated inside its query callback, so the results
   * are gathered first and acted on afterwards.
   */
  queryBall(pos: THREE.Vector3, radius: number, out: Entity[], max = 512): Entity[] {
    out.length = 0;
    const seen = new Set<number>();
    const shape = new RAPIER.Ball(radius);
    this.world.intersectionsWithShape(
      { x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: 0, z: 0, w: 1 }, shape,
      (c) => {
        const e = this.byCollider.get(c.handle);
        if (e && !e.has(F.DEAD) && !seen.has(e.id)) { seen.add(e.id); out.push(e); }
        return out.length < max;
      });
    // Rapier's query tree is only rebuilt at the end of a step, so colliders
    // made since then are invisible to it: a blast that has just woken the
    // crates around it would otherwise find none of them.
    for (const e of this.fresh) {
      if (out.length >= max) break;
      if (e.has(F.DEAD) || seen.has(e.id)) continue;
      const r = radius + e.radius;
      if (e.pos.distanceToSquared(pos) > r * r) continue;
      seen.add(e.id);
      out.push(e);
    }
    // Parked scenery has no collider for the query to find, but a blast out
    // there must still find it.
    if (out.length < max) this.parkedNear?.(pos, radius, out, seen, max);
    return out;
  }

  /** Entities whose colliders were made since the query tree was last rebuilt. */
  private fresh: Entity[] = [];

  /** Supplied by the activation system: parked entities within a radius. */
  parkedNear: ((pos: THREE.Vector3, radius: number, out: Entity[], seen: Set<number>, max: number) => void) | null = null;

  /**
   * Take a sleeping prop's colliders out of the world. It keeps its place, its
   * look and its mass, and costs the broadphase, the narrowphase and the query
   * tree nothing; `unpark` puts back exactly what was taken away. Only dormant
   * scenery on the shared body is ever parked.
   */
  park(e: Entity) {
    if (e.parked || !e.colliders.length || !e.has(F.SHARED_BODY) || e.has(F.DEAD)) return;
    const saved: ParkedCollider[] = [];
    for (const c of e.colliders) {
      const t = c.translation(), r = c.rotation();
      const sh = c.shape as unknown as { halfExtents?: RAPIER.Vector; radius?: number; halfHeight?: number; vertices?: Float32Array };
      saved.push({
        shape: sh.halfExtents ? 'box' : sh.halfHeight !== undefined ? 'cylinder' : sh.vertices ? 'hull' : 'ball',
        half: sh.halfExtents ? [sh.halfExtents.x, sh.halfExtents.y, sh.halfExtents.z] : [e.hx, e.hy, e.hz],
        radius: sh.radius ?? 0, halfHeight: sh.halfHeight ?? 0,
        points: sh.vertices ? new Float32Array(sh.vertices) : null,
        t: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w],
        density: c.density(), friction: c.friction(), restitution: c.restitution(),
        groups: c.collisionGroups(), sensor: c.isSensor(),
      });
      this.byCollider.delete(c.handle);
      this.world.removeCollider(c, false);
    }
    e.colliders.length = 0;
    e.parked = saved;
  }

  unpark(e: Entity) {
    const saved = e.parked;
    e.parked = null;
    if (!saved || !e.body || e.has(F.DEAD)) return;
    for (const p of saved) {
      let cd: RAPIER.ColliderDesc | null = null;
      if (p.shape === 'ball') cd = RAPIER.ColliderDesc.ball(p.radius);
      else if (p.shape === 'cylinder') cd = RAPIER.ColliderDesc.cylinder(p.halfHeight, p.radius);
      else if (p.shape === 'hull' && p.points) cd = RAPIER.ColliderDesc.convexHull(p.points);
      if (!cd) cd = RAPIER.ColliderDesc.cuboid(p.half[0], p.half[1], p.half[2]);
      cd.setTranslation(p.t[0], p.t[1], p.t[2]);
      cd.setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] });
      cd.setDensity(p.density);
      cd.setFriction(p.friction);
      cd.setRestitution(p.restitution);
      cd.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
      cd.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
      cd.setCollisionGroups(p.groups);
      if (p.sensor) cd.setSensor(true);
      const col = this.world.createCollider(cd, e.body);
      this.byCollider.set(col.handle, e);
      e.colliders.push(col);
    }
    this.fresh.push(e);
  }

  /**
   * Refresh cached transforms + views for everything the solver moved, and act
   * as the last line of defence against a numerical blow-up: nothing in this
   * world legitimately travels at 180 m/s, so anything that does is clamped and
   * anything that has left the map is retired.
   */
  syncViews() {
    const act = this.active;
    act.length = 0;
    const runaway = this.runaway;
    runaway.length = 0;
    this.world.forEachActiveRigidBody((body) => {
      // An exception thrown out of a Rapier callback leaves the Rust side
      // holding its borrow, and every later call into the world fails with
      // "recursive use of an object" — the simulation is dead for the rest of
      // the run. One bad entity is not worth that, so it is caught and retired.
      try { this.syncBody(body, act, runaway); } catch { /* skip this body, keep the world alive */ }
    });
    for (const e of runaway) {
      if (e.has(F.NO_DESPAWN) || e.kind === Kind.Player) {
        if (e.body) {
          const t = e.body.translation();
          const gy = this.groundAt ? this.groundAt(t.x, t.z) : 0;
          if (t.y < gy - 4) e.body.setTranslation({ x: t.x, y: gy + e.hy + 0.2, z: t.z }, true);
          e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      } else this.destroy(e);
    }
    runaway.length = 0;
    this.stats.bodies = this.world.bodies.len();
    this.stats.active = act.length;
    this.stats.debris = this.debris.length;
  }

  /** One body's share of syncViews. Never call into the world from here. */
  private syncBody(body: RAPIER.RigidBody, act: Entity[], runaway: Entity[]) {
    const e = this.byBody.get(body.handle);
    if (!e || e.has(F.DEAD)) return;
    const v = body.linvel();
    e.vel.set(v.x, v.y, v.z);
    const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (!(sp2 < 32400)) {
      if (!isFinite(sp2) || sp2 > 4e6) runaway.push(e);
      else { const k = 180 / Math.sqrt(sp2); body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false); }
    }
    // Anything moving fast enough to step past a thin collider in one frame
    // gets continuous collision until it slows down again. Without this a
    // mattress dropped from a fifth floor goes straight through the street.
    if (sp2 > 144) { if (!body.isCcdEnabled()) body.enableCcd(true); }
    else if (sp2 < 36 && body.isCcdEnabled() && !e.has(F.CARRYABLE)) body.enableCcd(false);

    const t = body.translation(), r = body.rotation();
    if (!isFinite(t.x) || !isFinite(t.y) || !isFinite(t.z) || Math.abs(t.x) > 4000 || t.y < -400 || Math.abs(t.z) > 4000) {
      runaway.push(e);
      return;
    }
    // Anything that has ended up under the street has been squeezed through it
    // by a collapse. It is already invisible down there, and left alone it
    // free-falls forever; retire it, or lift the ones that must not vanish.
    if (this.groundAt && t.y < this.groundAt(t.x, t.z) - 4) { runaway.push(e); return; }
    e.pos.set(t.x, t.y, t.z);
    e.quat.set(r.x, r.y, r.z, r.w);
    if (e.view) this.writeView(e);
    act.push(e);
  }

  private runaway: Entity[] = [];

  raw() { return RAPIER; }
}

function staticGroup(k: Kind) {
  switch (k) {
    case Kind.Terrain: return GROUP.TERRAIN;
    case Kind.Structure: return GROUP.STRUCTURE;
    case Kind.Sensor: return GROUP.SENSOR;
    default: return GROUP.DORMANT;
  }
}

function defaultGroup(k: Kind) {
  switch (k) {
    case Kind.Terrain: return GROUP.TERRAIN;
    case Kind.Structure: return GROUP.STRUCTURE;
    case Kind.Debris: return GROUP.DEBRIS;
    case Kind.Vehicle: return GROUP.VEHICLE;
    case Kind.Player: return GROUP.PLAYER;
    case Kind.Sensor: return GROUP.SENSOR;
    case Kind.Decor: return GROUP.DORMANT;
    default: return GROUP.PROP;
  }
}

export { RAPIER };

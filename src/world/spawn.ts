import * as THREE from 'three';
import type { PhysWorld, SpawnDesc, ColliderPart } from '../physics/physworld';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Entity, Kind, type View } from '../physics/entity';
import type { Mat } from '../physics/materials';
import type { PoolManager } from '../render/pool';
import { makeMaterial, type MatOptions } from '../render/materials';
import * as GEO from '../render/geometry';

const _s = new THREE.Vector3(1, 1, 1);

export interface BoxOpts {
  pos: THREE.Vector3;
  quat?: THREE.Quaternion;
  /** Full dimensions in metres. */
  size: THREE.Vector3;
  mat: Mat;
  body: SpawnDesc['body'];
  kind?: Kind;
  bevel?: number;
  matOpts?: MatOptions;
  flags?: number;
  hollow?: number;
  label?: string;
  massOverride?: number;
  sleeping?: boolean;
  ccd?: boolean;
  noImpactEvents?: boolean;
  cast?: boolean;
  receive?: boolean;
  capacity?: number;
  group?: number;
  filter?: number;
  attachedTo?: Entity | null;
  attachStrength?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** Skip the collider entirely (pure decoration welded to a parent body). */
  visualOnly?: boolean;
  /** Put the collider on an existing body (see PhysWorld.spawn). */
  attachTo?: RAPIER.RigidBody | null;
  /** Use the shared unit-cube geometry and scale per instance. */
  unit?: boolean;
}

/**
 * Bridges "I want a physical thing here" to pooled instanced rendering plus a
 * Rapier body. Sizes are snapped to geometry buckets so the chamfers stay
 * correct while the draw-call count stays low.
 */
export class Spawner {
  /**
   * One fixed body carries every dormant prop in the city. They only get a body
   * of their own once something actually needs them to move.
   */
  sceneryBody: RAPIER.RigidBody | null = null;
  constructor(public phys: PhysWorld, public pools: PoolManager) {}

  private bucketStep(maxDim: number) {
    return maxDim < 0.8 ? 0.1 : maxDim < 2.5 ? 0.25 : maxDim < 8 ? 0.5 : 1.0;
  }

  /** Allocate a pooled view for an arbitrary geometry + material. */
  view(geoKey: string, geometry: THREE.BufferGeometry, material: THREE.Material,
       scale: THREE.Vector3 = _s, capacity = 32,
       opts?: { cast?: boolean; receive?: boolean; renderOrder?: number },
       offset?: THREE.Vector3, rot?: THREE.Quaternion): View {
    const key = `${geoKey}#${material.uuid}`;
    const pool = this.pools.get(key, geometry, material, capacity, opts);
    const idx = pool.alloc();
    return { pool, idx, scale: scale.clone(), offset: offset?.clone(), rot: rot?.clone() };
  }

  box(o: BoxOpts): Entity {
    const s = o.size;
    let view;
    if (o.unit !== false) {
      // One shared unit cube for everything box-shaped. The chamfer is drawn by
      // the shader in world units, so a 6 x 0.26 x 6 slab still looks right.
      const mtl = makeMaterial(o.mat, { instanced: true, vary: 0.1, chamfer: true, ...o.matOpts });
      view = this.view('unitbox', GEO.unitBox(), mtl, s.clone(), o.capacity ?? 512,
        { cast: o.cast ?? true, receive: o.receive ?? true });
    } else {
      const maxD = Math.max(s.x, s.y, s.z);
      const step = this.bucketStep(maxD);
      const b = GEO.boxBucket(s.x, s.y, s.z, step);
      const bevel = o.bevel ?? Math.min(0.045, Math.min(s.x, s.y, s.z) * 0.22);
      const geo = GEO.beveledBox(b.bw, b.bh, b.bd, bevel, bevel > 0.02 ? 2 : 1);
      const mtl = makeMaterial(o.mat, { instanced: true, vary: 0.1, ...o.matOpts });
      view = this.view(`bx${b.bw}_${b.bh}_${b.bd}_${bevel.toFixed(3)}`, geo, mtl,
        new THREE.Vector3(b.sx, b.sy, b.sz), o.capacity ?? 48,
        { cast: o.cast ?? true, receive: o.receive ?? true });
    }

    const half = new THREE.Vector3(s.x / 2, s.y / 2, s.z / 2);
    return this.phys.spawn({
      kind: o.kind ?? Kind.Prop,
      mat: o.mat, pos: o.pos, quat: o.quat, half, body: o.body,
      shape: 'box', flags: o.flags, hollow: o.hollow, label: o.label,
      massOverride: o.massOverride, sleeping: o.sleeping, ccd: o.ccd,
      noImpactEvents: o.noImpactEvents, view, group: o.group, filter: o.filter,
      attachedTo: o.attachedTo, attachStrength: o.attachStrength,
      linearDamping: o.linearDamping, angularDamping: o.angularDamping,
      parts: o.visualOnly ? [] : undefined,
      attachTo: o.attachTo,
    });
  }

  /** A composite prop: one body, one merged geometry, optional extra colliders. */
  prop(opts: {
    geoKey: string;
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    pos: THREE.Vector3;
    quat?: THREE.Quaternion;
    half: THREE.Vector3;
    mat: Mat;
    body: SpawnDesc['body'];
    kind?: Kind;
    parts?: ColliderPart[];
    flags?: number;
    hollow?: number;
    label?: string;
    massOverride?: number;
    capacity?: number;
    scale?: THREE.Vector3;
    sleeping?: boolean;
    cast?: boolean;
    receive?: boolean;
    group?: number;
    filter?: number;
    noImpactEvents?: boolean;
    attachedTo?: Entity | null;
    attachStrength?: number;
    viewOffset?: THREE.Vector3;
    attachTo?: RAPIER.RigidBody | null;
    linearDamping?: number;
    angularDamping?: number;
    ccd?: boolean;
    /** Extra sub-meshes riding the same body (glass, emissive signage, trim). */
    extras?: {
      geoKey: string; geometry: THREE.BufferGeometry; material: THREE.Material;
      offset?: THREE.Vector3; rot?: THREE.Quaternion; scale?: THREE.Vector3;
      cast?: boolean; receive?: boolean; renderOrder?: number; capacity?: number;
    }[];
  }): Entity {
    const view = this.view(opts.geoKey, opts.geometry, opts.material,
      opts.scale ?? _s, opts.capacity ?? 24,
      { cast: opts.cast ?? true, receive: opts.receive ?? true }, opts.viewOffset);
    const views = opts.extras?.length
      ? opts.extras.map((x) => this.view(x.geoKey, x.geometry, x.material,
          x.scale ?? opts.scale ?? _s, x.capacity ?? opts.capacity ?? 24,
          { cast: x.cast ?? false, receive: x.receive ?? true, renderOrder: x.renderOrder ?? 0 },
          x.offset ?? new THREE.Vector3(), x.rot))
      : null;
    return this.phys.spawn({
      kind: opts.kind ?? Kind.Prop, mat: opts.mat, pos: opts.pos, quat: opts.quat,
      half: opts.half, body: opts.body, parts: opts.parts, flags: opts.flags,
      hollow: opts.hollow, label: opts.label, massOverride: opts.massOverride,
      view, views, sleeping: opts.sleeping, group: opts.group, filter: opts.filter,
      noImpactEvents: opts.noImpactEvents, ccd: opts.ccd, attachTo: opts.attachTo,
      linearDamping: opts.linearDamping, angularDamping: opts.angularDamping,
      attachedTo: opts.attachedTo, attachStrength: opts.attachStrength,
    });
  }

  /** Irregular rubble. Cheap, instanced, eight silhouettes. */
  chunk(pos: THREE.Vector3, size: THREE.Vector3, mat: Mat, variant: number,
        opts: { flags?: number; kind?: Kind; vel?: THREE.Vector3; quat?: THREE.Quaternion } = {}): Entity {
    const v = Math.abs(variant | 0) % 8;
    const geo = GEO.chunk(v);
    const mtl = makeMaterial(mat, { instanced: true, vary: 0.22, flatShading: true });
    const view = this.view(`chk${v}`, geo, mtl, size, 256, { cast: true, receive: true });
    const half = new THREE.Vector3(size.x * 0.42, size.y * 0.42, size.z * 0.42);
    const e = this.phys.spawn({
      kind: opts.kind ?? Kind.Debris, mat, pos, quat: opts.quat, half, body: 'dynamic',
      shape: 'box', flags: opts.flags, view, ccd: false,
      linearDamping: 0.09, angularDamping: 0.3,
    });
    if (opts.vel && e.body) e.body.setLinvel({ x: opts.vel.x, y: opts.vel.y, z: opts.vel.z }, true);
    return e;
  }

  shard(pos: THREE.Vector3, scale: number, mat: Mat, variant: number, vel?: THREE.Vector3): Entity {
    const v = Math.abs(variant | 0) % 5;
    const geo = GEO.shard(v);
    const mtl = makeMaterial(mat, { instanced: true, vary: 0.1 });
    const s = new THREE.Vector3(scale, scale, scale);
    const view = this.view(`shd${v}`, geo, mtl, s, 256, { cast: false, receive: false });
    const half = new THREE.Vector3(scale * 0.3, scale * 0.3, scale * 0.06);
    const e = this.phys.spawn({
      kind: Kind.Debris, mat, pos, half, body: 'dynamic', shape: 'box',
      view, linearDamping: 0.2, angularDamping: 0.4, noImpactEvents: true,
      flags: 0,
    });
    if (vel && e.body) e.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    return e;
  }

  splinter(pos: THREE.Vector3, scale: number, mat: Mat, variant: number, vel?: THREE.Vector3): Entity {
    const v = Math.abs(variant | 0) % 6;
    const geo = GEO.splinter(v);
    const mtl = makeMaterial(mat, { instanced: true, vary: 0.25 });
    const s = new THREE.Vector3(scale, scale, scale);
    const view = this.view(`spl${v}`, geo, mtl, s, 128, { cast: true, receive: true });
    const half = new THREE.Vector3(scale * 0.42, scale * 0.05, scale * 0.09);
    const e = this.phys.spawn({
      kind: Kind.Debris, mat, pos, half, body: 'dynamic', shape: 'box',
      view, linearDamping: 0.1, angularDamping: 0.3,
    });
    if (vel && e.body) e.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    return e;
  }
}

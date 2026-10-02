import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * A growable InstancedMesh with a free list, per-instance state vector and
 * partial buffer uploads. The whole city renders through a few hundred of
 * these, which keeps thousands of physical objects inside a sane draw budget.
 */
export class InstancedPool {
  mesh: THREE.InstancedMesh;
  private freeList: number[] = [];
  private highWater = 0;
  capacity: number;
  private state!: THREE.InstancedBufferAttribute;
  private matrixDirty = false;
  private stateDirty = false;
  private loI = 1e9;
  private hiI = -1;
  readonly geo: THREE.BufferGeometry;

  constructor(
    geometry: THREE.BufferGeometry,
    public material: THREE.Material,
    capacity = 64,
    public opts: { cast?: boolean; receive?: boolean; renderOrder?: number } = {},
  ) {
    this.capacity = Math.max(4, capacity);
    // Clone so this pool can own instanced attributes without touching the cache.
    this.geo = geometry.clone();
    this.mesh = this.build(this.capacity);
  }

  private build(cap: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geo, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.opts.cast ?? true;
    mesh.receiveShadow = this.opts.receive ?? true;
    mesh.frustumCulled = false;
    mesh.renderOrder = this.opts.renderOrder ?? 0;
    mesh.count = 0;
    const arr = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) { arr[i * 4 + 2] = (i * 0.6180339887) % 1; arr[i * 4 + 3] = 1; }
    this.state = new THREE.InstancedBufferAttribute(arr, 4);
    this.state.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aState', this.state);
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _zero);
    return mesh;
  }

  private grow() {
    const old = this.mesh;
    const oldState = this.state;
    const newCap = this.capacity * 2;
    const parent = old.parent;
    this.capacity = newCap;
    const arr = new Float32Array(newCap * 4);
    arr.set(oldState.array as Float32Array);
    for (let i = oldState.count; i < newCap; i++) { arr[i * 4 + 2] = (i * 0.6180339887) % 1; arr[i * 4 + 3] = 1; }
    this.geo.deleteAttribute('aState');
    const mesh = new THREE.InstancedMesh(this.geo, this.material, newCap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = old.castShadow; mesh.receiveShadow = old.receiveShadow;
    mesh.frustumCulled = false; mesh.renderOrder = old.renderOrder;
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    for (let i = old.count; i < newCap; i++) mesh.setMatrixAt(i, _zero);
    mesh.count = old.count;
    this.state = new THREE.InstancedBufferAttribute(arr, 4);
    this.state.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aState', this.state);
    this.mesh = mesh;
    if (parent) { parent.remove(old); parent.add(mesh); }
    old.dispose();
    this.matrixDirty = this.stateDirty = true;
    this.loI = 0; this.hiI = newCap - 1;
  }

  alloc(): number {
    const i = this.freeList.pop();
    if (i !== undefined) { this.touch(i); return i; }
    if (this.highWater >= this.capacity) this.grow();
    const idx = this.highWater++;
    this.mesh.count = this.highWater;
    this.touch(idx);
    return idx;
  }

  release(i: number) {
    this.mesh.setMatrixAt(i, _zero);
    this.setState(i, 0, 0, (i * 0.618) % 1, 1);
    this.freeList.push(i);
    this.touch(i);
    this.matrixDirty = true;
  }

  private touch(i: number) {
    if (i < this.loI) this.loI = i;
    if (i > this.hiI) this.hiI = i;
  }

  setMatrix(i: number, m: THREE.Matrix4) {
    this.mesh.setMatrixAt(i, m);
    this.matrixDirty = true;
    this.touch(i);
  }

  setTRS(i: number, p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3) {
    _m.compose(p, q, s);
    this.mesh.setMatrixAt(i, _m);
    this.matrixDirty = true;
    this.touch(i);
  }

  setState(i: number, char: number, glow: number, vary: number, emissive: number) {
    const a = this.state.array as Float32Array;
    a[i * 4] = char; a[i * 4 + 1] = glow; a[i * 4 + 2] = vary; a[i * 4 + 3] = emissive;
    this.stateDirty = true;
    this.touch(i);
  }
  setChar(i: number, char: number) {
    const a = this.state.array as Float32Array;
    if (a[i * 4] === char) return;
    a[i * 4] = char; this.stateDirty = true; this.touch(i);
  }
  setGlow(i: number, glow: number) {
    const a = this.state.array as Float32Array;
    if (a[i * 4 + 1] === glow) return;
    a[i * 4 + 1] = glow; this.stateDirty = true; this.touch(i);
  }
  setEmissive(i: number, e: number) {
    const a = this.state.array as Float32Array;
    if (a[i * 4 + 3] === e) return;
    a[i * 4 + 3] = e; this.stateDirty = true; this.touch(i);
  }
  getState(i: number, out: THREE.Vector4) {
    const a = this.state.array as Float32Array;
    out.set(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]);
    return out;
  }

  /** Upload only the touched range. Called once per frame by the manager. */
  flush() {
    if (this.hiI < this.loI) return;
    const count = this.hiI - this.loI + 1;
    if (this.matrixDirty) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      if (count < this.capacity * 0.6) im.addUpdateRange(this.loI * 16, count * 16);
      im.needsUpdate = true;
      this.matrixDirty = false;
    }
    if (this.stateDirty) {
      this.state.clearUpdateRanges();
      if (count < this.capacity * 0.6) this.state.addUpdateRange(this.loI * 4, count * 4);
      this.state.needsUpdate = true;
      this.stateDirty = false;
    }
    this.loI = 1e9; this.hiI = -1;
  }

  get live() { return this.highWater - this.freeList.length; }

  dispose() { this.mesh.dispose(); this.geo.dispose(); }
}

/** Owns every pool in the scene, keyed by geometry+material identity. */
export class PoolManager {
  private pools = new Map<string, InstancedPool>();
  readonly group = new THREE.Group();
  constructor(scene: THREE.Scene) { this.group.name = 'pools'; scene.add(this.group); }

  get(key: string, geometry: THREE.BufferGeometry, material: THREE.Material,
      initial = 32, opts?: { cast?: boolean; receive?: boolean; renderOrder?: number }): InstancedPool {
    let p = this.pools.get(key);
    if (!p) {
      p = new InstancedPool(geometry, material, initial, opts);
      this.pools.set(key, p);
      this.group.add(p.mesh);
    }
    return p;
  }

  has(key: string) { return this.pools.has(key); }

  flush() { for (const p of this.pools.values()) p.flush(); }

  stats() {
    let instances = 0, tris = 0;
    for (const p of this.pools.values()) {
      instances += p.live;
      const idx = p.geo.index;
      const t = idx ? idx.count / 3 : (p.geo.attributes.position?.count ?? 0) / 3;
      tris += t * p.mesh.count;
    }
    return { pools: this.pools.size, instances, tris: Math.round(tris) };
  }

  dispose() {
    for (const p of this.pools.values()) { this.group.remove(p.mesh); p.dispose(); }
    this.pools.clear();
    this.group.removeFromParent();
  }
}

import { Rng, clamp, clamp01, fbm2 } from '../util/math';

export const MAP = 512;          // metres across, centred on the origin
export const HALF = MAP / 2;

export type RoadKind = 'avenue' | 'street' | 'alley';
export interface RoadLine { pos: number; width: number; kind: RoadKind; }
export type BlockType = 'dense' | 'mixed' | 'office' | 'residential' | 'park' | 'construction' | 'parking' | 'plaza' | 'industrial' | 'river' | 'water';

export interface Lot {
  x0: number; z0: number; x1: number; z1: number;
  /** 0=+z (south face), 1=+x, 2=-z, 3=-x — which side has the main street. */
  face: number;
  type: BuildingType;
  floors: number;
  block: Block;
  /** Streets touching this lot, used to place entrances and signage. */
  openSides: boolean[];
}
export type BuildingType = 'shophouse' | 'apartment' | 'office' | 'tower' | 'parking' | 'warehouse' | 'lowrise';

export interface Block {
  x0: number; z0: number; x1: number; z1: number;
  type: BlockType;
  lots: Lot[];
  id: number;
}

/** The river runs east-west; the bay is to the south. */
export const RIVER_Z = -74;
export const RIVER_HALF = 17;
export const SHORE_Z = 196;      // where the land ends
export const SEA_FLOOR = -9;

export class CityPlan {
  rng: Rng;
  vLines: RoadLine[] = [];
  hLines: RoadLine[] = [];
  blocks: Block[] = [];
  lots: Lot[] = [];
  /** 1 m grid, 1 where a vehicle could drive or a pedestrian walk. */
  roadGrid: Uint8Array;
  /** 1 m grid, 1 where a building footprint sits. */
  buildGrid: Uint8Array;
  /** 8 m grid of 0..1 exposure used by the wind field. */
  openGrid: Float32Array;
  openN = MAP / 8;
  /** Height of the nearest building, 8 m grid — feeds wind shadowing. */
  heightGrid: Float32Array;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.roadGrid = new Uint8Array(MAP * MAP);
    this.buildGrid = new Uint8Array(MAP * MAP);
    this.openGrid = new Float32Array(this.openN * this.openN).fill(1);
    this.heightGrid = new Float32Array(this.openN * this.openN);
    this.generate();
  }

  // -- layout ---------------------------------------------------------------
  private makeLines(): RoadLine[] {
    const r = this.rng;
    const lines: RoadLine[] = [];
    let p = -HALF + r.range(8, 20);
    let sinceAvenue = 0;
    while (p < HALF - 20) {
      let kind: RoadKind;
      if (sinceAvenue >= 4 && r.bool(0.6)) { kind = 'avenue'; sinceAvenue = 0; }
      else if (r.bool(0.30)) { kind = 'alley'; sinceAvenue++; }
      else { kind = 'street'; sinceAvenue++; }
      const width = kind === 'avenue' ? r.range(19, 24) : kind === 'street' ? r.range(9.5, 13) : r.range(3.6, 5.4);
      lines.push({ pos: p, width, kind });
      const gap = kind === 'alley' ? r.range(16, 26) : r.range(32, 60);
      p += width * 0.5 + gap;
    }
    return lines;
  }

  private generate() {
    const r = this.rng;
    this.vLines = this.makeLines();
    this.hLines = this.makeLines();

    // Blocks between consecutive road lines.
    let id = 0;
    for (let i = 0; i < this.vLines.length - 1; i++) {
      for (let j = 0; j < this.hLines.length - 1; j++) {
        const a = this.vLines[i], b = this.vLines[i + 1];
        const c = this.hLines[j], d = this.hLines[j + 1];
        const x0 = a.pos + a.width / 2, x1 = b.pos - b.width / 2;
        const z0 = c.pos + c.width / 2, z1 = d.pos - d.width / 2;
        if (x1 - x0 < 10 || z1 - z0 < 10) continue;
        // Carve out the river and the sea.
        if (z0 < RIVER_Z + RIVER_HALF + 5 && z1 > RIVER_Z - RIVER_HALF - 5) continue;
        if (z0 > SHORE_Z - 12) continue;
        const area = (x1 - x0) * (z1 - z0);
        let type: BlockType = 'mixed';
        const distC = Math.hypot((x0 + x1) / 2, (z0 + z1) / 2);
        const t = r.next();
        if (area > 3600 && t < 0.10) type = 'park';
        else if (area > 2600 && t < 0.17) type = 'construction';
        else if (area > 2200 && t < 0.24) type = 'parking';
        else if (area < 900) type = 'dense';
        else if (distC < 110) type = t < 0.55 ? 'office' : 'dense';
        else if (distC > 180) type = t < 0.5 ? 'industrial' : 'residential';
        else type = t < 0.4 ? 'residential' : 'mixed';
        if (area > 5200 && t > 0.93) type = 'plaza';
        const bl: Block = { x0, z0, x1, z1, type, lots: [], id: id++ };
        this.blocks.push(bl);
      }
    }

    // Guarantee a few open sites: they are where the diggable earth, the loose
    // steel and the heavy machinery live, and the player should always be able
    // to find some.
    const wanted = Math.max(2, Math.round(this.blocks.length * 0.09));
    const sites = this.blocks.filter((b) => b.type === 'construction');
    if (sites.length < wanted) {
      const pool = this.blocks
        .filter((b) => b.type !== 'construction' && b.type !== 'park' && b.type !== 'plaza')
        .sort((a, b) => ((b.x1 - b.x0) * (b.z1 - b.z0)) - ((a.x1 - a.x0) * (a.z1 - a.z0)));
      for (let i = 0; i < wanted - sites.length && i < pool.length; i++) pool[i].type = 'construction';
    }

    for (const b of this.blocks) this.subdivide(b);
    this.rasterise();
    this.computeOpenness();
  }

  /** Split a block's perimeter into street-fronting lots. */
  private subdivide(b: Block) {
    const r = this.rng;
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    if (b.type === 'park' || b.type === 'plaza' || b.type === 'construction') {
      // open blocks get at most a couple of small structures, added later
      return;
    }
    if (b.type === 'parking') {
      b.lots.push(this.mkLot(b, b.x0, b.z0, b.x1, b.z1, 0, 'parking', r.int(3, 5)));
      return;
    }

    const targetW = b.type === 'dense' ? r.range(10, 16)
      : b.type === 'office' ? r.range(22, 34)
      : b.type === 'industrial' ? r.range(22, 38)
      : r.range(14, 24);

    // A ring of lots around the block edge; if the block is deep, leave a core.
    const deep = Math.min(w, d) > 46;
    const depth = deep ? Math.min(24, Math.min(w, d) * 0.36) : Math.min(w, d);

    const strip = (ax: number, az: number, bx: number, bz: number, face: number, horizontal: boolean) => {
      const len = horizontal ? bx - ax : bz - az;
      if (len < 8) return;
      const n = Math.max(1, Math.round(len / targetW));
      const step = len / n;
      for (let i = 0; i < n; i++) {
        const s = (horizontal ? ax : az) + i * step;
        const e = s + step - (n > 1 ? r.range(0.0, 0.7) : 0);
        const lx0 = horizontal ? s : ax, lx1 = horizontal ? e : bx;
        const lz0 = horizontal ? az : s, lz1 = horizontal ? bz : e;
        if (lx1 - lx0 < 6 || lz1 - lz0 < 6) continue;
        const type = this.pickBuilding(b, Math.min(lx1 - lx0, lz1 - lz0));
        const floors = this.pickFloors(type, r);
        b.lots.push(this.mkLot(b, lx0, lz0, lx1, lz1, face, type, floors));
      }
    };

    if (deep) {
      strip(b.x0, b.z1 - depth, b.x1, b.z1, 0, true);
      strip(b.x0, b.z0, b.x1, b.z0 + depth, 2, true);
      strip(b.x1 - depth, b.z0 + depth, b.x1, b.z1 - depth, 1, false);
      strip(b.x0, b.z0 + depth, b.x0 + depth, b.z1 - depth, 3, false);
    } else {
      const horiz = w >= d;
      strip(b.x0, b.z0, b.x1, b.z1, horiz ? 0 : 1, horiz);
    }
  }

  private mkLot(b: Block, x0: number, z0: number, x1: number, z1: number, face: number, type: BuildingType, floors: number): Lot {
    const eps = 1.2;
    const openSides = [
      z1 >= b.z1 - eps, x1 >= b.x1 - eps, z0 <= b.z0 + eps, x0 <= b.x0 + eps,
    ];
    const lot: Lot = { x0, z0, x1, z1, face, type, floors, block: b, openSides };
    this.lots.push(lot);
    return lot;
  }

  private pickBuilding(b: Block, minDim: number): BuildingType {
    const r = this.rng;
    if (minDim < 9) return 'shophouse';
    switch (b.type) {
      case 'office': return r.bool(0.34) ? 'tower' : 'office';
      case 'dense': return r.bool(0.7) ? 'shophouse' : 'lowrise';
      case 'residential': return r.bool(0.72) ? 'apartment' : 'shophouse';
      case 'industrial': return r.bool(0.55) ? 'warehouse' : 'lowrise';
      default: return r.weighted(['shophouse', 'apartment', 'office', 'lowrise'] as BuildingType[],
        (t) => t === 'shophouse' ? 3 : t === 'apartment' ? 3 : t === 'office' ? 2 : 1.5);
    }
  }

  private pickFloors(t: BuildingType, r: Rng) {
    switch (t) {
      case 'tower': return r.int(14, 24);
      case 'office': return r.int(7, 13);
      case 'apartment': return r.int(4, 9);
      case 'shophouse': return r.int(2, 5);
      case 'warehouse': return r.int(1, 2);
      case 'parking': return r.int(3, 5);
      default: return r.int(2, 4);
    }
  }

  // -- rasterised queries ---------------------------------------------------
  private rasterise() {
    const put = (grid: Uint8Array, x0: number, z0: number, x1: number, z1: number, v = 1) => {
      const i0 = clamp(Math.floor(x0 + HALF), 0, MAP - 1), i1 = clamp(Math.ceil(x1 + HALF), 0, MAP - 1);
      const j0 = clamp(Math.floor(z0 + HALF), 0, MAP - 1), j1 = clamp(Math.ceil(z1 + HALF), 0, MAP - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * MAP + i] = v;
    };
    for (const l of this.vLines) put(this.roadGrid, l.pos - l.width / 2, -HALF, l.pos + l.width / 2, HALF);
    for (const l of this.hLines) put(this.roadGrid, -HALF, l.pos - l.width / 2, HALF, l.pos + l.width / 2);
    for (const lot of this.lots) put(this.buildGrid, lot.x0, lot.z0, lot.x1, lot.z1);
    // Roads do not run across the river or out into the bay — only the bridges
    // do, and those carry their own deck. Clearing this keeps every spawn,
    // vehicle and pedestrian query on actual dry ground.
    for (let j = 0; j < MAP; j++) {
      const z = j - HALF + 0.5;
      const inRiver = Math.abs(z - RIVER_Z) < RIVER_HALF + 1.5;
      const inBay = z > SHORE_Z - 4;
      if (!inRiver && !inBay) continue;
      for (let i = 0; i < MAP; i++) this.roadGrid[j * MAP + i] = 0;
    }
  }

  private computeOpenness() {
    const N = this.openN, cell = MAP / N;
    for (const lot of this.lots) {
      const h = lot.floors * 3.3;
      const i0 = clamp(Math.floor((lot.x0 + HALF) / cell), 0, N - 1);
      const i1 = clamp(Math.floor((lot.x1 + HALF) / cell), 0, N - 1);
      const j0 = clamp(Math.floor((lot.z0 + HALF) / cell), 0, N - 1);
      const j1 = clamp(Math.floor((lot.z1 + HALF) / cell), 0, N - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        this.heightGrid[k] = Math.max(this.heightGrid[k], h);
      }
    }
    // Openness = how much of the 3x3 neighbourhood is free of tall mass.
    const src = this.heightGrid.slice();
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let blocked = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj, ii = i + di;
        if (jj < 0 || jj >= N || ii < 0 || ii >= N) continue;
        blocked += Math.min(1, src[jj * N + ii] / 26); n++;
      }
      this.openGrid[j * N + i] = clamp01(1 - (blocked / Math.max(1, n)) * 0.92);
    }
  }

  isRoad(x: number, z: number) {
    const i = Math.floor(x + HALF), j = Math.floor(z + HALF);
    if (i < 0 || j < 0 || i >= MAP || j >= MAP) return false;
    return this.roadGrid[j * MAP + i] === 1;
  }
  isBuilt(x: number, z: number) {
    const i = Math.floor(x + HALF), j = Math.floor(z + HALF);
    if (i < 0 || j < 0 || i >= MAP || j >= MAP) return false;
    return this.buildGrid[j * MAP + i] === 1;
  }
  /** 0 = deep alley or indoors, 1 = wide open street or rooftop. */
  openness(x: number, z: number) {
    const N = this.openN, cell = MAP / N;
    const fx = clamp((x + HALF) / cell, 0, N - 1.001);
    const fz = clamp((z + HALF) / cell, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const g = this.openGrid;
    const a = g[j * N + i], b = g[j * N + i + 1];
    const c = g[(j + 1) * N + i], d = g[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  buildingHeightNear(x: number, z: number) {
    const N = this.openN, cell = MAP / N;
    const i = clamp(Math.floor((x + HALF) / cell), 0, N - 1);
    const j = clamp(Math.floor((z + HALF) / cell), 0, N - 1);
    return this.heightGrid[j * N + i];
  }

  /**
   * A spot out in the open: on a road, clear of the river and the bay, and with
   * a few metres of daylight on every side so the player never starts wedged
   * against a wall.
   */
  findOpenSpot(rng: Rng, minOpen = 0.55, tries = 600, clearance = 5): { x: number; z: number } {
    let best: { x: number; z: number } | null = null;
    let bestScore = -1;
    for (let i = 0; i < tries; i++) {
      const x = rng.range(-HALF + 30, HALF - 30);
      const z = rng.range(-HALF + 30, SHORE_Z - 30);
      if (Math.abs(z - RIVER_Z) < RIVER_HALF + 8) continue;
      if (!this.isRoad(x, z) || this.isBuilt(x, z)) continue;
      const open = this.openness(x, z);
      if (open < minOpen) continue;
      let free = 0;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        let d = 0;
        while (d < clearance && !this.isBuilt(x + Math.cos(th) * d, z + Math.sin(th) * d)) d += 1;
        free += d;
      }
      const score = open + free / (clearance * 8);
      if (score > bestScore) { bestScore = score; best = { x, z }; }
      if (score > 1.85) break;
    }
    return best ?? { x: 0, z: 40 };
  }

  /**
   * Where a run should start: the middle of a real street, walled in by real
   * buildings, inside the simulated core. Picking the most open spot on the map
   * lands you in a car park by the seawall, which is a terrible first
   * impression and nowhere near anything that can fall on you.
   */
  findStreetSpot(rng: Rng, core: number, tries = 900): { x: number; z: number } {
    let best: { x: number; z: number } | null = null;
    let bestScore = -1e9;
    const zMax = Math.min(core, SHORE_Z - 60);
    for (let i = 0; i < tries; i++) {
      const x = rng.range(-core + 12, core - 12);
      const z = rng.range(-core + 12, zMax);
      if (Math.abs(z - RIVER_Z) < RIVER_HALF + 14) continue;
      if (!this.isRoad(x, z) || this.isBuilt(x, z)) continue;
      // Clear standing room, and something built within sight on at least two sides.
      let free = 0, walls = 0, minFree = 99;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const cx = Math.cos(th), cz = Math.sin(th);
        let d = 0;
        while (d < 26 && !this.isBuilt(x + cx * d, z + cz * d)) d += 1;
        free += Math.min(d, 6);
        minFree = Math.min(minFree, d);
        if (d < 26) walls++;
      }
      if (minFree < 3.5) continue;
      const h = this.buildingHeightNear(x, z);
      const score = free * 0.5 + walls * 2.2 + Math.min(h, 26) * 0.35
        + (this.blockAt(x, z)?.type === 'construction' ? -14 : 0);
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return best ?? this.findOpenSpot(rng, 0.7);
  }

  /** The block covering a point, if any. */
  blockAt(x: number, z: number): Block | null {
    for (const b of this.blocks) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return b;
    }
    return null;
  }
}

/** Ground height in metres. Flat city, carved river, sloped seabed, gentle rise inland. */
export function groundHeight(x: number, z: number): number {
  // River channel
  const dr = Math.abs(z - RIVER_Z);
  let h = 0;
  const inland = clamp01((-z - 40) / 260);
  h += inland * inland * 7.5;                       // land rises gently to the north
  h += fbm2(x * 0.0042, z * 0.0042, 3) * 1.1;       // slow undulation so it is not a table
  if (dr < RIVER_HALF + 10) {
    const t = clamp01((RIVER_HALF + 10 - dr) / (RIVER_HALF + 10));
    h -= Math.pow(t, 1.6) * 6.4;                     // channel
  }
  if (z > SHORE_Z - 34) {
    const t = clamp01((z - (SHORE_Z - 34)) / 60);
    h = h * (1 - t) + (SEA_FLOOR - 2) * t * t;       // beach shelving into the bay
  }
  return h;
}

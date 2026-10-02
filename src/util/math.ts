// Small, allocation-free math helpers used across every system.

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const remap = (v: number, a: number, b: number, c: number, d: number) =>
  c + ((clamp(v, Math.min(a, b), Math.max(a, b)) - a) / (b - a || 1e-9)) * (d - c);

/** Frame-rate independent exponential approach. `rate` = how much of the gap closes per second. */
export const damp = (a: number, b: number, rate: number, dt: number) =>
  b + (a - b) * Math.exp(-rate * dt);

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Mulberry32 — small fast seedable PRNG, so a run can be reproduced from a seed. */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1 - 1e-9)); }
  bool(p = 0.5) { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** Gaussian-ish via sum of uniforms — cheap and good enough for scatter. */
  gauss(mean = 0, sd = 1) {
    const u = this.next() + this.next() + this.next() + this.next() - 2;
    return mean + u * sd * 0.8660254;
  }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** Weighted pick. weights need not be normalised. */
  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    let r = this.next() * total;
    for (const it of items) { r -= Math.max(0, weight(it)); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------------------------------------------------------------------------
// Value noise. Used for wind gusts, cloud shapes, terrain, scatter — anything
// that needs coherent pseudo-randomness that is stable across frames.
// ---------------------------------------------------------------------------
const PERM = new Uint8Array(512);
{
  const r = new Rng(1337);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const grad2 = (h: number, x: number, y: number) => {
  switch (h & 7) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x; case 5: return -x; case 6: return y; default: return -y;
  }
};
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[xi] + yi], ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi], bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v); // roughly -1..1
}
export function fbm2(x: number, y: number, octaves = 4, lac = 2.03, gain = 0.5): number {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * f, y * f);
    norm += amp; amp *= gain; f *= lac;
  }
  return sum / (norm || 1);
}
const grad3 = (h: number, x: number, y: number, z: number) => {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
};
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y), zf = z - Math.floor(z);
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return lerp(
    lerp(lerp(grad3(PERM[AA], xf, yf, zf), grad3(PERM[BA], xf - 1, yf, zf), u),
         lerp(grad3(PERM[AB], xf, yf - 1, zf), grad3(PERM[BB], xf - 1, yf - 1, zf), u), v),
    lerp(lerp(grad3(PERM[AA + 1], xf, yf, zf - 1), grad3(PERM[BA + 1], xf - 1, yf, zf - 1), u),
         lerp(grad3(PERM[AB + 1], xf, yf - 1, zf - 1), grad3(PERM[BB + 1], xf - 1, yf - 1, zf - 1), u), v),
    w);
}

/** Uniform-grid spatial hash for broad "what is near here" queries outside the physics world. */
export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  constructor(public cellSize = 8) {}
  private key(x: number, z: number) {
    const ix = Math.floor(x / this.cellSize) + 4096;
    const iz = Math.floor(z / this.cellSize) + 4096;
    return ix * 8192 + iz;
  }
  clear() { this.cells.clear(); }
  insert(x: number, z: number, item: T) {
    const k = this.key(x, z);
    const arr = this.cells.get(k);
    if (arr) arr.push(item); else this.cells.set(k, [item]);
  }
  query(x: number, z: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const r = Math.max(1, Math.ceil(radius / this.cellSize));
    const cx = Math.floor(x / this.cellSize), cz = Math.floor(z / this.cellSize);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const arr = this.cells.get(((cx + i) + 4096) * 8192 + ((cz + j) + 4096));
      if (arr) for (let k = 0; k < arr.length; k++) out.push(arr[k]);
    }
    return out;
  }
}

/** Running average that ignores spikes — used for the frame-time governor. */
export class Smoothed {
  value: number;
  constructor(initial: number, private rate = 6) { this.value = initial; }
  push(v: number, dt: number) { this.value = damp(this.value, v, this.rate, dt); return this.value; }
}

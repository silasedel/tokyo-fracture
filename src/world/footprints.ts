/**
 * A plan-view record of everything that has been set down, so the next thing is
 * not set down inside it.
 *
 * Scenery sleeps as colliders on a shared static body, so two props placed
 * overlapping cost nothing — until the player walks up and they wake. Then the
 * solver prises them apart in a single step: they jump, they clank, and a van
 * parked with its nose in a shopfront comes out fast enough to take a column
 * with it. Checking at placement time is the only place that is cheap.
 */
export interface Foot {
  x: number; z: number;
  /** Half extents along the object's own X and Z. */
  hx: number; hz: number;
  /** Rotation about +Y, as three.js applies it. */
  rot: number;
  y0: number; y1: number;
}

export class Footprints {
  private cells = new Map<number, Foot[]>();

  constructor(private cell = 8) {}

  private key(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }

  private span(f: Foot, pad: number) {
    const r = Math.hypot(f.hx, f.hz) + pad;
    return {
      i0: Math.floor((f.x - r) / this.cell), i1: Math.floor((f.x + r) / this.cell),
      j0: Math.floor((f.z - r) / this.cell), j1: Math.floor((f.z + r) / this.cell),
    };
  }

  add(f: Foot) {
    const s = this.span(f, 0);
    for (let j = s.j0; j <= s.j1; j++) {
      for (let i = s.i0; i <= s.i1; i++) {
        const k = this.key(i, j);
        const arr = this.cells.get(k);
        if (arr) arr.push(f); else this.cells.set(k, [f]);
      }
    }
  }

  /** True if `f`, grown by `pad` metres all round, touches anything recorded. */
  hits(f: Foot, pad = 0.05): boolean {
    const s = this.span(f, pad);
    for (let j = s.j0; j <= s.j1; j++) {
      for (let i = s.i0; i <= s.i1; i++) {
        const arr = this.cells.get(this.key(i, j));
        if (!arr) continue;
        for (const g of arr) {
          if (f.y1 <= g.y0 || g.y1 <= f.y0) continue;
          if (overlap(f, g, pad)) return true;
        }
      }
    }
    return false;
  }
}

/** Separating-axis test for two boxes in plan. */
function overlap(a: Foot, b: Foot, pad: number): boolean {
  const ca = Math.cos(a.rot), sa = Math.sin(a.rot);
  const cb = Math.cos(b.rot), sb = Math.sin(b.rot);
  // Each box's own X and Z axes in world XZ (rotation about +Y).
  const axes = [[ca, -sa], [sa, ca], [cb, -sb], [sb, cb]];
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [nx, nz] of axes) {
    const ra = (a.hx + pad) * Math.abs(ca * nx - sa * nz) + (a.hz + pad) * Math.abs(sa * nx + ca * nz);
    const rb = b.hx * Math.abs(cb * nx - sb * nz) + b.hz * Math.abs(sb * nx + cb * nz);
    if (Math.abs(dx * nx + dz * nz) > ra + rb) return false;
  }
  return true;
}

/** Corners and edge midpoints of a footprint, grown by `pad`, in world XZ. */
export function footSamples(f: Foot, pad = 0): [number, number][] {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  const out: [number, number][] = [];
  for (const u of [-1, 0, 1]) {
    for (const v of [-1, 0, 1]) {
      if (u === 0 && v === 0) continue;
      const lx = u * (f.hx + pad), lz = v * (f.hz + pad);
      out.push([f.x + c * lx + s * lz, f.z - s * lx + c * lz]);
    }
  }
  return out;
}

import * as THREE from 'three';
import { noise3, clamp, clamp01, damp, lerp } from '../util/math';
import type { CityPlan } from '../world/cityplan';

export interface Vortex {
  x: number; z: number;
  /** Radius of maximum wind. */
  radius: number;
  /** Tangential speed at the radius, m/s. */
  strength: number;
  /** How high the circulation reaches. */
  height: number;
  /** Drift velocity of the vortex itself. */
  vx: number; vz: number;
  life: number;
  maxLife: number;
  /** 0..1 spin-up/spin-down envelope. */
  intensity: number;
  id: number;
}

const _v = new THREE.Vector3();

/**
 * A single wind field that every system reads: it moves rain, pushes the
 * player, tears loose signage, fans fire and drives debris. Storms raise the
 * base flow; tornadoes add vortices on top. Nothing is scripted — an object
 * flies because the field pushed on its exposed area.
 */
export class Wind {
  /** Base flow, m/s, at 10 m above open ground. */
  speed = 1.4;
  /** Direction the wind blows toward, radians. */
  dir = 0.6;
  gustiness = 0.25;
  vortices: Vortex[] = [];
  time = 0;
  private nextId = 1;
  /** Cached surface-level wind at the player, for HUD and audio. */
  atPlayer = new THREE.Vector3();
  peakLocal = 0;

  constructor(public plan: CityPlan) {}

  addVortex(v: Omit<Vortex, 'id' | 'intensity'>): Vortex {
    const vo: Vortex = { ...v, id: this.nextId++, intensity: 0 };
    this.vortices.push(vo);
    return vo;
  }

  update(dt: number) {
    this.time += dt;
    for (let i = this.vortices.length - 1; i >= 0; i--) {
      const v = this.vortices[i];
      v.life -= dt;
      // wander, steered by the base flow
      const drift = 0.35;
      v.vx = damp(v.vx, Math.cos(this.dir) * this.speed * drift + Math.sin(this.time * 0.21 + v.id) * 2.2, 0.5, dt);
      v.vz = damp(v.vz, Math.sin(this.dir) * this.speed * drift + Math.cos(this.time * 0.17 + v.id * 2) * 2.2, 0.5, dt);
      v.x += v.vx * dt;
      v.z += v.vz * dt;
      const t = 1 - clamp01(v.life / v.maxLife);
      v.intensity = Math.min(clamp01(t * 6), clamp01((1 - t) * 3.4));
      if (v.life <= 0) this.vortices.splice(i, 1);
    }
  }

  /** Wind velocity in m/s at a world point. */
  sample(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    // Boundary layer: sheltered at street level, full speed above the roofs.
    const roof = this.plan.buildingHeightNear(x, z);
    const open = this.plan.openness(x, z);
    const above = clamp01((y - roof) / 12);
    const profile = lerp(
      lerp(0.20, 0.95, open) * clamp01(0.25 + Math.log1p(Math.max(0, y) / 1.6) / Math.log1p(40)),
      1.18, above);

    const gust = 1 + this.gustiness * (
      noise3(x * 0.017, y * 0.012, this.time * 0.55) * 1.2 +
      noise3(x * 0.061 + 11, z * 0.061, this.time * 1.5) * 0.55);

    const s = this.speed * profile * gust;
    out.set(Math.cos(this.dir) * s, 0, Math.sin(this.dir) * s);

    // Air squeezes along street canyons rather than through buildings.
    if (open < 0.6 && y < roof) {
      const swirl = noise3(x * 0.03, z * 0.03, this.time * 0.3) * 0.6;
      out.x += -out.z * swirl * 0.5;
      out.z += out.x * swirl * 0.5;
    }
    // Updraft over the windward face of tall mass, downdraft behind it.
    if (roof > 10 && y < roof * 1.3) {
      out.y += this.speed * 0.12 * clamp01((roof - Math.abs(y - roof * 0.6)) / roof) * (1 - open);
    }

    for (let i = 0; i < this.vortices.length; i++) {
      const v = this.vortices[i];
      if (v.intensity <= 0) continue;
      const dx = x - v.x, dz = z - v.z;
      const r = Math.hypot(dx, dz);
      if (r > v.radius * 9 || y > v.height) continue;
      const nx = r > 1e-4 ? dx / r : 1, nz = r > 1e-4 ? dz / r : 0;
      // Rankine vortex: solid-body core, 1/r outside.
      const tang = r < v.radius ? (r / v.radius) : (v.radius / r);
      const vt = v.strength * tang * v.intensity;
      const vy = clamp01(1 - y / v.height);
      // tangential (counter-clockwise), plus inflow near the ground, plus lift
      out.x += -nz * vt * (0.55 + 0.45 * vy);
      out.z += nx * vt * (0.55 + 0.45 * vy);
      const inflow = vt * 0.42 * clamp01(1 - r / (v.radius * 3.2)) * (0.35 + 0.65 * vy);
      out.x += -nx * inflow;
      out.z += -nz * inflow;
      out.y += v.strength * v.intensity * 0.80 * clamp01(1 - Math.abs(r - v.radius * 0.55) / (v.radius * 1.9)) * vy;
      out.x += v.vx * 0.6 * v.intensity * clamp01(1 - r / (v.radius * 4));
      out.z += v.vz * 0.6 * v.intensity * clamp01(1 - r / (v.radius * 4));
    }
    return out;
  }

  /** Strongest vortex influence at a point, 0..1. Used for VFX and audio. */
  vortexAt(x: number, z: number): { v: Vortex | null; amount: number } {
    let best: Vortex | null = null, amt = 0;
    for (const v of this.vortices) {
      const r = Math.hypot(x - v.x, z - v.z);
      const a = clamp01(1 - r / (v.radius * 5)) * v.intensity;
      if (a > amt) { amt = a; best = v; }
    }
    return { v: best, amount: amt };
  }

  refreshPlayer(x: number, y: number, z: number) {
    this.sample(x, y, z, this.atPlayer);
    this.peakLocal = this.atPlayer.length();
    return this.atPlayer;
  }

  /** Exact projected area of a box along a direction — shape matters. */
  static boxArea(hx: number, hy: number, hz: number, dirLocal: THREE.Vector3) {
    return 4 * (Math.abs(dirLocal.x) * hy * hz
              + Math.abs(dirLocal.y) * hx * hz
              + Math.abs(dirLocal.z) * hx * hy);
  }

  clear() { this.vortices.length = 0; }
  get maxStrength() {
    let m = 0;
    for (const v of this.vortices) m = Math.max(m, v.strength * v.intensity);
    return m;
  }
  scratch() { return _v; }
  static clampSpeed(v: number) { return clamp(v, 0, 140); }
}

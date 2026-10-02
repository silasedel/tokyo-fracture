import * as THREE from 'three';
import { Rng, clamp, clamp01, damp, lerp, smoothstep } from '../util/math';
import type { Wind } from '../sim/wind';
import type { Water } from '../sim/water';
import type { Fire } from '../sim/fire';
import type { StructureSystem } from '../sim/structure';
import type { Forces } from '../sim/forces';
import type { Activation } from '../sim/activation';
import type { PhysWorld } from '../physics/physworld';
import type { Spawner } from '../world/spawn';
import type { CityPlan } from '../world/cityplan';
import type { Terrain } from '../world/terrain';
import type { Player } from '../player/player';
import type { Building } from '../world/building';
import { F, Kind } from '../physics/entity';
import { MATERIALS } from '../physics/materials';
import { HALF, SHORE_Z } from '../world/cityplan';
import { G } from '../render/globals';

export type HazardKind =
  | 'earthquake' | 'aftershock' | 'tornado' | 'typhoon' | 'downpour' | 'flood'
  | 'tsunami' | 'firestorm' | 'gasleak' | 'lightningstorm' | 'eruption'
  | 'ashfall' | 'landslide' | 'collapse' | 'hail' | 'blackout' | 'surge';

export interface Alert {
  title: string;
  sub?: string;
  crit: boolean;
  t: number;
  life: number;
}

export interface ActiveHazard {
  kind: HazardKind;
  t: number;
  duration: number;
  magnitude: number;
  data: Record<string, number>;
  label: string;
}

interface HazardDef {
  kind: HazardKind;
  minIntensity: number;
  weight: (i: number) => number;
  cooldown: number;
  label: string;
}

const HAZARDS: HazardDef[] = [
  { kind: 'downpour',       minIntensity: 0.045, weight: (i) => 2.6 - i * 1.6, cooldown: 70,  label: 'Torrential rain' },
  { kind: 'lightningstorm', minIntensity: 0.130, weight: () => 1.9,            cooldown: 85,  label: 'Electrical storm' },
  { kind: 'earthquake',     minIntensity: 0.205, weight: (i) => 1.1 + i * 2.4, cooldown: 110, label: 'Earthquake' },
  { kind: 'hail',           minIntensity: 0.260, weight: (i) => 0.9 - i * 0.4, cooldown: 95,  label: 'Hailstorm' },
  { kind: 'gasleak',        minIntensity: 0.300, weight: (i) => 0.7 + i * 1.5, cooldown: 55,  label: 'Ruptured gas main' },
  { kind: 'flood',          minIntensity: 0.330, weight: (i) => 1.0 + i * 1.2, cooldown: 100, label: 'Flooding' },
  { kind: 'typhoon',        minIntensity: 0.370, weight: (i) => 0.9 + i * 1.3, cooldown: 135, label: 'Typhoon front' },
  { kind: 'firestorm',      minIntensity: 0.400, weight: (i) => 0.8 + i * 1.8, cooldown: 72,  label: 'Fire' },
  { kind: 'blackout',       minIntensity: 0.420, weight: () => 0.8,            cooldown: 165, label: 'Grid failure' },
  { kind: 'collapse',       minIntensity: 0.455, weight: (i) => 0.6 + i * 2.0, cooldown: 52,  label: 'Structural failure' },
  { kind: 'tornado',        minIntensity: 0.550, weight: (i) => 0.7 + i * 2.2, cooldown: 130, label: 'Tornado' },
  { kind: 'landslide',      minIntensity: 0.565, weight: (i) => 0.5 + i * 1.1, cooldown: 120, label: 'Landslide' },
  { kind: 'eruption',       minIntensity: 0.700, weight: (i) => 0.5 + i * 1.6, cooldown: 240, label: 'Volcanic eruption' },
  { kind: 'tsunami',        minIntensity: 0.740, weight: (i) => 0.3 + i * 1.4, cooldown: 260, label: 'Tsunami' },
];

/**
 * The run is paced by authored timelines rather than a single formula, because
 * the opening has to be *felt*: a quiet city, then weather, then the ground
 * moving, and only much later the things that flatten districts. Values are
 * keyframes of (seconds, value) and are read with linear interpolation.
 */
type Curve = readonly (readonly [number, number])[];
function curve(t: number, pts: Curve): number {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      const k = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * (k * k * (3 - 2 * k));
    }
  }
  return pts[pts.length - 1][1];
}

/** Overall danger. Every hazard gate above is a point on this line. */
const INTENSITY: Curve = [
  [0, 0], [45, 0.015], [100, 0.05], [175, 0.12], [250, 0.21], [350, 0.30],
  [480, 0.40], [640, 0.50], [840, 0.62], [1080, 0.74], [1400, 0.88], [1800, 1.0],
];

/** Baseline weather. Hazards add to these; they never subtract. */
const W_CLOUD: Curve = [[0, 0.26], [45, 0.34], [100, 0.54], [175, 0.72], [260, 0.85], [420, 0.93], [700, 1.0]];
const W_RAIN: Curve = [[0, 0], [44, 0], [58, 0.09], [96, 0.15], [112, 0.33], [168, 0.43], [190, 0.56], [265, 0.68], [430, 0.82], [700, 0.98]];
const W_STORM: Curve = [[0, 0.02], [100, 0.07], [175, 0.22], [250, 0.45], [350, 0.62], [500, 0.78], [800, 0.95]];
const W_WIND: Curve = [[0, 1.1], [60, 1.7], [120, 2.9], [200, 4.8], [300, 7.0], [450, 9.5], [650, 13], [900, 17]];
const W_BOLT: Curve = [[0, 0], [195, 0], [215, 0.14], [265, 0.40], [365, 0.68], [600, 1.0], [900, 1.35]];
const W_NIGHT: Curve = [[0, 0], [160, 0], [420, 0.34], [720, 0.70], [1040, 0.90]];

/** Human-readable stage, driven by the clock so the progression reads clearly. */
const STAGE_NAMES: readonly (readonly [number, string])[] = [
  [45, 'calm'], [100, 'light rain'], [175, 'heavy rain'], [250, 'thunderstorm'],
  [350, 'tremors'], [480, 'storm front'], [640, 'escalating'], [840, 'severe'],
  [1080, 'disaster'], [1400, 'catastrophe'], [Infinity, 'collapse'],
];

/** The shape of a real earthquake: a sharp arrival, a violent body, a long tail. */
class Quake {
  t = 0;
  accel = new THREE.Vector3();
  private phases: { f: number; a: number; p: number }[] = [];
  constructor(public magnitude: number, public duration: number, rng: Rng) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      this.phases.push({
        f: rng.range(0.55, 4.2),
        a: rng.range(0.35, 1) / Math.sqrt(i + 1),
        p: rng.range(0, Math.PI * 2),
      });
    }
  }
  get envelope() {
    const t = this.t, d = this.duration;
    const rise = smoothstep(0, d * 0.10, t);
    const fall = 1 - smoothstep(d * 0.34, d, t);
    return rise * Math.max(fall, Math.exp(-(t - d * 0.34) / (d * 0.35)) * 0.55) ;
  }
  update(dt: number) {
    this.t += dt;
    const env = clamp01(this.envelope);
    // Peak ground acceleration, tuned so M5 is a scare, M6 breaks weak
    // structures and M7.5 approaches 1 g.
    const pga = 0.6 * Math.exp(0.82 * (this.magnitude - 4));
    let ax = 0, az = 0, ay = 0;
    for (const p of this.phases) {
      const w = p.f * Math.PI * 2;
      ax += Math.sin(this.t * w + p.p) * p.a;
      az += Math.sin(this.t * w * 0.93 + p.p * 1.7) * p.a;
      ay += Math.sin(this.t * w * 1.31 + p.p * 0.4) * p.a * 0.42;
    }
    const k = pga * env / 2.2;
    this.accel.set(ax * k, ay * k, az * k);
    return this.t < this.duration;
  }
}

export interface DirectorDeps {
  wind: Wind; water: Water; fire: Fire; structure: StructureSystem; forces: Forces;
  activation: Activation; phys: PhysWorld; spawn: Spawner; plan: CityPlan;
  terrain: Terrain; player: Player; rng: Rng;
}

export interface WeatherState {
  rain: number;        // 0..1 visual rain density
  rainRate: number;    // m/s onto the ground
  windSpeed: number;
  windDir: number;
  cloud: number;
  storm: number;
  night: number;
  ash: number;
  lightningRate: number;
  fogBoost: number;
  hail: number;
}

/** The sky every run opens under: dry, a light breeze, scattered cloud. */
const OPENING_WEATHER: WeatherState = {
  rain: 0, rainRate: 0, windSpeed: 1.1, windDir: 0.7, cloud: 0.26,
  storm: 0.02, night: 0, ash: 0, lightningRate: 0, fogBoost: 0, hail: 0,
};

/**
 * The director does not play a script. It tracks a rising danger level, picks
 * hazards that fit it, and lets them interact: a quake cracks gas mains, fire
 * follows, a typhoon pushes the fire downwind, flooding shorts the grid. Every
 * run is a different sequence.
 */
export class Director {
  time = 0;
  intensity = 0;
  phase = 'calm';
  phaseIndex = -1;
  active: ActiveHazard[] = [];
  alerts: Alert[] = [];
  quakes: Quake[] = [];
  private cooldowns = new Map<HazardKind, number>();
  private nextRoll = 58;
  private rng: Rng;
  weather: WeatherState = { ...OPENING_WEATHER };
  target: WeatherState;
  /** Lightning flash state, read by the sky and post stack. */
  flash = 0;
  flashDir = new THREE.Vector3(0, 1, 0);
  lastStrike = new THREE.Vector3();
  strikeTimer = 3;
  onAlert: ((a: Alert) => void) | null = null;
  onStrike: ((pos: THREE.Vector3, energy: number) => void) | null = null;
  onQuakeStart: ((mag: number) => void) | null = null;
  onHazard: ((h: ActiveHazard) => void) | null = null;
  eventLog: { t: number; label: string }[] = [];
  hazardCount = 0;
  /** Set true once the run has moved past the calm opening. */
  started = false;

  constructor(public d: DirectorDeps) {
    this.rng = d.rng;
    this.target = { ...this.weather };
  }

  private alert(title: string, sub: string, crit: boolean, life = 6) {
    const a: Alert = { title, sub, crit, t: this.time, life };
    this.alerts.push(a);
    this.onAlert?.(a);
    this.eventLog.push({ t: this.time, label: title });
  }

  update(dt: number, player: Player) {
    this.time += dt;

    // ---------------------------------------------------- danger curve
    const t = this.time;
    const wobble = 0.030 * Math.sin(t * 0.047) + 0.020 * Math.sin(t * 0.019 + 1.3);
    const base = curve(t, INTENSITY);
    this.intensity = clamp01(base + wobble * base);
    if (t > 45) this.started = true;

    let pi = 0;
    while (pi < STAGE_NAMES.length - 1 && t >= STAGE_NAMES[pi][0]) pi++;
    if (pi !== this.phaseIndex) { this.phaseIndex = pi; this.phase = STAGE_NAMES[pi][1]; }

    // ---------------------------------------------------- baseline weather
    const I = this.intensity;
    this.target.cloud = curve(t, W_CLOUD);
    this.target.storm = curve(t, W_STORM);
    this.target.rain = curve(t, W_RAIN);
    this.target.rainRate = this.target.rain * 0.000032;
    this.target.windSpeed = curve(t, W_WIND);
    this.target.night = curve(t, W_NIGHT);
    this.target.lightningRate = curve(t, W_BOLT);
    this.target.hail = 0;
    this.target.ash = Math.max(0, this.target.ash - dt * 0.004);

    // ---------------------------------------------------- active hazards
    for (let i = this.active.length - 1; i >= 0; i--) {
      const h = this.active[i];
      h.t += dt;
      this.tickHazard(h, dt, player);
      if (h.t >= h.duration) {
        this.active.splice(i, 1);
        this.endHazard(h);
      }
    }

    // ---------------------------------------------------- roll new hazards
    for (const [k, v] of this.cooldowns) {
      const nv = v - dt;
      if (nv <= 0) this.cooldowns.delete(k); else this.cooldowns.set(k, nv);
    }
    this.nextRoll -= dt;
    if (this.nextRoll <= 0) {
      // Early on, hazards arrive rarely and one at a time; late, they overlap.
      const gap = lerp(62, 11, I) * this.rng.range(0.75, 1.3);
      this.nextRoll = gap;
      this.rollHazard();
    }

    // ---------------------------------------------------- earthquakes
    this.d.forces.quakeAccel.set(0, 0, 0);
    let shake = 0;
    for (let i = this.quakes.length - 1; i >= 0; i--) {
      const q = this.quakes[i];
      if (!q.update(dt)) { this.quakes.splice(i, 1); continue; }
      this.d.forces.quakeAccel.add(q.accel);
      shake = Math.max(shake, q.accel.length());
    }
    if (shake > 0.05) {
      const a = this.d.forces.quakeAccel;
      this.d.structure.applyShaking(shake, dt);
      this.d.structure.setShake(clamp(a.x * 0.030, -0.55, 0.55), clamp(a.z * 0.030, -0.55, 0.55), 5.4);
      this.d.structure.updatePhysicalSway(player.pos);
      player.addShake(shake * dt * 1.3);
    } else if (this.d.structure.swayAmp.lengthSq() > 0) {
      this.d.structure.setShake(
        damp(this.d.structure.swayAmp.x, 0, 3, dt),
        damp(this.d.structure.swayAmp.y, 0, 3, dt), 5.4);
      if (this.d.structure.swayAmp.length() < 0.002) this.d.structure.setShake(0, 0, 5.4);
      this.d.structure.updatePhysicalSway(player.pos);
    }
    this.d.structure.relaxStress(dt);

    // ---------------------------------------------------- lightning
    this.updateLightning(dt, player);

    // ---------------------------------------------------- smooth the weather
    const w = this.weather, tg = this.target;
    w.rain = damp(w.rain, tg.rain, 0.35, dt);
    w.rainRate = damp(w.rainRate, tg.rainRate, 0.35, dt);
    w.windSpeed = damp(w.windSpeed, tg.windSpeed, 0.30, dt);
    w.windDir = damp(w.windDir, tg.windDir, 0.12, dt);
    w.cloud = damp(w.cloud, tg.cloud, 0.22, dt);
    w.storm = damp(w.storm, tg.storm, 0.22, dt);
    w.night = damp(w.night, tg.night, 0.5, dt);
    w.ash = damp(w.ash, tg.ash, 0.18, dt);
    w.lightningRate = damp(w.lightningRate, tg.lightningRate, 0.4, dt);
    w.hail = damp(w.hail, tg.hail, 0.8, dt);
    w.fogBoost = damp(w.fogBoost, tg.fogBoost, 0.3, dt);

    // push to the systems
    this.d.wind.speed = w.windSpeed;
    this.d.wind.dir = w.windDir;
    this.d.wind.gustiness = clamp(0.18 + I * 0.55, 0.15, 0.95);
    this.d.water.rainRate = w.rainRate;
    this.d.wind.update(dt);

    // alerts expire
    for (let i = this.alerts.length - 1; i >= 0; i--) {
      if (this.time - this.alerts[i].t > this.alerts[i].life) this.alerts.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ hazards

  private rollHazard() {
    const I = this.intensity;
    const pool = HAZARDS.filter((h) => I >= h.minIntensity && !this.cooldowns.has(h.kind));
    if (!pool.length) return;
    const def = this.rng.weighted(pool, (h) => Math.max(0.01, h.weight(I)));
    this.trigger(def.kind, I);
  }

  /** Public so cascades and debug keys can fire hazards directly. */
  trigger(kind: HazardKind, magnitude = this.intensity, silent = false): ActiveHazard | null {
    const def = HAZARDS.find((h) => h.kind === kind);
    const rng = this.rng;
    const d = this.d;
    const h: ActiveHazard = {
      kind, t: 0, duration: 20, magnitude, data: {}, label: def?.label ?? kind,
    };
    if (def) this.cooldowns.set(kind, def.cooldown * rng.range(0.8, 1.3));
    this.hazardCount++;

    switch (kind) {
      case 'earthquake': {
        // The first quakes of a run are rattles; the city-levelling ones only
        // become possible deep into the schedule.
        const mag = lerp(3.9, 7.8, clamp01(((magnitude - 0.18) / 0.72) * rng.range(0.8, 1.15)));
        const dur = lerp(12, 46, clamp01((mag - 4) / 3.4));
        this.quakes.push(new Quake(mag, dur, rng));
        h.duration = dur + 6;
        h.data.mag = mag;
        this.onQuakeStart?.(mag);
        if (!silent) this.alert(`Earthquake M${mag.toFixed(1)}`, 'Get away from anything that can fall', mag > 5.6, 8);
        // Cascades: shaking breaks things that then do their own damage.
        const cascades = Math.floor(clamp((mag - 4.6) * 2.2, 0, 6));
        for (let i = 0; i < cascades; i++) {
          setTimeoutLike(this, rng.range(3, dur * 0.8), () => {
            if (rng.bool(0.55)) this.trigger('gasleak', magnitude, true);
            else this.trigger('collapse', magnitude, true);
          });
        }
        if (mag > 6.3 && rng.bool(0.55)) {
          setTimeoutLike(this, rng.range(30, 70), () => this.trigger('tsunami', magnitude));
        }
        if (rng.bool(0.8)) {
          const n = rng.int(1, 3);
          for (let i = 0; i < n; i++) {
            setTimeoutLike(this, dur + rng.range(20, 150), () => this.trigger('aftershock', magnitude * 0.7));
          }
        }
        if (mag > 5.4 && rng.bool(0.6)) setTimeoutLike(this, rng.range(8, 40), () => this.trigger('blackout', magnitude, true));
        break;
      }
      case 'aftershock': {
        const mag = lerp(3.6, 6.0, clamp01(magnitude));
        const dur = lerp(7, 20, clamp01(magnitude));
        this.quakes.push(new Quake(mag, dur, rng));
        h.duration = dur;
        h.data.mag = mag;
        this.onQuakeStart?.(mag);
        if (!silent) this.alert('Aftershock', `Magnitude ${mag.toFixed(1)}`, false, 5);
        break;
      }
      case 'tornado': {
        const strength = lerp(22, 78, clamp01(magnitude * rng.range(0.8, 1.2)));
        const radius = lerp(9, 26, clamp01(magnitude));
        const life = rng.range(55, 130);
        const edge = rng.next();
        const sx = edge < 0.5 ? -HALF + 20 : rng.range(-HALF, HALF);
        const sz = edge < 0.5 ? rng.range(-HALF, SHORE_Z - 40) : -HALF + 20;
        d.wind.addVortex({
          x: sx, z: sz, radius, strength, height: lerp(90, 220, clamp01(magnitude)),
          vx: rng.range(4, 9), vz: rng.range(2, 7), life, maxLife: life,
        });
        h.duration = life;
        h.data.strength = strength;
        this.alert('Tornado', 'Do not stay in the open', true, 9);
        break;
      }
      case 'typhoon': {
        h.duration = rng.range(90, 190);
        h.data.wind = lerp(18, 52, clamp01(magnitude));
        h.data.rain = lerp(0.6, 1.5, clamp01(magnitude));
        h.data.dir = rng.range(0, Math.PI * 2);
        this.alert('Typhoon front', 'Sustained winds and heavy rain', magnitude > 0.6, 8);
        break;
      }
      case 'downpour': {
        h.duration = rng.range(45, 120);
        h.data.rain = lerp(0.5, 1.5, clamp01(magnitude + 0.25));
        if (!silent) this.alert('Torrential rain', 'Streets are filling faster than the drains', false, 5);
        break;
      }
      case 'flood': {
        h.duration = rng.range(80, 200);
        h.data.river = lerp(0.35, 1.6, clamp01(magnitude));
        h.data.drain = lerp(0.55, 0.1, clamp01(magnitude));
        this.alert('Flood warning', 'The river is over its banks', magnitude > 0.55, 8);
        break;
      }
      case 'tsunami': {
        const height = lerp(4.5, 13.5, clamp01(magnitude * rng.range(0.85, 1.15)));
        h.duration = 210;
        h.data.height = height;
        h.data.warn = 26;
        this.alert('TSUNAMI WARNING', `Wave height ~${height.toFixed(0)} m — get high, now`, true, 16);
        break;
      }
      case 'firestorm': {
        h.duration = rng.range(40, 110);
        // Try a few places until one of them actually has something to burn.
        let n = 0;
        for (let i = 0; i < 6 && n === 0; i++) {
          const spot = this.pickTarget(true);
          const fuel = d.fire.findFuel(spot.x, spot.z, 22);
          const at = fuel ? fuel.pos : spot;
          n = d.fire.startFire(at.x, at.y + 0.4, at.z, lerp(3, 9, clamp01(magnitude)), 1 + magnitude);
        }
        h.data.seeds = n;
        if (!silent && n > 0) this.alert('Fire', 'Smoke is rising over the district', magnitude > 0.6, 6);
        break;
      }
      case 'gasleak': {
        h.duration = rng.range(6, 24);
        const spot = this.pickTarget(true);
        h.data.x = spot.x; h.data.y = spot.y; h.data.z = spot.z;
        h.data.energy = lerp(90000, 460000, clamp01(magnitude));
        h.data.delay = rng.range(1.5, 7);
        if (!silent) this.alert('Gas main ruptured', 'Something is going to ignite it', true, 6);
        break;
      }
      case 'lightningstorm': {
        h.duration = rng.range(50, 140);
        h.data.rate = lerp(0.5, 3.4, clamp01(magnitude));
        if (!silent) this.alert('Electrical storm', '', false, 4);
        break;
      }
      case 'eruption': {
        h.duration = rng.range(150, 300);
        h.data.ash = lerp(0.3, 0.95, clamp01(magnitude));
        this.alert('The mountain has woken', 'Ash, tremor and falling rock', true, 12);
        setTimeoutLike(this, 8, () => this.trigger('aftershock', magnitude * 0.8, true));
        break;
      }
      case 'ashfall': {
        h.duration = rng.range(90, 220);
        h.data.ash = lerp(0.25, 0.8, clamp01(magnitude));
        break;
      }
      case 'landslide': {
        h.duration = 16;
        const spot = this.pickSlope();
        h.data.x = spot.x; h.data.y = spot.y; h.data.z = spot.z;
        h.data.n = Math.round(lerp(30, 110, clamp01(magnitude)));
        this.alert('Landslide', 'The hillside is coming down', true, 7);
        break;
      }
      case 'collapse': {
        h.duration = 4;
        const b = this.pickBuilding();
        h.data.building = b ? b.id : -1;
        if (!silent && b) this.alert('Structure failing', 'A building is coming apart', true, 6);
        break;
      }
      case 'hail': {
        h.duration = rng.range(25, 70);
        h.data.size = lerp(0.03, 0.14, clamp01(magnitude));
        if (!silent) this.alert('Hail', '', false, 4);
        break;
      }
      case 'blackout': {
        h.duration = rng.range(60, 400);
        if (!silent) this.alert('Power grid down', '', false, 5);
        break;
      }
      case 'surge': {
        h.duration = 30;
        break;
      }
    }
    this.active.push(h);
    this.onHazard?.(h);
    return h;
  }

  private tickHazard(h: ActiveHazard, dt: number, player: Player) {
    const d = this.d;
    const k = clamp01(h.t / Math.max(0.01, h.duration));
    const ramp = Math.min(smoothstep(0, 0.12, k), 1 - smoothstep(0.75, 1, k));
    switch (h.kind) {
      case 'typhoon':
        this.target.windSpeed = Math.max(this.target.windSpeed, h.data.wind * ramp);
        this.target.rain = Math.max(this.target.rain, h.data.rain * ramp);
        this.target.rainRate = this.target.rain * 0.000032;
        this.target.windDir = h.data.dir + Math.sin(h.t * 0.05) * 0.5;
        this.target.storm = Math.max(this.target.storm, 0.85 * ramp);
        break;
      case 'downpour':
        this.target.rain = Math.max(this.target.rain, h.data.rain * ramp);
        this.target.rainRate = this.target.rain * 0.000032;
        break;
      case 'flood':
        d.water.riverSwell = h.data.river * ramp;
        d.water.drainHealth = Math.min(d.water.drainHealth, lerp(1, h.data.drain, ramp));
        break;
      case 'tsunami': {
        const warn = h.data.warn;
        if (h.t > warn) {
          const p = clamp01((h.t - warn) / 26);
          const fall = 1 - smoothstep(0.55, 1, clamp01((h.t - warn) / 150));
          // Draw-back first, then the wall of water.
          const draw = p < 0.18 ? -smoothstep(0, 0.18, p) * 2.6 : 0;
          d.water.surge = draw + smoothstep(0.16, 0.55, p) * h.data.height * fall;
          d.water.surgeVel = -lerp(0, 9.5, smoothstep(0.16, 0.5, p)) * fall;
        }
        break;
      }
      case 'gasleak': {
        if (h.t > h.data.delay && !h.data.fired) {
          h.data.fired = 1;
          d.fire.explode(new THREE.Vector3(h.data.x, h.data.y + 1.0, h.data.z), h.data.energy,
            8 + h.data.energy / 45000, player);
          d.fire.startFire(h.data.x, h.data.y + 1, h.data.z, 6, 1.6);
        }
        break;
      }
      case 'lightningstorm':
        this.target.lightningRate = Math.max(this.target.lightningRate, h.data.rate * ramp);
        this.target.storm = Math.max(this.target.storm, 0.7);
        break;
      case 'eruption': {
        this.target.ash = Math.max(this.target.ash, h.data.ash * ramp);
        this.target.fogBoost = Math.max(this.target.fogBoost, 0.5 * ramp);
        // Volcanic bombs arc into the city at intervals.
        h.data.bomb = (h.data.bomb ?? 0) - dt;
        if (h.data.bomb <= 0 && ramp > 0.25) {
          h.data.bomb = this.rng.range(1.6, 6.5) / (0.4 + h.magnitude);
          this.dropBomb(player);
        }
        h.data.tremor = (h.data.tremor ?? 0) - dt;
        if (h.data.tremor <= 0) {
          h.data.tremor = this.rng.range(18, 45);
          this.quakes.push(new Quake(this.rng.range(3.4, 4.8), this.rng.range(8, 18), this.rng));
        }
        break;
      }
      case 'ashfall':
        this.target.ash = Math.max(this.target.ash, h.data.ash * ramp);
        break;
      case 'hail':
        this.target.hail = Math.max(this.target.hail, ramp);
        h.data.next = (h.data.next ?? 0) - dt;
        if (h.data.next <= 0) { h.data.next = 0.09; this.dropHail(player, h.data.size); }
        break;
      case 'blackout':
        G.uPower.value = damp(G.uPower.value, 0, 6, dt);
        break;
      case 'landslide':
        if (!h.data.done) { h.data.done = 1; this.spawnLandslide(h.data.x, h.data.y, h.data.z, h.data.n); }
        break;
      case 'collapse':
        if (!h.data.done) {
          h.data.done = 1;
          const b = d.structure.buildings[h.data.building | 0];
          if (b) d.structure.triggerCollapse(b, this.rng.int(0, Math.max(0, b.floors - 2)), 0.5 + h.magnitude * 0.5);
        }
        break;
      case 'firestorm':
        h.data.next = (h.data.next ?? 0) - dt;
        if (h.data.next <= 0 && ramp > 0.2) {
          h.data.next = this.rng.range(4, 14);
          const s = this.pickTarget(true);
          const fuel = d.fire.findFuel(s.x, s.z, 26);
          const at = fuel ? fuel.pos : s;
          d.fire.startFire(at.x, at.y + 0.4, at.z, 3.5, 1.4);
        }
        break;
      default: break;
    }
  }

  private endHazard(h: ActiveHazard) {
    const d = this.d;
    switch (h.kind) {
      case 'flood': d.water.riverSwell = 0; d.water.drainHealth = 1; break;
      case 'tsunami': d.water.surge = 0; d.water.surgeVel = 0; break;
      case 'blackout': break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ helpers

  private pickTarget(preferDamaged: boolean): THREE.Vector3 {
    const d = this.d;
    const rng = this.rng;
    if (preferDamaged) {
      const damaged = d.structure.buildings.filter((b) => b.collapsedFrac > 0.02);
      if (damaged.length && rng.bool(0.6)) {
        const b = rng.pick(damaged);
        return new THREE.Vector3(b.cx + rng.range(-b.w / 3, b.w / 3), b.floorY[0] + 1, b.cz + rng.range(-b.d / 3, b.d / 3));
      }
    }
    // Prefer somewhere the player can actually see happen.
    const p = d.player.pos;
    for (let i = 0; i < 40; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(18, 130);
      const x = clamp(p.x + Math.cos(a) * r, -HALF + 12, HALF - 12);
      const z = clamp(p.z + Math.sin(a) * r, -HALF + 12, SHORE_Z - 12);
      if (d.plan.isBuilt(x, z) || d.plan.isRoad(x, z)) {
        return new THREE.Vector3(x, d.terrain.heightAt(x, z), z);
      }
    }
    return new THREE.Vector3(p.x + 30, d.terrain.heightAt(p.x + 30, p.z), p.z);
  }

  private pickSlope(): THREE.Vector3 {
    const d = this.d;
    let best = new THREE.Vector3(0, 0, -HALF + 40);
    let bestSlope = 0;
    const n = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      const x = this.rng.range(-HALF + 20, HALF - 20);
      const z = this.rng.range(-HALF + 20, Math.min(SHORE_Z - 40, HALF - 20));
      d.terrain.normalAt(x, z, n);
      const slope = 1 - n.y;
      const near = Math.hypot(x - d.player.pos.x, z - d.player.pos.z);
      const score = slope * (1 + clamp01(1 - near / 220));
      if (score > bestSlope) { bestSlope = score; best.set(x, d.terrain.heightAt(x, z), z); }
    }
    return best;
  }

  private pickBuilding(): Building | null {
    const bs = this.d.structure.buildings.filter((b) => !b.shell && b.collapsedFrac < 0.75);
    if (!bs.length) return null;
    const p = this.d.player.pos;
    // Prefer already-damaged buildings near the player — cause and effect the
    // player can actually watch.
    return this.rng.weighted(bs, (b) => {
      const dist = Math.hypot(b.cx - p.x, b.cz - p.z);
      return (0.25 + b.collapsedFrac * 3) * (1 + clamp01(1 - dist / 200) * 2.2);
    });
  }

  private dropBomb(player: Player) {
    const rng = this.rng;
    const a = rng.range(0, Math.PI * 2), r = rng.range(15, 170);
    const x = clamp(player.pos.x + Math.cos(a) * r, -HALF, HALF);
    const z = clamp(player.pos.z + Math.sin(a) * r, -HALF, SHORE_Z);
    const size = rng.range(0.5, 1.8);
    const e = this.d.spawn.chunk(
      new THREE.Vector3(x - 55, 190, z - 35),
      new THREE.Vector3(size, size * 0.85, size), MATERIALS.volcanicRock, rng.int(0, 7),
      { kind: Kind.Debris, vel: new THREE.Vector3(24, -18, 15) });
    e.temp = 900;
    e.set(F.NO_DESPAWN, false);
    if (e.view) e.view.pool.setGlow(e.view.idx, 1);
    if (e.body) e.body.enableCcd(true);
  }

  private dropHail(player: Player, size: number) {
    const rng = this.rng;
    const p = player.pos;
    for (let i = 0; i < 3; i++) {
      const x = p.x + rng.range(-40, 40), z = p.z + rng.range(-40, 40);
      const e = this.d.spawn.chunk(
        new THREE.Vector3(x, p.y + rng.range(38, 62), z),
        new THREE.Vector3(size, size, size), MATERIALS.ice, rng.int(0, 7),
        { kind: Kind.Debris, vel: new THREE.Vector3(this.d.wind.atPlayer.x * 0.6, -16, this.d.wind.atPlayer.z * 0.6) });
      e.set(F.FRAGMENT);
      if (e.body) e.body.setLinearDamping(0.02);
    }
  }

  private spawnLandslide(x: number, _y: number, z: number, n: number) {
    const rng = this.rng;
    const d = this.d;
    const n2 = new THREE.Vector3();
    d.terrain.normalAt(x, z, n2);
    const dir = new THREE.Vector3(n2.x, 0, n2.z).normalize();
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    d.activation.wakeArea(x, z, 40, 200);
    for (let i = 0; i < n; i++) {
      const ox = rng.range(-16, 16), oz = rng.range(-16, 16);
      const px = x + ox, pz = z + oz;
      const s = rng.range(0.5, 2.6);
      const mat = rng.bool(0.6) ? MATERIALS.soil : MATERIALS.stone;
      const e = d.spawn.chunk(
        new THREE.Vector3(px, d.terrain.heightAt(px, pz) + rng.range(1, 9), pz),
        new THREE.Vector3(s, s * 0.7, s), mat, rng.int(0, 7),
        { kind: Kind.Debris, vel: dir.clone().multiplyScalar(rng.range(4, 13)).setY(rng.range(-2, 1)) });
      e.set(F.DIGGABLE);
    }
  }

  private updateLightning(dt: number, player: Player) {
    this.flash = Math.max(0, this.flash - dt * (3.4 + this.flash * 5));
    const rate = this.weather.lightningRate;
    if (rate <= 0.01) return;
    this.strikeTimer -= dt * rate;
    if (this.strikeTimer > 0) return;
    this.strikeTimer = this.rng.range(1.4, 9.0) / Math.max(0.15, rate);

    const close = this.rng.bool(clamp(0.18 + this.intensity * 0.5, 0, 0.8));
    if (close) {
      // Strike the tallest thing near the player — a mast, a roof, a crane.
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(20, 150);
      const x = clamp(player.pos.x + Math.cos(a) * r, -HALF, HALF);
      const z = clamp(player.pos.z + Math.sin(a) * r, -HALF, SHORE_Z);
      const roof = this.d.plan.buildingHeightNear(x, z);
      const y = this.d.terrain.heightAt(x, z) + Math.max(2, roof);
      this.lastStrike.set(x, y, z);
      this.flash = 1.6;
      this.flashDir.set(x - player.pos.x, 60, z - player.pos.z).normalize();
      const energy = this.rng.range(2.5e5, 1.4e6);
      this.onStrike?.(this.lastStrike.clone(), energy);
      this.d.fire.startFire(x, y, z, 3.4, 1.4);
      this.d.activation.wakeArea(x, z, 12, 40);
      this.d.fire.explode(this.lastStrike, energy * 0.14, 5.5, player);
      // Electrified water: conduction is a material property, so this is free.
      if (this.d.water.depthAt(x, z) > 0.08) this.electrify(x, z, 13, 3.2);
    } else {
      this.flash = this.rng.range(0.45, 1.0);
      this.flashDir.set(this.rng.range(-1, 1), this.rng.range(0.4, 1.3), this.rng.range(-1, 1)).normalize();
      this.lastStrike.set(player.pos.x + this.flashDir.x * 400, 200, player.pos.z + this.flashDir.z * 400);
      this.onStrike?.(this.lastStrike.clone(), 0);
    }
  }

  /** Charge a patch of standing water. Anyone in it is in serious trouble. */
  electrify(x: number, z: number, radius: number, seconds: number) {
    this.live.push({ x, z, radius, t: seconds });
  }
  live: { x: number; z: number; radius: number; t: number }[] = [];

  updateElectric(dt: number, player: Player) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.t -= dt;
      if (l.t <= 0) { this.live.splice(i, 1); continue; }
      const d = Math.hypot(player.pos.x - l.x, player.pos.z - l.z);
      if (d < l.radius && player.submerged > 0.04) {
        player.hurt(dt * 46 * (1 - d / l.radius), 'electrocuted');
        player.addShake(0.6 * dt * 10);
      }
    }
  }

  /** Short, readable description of what is currently wrong with the world. */
  hazardSummary(): string[] {
    const out: string[] = [];
    for (const h of this.active) {
      if (h.kind === 'surge') continue;
      out.push(h.label);
    }
    if (this.quakes.length) out.unshift('Shaking');
    if (this.d.fire.burning.length > 6) out.push('Fire spreading');
    if (this.d.water.floodedFraction > 0.012) out.push('Water rising');
    return [...new Set(out)].slice(0, 5);
  }

  /**
   * Back to the opening second of a run: the clock, every hazard, and the
   * weather itself. A run always starts dry and calm, however long the city sat
   * behind the menu or whatever the last run left in the sky.
   */
  reset() {
    this.time = 0; this.intensity = 0; this.phaseIndex = -1; this.phase = 'calm'; this.active.length = 0; this.quakes.length = 0;
    this.alerts.length = 0; this.cooldowns.clear(); this.nextRoll = 58; this.live.length = 0;
    this.eventLog.length = 0; this.hazardCount = 0; this.started = false;
    Object.assign(this.weather, OPENING_WEATHER);
    this.target = { ...OPENING_WEATHER };
    this.flash = 0; this.strikeTimer = 3;
    this.d.forces.quakeAccel.set(0, 0, 0);
    this.d.wind.speed = OPENING_WEATHER.windSpeed;
    this.d.wind.dir = OPENING_WEATHER.windDir;
    this.d.water.rainRate = 0;
    G.uPower.value = 1;
  }
}

/** Tiny scheduled callback tied to the director's own clock. */
const pending: { d: Director; at: number; fn: () => void }[] = [];
function setTimeoutLike(d: Director, delay: number, fn: () => void) {
  pending.push({ d, at: d.time + delay, fn });
}
export function runPending(d: Director) {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (p.d !== d) { if (p.d.time === 0) pending.splice(i, 1); continue; }
    if (d.time >= p.at) { pending.splice(i, 1); p.fn(); }
  }
}
export function clearPending() { pending.length = 0; }

// ---------------------------------------------------------------------------
// The material registry. Every physical object in the world derives its
// behaviour from one of these — mass comes from density x volume, breaking
// comes from toughness x volume, burning comes from flammability and fuel,
// floating comes from density vs water, and so on. No system special-cases an
// object type; they all read these numbers.
// ---------------------------------------------------------------------------

export interface Mat {
  id: string;
  /** kg / m^3. Under 1000 floats in fresh water. */
  density: number;
  /** Energy per m^3 the material absorbs before it fractures (J/m^3, scaled down to keep numbers sane). */
  toughness: number;
  /** Structural stress the material tolerates before permanent damage. Higher = stiffer frame. */
  strength: number;
  /** 0..1. Resistance to being dug/scratched; also how much damage it deals as a tool. */
  hardness: number;
  /** 0..1. 1 = shatters into many small pieces (glass), 0 = dents and bends (steel). */
  brittleness: number;
  friction: number;
  restitution: number;
  /** 0..1 chance-weight that heat takes hold at all. 0 = cannot burn. */
  flammability: number;
  /** deg C at which sustained ignition happens. */
  ignitionTemp: number;
  /** kg of fuel consumed per second per m^2 of burning surface. */
  burnRate: number;
  /** J/(kg K), scaled — how much heat it takes to raise its temperature. */
  heatCapacity: number;
  /** 0..1 thermal conduction to touching objects. */
  conductivity: number;
  /** 0..1 electrical conduction. Water + metal + a downed line is a hazard. */
  eConductivity: number;
  /** 0..1. How much water it soaks up, gaining mass and losing strength. */
  absorbency: number;
  /** Base drag coefficient; final drag also uses the object's shape factor. */
  drag: number;
  /** Multiplier on how much heat weakens the structure (steel softens, stone does not). */
  heatWeakening: number;
  // --- appearance ---
  color: number;
  roughness: number;
  metalness: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** 0..1 — how much the surface darkens and sharpens when wet. */
  wetResponse: number;
  transparent?: boolean;
  opacity?: number;
}

const M = (m: Mat) => m;

export const MATERIALS = {
  concrete: M({
    id: 'concrete', density: 2350, toughness: 2600, strength: 2.6, hardness: 0.72, brittleness: 0.62,
    friction: 0.82, restitution: 0.06, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 880, conductivity: 0.35, eConductivity: 0.05, absorbency: 0.12, drag: 1.05,
    heatWeakening: 0.35, color: 0x9a9d9c, roughness: 0.93, metalness: 0.0, wetResponse: 0.85,
  }),
  rebarConcrete: M({
    id: 'rebarConcrete', density: 2500, toughness: 5200, strength: 5.0, hardness: 0.78, brittleness: 0.4,
    friction: 0.85, restitution: 0.05, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 870, conductivity: 0.42, eConductivity: 0.12, absorbency: 0.1, drag: 1.05,
    heatWeakening: 0.7, color: 0x8f9391, roughness: 0.9, metalness: 0.02, wetResponse: 0.85,
  }),
  steel: M({
    id: 'steel', density: 7850, toughness: 14000, strength: 9.5, hardness: 0.95, brittleness: 0.08,
    friction: 0.55, restitution: 0.24, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 480, conductivity: 0.95, eConductivity: 0.98, absorbency: 0, drag: 1.0,
    heatWeakening: 1.6, color: 0x7e878f, roughness: 0.42, metalness: 0.92, wetResponse: 0.5,
  }),
  aluminium: M({
    id: 'aluminium', density: 2700, toughness: 4200, strength: 3.4, hardness: 0.6, brittleness: 0.16,
    friction: 0.48, restitution: 0.3, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 900, conductivity: 0.98, eConductivity: 0.95, absorbency: 0, drag: 1.0,
    heatWeakening: 1.9, color: 0xb3bcc4, roughness: 0.3, metalness: 0.88, wetResponse: 0.4,
  }),
  glass: M({
    id: 'glass', density: 2500, toughness: 180, strength: 0.7, hardness: 0.85, brittleness: 1.0,
    friction: 0.28, restitution: 0.16, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 840, conductivity: 0.4, eConductivity: 0.01, absorbency: 0, drag: 1.1,
    heatWeakening: 1.1, color: 0x9fc4d8, roughness: 0.04, metalness: 0.02, wetResponse: 0.2,
    transparent: true, opacity: 0.26,
  }),
  wood: M({
    id: 'wood', density: 620, toughness: 1400, strength: 1.5, hardness: 0.35, brittleness: 0.45,
    friction: 0.62, restitution: 0.22, flammability: 0.8, ignitionTemp: 255, burnRate: 0.9,
    heatCapacity: 1700, conductivity: 0.12, eConductivity: 0.02, absorbency: 0.45, drag: 1.05,
    heatWeakening: 2.2, color: 0x8a6440, roughness: 0.78, metalness: 0, wetResponse: 0.7,
  }),
  plywood: M({
    id: 'plywood', density: 520, toughness: 900, strength: 0.9, hardness: 0.28, brittleness: 0.5,
    friction: 0.6, restitution: 0.18, flammability: 0.92, ignitionTemp: 235, burnRate: 1.2,
    heatCapacity: 1650, conductivity: 0.12, eConductivity: 0.02, absorbency: 0.6, drag: 1.15,
    heatWeakening: 2.4, color: 0xa88358, roughness: 0.84, metalness: 0, wetResponse: 0.72,
  }),
  brick: M({
    id: 'brick', density: 1900, toughness: 1500, strength: 1.7, hardness: 0.65, brittleness: 0.75,
    friction: 0.8, restitution: 0.05, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 840, conductivity: 0.3, eConductivity: 0.03, absorbency: 0.2, drag: 1.05,
    heatWeakening: 0.25, color: 0x8d5a4a, roughness: 0.92, metalness: 0, wetResponse: 0.8,
  }),
  plaster: M({
    id: 'plaster', density: 900, toughness: 260, strength: 0.4, hardness: 0.22, brittleness: 0.9,
    friction: 0.7, restitution: 0.05, flammability: 0.1, ignitionTemp: 420, burnRate: 0.2,
    heatCapacity: 1000, conductivity: 0.2, eConductivity: 0.02, absorbency: 0.7, drag: 1.1,
    heatWeakening: 1.4, color: 0xd6d2c8, roughness: 0.95, metalness: 0, wetResponse: 0.75,
  }),
  plastic: M({
    id: 'plastic', density: 940, toughness: 1100, strength: 0.8, hardness: 0.3, brittleness: 0.3,
    friction: 0.42, restitution: 0.42, flammability: 0.55, ignitionTemp: 340, burnRate: 0.7,
    heatCapacity: 1600, conductivity: 0.1, eConductivity: 0.0, absorbency: 0, drag: 1.1,
    heatWeakening: 2.8, color: 0xc9cdd2, roughness: 0.46, metalness: 0, wetResponse: 0.35,
  }),
  rubber: M({
    id: 'rubber', density: 1150, toughness: 3200, strength: 0.6, hardness: 0.2, brittleness: 0.02,
    friction: 1.05, restitution: 0.62, flammability: 0.5, ignitionTemp: 320, burnRate: 0.5,
    heatCapacity: 1900, conductivity: 0.08, eConductivity: 0.0, absorbency: 0.02, drag: 1.1,
    heatWeakening: 1.2, color: 0x2b2d30, roughness: 0.88, metalness: 0, wetResponse: 0.4,
  }),
  fabric: M({
    id: 'fabric', density: 260, toughness: 240, strength: 0.2, hardness: 0.08, brittleness: 0.15,
    friction: 0.7, restitution: 0.06, flammability: 0.95, ignitionTemp: 210, burnRate: 2.1,
    heatCapacity: 1400, conductivity: 0.06, eConductivity: 0, absorbency: 0.95, drag: 1.5,
    heatWeakening: 3.0, color: 0xa4483f, roughness: 0.96, metalness: 0, wetResponse: 0.9,
  }),
  cardboard: M({
    id: 'cardboard', density: 190, toughness: 130, strength: 0.14, hardness: 0.07, brittleness: 0.3,
    friction: 0.62, restitution: 0.08, flammability: 1.0, ignitionTemp: 205, burnRate: 2.4,
    heatCapacity: 1300, conductivity: 0.07, eConductivity: 0, absorbency: 0.98, drag: 1.4,
    heatWeakening: 3.4, color: 0xb08c5e, roughness: 0.96, metalness: 0, wetResponse: 0.95,
  }),
  foam: M({
    id: 'foam', density: 55, toughness: 90, strength: 0.08, hardness: 0.03, brittleness: 0.4,
    friction: 0.72, restitution: 0.18, flammability: 0.85, ignitionTemp: 250, burnRate: 3.0,
    heatCapacity: 1400, conductivity: 0.03, eConductivity: 0, absorbency: 0.25, drag: 1.5,
    heatWeakening: 3.0, color: 0xe6e3da, roughness: 0.98, metalness: 0, wetResponse: 0.3,
  }),
  asphalt: M({
    id: 'asphalt', density: 2200, toughness: 1500, strength: 1.4, hardness: 0.5, brittleness: 0.5,
    friction: 0.88, restitution: 0.03, flammability: 0.1, ignitionTemp: 480, burnRate: 0.25,
    heatCapacity: 920, conductivity: 0.25, eConductivity: 0.02, absorbency: 0.05, drag: 1.05,
    heatWeakening: 1.2, color: 0x33383d, roughness: 0.94, metalness: 0, wetResponse: 1.0,
  }),
  soil: M({
    id: 'soil', density: 1500, toughness: 300, strength: 0.25, hardness: 0.18, brittleness: 0.6,
    friction: 0.95, restitution: 0.02, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 1200, conductivity: 0.2, eConductivity: 0.25, absorbency: 0.8, drag: 1.1,
    heatWeakening: 0, color: 0x5b4a38, roughness: 1.0, metalness: 0, wetResponse: 0.9,
  }),
  stone: M({
    id: 'stone', density: 2700, toughness: 3400, strength: 3.2, hardness: 0.88, brittleness: 0.7,
    friction: 0.85, restitution: 0.08, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 850, conductivity: 0.32, eConductivity: 0.03, absorbency: 0.06, drag: 1.05,
    heatWeakening: 0.15, color: 0x6f7377, roughness: 0.88, metalness: 0, wetResponse: 0.85,
  }),
  vegetation: M({
    id: 'vegetation', density: 480, toughness: 700, strength: 0.7, hardness: 0.2, brittleness: 0.25,
    friction: 0.7, restitution: 0.2, flammability: 0.6, ignitionTemp: 290, burnRate: 1.4,
    heatCapacity: 2400, conductivity: 0.1, eConductivity: 0.1, absorbency: 0.7, drag: 1.7,
    heatWeakening: 2.0, color: 0x3f6b3a, roughness: 0.9, metalness: 0, wetResponse: 0.6,
  }),
  neon: M({
    id: 'neon', density: 1100, toughness: 200, strength: 0.3, hardness: 0.4, brittleness: 0.95,
    friction: 0.45, restitution: 0.2, flammability: 0.2, ignitionTemp: 380, burnRate: 0.3,
    heatCapacity: 900, conductivity: 0.4, eConductivity: 0.6, absorbency: 0, drag: 1.2,
    heatWeakening: 1.6, color: 0x101318, roughness: 0.35, metalness: 0.3,
    emissive: 0xff3366, emissiveIntensity: 3.2, wetResponse: 0.35,
  }),
  paintedSteel: M({
    id: 'paintedSteel', density: 7600, toughness: 9000, strength: 7.0, hardness: 0.9, brittleness: 0.12,
    friction: 0.5, restitution: 0.26, flammability: 0.05, ignitionTemp: 600, burnRate: 0.1,
    heatCapacity: 490, conductivity: 0.9, eConductivity: 0.9, absorbency: 0, drag: 1.0,
    heatWeakening: 1.5, color: 0xcf4a3a, roughness: 0.48, metalness: 0.7, wetResponse: 0.45,
  }),
  chrome: M({
    id: 'chrome', density: 7200, toughness: 8000, strength: 6.0, hardness: 0.93, brittleness: 0.2,
    friction: 0.4, restitution: 0.3, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 460, conductivity: 0.92, eConductivity: 0.94, absorbency: 0, drag: 1.0,
    heatWeakening: 1.4, color: 0xd8dde2, roughness: 0.12, metalness: 1.0, wetResponse: 0.3,
  }),
  ceramic: M({
    id: 'ceramic', density: 2300, toughness: 400, strength: 0.9, hardness: 0.8, brittleness: 0.95,
    friction: 0.6, restitution: 0.14, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 800, conductivity: 0.3, eConductivity: 0.01, absorbency: 0.05, drag: 1.1,
    heatWeakening: 0.5, color: 0xe4e6e3, roughness: 0.22, metalness: 0, wetResponse: 0.3,
  }),
  ice: M({
    id: 'ice', density: 917, toughness: 300, strength: 0.5, hardness: 0.35, brittleness: 0.9,
    friction: 0.09, restitution: 0.14, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 2100, conductivity: 0.5, eConductivity: 0.1, absorbency: 0, drag: 1.05,
    heatWeakening: 6.0, color: 0xcfe8f5, roughness: 0.12, metalness: 0, wetResponse: 0.2,
    transparent: true, opacity: 0.7,
  }),
  volcanicRock: M({
    id: 'volcanicRock', density: 2100, toughness: 1800, strength: 2.0, hardness: 0.8, brittleness: 0.7,
    friction: 0.95, restitution: 0.06, flammability: 0, ignitionTemp: 9999, burnRate: 0,
    heatCapacity: 840, conductivity: 0.3, eConductivity: 0.05, absorbency: 0.2, drag: 1.1,
    heatWeakening: 0, color: 0x33302e, roughness: 0.96, metalness: 0,
    emissive: 0xff4400, emissiveIntensity: 0, wetResponse: 0.7,
  }),
} as const;

export type MatId = keyof typeof MATERIALS;
export const MAT_LIST = Object.values(MATERIALS) as Mat[];
export function mat(id: MatId): Mat { return MATERIALS[id]; }

// --- Environment constants -------------------------------------------------
export const WATER_DENSITY = 1000;      // kg/m^3
export const AIR_DENSITY = 1.225;       // kg/m^3
export const GRAVITY = -9.81;           // m/s^2
export const AMBIENT_TEMP = 17;         // deg C, a wet autumn evening

/**
 * Derived, per-object physical facts. Shape matters as much as substance: the
 * same mass in a flat sheet catches wind and is awkward to carry, while a
 * compact block is neither.
 */
export function shapeFactors(hx: number, hy: number, hz: number) {
  const dims = [hx * 2, hy * 2, hz * 2].sort((a, b) => a - b);
  const [smallest, mid, largest] = dims;
  const volume = 8 * hx * hy * hz;
  // 0 = cube, 1 = extremely flat or thin
  const aspect = 1 - smallest / (largest || 1e-6);
  // Sheets and planks catch far more air than their volume suggests.
  const dragBoost = 1 + aspect * aspect * 1.35;
  // Carrying: long or wide things are unwieldy even when light.
  const awkwardness = Math.min(1, (largest - 0.45) / 2.6) * (0.55 + 0.45 * aspect) +
                      Math.min(0.5, (mid - 0.4) / 3.0) * 0.4;
  return { volume, aspect, dragBoost, awkwardness: Math.max(0, Math.min(1.6, awkwardness)), largest, mid, smallest };
}

/** Energy (J) this object absorbs before it fractures. */
export function breakEnergy(m: Mat, volume: number, integrity: number) {
  return m.toughness * Math.pow(volume, 0.82) * 42 * Math.max(0.06, integrity);
}

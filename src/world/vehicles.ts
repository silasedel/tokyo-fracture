import * as THREE from 'three';
import * as GEO from '../render/geometry';
import { makeMaterial } from '../render/materials';
import { MATERIALS } from '../physics/materials';
import { F, Kind, type Entity } from '../physics/entity';
import type { ColliderPart } from '../physics/physworld';
import type { Spawner } from './spawn';
import { Rng } from '../util/math';
import { emissiveMat } from './props';

export type VehicleKind = 'sedan' | 'kei' | 'taxi' | 'van' | 'bus' | 'truck' | 'scooter' | 'police';

interface VDef {
  L: number; W: number; H: number;      // body envelope
  cabL: number; cabH: number; cabOff: number;
  wheelR: number; wheelW: number; axle: number;
  mass: number; color: number; roofBox?: boolean; box?: boolean; sign?: boolean;
}

const DEFS: Record<VehicleKind, VDef> = {
  sedan:   { L: 4.42, W: 1.80, H: 0.78, cabL: 2.25, cabH: 0.62, cabOff: -0.18, wheelR: 0.33, wheelW: 0.22, axle: 1.32, mass: 1420, color: 0x8d9298 },
  kei:     { L: 3.42, W: 1.50, H: 0.92, cabL: 2.10, cabH: 0.68, cabOff: -0.10, wheelR: 0.28, wheelW: 0.18, axle: 1.08, mass: 860,  color: 0xe8e9ea },
  taxi:    { L: 4.62, W: 1.76, H: 0.82, cabL: 2.35, cabH: 0.66, cabOff: -0.16, wheelR: 0.33, wheelW: 0.21, axle: 1.36, mass: 1520, color: 0x1a2c4e, sign: true },
  police:  { L: 4.60, W: 1.80, H: 0.80, cabL: 2.30, cabH: 0.64, cabOff: -0.16, wheelR: 0.33, wheelW: 0.22, axle: 1.36, mass: 1560, color: 0x0f1216, roofBox: true },
  // Box-bodied vehicles are built 2H tall above the sill: a van stands about
  // 2 m, a truck a little under 3 m, a bus just over 3 m.
  van:     { L: 4.90, W: 1.90, H: 0.80, cabL: 1.60, cabH: 0.55, cabOff: 1.20, wheelR: 0.35, wheelW: 0.24, axle: 1.52, mass: 2350, color: 0xdfe1e2, box: true },
  bus:     { L: 10.6, W: 2.50, H: 1.30, cabL: 0,    cabH: 0,    cabOff: 0,    wheelR: 0.48, wheelW: 0.30, axle: 3.40, mass: 12800, color: 0x2f6e46, box: true },
  truck:   { L: 7.40, W: 2.34, H: 1.18, cabL: 1.90, cabH: 0.9,  cabOff: 2.30, wheelR: 0.45, wheelW: 0.28, axle: 2.40, mass: 7600, color: 0xb9bcbe, box: true },
  scooter: { L: 1.82, W: 0.62, H: 0.62, cabL: 0,    cabH: 0,    cabOff: 0,    wheelR: 0.22, wheelW: 0.10, axle: 0.62, mass: 118,  color: 0x3d4a58 },
};

const PAINT = [0xb8babd, 0x343a42, 0xd8dade, 0x35558a, 0x8d3438, 0x35664a, 0xa07c52, 0xc9c2b4];

const RB = (w: number, h: number, d: number, r: number, x = 0, y = 0, z = 0) =>
  GEO.translated(GEO.beveledBox(w, h, d, r, 2).clone(), x, y, z);
const CYZ = (r: number, len: number, seg: number, x: number, y: number, z: number) => {
  const g = GEO.cylinder(r, len, seg).clone(); g.rotateX(Math.PI / 2); g.translate(x, y, z); return g;
};
const slab = (w: number, h: number, d: number, rot: number, x: number, y: number, z: number) =>
  GEO.transformed(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeRotationZ(rot).setPosition(x, y, z));

/**
 * A wheel that reads as a wheel: tyre, a dished rim face, a hub and a brake
 * disc behind it. Six of these per bus, so the section counts stay modest.
 */
function wheel(r: number, w: number, x: number, y: number, z: number) {
  const g: THREE.BufferGeometry[] = [];
  const tyre = GEO.cylinder(r, w, 12).clone();
  tyre.rotateZ(Math.PI / 2); tyre.translate(x, y, z); g.push(tyre);
  const shoulder = GEO.cylinder(r * 0.94, w + 0.03, 12).clone();
  shoulder.rotateZ(Math.PI / 2); shoulder.translate(x, y, z); g.push(shoulder);
  const sx = Math.sign(z) || 1;
  const rim = GEO.cylinder(r * 0.60, 0.035, 10).clone();
  rim.rotateZ(Math.PI / 2); rim.translate(x, y, z + sx * (w / 2 + 0.005)); g.push(rim);
  const hub = GEO.cylinder(r * 0.22, 0.05, 8).clone();
  hub.rotateZ(Math.PI / 2); hub.translate(x, y, z + sx * (w / 2 + 0.02)); g.push(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(r * 0.09, r * 0.62, 0.02);
    g.push(GEO.transformed(spoke, new THREE.Matrix4().makeRotationX(a)
      .setPosition(x, y, z + sx * (w / 2 + 0.028))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, 0))));
    const m = new THREE.Matrix4().makeRotationX(a);
    m.setPosition(x, y + Math.cos(a) * r * 0.32, z + sx * (w / 2 + 0.028) + Math.sin(a) * r * 0.32);
    g.push(GEO.transformed(new THREE.BoxGeometry(r * 0.10, r * 0.34, 0.02), m));
  }
  return g;
}

/** Flared arch over a wheel, built from five short facets. */
function arch(r: number, w: number, x: number, y: number, z: number) {
  const g: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -1.0 + i * 0.5;
    const m = new THREE.Matrix4().makeRotationZ(a);
    m.setPosition(x + Math.sin(a) * (r + 0.05), y + Math.cos(a) * (r + 0.05), z);
    g.push(GEO.transformed(new THREE.BoxGeometry(r * 0.56, 0.06, w + 0.14), m));
  }
  return g;
}

export function vehicleGeo(kind: VehicleKind): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const d = DEFS[kind];
  const key = `veh_${kind}`;
  const sill = d.wheelR + 0.02;                 // underside of the body
  const belt = sill + d.H;                      // beltline, where the glass starts
  const roof = belt + d.cabH;

  const body = GEO.composite(key, () => {
    const g: THREE.BufferGeometry[] = [];

    if (kind === 'scooter') {
      g.push(RB(0.86, 0.22, 0.40, 0.09, -0.08, 0.54, 0));           // floorpan
      g.push(RB(0.52, 0.46, 0.38, 0.13, 0.50, 0.66, 0));            // leg shield
      g.push(RB(0.60, 0.20, 0.36, 0.08, -0.40, 0.76, 0));           // seat
      g.push(RB(0.30, 0.26, 0.34, 0.07, -0.70, 0.90, 0));           // top box
      g.push(GEO.transformed(GEO.cylinder(0.035, 0.52, 6), new THREE.Matrix4().makeRotationZ(0.3).setPosition(0.66, 0.80, 0)));
      g.push(CYZ(0.026, 0.58, 6, 0.70, 1.02, 0));                   // bar
      for (const sz of [-0.26, 0.26]) g.push(CYZ(0.034, 0.10, 6, 0.70, 1.02, sz));
      g.push(RB(0.16, 0.18, 0.26, 0.05, 0.74, 0.86, 0));            // headlamp nacelle
      g.push(...wheel(d.wheelR, d.wheelW, 0.70, d.wheelR, 0));
      g.push(...wheel(d.wheelR, d.wheelW, -0.68, d.wheelR, 0));
      for (const sx of [0.70, -0.68]) {
        g.push(GEO.transformed(new THREE.BoxGeometry(0.34, 0.05, 0.16),
          new THREE.Matrix4().makeTranslation(sx, d.wheelR + 0.24, 0)));
      }
      return GEO.merge(g);
    }

    if (d.box) {
      // van / bus / truck: a slab-sided box with a real waistline and skirts
      const bl = kind === 'truck' ? d.L - d.cabL - 0.2 : d.L;
      const bx = kind === 'truck' ? -(d.cabL / 2 + 0.1) : 0;
      const top = sill + d.H * 2.05;
      g.push(RB(bl, d.H * 2.0, d.W, 0.10, bx, sill + d.H, 0));
      g.push(RB(bl + 0.04, 0.08, d.W + 0.04, 0.02, bx, top, 0));    // roof cap
      g.push(RB(bl - 0.1, 0.10, d.W + 0.05, 0.03, bx, belt - 0.05, 0));  // waist rail
      g.push(RB(bl - 0.3, 0.16, d.W + 0.04, 0.04, bx, sill + 0.06, 0));  // skirt
      if (kind === 'truck') {
        g.push(RB(d.cabL, d.H * 1.55, d.W - 0.06, 0.12, d.cabOff - 0.4, sill + d.H * 0.82, 0));
        g.push(RB(d.cabL * 0.5, 0.18, d.W - 0.1, 0.05, d.cabOff + 0.35, sill + d.H * 1.62, 0)); // sun visor
        g.push(RB(0.22, 0.34, d.W - 0.5, 0.06, d.cabOff + d.cabL / 2 - 0.05, sill + 0.34, 0)); // grille
        g.push(CYZ(0.07, 0.1, 8, d.cabOff - d.cabL / 2 - 0.1, sill + d.H * 1.2, -d.W / 2 + 0.2));          // stack bracket
        g.push(GEO.translated(GEO.cylinder(0.065, 1.3, 8).clone(), d.cabOff - d.cabL / 2 - 0.1, sill + d.H * 1.5 + 0.2, -d.W / 2 + 0.2)); // exhaust stack
      }
      if (kind === 'bus') {
        for (let x = -d.L / 2 + 1.35; x < d.L / 2 - 0.8; x += 1.35) {
          g.push(RB(0.09, d.H * 1.5, d.W + 0.02, 0.02, x, sill + d.H * 1.2, 0));   // pillars
        }
        g.push(RB(d.L - 0.5, 0.12, d.W - 0.24, 0.04, 0, top + 0.06, 0));           // roof ribs
        g.push(RB(1.1, 0.30, d.W - 0.5, 0.06, d.L / 2 - 0.05, sill + 0.22, 0));    // front skirt
        g.push(RB(0.9, 0.5, 0.10, 0.03, d.L / 2 - 1.5, sill + d.H * 1.1, d.W / 2)); // door line
      }
      if (kind === 'van') {
        g.push(RB(0.10, d.H * 1.5, d.W + 0.02, 0.02, -0.2, sill + d.H * 1.15, 0)); // B pillar
        g.push(RB(0.20, 0.30, d.W - 0.4, 0.05, d.L / 2 - 0.03, sill + 0.30, 0));   // grille
      }
      // bumpers, plate, exhaust
      g.push(RB(0.24, 0.26, d.W + 0.05, 0.07, d.L / 2 - 0.06, sill + 0.06, 0));
      g.push(RB(0.24, 0.26, d.W + 0.05, 0.07, -d.L / 2 + 0.06, sill + 0.06, 0));
      g.push(RB(0.05, 0.14, 0.32, 0.01, -d.L / 2 + 0.01, sill + 0.14, 0.3));
      const zsB = [d.W / 2 - d.wheelW / 2 - 0.02, -(d.W / 2 - d.wheelW / 2 - 0.02)];
      const xsB = [d.axle / 2 + 0.7, -d.axle / 2 - 0.2];
      for (const x of xsB) for (const z of zsB) {
        g.push(...wheel(d.wheelR, d.wheelW, x, d.wheelR, z));
        g.push(...arch(d.wheelR, d.wheelW, x, d.wheelR, z));
      }
      for (const z of [d.W / 2 + 0.07, -(d.W / 2 + 0.07)]) {
        g.push(RB(0.22, 0.13, 0.11, 0.03, d.L / 2 - 0.9, belt + 0.14, z));
        g.push(GEO.transformed(GEO.cylinder(0.02, 0.16, 5), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(d.L / 2 - 0.9, belt + 0.10, z * 0.93)));
      }
      return GEO.merge(g);
    }

    // ---- car ----------------------------------------------------------
    const hoodX = d.L * 0.30, bootX = -d.L * 0.34;
    g.push(RB(d.L, d.H * 0.86, d.W, 0.12, 0, sill + d.H * 0.43, 0));          // lower body
    g.push(RB(d.L * 0.42, 0.16, d.W - 0.10, 0.06, hoodX, belt - 0.06, 0));    // bonnet
    g.push(RB(d.L * 0.30, 0.15, d.W - 0.12, 0.06, bootX, belt - 0.07, 0));    // boot lid
    g.push(RB(d.L - 0.30, 0.10, d.W + 0.02, 0.03, 0, belt - 0.10, 0));        // beltline
    // greenhouse: roof panel plus raked pillars, so it is not a box on a box
    const cabL = d.cabL, cx = d.cabOff;
    g.push(RB(cabL * 0.80, 0.09, d.W - 0.24, 0.05, cx - 0.04, roof - 0.04, 0));
    g.push(slab(0.09, d.cabH * 1.12, d.W - 0.26, -0.58, cx + cabL / 2 - 0.10, (belt + roof) / 2, 0));  // A pillar plane
    g.push(slab(0.09, d.cabH * 1.05, d.W - 0.32, 0.66, cx - cabL / 2 + 0.10, (belt + roof) / 2, 0));   // C pillar plane
    for (const sz of [-1, 1]) {
      const z = sz * (d.W / 2 - 0.05);
      g.push(RB(cabL * 0.86, d.cabH, 0.07, 0.03, cx, (belt + roof) / 2 + 0.02, z));   // side glass frame
      g.push(RB(0.07, d.cabH, 0.09, 0.02, cx, (belt + roof) / 2, z));                 // B pillar
      g.push(RB(0.16, 0.04, 0.05, 0.01, cx + 0.30, belt + 0.10, z + sz * 0.03));      // door handles
      g.push(RB(0.16, 0.04, 0.05, 0.01, cx - 0.42, belt + 0.10, z + sz * 0.03));
      g.push(RB(d.L - 0.9, 0.05, 0.04, 0.01, -0.05, sill + d.H * 0.20, z + sz * 0.02)); // shut line / rubbing strip
    }
    // front and rear treatment
    g.push(RB(0.16, 0.20, d.W - 0.34, 0.05, d.L / 2 - 0.04, sill + d.H * 0.52, 0));   // grille
    g.push(RB(0.22, 0.24, d.W + 0.03, 0.07, d.L / 2 - 0.08, sill + d.H * 0.20, 0));   // front bumper
    g.push(RB(0.22, 0.24, d.W + 0.03, 0.07, -d.L / 2 + 0.08, sill + d.H * 0.20, 0));  // rear bumper
    g.push(RB(0.04, 0.12, 0.30, 0.01, d.L / 2 - 0.02, sill + d.H * 0.12, -0.1));      // plate
    g.push(RB(0.04, 0.12, 0.30, 0.01, -d.L / 2 + 0.02, sill + d.H * 0.12, 0.1));
    g.push(GEO.transformed(GEO.cylinder(0.035, 0.14, 6), new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(-d.L / 2 + 0.04, sill + 0.02, 0.32)));
    // wheels and arches
    const zs = [d.W / 2 - d.wheelW / 2 - 0.02, -(d.W / 2 - d.wheelW / 2 - 0.02)];
    for (const x of [d.axle / 2, -d.axle / 2]) for (const z of zs) {
      g.push(...wheel(d.wheelR, d.wheelW, x, d.wheelR, z));
      g.push(...arch(d.wheelR, d.wheelW, x, d.wheelR, z));
    }
    // mirrors on stalks
    for (const z of [d.W / 2 + 0.03, -(d.W / 2 + 0.03)]) {
      g.push(GEO.transformed(GEO.cylinder(0.018, 0.10, 5), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(cx + cabL / 2 - 0.08, belt + 0.10, z)));
      g.push(RB(0.19, 0.10, 0.07, 0.03, cx + cabL / 2 - 0.08, belt + 0.12, z + Math.sign(z) * 0.06));
    }
    if (d.roofBox) {
      g.push(RB(1.0, 0.12, 0.36, 0.04, cx, roof + 0.06, 0));
      for (const sx of [-0.34, 0.34]) g.push(RB(0.26, 0.14, 0.30, 0.05, cx + sx, roof + 0.10, 0));
    }
    if (d.sign) {
      g.push(RB(0.46, 0.20, 0.28, 0.05, cx + 0.2, roof + 0.10, 0));
      g.push(RB(0.10, 0.06, 0.20, 0.02, cx + 0.2, roof - 0.01, 0));
    }
    return GEO.merge(g);
  });

  const glass = GEO.composite(`${key}_g`, () => {
    const g: THREE.BufferGeometry[] = [];
    if (kind === 'scooter') return GEO.merge([GEO.translated(new THREE.BoxGeometry(0.03, 0.34, 0.34), 0.72, 1.02, 0)]);
    if (d.box) {
      const cy = sill + d.H * (kind === 'truck' ? 1.05 : 1.30);
      const cx = kind === 'truck' ? d.cabOff - 0.4 + d.cabL / 2 - 0.05 : d.L / 2 - 0.04;
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, d.H * 0.72, d.W - 0.30), cx, cy + 0.12, 0));
      if (kind === 'bus') {
        for (let x = -d.L / 2 + 0.75; x < d.L / 2 - 0.9; x += 1.35) {
          g.push(GEO.translated(new THREE.BoxGeometry(1.18, d.H * 0.80, 0.04), x, cy + 0.16, d.W / 2 - 0.02));
          g.push(GEO.translated(new THREE.BoxGeometry(1.18, d.H * 0.80, 0.04), x, cy + 0.16, -d.W / 2 + 0.02));
        }
        g.push(GEO.translated(new THREE.BoxGeometry(0.05, d.H * 0.7, d.W - 0.34), -d.L / 2 + 0.05, cy + 0.12, 0));
      } else {
        g.push(GEO.translated(new THREE.BoxGeometry(1.0, d.H * 0.58, 0.04), cx - 0.65, cy + 0.10, d.W / 2 - 0.035));
        g.push(GEO.translated(new THREE.BoxGeometry(1.0, d.H * 0.58, 0.04), cx - 0.65, cy + 0.10, -d.W / 2 + 0.035));
      }
      return GEO.merge(g);
    }
    const cx = d.cabOff, cabL = d.cabL, cy = (belt + roof) / 2;
    g.push(slab(0.04, d.cabH * 1.06, d.W - 0.34, -0.58, cx + cabL / 2 - 0.10, cy, 0));   // windscreen
    g.push(slab(0.04, d.cabH * 0.98, d.W - 0.40, 0.66, cx - cabL / 2 + 0.10, cy, 0));    // backlight
    for (const sz of [-1, 1]) {
      const z = sz * (d.W / 2 - 0.045);
      g.push(GEO.translated(new THREE.BoxGeometry(cabL * 0.38, d.cabH * 0.72, 0.03), cx + cabL * 0.20, cy + 0.02, z));
      g.push(GEO.translated(new THREE.BoxGeometry(cabL * 0.32, d.cabH * 0.66, 0.03), cx - cabL * 0.24, cy + 0.02, z));
    }
    return GEO.merge(g);
  });

  const lights = GEO.composite(`${key}_l`, () => {
    if (kind === 'scooter') return GEO.translated(new THREE.BoxGeometry(0.05, 0.14, 0.18), 0.81, 0.86, 0);
    const g: THREE.BufferGeometry[] = [];
    const ly = d.box ? sill + 0.34 : sill + d.H * 0.52;
    for (const z of [d.W / 2 - 0.28, -(d.W / 2 - 0.28)]) {
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 0.17, 0.40), d.L / 2 - 0.02, ly, z));
      g.push(GEO.translated(new THREE.BoxGeometry(0.05, 0.15, 0.34), -d.L / 2 + 0.02, ly, z));
    }
    if (d.roofBox) {
      g.push(GEO.translated(new THREE.BoxGeometry(0.24, 0.10, 0.26), d.cabOff - 0.34, roof + 0.10, 0));
      g.push(GEO.translated(new THREE.BoxGeometry(0.24, 0.10, 0.26), d.cabOff + 0.34, roof + 0.10, 0));
    }
    if (d.sign) g.push(GEO.translated(new THREE.BoxGeometry(0.40, 0.14, 0.24), d.cabOff + 0.2, roof + 0.10, 0));
    return GEO.merge(g);
  });

  return { body, glass, lights };
}

/**
 * Collision hulls taken from the vehicle's own surface, so the body you walk
 * into is the body you see. A car gets two, the body up to the beltline and
 * the glasshouse above it; a truck's cab and box are separate; the wing
 * mirrors, standing proud of everything, are left out.
 */
const HULLS = new Map<VehicleKind, Float32Array[]>();
function vehicleHulls(kind: VehicleKind): Float32Array[] {
  const cached = HULLS.get(kind);
  if (cached) return cached;
  const d = DEFS[kind];
  const { body, glass, lights } = vehicleGeo(kind);
  const belt = d.wheelR + 0.02 + d.H;
  const car = !d.box && kind !== 'scooter';
  const boxFront = -(d.cabL / 2 + 0.1) + (d.L - d.cabL - 0.2) / 2;
  const buckets: number[][] = car || kind === 'truck' ? [[], []] : [[]];
  for (const g of [body, glass, lights]) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // the mirrors stand out at the beltline; the wheel arches below it stay in
      if (Math.abs(z) > d.W / 2 + 0.06 && y > belt - 0.2) continue;
      if (car) {
        if (y <= belt + 0.02) buckets[0].push(x, y, z);
        if (y >= belt - 0.12) buckets[1].push(x, y, z);
      } else if (kind === 'truck') {
        buckets[x > boxFront ? 0 : 1].push(x, y, z);
      } else buckets[0].push(x, y, z);
    }
  }
  const out = buckets.filter((b) => b.length >= 12).map((b) => new Float32Array(b));
  HULLS.set(kind, out);
  return out;
}

/** Overall length, width and height, for finding somewhere it fits. */
export function vehicleSize(kind: VehicleKind) {
  const d = DEFS[kind];
  return { L: d.L, W: d.W, H: d.wheelR + (d.box ? d.H * 2.2 : d.H + d.cabH) };
}

export function spawnVehicle(spawn: Spawner, kind: VehicleKind, rng: Rng,
                             x: number, y: number, z: number, rotY: number): Entity {
  const d = DEFS[kind];
  const { body, glass, lights } = vehicleGeo(kind);
  const color = kind === 'taxi' || kind === 'police' || kind === 'bus' ? d.color : rng.pick(PAINT);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const bodyH = d.box ? d.H * 2.2 : d.H + d.cabH;
  const centreY = d.wheelR + bodyH / 2 - 0.06;
  // Collision is the vehicle's own surface. It includes the tyres, so a
  // parked car rests on them rather than dropping onto a box set at sill height.
  const parts: ColliderPart[] = vehicleHulls(kind).map((points) => ({ shape: 'hull' as const, points, friction: 0.72 }));
  const glassMat = makeMaterial(MATERIALS.glass, {
    instanced: true, transparent: true, opacity: 0.30, roughOverride: 0.03,
    colorOverride: 0x0d1418, metalOverride: 0.1, envIntensity: 1.6,
  });
  const e = spawn.prop({
    geoKey: `veh_${kind}`, geometry: body,
    material: makeMaterial(MATERIALS.paintedSteel, {
      instanced: true, vary: 0.1, colorOverride: color, roughOverride: 0.24, metalOverride: 0.55, envIntensity: 1.8,
    }),
    pos: new THREE.Vector3(x, y, z), quat: q,
    half: new THREE.Vector3(d.L / 2, bodyH / 2, d.W / 2),
    mat: MATERIALS.paintedSteel, body: spawn.sceneryBody ? 'fixed' : 'dynamic', kind: Kind.Vehicle, parts,
    flags: F.BREAKABLE | F.HOLLOW | F.GLASS | F.FLAMMABLE | (spawn.sceneryBody ? F.DORMANT : 0),
    hollow: 0.80, massOverride: d.mass, capacity: 16, attachTo: spawn.sceneryBody,
    label: kind, sleeping: true, linearDamping: 0.35, angularDamping: 0.6,
    extras: [
      { geoKey: `veh_${kind}_g`, geometry: glass, material: glassMat, cast: false, renderOrder: 1, capacity: 16 },
      { geoKey: `veh_${kind}_l`, geometry: lights, material: emissiveMat(kind === 'police' ? 0xff3344 : 0xffe4b0, 1.6), cast: false, capacity: 16 },
    ],
  });
  void centreY;
  e.fuel = 45;
  return e;
}

export const VEHICLE_KINDS: VehicleKind[] = ['sedan', 'kei', 'taxi', 'van', 'sedan', 'kei', 'scooter', 'truck', 'sedan', 'police', 'bus'];

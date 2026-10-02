import * as THREE from 'three';
import * as GEO from '../render/geometry';
import { makeMaterial, simpleMaterial } from '../render/materials';
import { MATERIALS, type Mat } from '../physics/materials';
import { F, Kind, type Entity } from '../physics/entity';
import type { ColliderPart } from '../physics/physworld';
import type { Spawner } from './spawn';
import { Rng } from '../util/math';
import type { Foot, Footprints } from './footprints';

const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0) =>
  GEO.translated(new THREE.BoxGeometry(w, h, d), x, y, z);
const RB = (w: number, h: number, d: number, r = 0.03, x = 0, y = 0, z = 0) =>
  GEO.translated(GEO.beveledBox(w, h, d, r, 1).clone(), x, y, z);
const CY = (r: number, h: number, seg = 10, x = 0, y = 0, z = 0) =>
  GEO.translated(GEO.cylinder(r, h, seg).clone(), x, y, z);
const rotG = (g: THREE.BufferGeometry, rx: number, ry = 0, rz = 0) => {
  const c = g.clone(); c.rotateX(rx); c.rotateY(ry); c.rotateZ(rz); return c;
};
/** Truncated cone standing on its base. */
const TP = (rb: number, rt: number, h: number, seg = 10, x = 0, y = 0, z = 0) =>
  GEO.translated(GEO.taper(rb, rt, h, seg).clone(), x, y, z);
/** Ring lying flat (axis vertical), e.g. a rim or a collar. */
const RINGY = (r: number, t: number, x = 0, y = 0, z = 0, radial = 4, tub = 10) =>
  GEO.translated(rotG(GEO.torus(r, t, radial, tub), Math.PI / 2), x, y, z);
/** Ring standing upright facing +/-X, e.g. a bicycle wheel. */
const RINGX = (r: number, t: number, x = 0, y = 0, z = 0, radial = 4, tub = 12) =>
  GEO.translated(rotG(GEO.torus(r, t, radial, tub), 0, Math.PI / 2), x, y, z);
/** Cylinder lying along X. */
const CYX = (r: number, len: number, seg = 8, x = 0, y = 0, z = 0) =>
  GEO.translated(rotG(GEO.cylinder(r, len, seg), 0, 0, Math.PI / 2), x, y, z);
/** Cylinder lying along Z. */
const CYZ = (r: number, len: number, seg = 8, x = 0, y = 0, z = 0) =>
  GEO.translated(rotG(GEO.cylinder(r, len, seg), Math.PI / 2), x, y, z);
/** A tube between two points — frame members, handrails, pipework. */
const STRUT = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg = 6) => {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const g = GEO.cylinder(r, len, seg).clone();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  m.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return GEO.transformed(g, m);
};

export type PropKind =
  | 'vending' | 'trafficLight' | 'streetLamp' | 'verticalSign' | 'boxSign' | 'utilityPole'
  | 'acUnit' | 'waterTank' | 'rooftopVent' | 'antenna' | 'bicycle' | 'bench' | 'bollard'
  | 'planter' | 'trashBin' | 'aBoard' | 'cone' | 'barrier' | 'guardrail' | 'dumpster'
  | 'pallet' | 'crate' | 'barrel' | 'sandbag' | 'container' | 'scaffold' | 'tree' | 'torii'
  | 'hydrant' | 'busStop' | 'phoneBooth' | 'spool' | 'drainPipe' | 'banner' | 'steelBeam'
  | 'rebar' | 'portaloo' | 'gasCanister' | 'plank' | 'mattress' | 'fridge' | 'desk'
  | 'shelf' | 'sofa' | 'locker' | 'chair' | 'table' | 'tv' | 'bathtub' | 'door'
  | 'ladder' | 'soilBlock'
  | 'plywood' | 'corrugated' | 'cinderBlock' | 'scaffoldPole' | 'scaffoldBoard' | 'timberPost'
  | 'tyre' | 'cardboardBox' | 'trashBag' | 'bucket' | 'jerryCan' | 'toolbox' | 'plasticCrate'
  | 'scaffoldLadder';

export interface PropSpec {
  key: string;
  geo: THREE.BufferGeometry;
  mat: Mat;
  matOpts?: Parameters<typeof makeMaterial>[1];
  half: THREE.Vector3;
  parts?: ColliderPart[];
  mass?: number;
  hollow?: number;
  flags?: number;
  body?: 'dynamic' | 'fixed';
  capacity?: number;
  extras?: {
    geoKey: string; geometry: THREE.BufferGeometry; material: THREE.Material;
    cast?: boolean; receive?: boolean; renderOrder?: number; capacity?: number;
  }[];
  label?: string;
  /**
   * Authored about its centre rather than standing on its base: wall-mounted
   * things, and loose flat things. Set down on a surface, it is lifted by its
   * half height; hung on a wall, it is placed by its centre.
   */
  centred?: boolean;
}

const NEON = [0xff2e63, 0x18d7ff, 0xffd23f, 0x25e07a, 0xff7a1f, 0xd94dff, 0xffffff];

const emissiveMat = (color: number, intensity = 3.2) =>
  makeMaterial(MATERIALS.neon, {
    instanced: true, vary: 0.05, colorOverride: 0x0a0c0f,
    emissive: color, emissiveIntensity: intensity, roughOverride: 0.3, metalOverride: 0.15,
    signage: true,
  });

const paintMat = (color: number, rough = 0.55, metal = 0.35) =>
  makeMaterial(MATERIALS.paintedSteel, { instanced: true, vary: 0.13, colorOverride: color, roughOverride: rough, metalOverride: metal });

// ---------------------------------------------------------------------------

export function propSpec(kind: PropKind, rng: Rng): PropSpec {
  const v = rng.int(0, 999);
  switch (kind) {

    case 'vending': {
      const col = rng.pick([0xd8322c, 0xf0f1f2, 0x1a4fa0, 0xe8a400, 0x1f7a44]);
      const key = `vending${col.toString(16)}`;
      // A Japanese street machine. The cabinet is built as walls with a real
      // opening in the front, so the lit display, the shelves and the rows of
      // cans are genuinely inside it rather than painted on a solid box.
      const W = 0.53, D = 0.36, T = 0.028;
      const winX0 = -0.47, winX1 = 0.10, winY0 = 0.60, winY1 = 1.76;
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(B(W * 2, 1.80, T, 0, 0.94, -D + T / 2));           // back
        g.push(B(T, 1.80, D * 2, -W + T / 2, 0.94, 0));           // sides
        g.push(B(T, 1.80, D * 2, W - T / 2, 0.94, 0));
        g.push(RB(W * 2 + 0.04, 0.09, D * 2 + 0.04, 0.02, 0, 1.87, 0)); // top cap
        g.push(B(W * 2, 0.07, D * 2, 0, 0.075, 0));               // floor
        g.push(B(W * 2 - 0.04, 0.14, 0.10, 0, 0.09, D - 0.05));   // kick plate
        // front face, built around the opening
        g.push(B(W + winX0, 1.80, T, (-W + winX0) / 2, 0.94, D - T / 2));
        g.push(B(W - winX1, 1.80, T, (W + winX1) / 2, 0.94, D - T / 2));
        g.push(B(winX1 - winX0, winY0 - 0.04, T, (winX0 + winX1) / 2, (0.04 + winY0) / 2, D - T / 2));
        g.push(B(winX1 - winX0, 1.84 - winY1, T, (winX0 + winX1) / 2, (winY1 + 1.84) / 2, D - T / 2));
        // bezel proud of the opening
        g.push(B(0.05, winY1 - winY0 + 0.1, 0.04, winX0, (winY0 + winY1) / 2, D + 0.01));
        g.push(B(0.05, winY1 - winY0 + 0.1, 0.04, winX1, (winY0 + winY1) / 2, D + 0.01));
        g.push(B(winX1 - winX0, 0.05, 0.04, (winX0 + winX1) / 2, winY1, D + 0.01));
        g.push(B(winX1 - winX0, 0.06, 0.04, (winX0 + winX1) / 2, winY0, D + 0.01));
        // control column
        for (let i = 0; i < 4; i++) {
          g.push(RB(0.13, 0.055, 0.035, 0.012, 0.23, 1.62 - i * 0.16, D + 0.02));
          g.push(RB(0.13, 0.055, 0.035, 0.012, 0.42, 1.62 - i * 0.16, D + 0.02));
        }
        g.push(B(0.32, 0.22, 0.03, 0.33, 0.90, D + 0.015));       // coin mech plate
        g.push(B(0.035, 0.09, 0.025, 0.26, 0.94, D + 0.035));     // coin slot
        g.push(RB(0.16, 0.05, 0.025, 0.01, 0.41, 0.87, D + 0.035)); // card reader
        g.push(B(0.10, 0.045, 0.025, 0.26, 0.78, D + 0.035));     // change cup
        // delivery flap, recessed with a lip
        g.push(B(0.60, 0.20, 0.03, -0.19, 0.36, D - 0.04));
        g.push(B(0.62, 0.035, 0.05, -0.19, 0.47, D + 0.005));
        g.push(B(0.62, 0.03, 0.05, -0.19, 0.25, D + 0.005));
        // side ribs and levelling feet
        for (const sx of [-W - 0.005, W + 0.005]) {
          g.push(B(0.02, 1.5, 0.07, sx, 1.0, -0.20));
          g.push(B(0.02, 1.5, 0.07, sx, 1.0, 0.16));
        }
        for (const [fx, fz] of [[-0.44, -0.28], [0.44, -0.28], [-0.44, 0.28], [0.44, 0.28]] as const) {
          g.push(CY(0.035, 0.045, 6, fx, 0.023, fz));
        }
        return GEO.merge(g);
      });
      // Backlight: the header sign and the panel at the back of the display.
      const front = GEO.composite(`${key}_f`, () => GEO.merge([
        B(0.94, 0.20, 0.03, 0, 1.70, D + 0.005),
        B(winX1 - winX0 - 0.03, winY1 - winY0 - 0.03, 0.02, (winX0 + winX1) / 2, (winY0 + winY1) / 2, -D + T + 0.01),
      ]));
      // Shelves and stock, standing in front of the light.
      const stock = GEO.composite(`${key}_s`, () => {
        const g: THREE.BufferGeometry[] = [];
        const r = new Rng(77);
        for (let row = 0; row < 3; row++) {
          const sy = winY0 + 0.06 + row * 0.37;
          g.push(B(0.55, 0.018, 0.34, -0.185, sy, -0.06));
          for (let i = 0; i < 6; i++) {
            g.push(CY(0.032, 0.16, 6, -0.42 + i * 0.098, sy + 0.088, 0.06 + r.range(-0.03, 0.03)));
          }
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.08, colorOverride: col, roughOverride: 0.42, metalOverride: 0.3 },
        half: new THREE.Vector3(0.53, 0.93, 0.37), mass: 330, hollow: 0.55,
        flags: F.BREAKABLE, body: 'dynamic', capacity: 64,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.53, 0.93, 0.37), offset: new THREE.Vector3(0, 0.93, 0) }],
        extras: [
          { geoKey: `${key}_f`, geometry: front, material: emissiveMat(rng.pick([0xfff0c0, 0xffffff, 0xbfe8ff]), 1.9), cast: false, capacity: 64 },
          { geoKey: `${key}_s`, geometry: stock, material: simpleMaterial(rng.pick([0xa8352c, 0x2a4f8c, 0x2c7a4a, 0xc19a2e]), 0.45, 0.25, { instanced: true, vary: 0.55 }), cast: false, capacity: 64 },
        ],
        label: 'vending machine',
      };
    }

    case 'trafficLight': {
      const key = 'trafficLight';
      // Signal on a mast arm: hooded three-aspect head over the road, a
      // pedestal head on the post, and a pedestrian box below.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.125, 0.085, 5.0, 10, 0, 2.5, 0));             // post
        g.push(TP(0.19, 0.155, 0.22, 10, 0, 0.11, 0));            // base
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.5;
          g.push(CY(0.015, 0.03, 5, Math.cos(a) * 0.15, 0.23, Math.sin(a) * 0.15));
        }
        g.push(CYX(0.062, 3.0, 8, 1.5, 4.9, 0));                  // mast arm
        g.push(STRUT(0.06, 4.35, 0, 0.72, 4.86, 0, 0.030));       // arm brace
        g.push(CY(0.09, 0.22, 8, 0, 4.92, 0));                    // arm collar
        // signal head over the carriageway
        g.push(RB(0.36, 1.02, 0.30, 0.03, 2.6, 4.45, 0));
        g.push(B(0.40, 0.05, 0.34, 2.6, 4.99, 0));                // head cap
        for (let i = 0; i < 3; i++) {
          const y = 4.78 - i * 0.33;
          g.push(CYZ(0.115, 0.05, 10, 2.6, y, 0.155));            // lens rim
          g.push(GEO.transformed(rotG(GEO.taper(0.16, 0.13, 0.13, 10), Math.PI / 2),
            new THREE.Matrix4().makeRotationX(-0.28).setPosition(2.6, y + 0.05, 0.21)));  // hood
        }
        // pedestrian head on the post
        g.push(RB(0.30, 0.66, 0.24, 0.025, 0, 3.05, 0.17));
        g.push(B(0.34, 0.04, 0.28, 0, 3.40, 0.17));
        g.push(B(0.26, 0.05, 0.05, 0, 3.36, 0.31));               // visor
        g.push(RB(0.16, 0.22, 0.10, 0.02, 0, 1.30, 0.16));        // push-button box
        g.push(CYZ(0.028, 0.03, 6, 0, 1.30, 0.22));
        return GEO.merge(g);
      });
      const lamps = GEO.composite(`${key}_l`, () => GEO.merge([
        CYZ(0.10, 0.03, 10, 2.6, 4.78, 0.17),
        CYZ(0.10, 0.03, 10, 2.6, 4.45, 0.17),
        CYZ(0.10, 0.03, 10, 2.6, 4.12, 0.17),
        B(0.18, 0.24, 0.02, 0, 3.12, 0.30),
      ]));
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x3c4a41, roughOverride: 0.5, metalOverride: 0.45 },
        half: new THREE.Vector3(0.16, 2.5, 0.16),
        parts: [
          { shape: 'cylinder', radius: 0.13, halfHeight: 2.5, offset: new THREE.Vector3(0, 2.5, 0) },
          { shape: 'box', half: new THREE.Vector3(1.5, 0.07, 0.07), offset: new THREE.Vector3(1.5, 4.9, 0) },
          { shape: 'box', half: new THREE.Vector3(0.2, 0.56, 0.2), offset: new THREE.Vector3(2.6, 4.47, 0.05) },
          { shape: 'box', half: new THREE.Vector3(0.17, 0.37, 0.16), offset: new THREE.Vector3(0, 3.07, 0.17) },
        ],
        mass: 190, flags: F.BREAKABLE, body: 'fixed', capacity: 48,
        extras: [{ geoKey: `${key}_l`, geometry: lamps, material: emissiveMat(0xff4422, 3.0), capacity: 48 }],
        label: 'traffic signal',
      };
    }

    case 'streetLamp': {
      const key = 'streetLamp';
      // Tapered column on a bolted base, swan-neck bracket, shallow lantern.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.135, 0.072, 6.3, 10, 0, 3.25, 0));            // column
        g.push(TP(0.22, 0.19, 0.16, 10, 0, 0.08, 0));             // base plinth
        g.push(RINGY(0.155, 0.022, 0, 0.20, 0, 5, 10));           // base collar
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.6;
          g.push(CY(0.016, 0.03, 5, Math.cos(a) * 0.185, 0.17, Math.sin(a) * 0.185));
        }
        g.push(RB(0.13, 0.30, 0.09, 0.015, 0, 0.85, 0.095));      // access hatch
        // swan neck
        g.push(GEO.tube([
          new THREE.Vector3(0, 6.25, 0), new THREE.Vector3(0.0, 6.72, 0.22),
          new THREE.Vector3(0.0, 6.95, 0.62), new THREE.Vector3(0, 6.98, 1.08)], 0.058, 6));
        // lantern: shallow housing with a rim and a canopy
        g.push(RB(0.30, 0.10, 0.76, 0.03, 0, 6.99, 1.24));
        g.push(RB(0.34, 0.035, 0.80, 0.015, 0, 7.05, 1.24));
        g.push(B(0.05, 0.07, 0.72, -0.155, 6.94, 1.24));
        g.push(B(0.05, 0.07, 0.72, 0.155, 6.94, 1.24));
        return GEO.merge(g);
      });
      const lamp = GEO.composite(`${key}_l`, () => GEO.merge([
        B(0.24, 0.045, 0.66, 0, 6.925, 1.24),
      ]));
      return {
        key, geo, mat: MATERIALS.aluminium,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0x76797d, roughOverride: 0.4, metalOverride: 0.7 },
        half: new THREE.Vector3(0.18, 3.2, 0.18),
        parts: [{ shape: 'cylinder', radius: 0.16, halfHeight: 3.2, offset: new THREE.Vector3(0, 3.2, 0) }, { shape: 'box', half: new THREE.Vector3(0.17, 0.26, 0.82), offset: new THREE.Vector3(0, 6.84, 0.82) }],
        mass: 130, flags: F.BREAKABLE, body: 'fixed', capacity: 64,
        extras: [{ geoKey: `${key}_l`, geometry: lamp, material: emissiveMat(0xffe0a8, 4.2), capacity: 64 }],
        label: 'street lamp',
      };
    }

    case 'verticalSign': {
      const col = NEON[v % NEON.length];
      const h = 2.2 + (v % 5) * 0.6;
      const key = `vsign${h.toFixed(1)}`;
      // Kanban: a lightbox on a wall bracket, framed on all four edges.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        // bracket back to the wall the sign projects from (-Z)
        g.push(B(0.30, h * 0.7, 0.06, 0.16, 0, -0.45));           // wall plate
        for (const sy of [-1, 1]) {
          g.push(STRUT(0.16, sy * (h * 0.28), -0.43, 0.16, sy * (h * 0.28), -0.31, 0.028));
          g.push(STRUT(0.16, sy * (h * 0.28), -0.43, 0.16, sy * (h * 0.40), -0.33, 0.020));
        }
        // box frame
        g.push(B(0.16, 0.06, 0.66, 0.16, h / 2, 0));
        g.push(B(0.16, 0.06, 0.66, 0.16, -h / 2, 0));
        g.push(B(0.16, h, 0.06, 0.16, 0, 0.30));
        g.push(B(0.16, h, 0.06, 0.16, 0, -0.30));
        g.push(B(0.05, h - 0.10, 0.60, 0.08, 0, 0));              // spine
        g.push(B(0.10, 0.05, 0.62, 0.16, h / 2 - 0.22, 0));       // service seam
        return GEO.merge(g);
      });
      const face = GEO.composite(`${key}_f`, () => GEO.merge([
        B(0.025, h - 0.14, 0.56, 0.225, 0, 0),
        B(0.025, h - 0.14, 0.56, 0.095, 0, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.aluminium,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x23262b, roughOverride: 0.45, metalOverride: 0.5 },
        half: new THREE.Vector3(0.3, h / 2, 0.34), mass: 26 + h * 7, hollow: 0.6,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.1, h / 2 + 0.02, 0.34), offset: new THREE.Vector3(0.16, 0, 0) },
                { shape: 'box', half: new THREE.Vector3(0.16, h * 0.36, 0.07), offset: new THREE.Vector3(0.16, 0, -0.42) }], centred: true,
        flags: F.BREAKABLE, body: 'dynamic', capacity: 96,
        extras: [{ geoKey: `${key}_f`, geometry: face, material: emissiveMat(col, 3.6), capacity: 96 }],
        label: 'shop sign',
      };
    }

    case 'boxSign': {
      const col = NEON[(v + 3) % NEON.length];
      const w = 1.4 + (v % 4) * 0.5;
      const key = `bsign${w.toFixed(1)}`;
      // Projecting lightbox: framed panel on two gusseted arms, with a drip cap.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(B(w, 0.06, 0.20, 0, 0.35, 0));                     // top rail
        g.push(B(w, 0.06, 0.20, 0, -0.35, 0));                    // bottom rail
        g.push(B(0.06, 0.70, 0.20, -w / 2 + 0.03, 0, 0));         // end caps
        g.push(B(0.06, 0.70, 0.20, w / 2 - 0.03, 0, 0));
        g.push(B(w + 0.06, 0.05, 0.26, 0, 0.40, 0));              // drip cap
        for (const sx of [-w / 2 + 0.14, w / 2 - 0.14]) {
          g.push(B(0.05, 0.05, 0.42, sx, 0, -0.28));              // arms
          g.push(STRUT(sx, 0.30, -0.10, sx, 0.02, -0.44, 0.018)); // gussets
          g.push(B(0.10, 0.22, 0.04, sx, 0, -0.47));              // wall plates
        }
        return GEO.merge(g);
      });
      const face = GEO.composite(`${key}_f`, () => GEO.merge([
        B(w - 0.14, 0.58, 0.03, 0, 0, 0.085),
        B(w - 0.14, 0.58, 0.03, 0, 0, -0.085),
      ]));
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x1a1d21 },
        half: new THREE.Vector3(w / 2, 0.35, 0.16), mass: 14 + w * 4, hollow: 0.7,
        parts: [{ shape: 'box', half: new THREE.Vector3(w / 2 + 0.03, 0.42, 0.13), offset: new THREE.Vector3() },
                { shape: 'box', half: new THREE.Vector3(w / 2, 0.12, 0.18), offset: new THREE.Vector3(0, 0, -0.31) }], centred: true,
        flags: F.BREAKABLE, body: 'dynamic', capacity: 96,
        extras: [{ geoKey: `${key}_f`, geometry: face, material: emissiveMat(col, 3.8), capacity: 96 }],
        label: 'lightbox sign',
      };
    }

    case 'utilityPole': {
      const key = 'utilityPole';
      // Concrete pole with two crossarms, pin insulators, a pole transformer
      // and a service box — the single most Tokyo object on any street.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.20, 0.125, 9.4, 9, 0, 4.7, 0));               // pole
        for (const y of [8.5, 7.9]) {
          g.push(B(1.95, 0.10, 0.12, 0, y, 0));                   // crossarm
          g.push(STRUT(-0.62, y - 0.02, 0, -0.10, y - 0.55, 0, 0.022));
          g.push(STRUT(0.62, y - 0.02, 0, 0.10, y - 0.55, 0, 0.022));
          for (const x of [-0.82, -0.40, 0.40, 0.82]) {           // insulators
            g.push(CY(0.022, 0.13, 5, x, y + 0.12, 0));
            g.push(TP(0.062, 0.050, 0.06, 7, x, y + 0.17, 0));
            g.push(TP(0.052, 0.040, 0.05, 7, x, y + 0.22, 0));
          }
        }
        // pole transformer with fins and bushings
        g.push(CY(0.30, 0.78, 10, 0.40, 6.65, 0));
        g.push(TP(0.30, 0.24, 0.10, 10, 0.40, 7.09, 0));
        g.push(RINGY(0.305, 0.022, 0.40, 6.40, 0, 4, 10));
        g.push(RINGY(0.305, 0.022, 0.40, 6.90, 0, 4, 10));
        for (let i = 0; i < 2; i++) {
          g.push(CY(0.035, 0.12, 5, 0.30 + i * 0.18, 7.18, 0));
          g.push(TP(0.055, 0.042, 0.05, 6, 0.30 + i * 0.18, 7.26, 0));
        }
        g.push(STRUT(0.10, 6.40, 0, 0.10, 7.00, 0, 0.030));       // mounting bracket
        g.push(B(0.30, 0.46, 0.22, -0.30, 3.20, 0));              // service box
        g.push(B(0.34, 0.05, 0.26, -0.30, 3.45, 0));
        for (let i = 0; i < 6; i++) g.push(B(0.06, 0.03, 0.14, -0.20, 1.2 + i * 0.42, 0)); // step bolts
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.concrete,
        matOpts: { instanced: true, vary: 0.13, colorOverride: 0x9a978f },
        half: new THREE.Vector3(0.2, 4.7, 0.2),
        parts: [{ shape: 'cylinder', radius: 0.2, halfHeight: 4.7, offset: new THREE.Vector3(0, 4.7, 0) },
                { shape: 'box', half: new THREE.Vector3(0.98, 0.45, 0.08), offset: new THREE.Vector3(0, 8.3, 0) },
                { shape: 'cylinder', radius: 0.31, halfHeight: 0.46, offset: new THREE.Vector3(0.4, 6.72, 0) },
                { shape: 'box', half: new THREE.Vector3(0.17, 0.26, 0.13), offset: new THREE.Vector3(-0.3, 3.25, 0) }],
        mass: 760, flags: F.BREAKABLE | F.LIVE_WIRE, body: 'fixed', capacity: 96,
        label: 'utility pole',
      };
    }

    case 'acUnit': {
      const key = 'acUnit';
      // Split-system condenser: louvred grille, fan bezel, pipe run, brackets.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.86, 0.58, 0.32, 0.028, 0, 0, 0));             // casing
        g.push(RB(0.88, 0.04, 0.34, 0.012, 0, 0.30, 0));          // top cap
        g.push(RINGX(0.20, 0.028, 0, 0, 0.165, 3, 10));           // fan bezel
        for (let i = 0; i < 3; i++) {                              // fan blades
          const a = (i / 3) * Math.PI * 2;
          g.push(GEO.transformed(B(0.015, 0.30, 0.10),
            new THREE.Matrix4().makeRotationZ(a).setPosition(0, 0, 0.155)));
        }
        g.push(CYZ(0.03, 0.06, 5, 0, 0, 0.16));                   // hub
        for (let i = 0; i < 5; i++) g.push(B(0.80, 0.016, 0.02, 0, -0.22 + i * 0.105, 0.168)); // louvres
        g.push(RB(0.20, 0.44, 0.03, 0.01, -0.33, -0.02, 0.165));  // side panel seam
        g.push(CYZ(0.030, 0.12, 5, 0.30, -0.16, -0.20));          // pipe stubs
        for (const sx of [-0.40, 0.40]) {                           // wall brackets
          g.push(B(0.06, 0.05, 0.42, sx, -0.28, -0.06));
          g.push(B(0.05, 0.28, 0.05, sx, -0.16, -0.22));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0xb8b5ad, roughOverride: 0.55, metalOverride: 0.5 },
        half: new THREE.Vector3(0.43, 0.29, 0.19), mass: 38, hollow: 0.4,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.43, 0.29, 0.19), offset: new THREE.Vector3() }], centred: true,
        flags: F.BREAKABLE, body: 'dynamic', capacity: 128, label: 'air conditioner',
      };
    }

    case 'waterTank': {
      const key = 'waterTank';
      // FRP panel tank on a steel stand: panelled sides, hatch, ladder, pipes.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(2.3, 1.55, 1.7, 0.06, 0, 1.75, 0));
        g.push(B(2.42, 0.07, 1.82, 0, 2.55, 0));                  // roof
        // moulded panel grid on all four sides
        for (let i = 0; i < 3; i++) for (let k = 0; k < 2; k++) {
          const px = -0.74 + i * 0.74, py = 1.38 + k * 0.72;
          g.push(B(0.62, 0.58, 0.03, px, py, 0.86));
          g.push(B(0.62, 0.58, 0.03, px, py, -0.86));
        }
        for (let k = 0; k < 2; k++) {
          g.push(B(0.03, 0.58, 0.62, 1.16, 1.38 + k * 0.72, 0.38));
          g.push(B(0.03, 0.58, 0.62, 1.16, 1.38 + k * 0.72, -0.38));
          g.push(B(0.03, 0.58, 0.62, -1.16, 1.38 + k * 0.72, 0.38));
          g.push(B(0.03, 0.58, 0.62, -1.16, 1.38 + k * 0.72, -0.38));
        }
        g.push(RB(0.62, 0.10, 0.62, 0.02, 0.45, 2.62, 0));        // hatch
        g.push(CY(0.05, 0.14, 6, 0.45, 2.72, 0));                 // hatch handle
        g.push(CY(0.085, 1.30, 8, 1.06, 0.62, 0.62));             // downpipe
        g.push(CYZ(0.085, 0.36, 8, 1.06, 1.22, 0.80));
        g.push(CY(0.055, 0.50, 6, -1.06, 2.75, 0));               // vent
        g.push(TP(0.10, 0.07, 0.07, 6, -1.06, 3.02, 0));
        // stand
        for (const [x, z] of [[-0.95, -0.7], [0.95, -0.7], [-0.95, 0.7], [0.95, 0.7]] as const) {
          g.push(B(0.11, 1.00, 0.11, x, 0.50, z));
          g.push(RB(0.22, 0.03, 0.22, 0.006, x, 0.015, z));
        }
        g.push(B(2.10, 0.07, 0.07, 0, 0.92, -0.70));
        g.push(B(2.10, 0.07, 0.07, 0, 0.92, 0.70));
        g.push(B(0.07, 0.07, 1.48, -0.95, 0.92, 0));
        g.push(B(0.07, 0.07, 1.48, 0.95, 0.92, 0));
        g.push(STRUT(-0.95, 0.06, -0.70, 0.95, 0.92, -0.70, 0.024));
        // access ladder
        for (const sx of [-0.18, 0.18]) g.push(CY(0.022, 2.5, 5, sx, 1.3, -0.95));
        for (let i = 0; i < 8; i++) g.push(CYX(0.018, 0.40, 5, 0, 0.30 + i * 0.30, -0.95));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.06, colorOverride: 0x9fa6a2, roughOverride: 0.6 },
        half: new THREE.Vector3(1.2, 1.3, 0.9), mass: 420, hollow: 0.35,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.16, 0.8, 0.87), offset: new THREE.Vector3(0, 1.75, 0) },
                { shape: 'box', half: new THREE.Vector3(1.1, 0.5, 0.8), offset: new THREE.Vector3(0, 0.5, 0) },
                { shape: 'box', half: new THREE.Vector3(1.21, 0.09, 0.91), offset: new THREE.Vector3(0, 2.6, 0) },
                { shape: 'cylinder', radius: 0.1, halfHeight: 0.18, offset: new THREE.Vector3(-1.06, 2.9, 0) },
                { shape: 'box', half: new THREE.Vector3(0.21, 1.25, 0.04), offset: new THREE.Vector3(0, 1.3, -0.95) }],
        flags: F.BREAKABLE, body: 'dynamic', capacity: 48, label: 'water tank',
      };
    }

    case 'rooftopVent': {
      const key = 'rooftopVent';
      // Extract unit: louvred housing, fan cowl with a mesh, mounting feet.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.5, 0.9, 1.1, 0.04, 0, 0.45, 0));
        g.push(B(1.62, 0.08, 1.22, 0, 0.94, 0));                  // drip lip
        for (let i = 0; i < 8; i++) g.push(B(1.28, 0.022, 0.03, 0, 0.16 + i * 0.085, 0.565)); // louvres
        g.push(B(1.34, 0.70, 0.04, 0, 0.45, -0.555));             // access panel
        for (let i = 0; i < 4; i++) g.push(CY(0.018, 0.03, 5, -0.58 + i * 0.39, 0.45, -0.58));
        g.push(CY(0.32, 0.62, 12, 0, 1.28, 0));                   // cowl
        g.push(RINGY(0.33, 0.028, 0, 1.58, 0, 4, 12));
        g.push(TP(0.44, 0.40, 0.09, 12, 0, 1.66, 0));             // rain hood
        g.push(CY(0.05, 0.10, 6, 0, 1.73, 0));
        for (let i = 0; i < 3; i++) g.push(RINGY(0.30, 0.012, 0, 1.10 + i * 0.16, 0, 3, 10)); // mesh bands
        for (const [x, z] of [[-0.62, -0.44], [0.62, -0.44], [-0.62, 0.44], [0.62, 0.44]] as const) {
          g.push(B(0.16, 0.06, 0.16, x, 0.03, z));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.aluminium,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x8d9196, roughOverride: 0.48, metalOverride: 0.65 },
        half: new THREE.Vector3(0.78, 0.5, 0.58), mass: 95, hollow: 0.5,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.81, 0.5, 0.61), offset: new THREE.Vector3(0, 0.5, 0) }, { shape: 'cylinder', radius: 0.34, halfHeight: 0.36, offset: new THREE.Vector3(0, 1.32, 0) }, { shape: 'cylinder', radius: 0.44, halfHeight: 0.06, offset: new THREE.Vector3(0, 1.68, 0) }],
        flags: F.BREAKABLE, body: 'dynamic', capacity: 48, label: 'roof vent',
      };
    }

    case 'antenna': {
      const key = 'antenna';
      // Lattice mast with diagonal bracing, a dish and a yagi array.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const H = 7.5, L = 0.28;
        for (const [x, z] of [[-L, -L], [L, -L], [-L, L], [L, L]] as const) {
          g.push(CY(0.042, H, 6, x, H / 2, z));
        }
        let flip = 0;
        for (let y = 0.5; y < H; y += 0.85) {
          g.push(B(L * 2, 0.04, 0.04, 0, y, -L));
          g.push(B(L * 2, 0.04, 0.04, 0, y, L));
          g.push(B(0.04, 0.04, L * 2, -L, y, 0));
          g.push(B(0.04, 0.04, L * 2, L, y, 0));
          const s2 = flip ? 1 : -1;
          if (y + 0.85 < H) {
            g.push(STRUT(-L * s2, y, -L, L * s2, y + 0.85, -L, 0.020));
            g.push(STRUT(-L * s2, y, L, L * s2, y + 0.85, L, 0.020));
            g.push(STRUT(-L, y, -L * s2, -L, y + 0.85, L * s2, 0.020));
            g.push(STRUT(L, y, -L * s2, L, y + 0.85, L * s2, 0.020));
          }
          flip ^= 1;
        }
        // dish on a bracket
        g.push(STRUT(L, 4.6, 0, 0.78, 4.6, 0, 0.028));
        g.push(GEO.translated(rotG(GEO.taper(0.52, 0.44, 0.14, 12), 0, 0, Math.PI / 2), 0.92, 4.6, 0));
        g.push(STRUT(0.92, 4.6, 0, 1.26, 4.6, 0, 0.016));
        g.push(GEO.sphere(0.07, 6).clone().translate(1.28, 4.6, 0));
        // yagi array
        g.push(CY(0.028, 2.2, 6, 0, H + 1.1, 0));
        for (let i = 0; i < 5; i++) {
          const yy = H + 0.35 + i * 0.42, len = 1.15 - i * 0.14;
          g.push(CYZ(0.014, len, 5, 0, yy, 0));
        }
        g.push(GEO.sphere(0.05, 6).clone().translate(0, H + 2.2, 0));
        // guys
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          g.push(STRUT(0, H * 0.82, 0, Math.cos(a) * 1.9, 0.1, Math.sin(a) * 1.9, 0.012, 4));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x9a9084, roughOverride: 0.55, metalOverride: 0.8 },
        half: new THREE.Vector3(0.36, 3.75, 0.36),
        parts: [{ shape: 'box', half: new THREE.Vector3(0.34, 3.75, 0.34), offset: new THREE.Vector3(0, 3.75, 0) }, { shape: 'box', half: new THREE.Vector3(0.07, 1.12, 0.58), offset: new THREE.Vector3(0, 8.62, 0) }, { shape: 'box', half: new THREE.Vector3(0.2, 0.52, 0.52), offset: new THREE.Vector3(1.0, 4.6, 0) }],
        mass: 160, hollow: 0.85, flags: F.BREAKABLE, body: 'dynamic', capacity: 32, label: 'antenna mast',
      };
    }

    case 'bicycle': {
      const key = 'bicycle';
      // A mamachari: step-through frame, front basket, rear rack, mudguards.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const FX = 0.52, RX = -0.52, WR = 0.33;
        // Wheels lie in the plane of the frame, turning about an axle across it.
        const wheel = (x: number) => {
          g.push(GEO.translated(GEO.torus(WR, 0.032, 5, 14), x, WR, 0));          // tyre
          g.push(GEO.translated(GEO.torus(WR - 0.055, 0.018, 4, 12), x, WR, 0));  // rim
          g.push(CYZ(0.028, 0.075, 6, x, WR, 0));                                 // hub
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI;
            g.push(GEO.transformed(B(0.009, WR * 2 - 0.06, 0.009),
              new THREE.Matrix4().makeRotationZ(a).setPosition(x, WR, 0)));
          }
          // mudguard: three short arcs over the top of the wheel
          for (let i = 0; i < 3; i++) {
            const a = -0.55 + i * 0.55;
            g.push(GEO.transformed(B(0.24, 0.016, 0.055),
              new THREE.Matrix4().makeRotationZ(-a).setPosition(x + Math.sin(a) * (WR + 0.05), WR + Math.cos(a) * (WR + 0.05), 0)));
          }
        };
        wheel(FX); wheel(RX);
        // frame
        g.push(STRUT(FX - 0.06, 0.80, 0, 0.10, 0.44, 0, 0.022));  // down tube
        g.push(STRUT(0.10, 0.44, 0, RX + 0.03, 0.34, 0, 0.022));  // bottom run
        g.push(STRUT(RX + 0.03, 0.34, 0, RX + 0.03, 0.80, 0, 0.022)); // seat tube
        g.push(STRUT(RX + 0.03, 0.80, 0, FX - 0.10, 0.74, 0, 0.018));  // top run
        g.push(STRUT(RX + 0.03, 0.34, 0, RX, WR, 0.055, 0.013));  // chainstays
        g.push(STRUT(RX + 0.03, 0.34, 0, RX, WR, -0.055, 0.013));
        g.push(STRUT(RX + 0.03, 0.78, 0, RX, WR, 0.05, 0.012));   // seatstays
        g.push(STRUT(RX + 0.03, 0.78, 0, RX, WR, -0.05, 0.012));
        g.push(STRUT(FX - 0.07, 0.86, 0, FX, WR, 0.05, 0.015));   // fork
        g.push(STRUT(FX - 0.07, 0.86, 0, FX, WR, -0.05, 0.015));
        g.push(CY(0.026, 0.16, 6, FX - 0.065, 0.84, 0));          // head tube
        // bars, saddle, cranks
        g.push(CY(0.018, 0.22, 6, FX - 0.065, 1.00, 0));          // stem
        g.push(CYZ(0.016, 0.52, 6, FX - 0.065, 1.09, 0));         // handlebar
        for (const sz of [-0.22, 0.22]) g.push(CYZ(0.022, 0.10, 6, FX - 0.065, 1.09, sz));
        g.push(CY(0.017, 0.24, 6, RX + 0.03, 0.92, 0));           // seat post
        g.push(RB(0.24, 0.055, 0.14, 0.025, RX + 0.02, 1.03, 0)); // saddle
        g.push(GEO.translated(GEO.torus(0.075, 0.012, 4, 10), 0.115, 0.44, 0.03));    // chainring
        g.push(CYZ(0.012, 0.19, 5, 0.11, 0.44, 0));               // crank axle
        g.push(B(0.075, 0.018, 0.045, 0.11, 0.33, 0.10));         // pedals
        g.push(B(0.075, 0.018, 0.045, 0.11, 0.55, -0.10));
        // front basket: open box of wire
        const bx = FX - 0.14, by = 0.92;
        g.push(B(0.26, 0.012, 0.30, bx, by - 0.10, 0));
        for (const [ox, oz, w, d] of [[0.13, 0, 0.012, 0.30], [-0.13, 0, 0.012, 0.30], [0, 0.15, 0.26, 0.012], [0, -0.15, 0.26, 0.012]] as const) {
          g.push(B(w, 0.20, d, bx + ox, by, oz));
        }
        // rear rack
        g.push(B(0.30, 0.016, 0.20, RX + 0.10, 0.70, 0));
        g.push(STRUT(RX + 0.20, 0.70, 0.08, RX, WR + 0.02, 0.06, 0.010));
        g.push(STRUT(RX + 0.20, 0.70, -0.08, RX, WR + 0.02, -0.06, 0.010));
        // kickstand
        g.push(STRUT(RX + 0.06, 0.32, 0.02, RX + 0.14, 0.02, 0.16, 0.012));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.35, colorOverride: 0x5b6a78, roughOverride: 0.45, metalOverride: 0.7 },
        half: new THREE.Vector3(0.88, 0.55, 0.18), mass: 14, hollow: 0.9,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.88, 0.37, 0.05), offset: new THREE.Vector3(0, 0.37, 0) },
                { shape: 'box', half: new THREE.Vector3(0.62, 0.17, 0.07), offset: new THREE.Vector3(-0.05, 0.9, 0) }, { shape: 'box', half: new THREE.Vector3(0.05, 0.04, 0.28), offset: new THREE.Vector3(0.455, 1.09, 0) }, { shape: 'box', half: new THREE.Vector3(0.14, 0.11, 0.16), offset: new THREE.Vector3(0.38, 0.87, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 96, label: 'bicycle',
      };
    }

    case 'bench': {
      const key = 'bench';
      // Park bench: timber slats on cast end frames, with armrests.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 4; i++) g.push(RB(1.85, 0.045, 0.125, 0.015, 0, 0.44, -0.21 + i * 0.145));
        for (let i = 0; i < 3; i++) {
          g.push(GEO.transformed(RB(1.85, 0.04, 0.115, 0.015),
            new THREE.Matrix4().makeRotationX(0.16).setPosition(0, 0.60 + i * 0.125, -0.24 - i * 0.02)));
        }
        for (const x of [-0.8, 0.8]) {
          g.push(STRUT(x, 0.02, -0.17, x, 0.45, -0.17, 0.028));   // rear leg
          g.push(STRUT(x, 0.02, 0.22, x, 0.45, 0.22, 0.028));     // front leg
          g.push(STRUT(x, 0.45, -0.20, x, 0.45, 0.25, 0.024));    // seat rail
          g.push(STRUT(x, 0.45, -0.22, x, 0.86, -0.30, 0.024));   // back post
          g.push(STRUT(x, 0.62, 0.20, x, 0.66, -0.24, 0.022));    // armrest
          g.push(STRUT(x, 0.45, 0.22, x, 0.62, 0.20, 0.020));     // armrest support
          g.push(RB(0.12, 0.02, 0.10, 0.005, x, 0.015, -0.17));   // foot plates
          g.push(RB(0.12, 0.02, 0.10, 0.005, x, 0.015, 0.22));
        }
        g.push(STRUT(-0.8, 0.20, 0.03, 0.8, 0.20, 0.03, 0.018));  // cross brace
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x6d5741 },
        half: new THREE.Vector3(0.95, 0.44, 0.34), mass: 58, hollow: 0.5,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.93, 0.28, 0.24), offset: new THREE.Vector3(0, 0.28, 0.02) },
                { shape: 'box', half: new THREE.Vector3(0.93, 0.2, 0.09), offset: new THREE.Vector3(0, 0.66, -0.25) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64, label: 'bench',
      };
    }

    case 'bollard': {
      const key = 'bollard';
      // Cast bollard: flanged base, swelled shaft, domed cap, two bands.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.135, 0.105, 0.10, 12, 0, 0.05, 0));           // base flange
        g.push(TP(0.095, 0.082, 0.62, 12, 0, 0.42, 0));           // shaft
        g.push(RINGY(0.093, 0.016, 0, 0.16, 0, 5, 10));           // collar
        g.push(TP(0.082, 0.09, 0.09, 12, 0, 0.775, 0));           // swell under the cap
        g.push(GEO.sphere(0.09, 10).clone().scale(1, 0.62, 1).translate(0, 0.82, 0));
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4;
          g.push(CY(0.012, 0.022, 5, Math.cos(a) * 0.115, 0.10, Math.sin(a) * 0.115));
        }
        return GEO.merge(g);
      });
      const band = GEO.composite(`${key}_b`, () => GEO.merge([
        TP(0.089, 0.086, 0.075, 12, 0, 0.60, 0),
        TP(0.093, 0.091, 0.055, 12, 0, 0.30, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.06, colorOverride: 0xd9d4c8, roughOverride: 0.5 },
        half: new THREE.Vector3(0.1, 0.46, 0.1), mass: 32,
        parts: [{ shape: 'cylinder', radius: 0.1, halfHeight: 0.46, offset: new THREE.Vector3(0, 0.46, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 128,
        extras: [{ geoKey: `${key}_b`, geometry: band, material: emissiveMat(0xff6a2a, 1.4), capacity: 128 }],
        label: 'bollard',
      };
    }

    case 'planter': {
      const key = 'planter';
      // Tapered cast planter with a moulded rim, soil, and a clipped shrub.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const body = rotG(GEO.taper(0.82, 0.74, 0.56, 4), 0, Math.PI / 4);
        g.push(GEO.translated(body, 0, 0.30, 0));
        const rim = rotG(GEO.taper(0.80, 0.80, 0.10, 4), 0, Math.PI / 4);
        g.push(GEO.translated(rim, 0, 0.60, 0));
        const plinth = rotG(GEO.taper(0.86, 0.84, 0.07, 4), 0, Math.PI / 4);
        g.push(GEO.translated(plinth, 0, 0.035, 0));
        // recessed panels on each face
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          g.push(GEO.transformed(B(0.42, 0.28, 0.03),
            new THREE.Matrix4().makeRotationY(a).setPosition(Math.sin(a) * 0.525, 0.31, Math.cos(a) * 0.525)));
        }
        return GEO.merge(g);
      });
      const soil = GEO.composite(`${key}_soil`, () => B(0.96, 0.05, 0.96, 0, 0.60, 0));
      const bush = GEO.composite(`${key}_bush`, () => {
        const g: THREE.BufferGeometry[] = [];
        const r = new Rng(31);
        for (let i = 0; i < 11; i++) {
          const s = GEO.sphere(r.range(0.16, 0.33), 7).clone();
          s.scale(1, r.range(0.7, 0.95), 1);
          s.translate(r.range(-0.32, 0.32), 0.72 + r.range(0, 0.42), r.range(-0.32, 0.32));
          g.push(s);
        }
        for (let i = 0; i < 3; i++) {
          g.push(STRUT(0, 0.60, 0, r.range(-0.12, 0.12), 0.90, r.range(-0.12, 0.12), 0.022, 5));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.concrete,
        matOpts: { instanced: true, vary: 0.12, colorOverride: 0x8a8880 },
        half: new THREE.Vector3(0.55, 0.33, 0.55), mass: 480,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.58, 0.33, 0.58), offset: new THREE.Vector3(0, 0.33, 0) }, { shape: 'ball', radius: 0.42, offset: new THREE.Vector3(0, 0.98, 0) }],
        flags: F.BREAKABLE, body: 'dynamic', capacity: 64,
        extras: [
          { geoKey: `${key}_soil`, geometry: soil, material: makeMaterial(MATERIALS.soil, { instanced: true, vary: 0.2 }), cast: false, capacity: 64 },
          { geoKey: `${key}_bush`, geometry: bush, material: makeMaterial(MATERIALS.vegetation, { instanced: true, vary: 0.3, flatShading: true }), cast: true, capacity: 64 },
        ],
        label: 'planter',
      };
    }

    case 'trashBin': {
      const key = 'trashBin';
      // Public bin: tapered drum, rolled rim, domed lid with posting slots.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.27, 0.305, 0.80, 12, 0, 0.42, 0));            // drum
        g.push(RINGY(0.305, 0.028, 0, 0.82, 0, 5, 12));           // rolled rim
        g.push(RINGY(0.272, 0.024, 0, 0.10, 0, 5, 12));           // foot ring
        g.push(TP(0.30, 0.20, 0.10, 12, 0, 0.87, 0));             // domed lid
        g.push(CY(0.20, 0.035, 10, 0, 0.93, 0));                  // lid top
        g.push(CY(0.035, 0.05, 6, 0, 0.96, 0));                   // knob
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          g.push(B(0.022, 0.72, 0.022, Math.cos(a) * 0.288, 0.44, Math.sin(a) * 0.288));
        }
        g.push(B(0.16, 0.10, 0.012, 0, 0.55, 0.30));              // label plate
        return GEO.merge(g);
      });
      const slots = GEO.composite(`${key}_o`, () => GEO.merge([
        B(0.20, 0.05, 0.09, 0, 0.90, 0.10),
        B(0.20, 0.05, 0.09, 0, 0.90, -0.10),
      ]));
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x4a5a52, roughOverride: 0.6 },
        half: new THREE.Vector3(0.31, 0.49, 0.31), mass: 16, hollow: 0.7,
        parts: [{ shape: 'cylinder', radius: 0.31, halfHeight: 0.49, offset: new THREE.Vector3(0, 0.49, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 96,
        extras: [{ geoKey: `${key}_o`, geometry: slots, material: simpleMaterial(0x14181a, 0.85, 0, { instanced: true }), cast: false, capacity: 96 }],
        label: 'bin',
      };
    }

    case 'aBoard': {
      const key = 'aBoard';
      // Sandwich board: two framed panels on a hinge, chained at the feet.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const leaf = (sign: number) => {
          const m = new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(0, 0.48, sign * 0.13);
          g.push(GEO.transformed(RB(0.62, 0.94, 0.035, 0.012), m));
          // frame border, proud of the face
          g.push(GEO.transformed(B(0.66, 0.05, 0.05), new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(0, 0.94, sign * 0.155)));
          g.push(GEO.transformed(B(0.66, 0.05, 0.05), new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(0, 0.05, sign * 0.06)));
          g.push(GEO.transformed(B(0.05, 0.94, 0.05), new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(-0.305, 0.48, sign * 0.145)));
          g.push(GEO.transformed(B(0.05, 0.94, 0.05), new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(0.305, 0.48, sign * 0.145)));
        };
        leaf(-1); leaf(1);
        g.push(CYX(0.022, 0.64, 6, 0, 0.955, 0));                 // hinge bar
        for (let i = 0; i < 4; i++) g.push(CYZ(0.010, 0.07, 5, -0.10 + i * 0.07, 0.20, 0));  // chain
        return GEO.merge(g);
      });
      const face = GEO.composite(`${key}_f`, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const sign of [-1, 1]) {
          g.push(GEO.transformed(RB(0.50, 0.80, 0.012, 0.008),
            new THREE.Matrix4().makeRotationX(sign * 0.22).setPosition(0, 0.48, sign * 0.152)));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plywood,
        matOpts: { instanced: true, vary: 0.3, colorOverride: 0x2c2f33 },
        half: new THREE.Vector3(0.33, 0.48, 0.28), mass: 8,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.32, 0.48, 0.26), offset: new THREE.Vector3(0, 0.48, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64,
        extras: [{ geoKey: `${key}_f`, geometry: face, material: simpleMaterial(0xe9e4d8, 0.8, 0, { instanced: true, vary: 0.1 }), cast: false, capacity: 64 }],
        label: 'A-board',
      };
    }

    case 'cone': {
      const key = 'cone';
      // Traffic cone: square base with a lip, tapered body, top handle ring.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.40, 0.035, 0.40, 0.02, 0, 0.018, 0));         // base
        g.push(RB(0.34, 0.03, 0.34, 0.015, 0, 0.048, 0));         // lip
        g.push(TP(0.155, 0.10, 0.16, 10, 0, 0.13, 0));            // skirt
        g.push(TP(0.10, 0.032, 0.48, 10, 0, 0.45, 0));            // body
        g.push(RINGY(0.036, 0.012, 0, 0.68, 0, 4, 8));            // handle ring
        return GEO.merge(g);
      });
      const band = GEO.composite(`${key}_b`, () => GEO.merge([
        TP(0.083, 0.070, 0.12, 10, 0, 0.36, 0),
        TP(0.055, 0.046, 0.075, 10, 0, 0.55, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0xe8560f, roughOverride: 0.62 },
        half: new THREE.Vector3(0.2, 0.35, 0.2), mass: 3.2, hollow: 0.6,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.18, 0.35, 0.18), offset: new THREE.Vector3(0, 0.35, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 192,
        extras: [{ geoKey: `${key}_b`, geometry: band, material: simpleMaterial(0xf2f2f0, 0.55, 0, { instanced: true }), capacity: 192 }],
        label: 'traffic cone',
      };
    }

    case 'barrier': {
      const key = 'barrier';
      // Water-filled road barrier: ribbed body, interlocking ends, fill caps.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(GEO.translated(rotG(GEO.taper(0.60, 0.44, 0.62, 4), 0, Math.PI / 4).clone().scale(1.55, 1, 0.72), 0, 0.32, 0));
        g.push(RB(2.0, 0.10, 0.34, 0.03, 0, 0.68, 0));            // top rail
        for (let i = 0; i < 5; i++) g.push(B(0.05, 0.56, 0.46, -0.72 + i * 0.36, 0.32, 0)); // ribs
        g.push(B(0.16, 0.68, 0.30, -1.00, 0.34, 0));              // male end
        g.push(B(0.20, 0.68, 0.36, 1.00, 0.34, 0));               // female end
        g.push(B(0.10, 0.30, 0.16, 1.02, 0.34, 0));
        for (const sx of [-0.45, 0.45]) g.push(CY(0.055, 0.05, 8, sx, 0.71, 0)); // fill caps
        g.push(RB(1.9, 0.08, 0.52, 0.02, 0, 0.04, 0));            // foot
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.05, colorOverride: 0xe23b1e, roughOverride: 0.66 },
        half: new THREE.Vector3(1.0, 0.38, 0.25), mass: 26, hollow: 0.72,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.0, 0.38, 0.25), offset: new THREE.Vector3(0, 0.38, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 96, label: 'barrier',
      };
    }

    case 'guardrail': {
      const key = 'guardrail';
      // Japanese guard pipe: posts on base plates, two rails, capped ends.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const x of [-1.5, 0, 1.5]) {
          g.push(CY(0.045, 0.80, 8, x, 0.40, 0));
          g.push(TP(0.055, 0.045, 0.05, 8, x, 0.805, 0));         // post cap
          g.push(RB(0.16, 0.018, 0.16, 0.006, x, 0.012, 0));      // base plate
          for (const [bx, bz] of [[-0.055, -0.055], [0.055, 0.055]] as const) {
            g.push(CY(0.012, 0.022, 5, x + bx, 0.028, bz));
          }
        }
        g.push(CYX(0.05, 3.12, 8, 0, 0.78, 0));                   // top rail
        g.push(CYX(0.04, 3.12, 8, 0, 0.44, 0));                   // lower rail
        for (const sx of [-1.56, 1.56]) {
          g.push(CYX(0.056, 0.05, 8, sx, 0.78, 0));               // rail end caps
          g.push(CYX(0.046, 0.05, 8, sx, 0.44, 0));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0xbfc2c0, roughOverride: 0.42, metalOverride: 0.6 },
        half: new THREE.Vector3(1.6, 0.4, 0.09), mass: 70, hollow: 0.85,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.6, 0.4, 0.07), offset: new THREE.Vector3(0, 0.4, 0) }],
        flags: F.BREAKABLE, body: 'dynamic', capacity: 96, label: 'guardrail',
      };
    }

    case 'dumpster': {
      const key = 'dumpster';
      // Skip bin: sloped body, ribbed sides, two lids, castors and lift pockets.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(GEO.translated(rotG(GEO.taper(1.32, 1.42, 1.02, 4), 0, Math.PI / 4), 0, 0.62, 0));
        g.push(B(1.92, 0.06, 1.32, 0, 1.14, 0));                  // rim
        for (let i = 0; i < 5; i++) {                              // side ribs
          const x = -0.72 + i * 0.36;
          g.push(B(0.05, 0.94, 1.30, x, 0.62, 0));
        }
        // two hinged lids, one tipped open
        g.push(GEO.transformed(RB(0.94, 0.05, 1.30, 0.02),
          new THREE.Matrix4().makeRotationX(0).setPosition(-0.48, 1.19, 0)));
        g.push(GEO.transformed(RB(0.94, 0.05, 1.30, 0.02),
          new THREE.Matrix4().makeRotationZ(-0.5).setPosition(0.62, 1.38, 0)));
        g.push(CYX(0.028, 1.9, 6, 0, 1.19, -0.62));               // hinge bar
        for (const sx of [-0.55, 0.55]) g.push(B(0.30, 0.16, 0.10, sx, 0.52, 0.66)); // lift pockets
        for (const [cx, cz] of [[-0.74, -0.52], [0.74, -0.52], [-0.74, 0.52], [0.74, 0.52]] as const) {
          g.push(CYX(0.105, 0.07, 8, cx, 0.105, cz));             // castors
          g.push(B(0.07, 0.10, 0.07, cx, 0.20, cz));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x2e6b4f, roughOverride: 0.6, metalOverride: 0.35 },
        half: new THREE.Vector3(0.95, 0.62, 0.65), mass: 260, hollow: 0.6,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.96, 0.61, 0.66), offset: new THREE.Vector3(0, 0.62, 0) },
                { shape: 'box', half: new THREE.Vector3(0.47, 0.03, 0.65), offset: new THREE.Vector3(0.62, 1.38, 0), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.5) }],
        flags: F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 48, label: 'dumpster',
      };
    }

    case 'pallet': {
      const key = 'pallet';
      // Euro pallet: seven deck boards, three bearers, nine blocks.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 5; i++) g.push(B(1.2, 0.022, 0.10, 0, 0.144, -0.44 + i * 0.22));
        g.push(B(1.2, 0.022, 0.14, 0, 0.144, -0.48));
        g.push(B(1.2, 0.022, 0.14, 0, 0.144, 0.48));
        for (const z of [-0.42, 0, 0.42]) g.push(B(1.2, 0.022, 0.12, 0, 0.128, z));  // stringers
        for (const z of [-0.42, 0, 0.42]) {
          for (const x of [-0.53, 0, 0.53]) g.push(B(0.14, 0.078, 0.12, x, 0.078, z)); // blocks
          g.push(B(1.2, 0.020, 0.12, 0, 0.030, z));               // bottom boards
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.3, colorOverride: 0x9b7a52 },
        half: new THREE.Vector3(0.6, 0.078, 0.5), mass: 22,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.6, 0.078, 0.5), offset: new THREE.Vector3(0, 0.078, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'pallet',
      };
    }

    case 'crate': {
      const sz = 0.6 + (v % 3) * 0.24;
      const key = `crate${sz.toFixed(2)}`;
      // Slatted timber crate: corner posts, plank faces, banding.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const h = sz / 2, t = 0.035;
        for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          g.push(B(0.06, sz, 0.06, ax * (h - 0.03), h, az * (h - 0.03)));
        }
        // four faces of horizontal planks with gaps
        const planks = 4;
        for (let i = 0; i < planks; i++) {
          const y = 0.07 + i * (sz - 0.12) / (planks - 1);
          g.push(B(sz - 0.10, (sz - 0.12) / planks * 0.62, t, 0, y, -h + t / 2));
          g.push(B(sz - 0.10, (sz - 0.12) / planks * 0.62, t, 0, y, h - t / 2));
          g.push(B(t, (sz - 0.12) / planks * 0.62, sz - 0.10, -h + t / 2, y, 0));
          g.push(B(t, (sz - 0.12) / planks * 0.62, sz - 0.10, h - t / 2, y, 0));
        }
        g.push(B(sz - 0.04, t, sz - 0.04, 0, sz - t / 2, 0));      // lid
        g.push(B(sz + 0.01, 0.022, 0.05, 0, sz * 0.52, 0));        // steel band
        g.push(B(0.05, 0.022, sz + 0.01, 0, sz * 0.52, 0));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plywood,
        matOpts: { instanced: true, vary: 0.25, colorOverride: 0xa88055 },
        half: new THREE.Vector3(sz / 2, sz / 2, sz / 2), mass: 12 * sz * sz, hollow: 0.72,
        parts: [{ shape: 'box', half: new THREE.Vector3(sz / 2, sz / 2, sz / 2), offset: new THREE.Vector3(0, sz / 2, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'crate',
      };
    }

    case 'barrel': {
      const key = 'barrel';
      // 200 litre steel drum: rolling hoops, chimed ends, bung plugs.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(CY(0.295, 0.86, 14, 0, 0.45, 0));                  // shell
        g.push(RINGY(0.302, 0.028, 0, 0.30, 0, 3, 12));           // rolling hoops
        g.push(RINGY(0.302, 0.028, 0, 0.60, 0, 3, 12));
        g.push(RINGY(0.295, 0.030, 0, 0.885, 0, 3, 12));          // top chime
        g.push(CY(0.28, 0.02, 14, 0, 0.895, 0));                  // lid
        g.push(CY(0.045, 0.022, 6, 0.15, 0.905, 0.06));           // bungs
        g.push(CY(0.030, 0.022, 6, -0.13, 0.905, -0.08));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.25, colorOverride: 0x2f5fa8, roughOverride: 0.5, metalOverride: 0.45 },
        half: new THREE.Vector3(0.31, 0.45, 0.31), mass: 34, hollow: 0.82,
        parts: [{ shape: 'cylinder', radius: 0.31, halfHeight: 0.45, offset: new THREE.Vector3(0, 0.45, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 96, label: 'barrel',
      };
    }



    case 'sandbag': {
      const key = 'sandbag';
      // A filled bag is a slumped pillow: the belly bulges where the sand
      // gathers, the ends flatten and sag, one corner is folded under, and the
      // stitched seam runs along the top.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const bag = GEO.beveledBox(0.60, 0.25, 0.42, 0.105, 3).clone();
        const pos = bag.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          const t = 1 - Math.min(1, Math.abs(v.x) / 0.30);   // 1 at the belly, 0 at the ends
          const b = t * t;
          v.z *= 1 + 0.20 * b;
          v.y *= 1 + 0.26 * b;
          v.y -= 0.035 * (1 - b);                            // ends settle lower than the middle
          v.z += 0.018 * Math.sin(v.x * 9.0);                // slack in the cloth
          pos.setXYZ(i, v.x, v.y, v.z);
        }
        bag.computeVertexNormals();
        g.push(GEO.translated(bag, 0, 0.152, 0));
        // folded end, tucked under the bag's own weight
        g.push(GEO.transformed(GEO.beveledBox(0.17, 0.075, 0.33, 0.03, 2),
          new THREE.Matrix4().makeRotationZ(0.34).setPosition(-0.285, 0.075, 0.01)));
        g.push(GEO.transformed(GEO.beveledBox(0.13, 0.06, 0.30, 0.025, 2),
          new THREE.Matrix4().makeRotationZ(-0.26).setPosition(0.292, 0.095, -0.01)));
        // stitched seam and the creases either side of it
        g.push(GEO.transformed(B(0.50, 0.024, 0.045),
          new THREE.Matrix4().makeRotationZ(0.03).setPosition(0, 0.283, 0.0)));
        for (const z of [-0.12, 0.13]) g.push(B(0.42, 0.012, 0.022, 0.01, 0.268, z));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.fabric,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0xa89877, roughOverride: 0.96 },
        half: new THREE.Vector3(0.31, 0.15, 0.21), mass: 22,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.29, 0.14, 0.2), offset: new THREE.Vector3(0, 0.15, 0) }],
        flags: F.CARRYABLE | F.FLAMMABLE, body: 'dynamic', capacity: 160, label: 'sandbag',
      };
    }

    case 'container': {
      const key = 'container';
      // Shipping container: corrugated sides, corner castings, cargo doors.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(B(5.96, 2.50, 2.36, 0, 1.30, 0));                  // shell
        g.push(B(6.06, 0.10, 2.46, 0, 2.56, 0));                  // roof rail
        g.push(B(6.06, 0.12, 2.46, 0, 0.06, 0));                  // floor rail
        for (let i = 0; i < 19; i++) {                             // corrugations
          const x = -2.80 + i * 0.31;
          g.push(B(0.16, 2.34, 0.06, x, 1.30, 1.21));
          g.push(B(0.16, 2.34, 0.06, x, 1.30, -1.21));
        }
        for (const [cx, cz] of [[-2.98, -1.18], [2.98, -1.18], [-2.98, 1.18], [2.98, 1.18]] as const) {
          g.push(B(0.16, 2.60, 0.16, cx, 1.30, cz));              // corner posts
          g.push(RB(0.22, 0.20, 0.22, 0.02, cx, 0.10, cz));       // corner castings
          g.push(RB(0.22, 0.20, 0.22, 0.02, cx, 2.50, cz));
        }
        // cargo doors on one end
        for (const sz of [-0.59, 0.59]) {
          g.push(B(0.06, 2.34, 1.12, 2.99, 1.30, sz));
          for (let i = 0; i < 2; i++) {
            g.push(CY(0.035, 2.20, 6, 3.04, 1.30, sz + (i ? 0.26 : -0.26)));   // locking bars
            g.push(B(0.10, 0.16, 0.10, 3.06, 1.55, sz + (i ? 0.26 : -0.26)));  // handles
          }
        }
        g.push(B(0.05, 2.34, 0.10, 3.00, 1.30, 0));               // door seam
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.3, colorOverride: 0xa8481f, roughOverride: 0.68, metalOverride: 0.4 },
        half: new THREE.Vector3(3.0, 1.3, 1.22), mass: 2600, hollow: 0.88,
        parts: [{ shape: 'box', half: new THREE.Vector3(3.07, 1.3, 1.24), offset: new THREE.Vector3(0, 1.3, 0) }],
        flags: F.BREAKABLE | F.HOLLOW, body: 'dynamic', capacity: 24, label: 'shipping container',
      };
    }


    case 'scaffold': {
      const key = 'scaffold';
      // A tube-and-fitting tower: standards on screw jacks, ledgers and
      // transoms at each lift, face bracing that alternates hand, boarded
      // decks with toe boards, a guard rail at the top and an access ladder.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const H = 6.0, W = 2.4, D = 1.2, R = 0.032, LIFT = 2.0;
        const XS = [-W / 2, W / 2], ZS = [-D / 2, D / 2];
        const coupler = (x: number, y: number, z: number) => {
          g.push(CY(0.055, 0.10, 6, x, y, z));
          g.push(B(0.03, 0.05, 0.14, x, y + 0.055, z));
        };
        // standards, each on a base jack, with a spigot collar per lift
        for (const x of XS) for (const z of ZS) {
          g.push(CY(R, H - 0.14, 6, x, (H - 0.14) / 2 + 0.14, z));
          g.push(CY(0.021, 0.16, 6, x, 0.09, z));                             // jack stem
          for (let t = 0; t < 4; t++) g.push(RINGY(0.026, 0.008, x, 0.05 + t * 0.03, z, 4, 8));  // jack thread
          g.push(RB(0.16, 0.022, 0.16, 0.006, x, 0.011, z));                  // base plate
          for (let l = 1; l * LIFT < H; l++) g.push(CY(0.040, 0.13, 6, x, l * LIFT + 0.14, z));
        }
        for (let l = 0; l * LIFT < H; l++) {
          const y = 0.90 + l * LIFT;
          for (const z of ZS) { g.push(CYX(0.030, W, 6, 0, y, z)); coupler(XS[0], y, z); coupler(XS[1], y, z); }
          for (const x of XS) g.push(CYZ(0.030, D, 6, x, y + 0.06, 0));
          // transoms carrying the deck, then the boards themselves
          for (let t = 0; t < 3; t++) g.push(CYZ(0.028, D, 6, -W / 2 + 0.3 + t * (W - 0.6) / 2, y + 0.10, 0));
          for (let b = 0; b < 4; b++) {
            const z = -D / 2 + 0.11 + b * (D - 0.22) / 3;
            g.push(RB(W - 0.12, 0.042, (D - 0.26) / 4, 0.008, 0, y + 0.135, z));
            for (const sx of [-1, 1]) g.push(B(0.05, 0.05, (D - 0.24) / 4, sx * (W - 0.14) / 2, y + 0.135, z)); // end bands
          }
          // toe boards along the open edges
          g.push(RB(W - 0.12, 0.16, 0.026, 0.005, 0, y + 0.23, D / 2 - 0.05));
          g.push(RB(W - 0.12, 0.16, 0.026, 0.005, 0, y + 0.23, -D / 2 + 0.05));
          // face brace, alternating hand each lift
          const s = l % 2 === 0 ? 1 : -1;
          g.push(STRUT(-s * W / 2, y - 0.86, D / 2, s * W / 2, y + 0.94, D / 2, 0.028, 6));
          coupler(-s * W / 2, y - 0.86, D / 2); coupler(s * W / 2, y + 0.94, D / 2);
        }
        // guard and mid rail round the top deck
        const ty = 0.90 + Math.floor((H - 0.9) / LIFT) * LIFT;
        for (const dy of [0.63, 1.10]) {
          for (const z of ZS) g.push(CYX(0.028, W, 6, 0, ty + dy, z));
          for (const x of XS) g.push(CYZ(0.028, D, 6, x, ty + dy, 0));
        }
        for (const x of XS) for (const z of ZS) g.push(CY(R, 1.16, 6, x, ty + 0.72, z));
        // access ladder in the end bay
        for (const z of [-0.20, 0.20]) g.push(CY(0.022, H - 0.4, 6, -W / 2 + 0.16, (H - 0.4) / 2 + 0.2, z));
        for (let r = 0; r * 0.31 < H - 0.7; r++) g.push(CYZ(0.016, 0.44, 6, -W / 2 + 0.16, 0.34 + r * 0.31, 0));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.12, colorOverride: 0x8a8f94, roughOverride: 0.5, metalOverride: 0.78 },
        half: new THREE.Vector3(1.25, 3.0, 0.65), mass: 340, hollow: 0.94,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.25, 3.0, 0.65), offset: new THREE.Vector3(0, 3.0, 0) }],
        flags: F.BREAKABLE | F.LADDER, body: 'dynamic', capacity: 48, label: 'scaffold',
      };
    }

    case 'tree': {
      const h = 4.5 + (v % 5) * 1.1;
      const key = `tree${h.toFixed(1)}`;
      // A street tree: flaring trunk, a few real limbs, and foliage clustered on
      // the ends of them rather than a ball floating above a stick.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const r = new Rng(v + 11);
        g.push(TP(0.30, 0.20, 0.45, 8, 0, 0.22, 0));              // root flare
        g.push(TP(0.21, 0.145, h * 0.60, 8, 0, h * 0.30 + 0.2, 0));
        const limbs: [number, number, number][] = [];
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + r.range(-0.3, 0.3);
          const len = r.range(1.0, 1.6);
          const y0 = h * (0.50 + r.range(0, 0.18));
          const x1 = Math.cos(a) * len, z1 = Math.sin(a) * len, y1 = y0 + r.range(0.5, 1.0);
          g.push(STRUT(0, y0, 0, x1, y1, z1, 0.065, 5));
          g.push(STRUT(x1, y1, z1, x1 * 1.35, y1 + 0.42, z1 * 1.35, 0.036, 5));
          limbs.push([x1 * 1.35, y1 + 0.42, z1 * 1.35]);
        }
        return GEO.merge(g);
      });
      const leaves = GEO.composite(`${key}_lv`, () => {
        const g: THREE.BufferGeometry[] = [];
        const r = new Rng(v);
        // a canopy that follows the limbs, plus a denser core
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + r.range(-0.3, 0.3);
          const len = r.range(1.0, 1.6) * 1.35;
          const y = h * (0.50 + r.range(0, 0.18)) + r.range(0.5, 1.0) + 0.42;
          for (let k = 0; k < 3; k++) {
            const sph = GEO.sphere(r.range(0.55, 0.95), 7).clone();
            sph.scale(1.1, 0.78, 1.1);
            sph.translate(Math.cos(a) * len + r.range(-0.4, 0.4), y + r.range(-0.25, 0.45), Math.sin(a) * len + r.range(-0.4, 0.4));
            g.push(sph);
          }
        }
        for (let i = 0; i < 4; i++) {
          const sph = GEO.sphere(r.range(0.8, 1.15), 7).clone();
          sph.scale(1.1, 0.8, 1.1);
          sph.translate(r.range(-0.5, 0.5), h * 0.78 + r.range(-0.2, 0.5), r.range(-0.5, 0.5));
          g.push(sph);
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x5a4736, roughOverride: 0.92 },
        half: new THREE.Vector3(0.25, h * 0.32, 0.25), mass: 420,
        parts: [{ shape: 'cylinder', radius: 0.26, halfHeight: h * 0.32, offset: new THREE.Vector3(0, h * 0.32, 0) },
                { shape: 'ball', radius: 1.5, offset: new THREE.Vector3(0, h * 0.75, 0) }],
        flags: F.BREAKABLE | F.FLAMMABLE | F.TREE, body: 'fixed', capacity: 64,
        extras: [{ geoKey: `${key}_lv`, geometry: leaves, material: makeMaterial(MATERIALS.vegetation, { instanced: true, vary: 0.34, flatShading: true }), cast: true, capacity: 64 }],
        label: 'tree',
      };
    }

    case 'torii': {
      const key = 'torii';
      // Myojin torii: curved kasagi over a shimaki, a nuki through the posts,
      // a gakuzuka strut between them, tapered posts on stone kamebara.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const sx of [-1.8, 1.8]) {
          g.push(TP(0.27, 0.215, 4.4, 10, sx, 2.2, 0));           // post
          g.push(TP(0.36, 0.30, 0.26, 10, sx, 0.13, 0));          // stone base
          g.push(RINGY(0.235, 0.022, sx, 3.92, 0, 4, 10));        // collar
        }
        // nuki: the lower lintel, passing through and beyond the posts
        g.push(RB(4.5, 0.26, 0.36, 0.04, 0, 3.55, 0));
        g.push(B(0.30, 0.46, 0.30, 0, 3.94, 0));                  // gakuzuka
        // shimaki: the straight beam under the cap
        g.push(RB(5.1, 0.26, 0.42, 0.05, 0, 4.30, 0));
        // kasagi: a shallow upward curve built from five segments
        for (let i = 0; i < 5; i++) {
          const t = (i - 2) / 2;
          const w2 = 1.16;
          g.push(GEO.transformed(RB(w2, 0.24, 0.50, 0.06),
            new THREE.Matrix4().makeRotationZ(t * 0.075).setPosition(t * (w2 - 0.06) * 2.05, 4.60 + t * t * 0.14, 0)));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.05, colorOverride: 0xc2402c, roughOverride: 0.72 },
        half: new THREE.Vector3(2.8, 2.4, 0.28), mass: 1800,
        parts: [
          { shape: 'cylinder', radius: 0.26, halfHeight: 2.2, offset: new THREE.Vector3(-1.8, 2.2, 0) },
          { shape: 'cylinder', radius: 0.26, halfHeight: 2.2, offset: new THREE.Vector3(1.8, 2.2, 0) },
          { shape: 'box', half: new THREE.Vector3(2.75, 0.3, 0.26), offset: new THREE.Vector3(0, 4.45, 0) },
          { shape: 'box', half: new THREE.Vector3(2.25, 0.13, 0.18), offset: new THREE.Vector3(0, 3.55, 0) },
          { shape: 'box', half: new THREE.Vector3(0.15, 0.23, 0.15), offset: new THREE.Vector3(0, 3.94, 0) },
        ],
        flags: F.BREAKABLE | F.FLAMMABLE, body: 'fixed', capacity: 8, label: 'torii gate',
      };
    }

    case 'hydrant': {
      const key = 'hydrant';
      // Pillar hydrant: bolted flange, ribbed barrel, bonnet, three outlets.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(TP(0.19, 0.155, 0.09, 10, 0, 0.045, 0));           // base flange
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          g.push(CY(0.017, 0.03, 5, Math.cos(a) * 0.155, 0.10, Math.sin(a) * 0.155));
        }
        g.push(TP(0.145, 0.125, 0.46, 10, 0, 0.32, 0));           // barrel
        g.push(RINGY(0.138, 0.018, 0, 0.20, 0, 5, 10));           // lower band
        g.push(RINGY(0.128, 0.018, 0, 0.55, 0, 5, 10));           // upper band
        g.push(TP(0.135, 0.115, 0.07, 10, 0, 0.60, 0));           // shoulder
        g.push(GEO.sphere(0.115, 10).clone().scale(1, 0.75, 1).translate(0, 0.645, 0));
        g.push(CY(0.045, 0.055, 6, 0, 0.72, 0));                  // operating nut
        // two side outlets with caps, one larger pumper outlet at the front
        for (const sx of [-1, 1]) {
          g.push(CYX(0.052, 0.10, 8, sx * 0.165, 0.42, 0));
          g.push(CYX(0.062, 0.035, 8, sx * 0.225, 0.42, 0));
        }
        g.push(CYZ(0.072, 0.11, 8, 0, 0.36, 0.175));
        g.push(CYZ(0.082, 0.035, 8, 0, 0.36, 0.245));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.05, colorOverride: 0xd8b21e, roughOverride: 0.5 },
        half: new THREE.Vector3(0.19, 0.38, 0.19), mass: 90,
        parts: [{ shape: 'cylinder', radius: 0.18, halfHeight: 0.38, offset: new THREE.Vector3(0, 0.38, 0) }],
        flags: F.BREAKABLE, body: 'dynamic', capacity: 48, label: 'hydrant',
      };
    }


    case 'busStop': {
      const key = 'busStop';
      // A roadside shelter. The roof is a fascia band with a deck and exposed
      // purlins under it; the back is glazed in three bays between mullions;
      // the bench is slats on steel brackets, and a lit timetable case hangs
      // off the kerb-end mullion.
      const HW = 1.72, D = 0.72, EAVE = 2.42;
      const MULL = [-1.64, -0.55, 0.55, 1.64];
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        // --- roof ------------------------------------------------------
        g.push(GEO.translated(rotG(GEO.frame(HW * 2 + 0.20, D * 2 + 0.20, 0.10, 0.17), Math.PI / 2), 0, EAVE + 0.09, 0));
        g.push(B(HW * 2 + 0.02, 0.045, D * 2 + 0.02, 0, EAVE + 0.155, 0));   // deck
        g.push(B(HW * 2 - 0.02, 0.03, D * 2 - 0.02, 0, EAVE + 0.02, 0));     // soffit liner
        for (let i = -2; i <= 2; i++) g.push(B(0.05, 0.09, D * 2 - 0.04, i * 0.7, EAVE + 0.08, 0)); // purlins
        g.push(B(HW * 2 - 0.04, 0.05, 0.06, 0, EAVE + 0.055, -D + 0.09));    // gutter lip
        // --- posts and mullions ---------------------------------------
        for (const x of [MULL[0], MULL[3]]) {
          for (const z of [-D + 0.06, D - 0.06]) {
            g.push(RB(0.085, EAVE, 0.085, 0.012, x, EAVE / 2, z));
            g.push(B(0.16, 0.035, 0.16, x, 0.018, z));                        // base plate
            g.push(B(0.12, 0.02, 0.12, x, EAVE - 0.14, z));                   // collar
          }
        }
        for (const x of MULL.slice(1, 3)) g.push(RB(0.06, EAVE - 0.06, 0.07, 0.01, x, (EAVE - 0.06) / 2 + 0.03, -D + 0.06));
        g.push(B(HW * 2 - 0.02, 0.08, 0.08, 0, EAVE - 0.06, -D + 0.06));      // head rail
        g.push(B(HW * 2 - 0.02, 0.10, 0.09, 0, 0.09, -D + 0.06));             // cill rail
        g.push(B(0.07, EAVE - 0.06, 0.07, MULL[0] + 0.02, (EAVE - 0.06) / 2 + 0.03, 0)); // side head/cill
        g.push(B(0.08, 0.07, D * 2 - 0.16, MULL[0] + 0.02, EAVE - 0.06, 0));
        g.push(B(0.09, 0.09, D * 2 - 0.16, MULL[0] + 0.02, 0.09, 0));
        // --- bench -----------------------------------------------------
        for (let i = 0; i < 5; i++) {
          g.push(RB(2.94, 0.038, 0.088, 0.008, 0, 0.475, -0.55 + i * 0.115));
        }
        for (const x of [-1.24, 0, 1.24]) {
          g.push(B(0.055, 0.44, 0.05, x, 0.24, -0.15));                       // front leg
          g.push(B(0.05, 0.40, 0.42, x, 0.46 - 0.21, -0.37 + 0.0));           // bracket web
          g.push(B(0.05, 0.05, 0.60, x, 0.455, -0.30));                       // seat bearer
          g.push(STRUT(x, 0.46, -0.16, x, 0.10, -0.58, 0.022));               // diagonal stay
        }
        for (const y of [0.74, 0.88]) g.push(RB(2.94, 0.06, 0.05, 0.008, 0, y, -0.60)); // back rails
        // --- timetable case -------------------------------------------
        g.push(B(0.58, 0.80, 0.075, 1.12, 1.56, -D + 0.14));
        g.push(GEO.translated(GEO.frame(0.58, 0.80, 0.05, 0.11), 1.12, 1.56, -D + 0.16));
        g.push(B(0.10, 0.03, 0.06, 1.38, 1.20, -D + 0.18));                   // hinge tab
        // --- flag sign on the kerb post -------------------------------
        g.push(CY(0.045, 0.62, 8, MULL[3], EAVE + 0.44, D - 0.06));
        g.push(GEO.translated(rotG(GEO.cylinder(0.30, 0.05, 20), Math.PI / 2), MULL[3], EAVE + 0.74, D - 0.02));
        g.push(GEO.translated(rotG(GEO.torus(0.30, 0.028, 4, 18), Math.PI / 2), MULL[3], EAVE + 0.74, D - 0.02));
        return GEO.merge(g);
      });
      const glass = GEO.composite(`${key}_g`, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 3; i++) {
          const x0 = MULL[i] + 0.035, x1 = MULL[i + 1] - 0.035;
          g.push(B(x1 - x0, EAVE - 0.28, 0.012, (x0 + x1) / 2, (EAVE + 0.10) / 2, -D + 0.06));
        }
        g.push(B(0.012, EAVE - 0.28, D * 2 - 0.26, MULL[0] + 0.02, (EAVE + 0.10) / 2, 0));
        return GEO.merge(g);
      });
      const lit = GEO.composite(`${key}_l`, () => GEO.merge([
        B(0.50, 0.72, 0.012, 1.12, 1.56, -D + 0.185),                         // timetable face
        B(HW * 2 - 0.30, 0.025, 0.09, 0, EAVE - 0.005, D - 0.12),             // eaves strip
      ]));
      return {
        key, geo, mat: MATERIALS.aluminium,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0x6f7378, roughOverride: 0.4, metalOverride: 0.7 },
        half: new THREE.Vector3(1.75, 1.35, 0.8), mass: 380, hollow: 0.8,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.78, 0.12, 0.8), offset: new THREE.Vector3(0, 2.5, 0) },
                { shape: 'box', half: new THREE.Vector3(0.1, 1.25, 0.78), offset: new THREE.Vector3(-1.64, 1.25, 0) },
                { shape: 'box', half: new THREE.Vector3(0.1, 1.25, 0.78), offset: new THREE.Vector3(1.64, 1.25, 0) },
                { shape: 'box', half: new THREE.Vector3(1.6, 1.2, 0.08), offset: new THREE.Vector3(0, 1.2, -0.66) },
                { shape: 'box', half: new THREE.Vector3(1.5, 0.26, 0.32), offset: new THREE.Vector3(0, 0.26, -0.32) },
                { shape: 'cylinder', radius: 0.05, halfHeight: 0.32, offset: new THREE.Vector3(1.64, 2.86, 0.66) },
                { shape: 'box', half: new THREE.Vector3(0.31, 0.31, 0.04), offset: new THREE.Vector3(1.64, 3.16, 0.7) }],
        flags: F.BREAKABLE | F.GLASS, body: 'fixed', capacity: 24,
        extras: [
          { geoKey: `${key}_g`, geometry: glass, material: makeMaterial(MATERIALS.glass, { instanced: true, transparent: true, opacity: 0.22, roughOverride: 0.04 }), cast: false, renderOrder: 1, capacity: 24 },
          { geoKey: `${key}_l`, geometry: lit, material: emissiveMat(0xfff0cf, 2.0), cast: false, capacity: 24 },
        ],
        label: 'bus shelter',
      };
    }


    case 'phoneBooth': {
      const key = 'phoneBooth';
      // Glazed on three sides with a hinged door on the fourth, a lit sign band
      // round the head, and a real phone inside: body, keypad, coin slot, a
      // shelf, and a handset hanging on its hook with the cord looping down.
      const HS = 0.52, HT = 2.30;             // half plan size, head height
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        // plinth
        g.push(RB(HS * 2 + 0.06, 0.10, HS * 2 + 0.06, 0.02, 0, 0.05, 0));
        g.push(B(HS * 2 - 0.02, 0.06, HS * 2 - 0.02, 0, 0.13, 0));
        // corner posts, channel section so they read as extrusions not sticks
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const x = sx * (HS - 0.035), z = sz * (HS - 0.035);
          g.push(B(0.075, HT - 0.16, 0.075, x, (HT - 0.16) / 2 + 0.16, z));
          g.push(B(0.03, HT - 0.24, 0.055, x - sx * 0.05, (HT - 0.24) / 2 + 0.18, z));
          g.push(B(0.055, HT - 0.24, 0.03, x, (HT - 0.24) / 2 + 0.18, z - sz * 0.05));
        }
        // cill and head rails on the three glazed faces
        for (const [ax, az] of [[0, -1], [-1, 0], [1, 0]] as const) {
          const w = 0.10, span = HS * 2 - 0.10;
          if (az !== 0) {
            g.push(B(span, 0.09, w, 0, 0.22, az * (HS - 0.04)));
            g.push(B(span, 0.09, w, 0, HT - 0.20, az * (HS - 0.04)));
            g.push(B(span, 0.05, 0.06, 0, 1.12, az * (HS - 0.04)));          // mid rail
          } else {
            g.push(B(w, 0.09, span, ax * (HS - 0.04), 0.22, 0));
            g.push(B(w, 0.09, span, ax * (HS - 0.04), HT - 0.20, 0));
            g.push(B(0.06, 0.05, span, ax * (HS - 0.04), 1.12, 0));
          }
        }
        // door leaf on +Z: stiles, rails, handle, hinges
        g.push(B(0.085, HT - 0.34, 0.06, -0.44, (HT - 0.34) / 2 + 0.20, HS - 0.02));
        g.push(B(0.085, HT - 0.34, 0.06,  0.44, (HT - 0.34) / 2 + 0.20, HS - 0.02));
        g.push(B(0.88, 0.09, 0.06, 0, 0.245, HS - 0.02));
        g.push(B(0.88, 0.09, 0.06, 0, HT - 0.24, HS - 0.02));
        g.push(B(0.88, 0.05, 0.05, 0, 1.12, HS - 0.02));
        g.push(CYX(0.018, 0.22, 8, 0.30, 1.12, HS + 0.06));                   // pull handle
        for (const y of [1.05, 1.19]) g.push(B(0.05, 0.05, 0.10, 0.30, y, HS + 0.02));
        for (const y of [0.42, 1.18, 1.94]) g.push(CYZ(0.022, 0.09, 8, -0.48, y, HS - 0.02));
        // head: fascia and cornice
        g.push(GEO.translated(rotG(GEO.frame(HS * 2 + 0.10, HS * 2 + 0.10, 0.09, 0.30), Math.PI / 2), 0, HT - 0.02, 0));
        g.push(RB(HS * 2 + 0.16, 0.07, HS * 2 + 0.16, 0.02, 0, HT + 0.17, 0));
        g.push(B(HS * 2 - 0.02, 0.05, HS * 2 - 0.02, 0, HT - 0.16, 0));       // ceiling
        // vents over the door head
        for (let i = 0; i < 4; i++) g.push(B(0.60, 0.018, 0.03, 0, HT - 0.30 + i * 0.03, -HS + 0.05));
        // --- the phone itself, on the back wall ------------------------
        const bz = -HS + 0.10;
        g.push(RB(0.34, 0.50, 0.15, 0.02, 0.10, 1.34, bz + 0.05));            // body
        g.push(B(0.30, 0.12, 0.03, 0.10, 1.50, bz + 0.13));                   // display panel surround
        g.push(B(0.20, 0.16, 0.025, 0.12, 1.30, bz + 0.13));                  // keypad plate
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
          g.push(B(0.035, 0.026, 0.012, 0.045 + c * 0.055, 1.365 - r * 0.04, bz + 0.145));
        }
        g.push(B(0.06, 0.012, 0.02, 0.10, 1.57, bz + 0.15));                  // coin slot
        g.push(B(0.12, 0.05, 0.05, 0.10, 1.12, bz + 0.13));                   // coin return
        g.push(RB(0.46, 0.035, 0.24, 0.01, -0.02, 1.05, bz + 0.12));          // shelf
        for (const x of [-0.22, 0.18]) g.push(STRUT(x, 1.03, bz + 0.04, x, 0.88, bz + 0.22, 0.012));
        g.push(RB(0.22, 0.03, 0.16, 0.01, -0.14, 1.09, bz + 0.13));           // directory on the shelf
        // handset on its hook: earpiece, grip, mouthpiece, and the cord
        g.push(B(0.05, 0.03, 0.04, -0.13, 1.44, bz + 0.13));                  // hook
        g.push(RB(0.055, 0.075, 0.05, 0.012, -0.13, 1.50, bz + 0.15));        // earpiece
        g.push(RB(0.045, 0.22, 0.04, 0.012, -0.13, 1.35, bz + 0.15));         // grip
        g.push(RB(0.055, 0.075, 0.05, 0.012, -0.13, 1.21, bz + 0.15));        // mouthpiece
        g.push(GEO.tube([
          new THREE.Vector3(-0.13, 1.20, bz + 0.15), new THREE.Vector3(-0.15, 1.06, bz + 0.19),
          new THREE.Vector3(-0.09, 0.96, bz + 0.16), new THREE.Vector3(-0.02, 1.02, bz + 0.09),
          new THREE.Vector3(0.02, 1.14, bz + 0.07),
        ], 0.012, 5));
        return GEO.merge(g);
      });
      const glass = GEO.composite(`${key}_g`, () => GEO.merge([
        B(HS * 2 - 0.14, 0.82, 0.012, 0, 0.70, -HS + 0.04), B(HS * 2 - 0.14, 0.92, 0.012, 0, 1.63, -HS + 0.04),
        B(0.012, 0.82, HS * 2 - 0.14, -HS + 0.04, 0.70, 0), B(0.012, 0.92, HS * 2 - 0.14, -HS + 0.04, 1.63, 0),
        B(0.012, 0.82, HS * 2 - 0.14,  HS - 0.04, 0.70, 0), B(0.012, 0.92, HS * 2 - 0.14,  HS - 0.04, 1.63, 0),
        B(0.80, 0.80, 0.012, 0, 0.71, HS - 0.02), B(0.80, 0.90, 0.012, 0, 1.62, HS - 0.02),
      ]));
      const lit = GEO.composite(`${key}_l`, () => GEO.merge([
        B(HS * 2 - 0.02, 0.22, 0.012, 0, HT + 0.02, HS + 0.045),
        B(HS * 2 - 0.02, 0.22, 0.012, 0, HT + 0.02, -HS - 0.045),
        B(0.012, 0.22, HS * 2 - 0.02, HS + 0.045, HT + 0.02, 0),
        B(0.012, 0.22, HS * 2 - 0.02, -HS - 0.045, HT + 0.02, 0),
        B(0.28, 0.09, 0.012, 0.10, 1.50, -HS + 0.125),                        // phone display
      ]));
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.05, colorOverride: 0x2a6c4a, roughOverride: 0.45, metalOverride: 0.45 },
        half: new THREE.Vector3(0.55, 1.2, 0.55), mass: 320, hollow: 0.82,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.55, 1.2, 0.55), offset: new THREE.Vector3(0, 1.2, 0) }],
        flags: F.BREAKABLE | F.GLASS, body: 'dynamic', capacity: 24,
        extras: [
          { geoKey: `${key}_g`, geometry: glass, material: makeMaterial(MATERIALS.glass, { instanced: true, transparent: true, opacity: 0.2, roughOverride: 0.04 }), cast: false, renderOrder: 1, capacity: 24 },
          { geoKey: `${key}_l`, geometry: lit, material: emissiveMat(0xd6f2ff, 2.4), cast: false, capacity: 24 },
        ],
        label: 'phone booth',
      };
    }


    case 'spool': {
      const key = 'spool';
      // A timber cable drum: each flange is radial boards between a hub disc
      // and a rim band, with the cable wound on the barrel and one end left
      // trailing over the edge the way they are always found on a site.
      const R = 0.85, HWID = 0.40, FT = 0.11;
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const z of [-HWID, HWID]) {
          g.push(CYZ(0.30, FT + 0.02, 16, 0, 0, z));                          // hub disc
          for (let i = 0; i < 12; i++) {
            const a = i * Math.PI / 6;
            g.push(GEO.transformed(B(R - 0.22, 0.185, FT),
              new THREE.Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * (R + 0.22) / 2, Math.sin(a) * (R + 0.22) / 2, z)));
          }
          g.push(GEO.translated(GEO.torus(R - 0.05, 0.055, 4, 22), 0, 0, z)); // rim band
          g.push(GEO.translated(GEO.torus(0.52, 0.035, 4, 18), 0, 0, z));     // inner band
          for (let i = 0; i < 6; i++) {                                       // hub bolts
            const a = i * Math.PI / 3 + 0.3;
            g.push(CYZ(0.026, FT + 0.06, 6, Math.cos(a) * 0.22, Math.sin(a) * 0.22, z));
          }
        }
        g.push(CYZ(0.47, HWID * 2 - FT, 20, 0, 0, 0));                        // barrel
        g.push(CYZ(0.062, HWID * 2 + 0.34, 10, 0, 0, 0));                     // axle
        for (const z of [-HWID - 0.11, HWID + 0.11]) { g.push(CYZ(0.11, 0.035, 10, 0, 0, z)); g.push(CYZ(0.078, 0.055, 6, 0, 0, z + Math.sign(z) * 0.04)); }
        return GEO.translated(GEO.merge(g), 0, R, 0);
      });
      // The wound cable and the trailing end are rubber, not timber.
      const cable = GEO.composite(`${key}_c`, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 9; i++) g.push(GEO.translated(GEO.torus(0.515, 0.042, 5, 18), 0, 0, -0.26 + i * 0.065));
        for (let i = 0; i < 6; i++) g.push(GEO.translated(GEO.torus(0.596, 0.042, 5, 18), 0, 0, -0.17 + i * 0.068));
        g.push(GEO.tube([
          new THREE.Vector3(0.59, 0.12, 0.24), new THREE.Vector3(0.78, 0.38, 0.32),
          new THREE.Vector3(0.90, 0.56, 0.16), new THREE.Vector3(0.83, 0.30, -0.12),
          new THREE.Vector3(0.64, 0.02, -0.24),
        ], 0.042, 6));
        return GEO.translated(GEO.merge(g), 0, R, 0);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x8d7050 },
        half: new THREE.Vector3(0.86, 0.86, 0.52), mass: 240,
        parts: [{ shape: 'cylinder', radius: 0.85, halfHeight: 0.52, offset: new THREE.Vector3(0, R, 0), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2) }],
        flags: F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 32, label: 'cable spool',
        extras: [{ geoKey: `${key}_c`, geometry: cable, material: makeMaterial(MATERIALS.rubber, { instanced: true, vary: 0.1, colorOverride: 0x33383f, roughOverride: 0.66 }), capacity: 32 }],
      };
    }

    case 'drainPipe': {
      const key = 'drainPipe';
      // Downpipe with socketed joints, wall clips and a shoe at the bottom.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(CY(0.072, 3.2, 8, 0, 0, 0));
        for (const y of [-1.0, 1.2]) g.push(CY(0.086, 0.13, 6, 0, y, 0)); // socket joints
        for (const y of [-1.35, 0.95]) {                           // wall clips
          g.push(RINGY(0.082, 0.014, 0, y, 0, 3, 8));
          g.push(B(0.05, 0.05, 0.10, 0, y, -0.12));
          g.push(B(0.09, 0.09, 0.02, 0, y, -0.18));
        }
        g.push(GEO.transformed(GEO.cylinder(0.072, 0.30, 8),
          new THREE.Matrix4().makeRotationX(0.6).setPosition(0, -1.66, 0.09)));  // shoe
        g.push(CY(0.086, 0.10, 8, 0, 1.58, 0));                   // hopper collar
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0x57585a, roughOverride: 0.6 },
        half: new THREE.Vector3(0.09, 1.6, 0.09), mass: 9, hollow: 0.78,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.09, 1.6, 0.09), offset: new THREE.Vector3() }], centred: true,
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 96, label: 'drain pipe',
      };
    }



    case 'banner': {
      const key = 'banner';
      // A shopfront nobori. The cloth is strips following a slack curve with a
      // little twist in each, so the edges waver and it hangs rather than
      // reading as a card; the printed panel and hems are a separate colour.
      const W = 0.86, H = 2.34, N = 11;
      const bowAt = (t: number) => Math.sin(t * Math.PI) * 0.085 + Math.sin(t * Math.PI * 2.7) * 0.045;
      const twistAt = (t: number) => Math.sin(t * Math.PI * 1.9 + 0.6) * 0.085;
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 0; i < N; i++) {
          const t = (i + 0.5) / N;
          const z = bowAt(t);
          const dz = (bowAt(Math.min(1, t + 1 / N)) - bowAt(Math.max(0, t - 1 / N))) * 0.5;
          g.push(GEO.transformed(B(W + 0.012, H / N + 0.008, 0.011), new THREE.Matrix4()
            .makeRotationFromEuler(new THREE.Euler(-Math.atan2(dz, H / N), twistAt(t), 0))
            .setPosition(0, H / 2 - (i + 0.5) * (H / N), z)));
        }
        for (const sx of [-1, 1]) {                                            // side hems follow the bow
          for (let i = 0; i < N; i++) {
            const t = (i + 0.5) / N;
            g.push(GEO.transformed(B(0.030, H / N + 0.008, 0.026), new THREE.Matrix4()
              .makeRotationY(twistAt(t))
              .setPosition(sx * (W / 2 + 0.004), H / 2 - (i + 0.5) * (H / N), bowAt(t) + 0.012)));
          }
        }
        g.push(CYX(0.028, W + 0.20, 8, 0, H / 2 + 0.06, bowAt(0)));           // head rail in its sleeve
        g.push(B(W + 0.04, 0.10, 0.058, 0, H / 2 + 0.055, bowAt(0.02)));
        g.push(CYX(0.022, W + 0.12, 8, 0, -H / 2 - 0.05, bowAt(1)));          // weighted foot rail
        for (const sx of [-1, 1]) {
          g.push(CY(0.035, 0.05, 8, sx * (W / 2 + 0.10), H / 2 + 0.06, bowAt(0)));
          g.push(GEO.tube([                                                    // cord tie
            new THREE.Vector3(sx * (W / 2 + 0.07), H / 2 + 0.06, bowAt(0)),
            new THREE.Vector3(sx * (W / 2 + 0.12), H / 2 - 0.02, bowAt(0.04) + 0.05),
            new THREE.Vector3(sx * (W / 2 + 0.06), H / 2 - 0.12, bowAt(0.08) + 0.02),
          ], 0.008, 4));
        }
        return GEO.merge(g);
      });
      // Printed field and hem bands, so the banner is not one flat colour.
      const print = GEO.composite(`${key}_p`, () => {
        const g: THREE.BufferGeometry[] = [];
        for (let i = 1; i < N - 1; i++) {
          const t = (i + 0.5) / N;
          const dz = (bowAt(Math.min(1, t + 1 / N)) - bowAt(Math.max(0, t - 1 / N))) * 0.5;
          const e = new THREE.Euler(-Math.atan2(dz, H / N), twistAt(t), 0);
          for (const sz of [-1, 1]) {
            g.push(GEO.transformed(B(W * 0.46, H / N + 0.008, 0.006), new THREE.Matrix4()
              .makeRotationFromEuler(e).setPosition(0, H / 2 - (i + 0.5) * (H / N), bowAt(t) + sz * 0.009)));
          }
        }
        for (const [t, h] of [[0.035, 0.07], [0.965, 0.07]] as const) {
          g.push(GEO.transformed(B(W + 0.015, h, 0.016), new THREE.Matrix4()
            .makeRotationY(twistAt(t)).setPosition(0, H / 2 - t * H, bowAt(t))));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.fabric,
        matOpts: { instanced: true, vary: 0.4, colorOverride: 0xc23a2e },
        half: new THREE.Vector3(0.45, 1.2, 0.02), mass: 2.4,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.45, 1.2, 0.08), offset: new THREE.Vector3() }], centred: true,
        flags: F.CARRYABLE | F.FLAMMABLE | F.BREAKABLE, body: 'dynamic', capacity: 96, label: 'banner',
        extras: [{ geoKey: `${key}_p`, geometry: print, material: makeMaterial(MATERIALS.fabric, { instanced: true, vary: 0.08, colorOverride: 0xece4d3, roughOverride: 0.95 }), capacity: 96 }],
      };
    }


    case 'steelBeam': {
      const L = 4 + (v % 4) * 1.6;
      const key = `beam${L.toFixed(1)}`;
      // A universal beam: tapered flanges, root fillets where the web meets
      // them, web stiffeners at the third points, and bolted end plates.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const FY = 0.145, FT = 0.028, BW = 0.125, WT = 0.016;
        for (const sy of [-1, 1]) {
          g.push(B(L, FT, BW * 2, 0, sy * FY, 0));                            // flange
          g.push(B(L, 0.012, BW * 2 - 0.03, 0, sy * (FY - FT / 2 - 0.004), 0)); // inner taper
          for (const sz of [-1, 1]) {                                          // root fillet
            g.push(GEO.transformed(B(L, 0.026, 0.026), new THREE.Matrix4()
              .makeRotationX(Math.PI / 4).setPosition(0, sy * (FY - FT / 2 - 0.012), sz * (WT / 2 + 0.012))));
          }
        }
        g.push(B(L, (FY - FT / 2) * 2, WT, 0, 0, 0));                         // web
        for (let i = 1; i <= 3; i++) {                                         // web stiffeners
          const x = -L / 2 + (i * L) / 4;
          for (const sz of [-1, 1]) g.push(B(0.014, (FY - FT) * 2, BW - WT / 2, x, 0, sz * (BW / 2 + WT / 4)));
        }
        for (const sx of [-1, 1]) {                                            // bolted end plate
          const x = sx * (L / 2 + 0.008);
          g.push(RB(0.016, FY * 2 + 0.05, BW * 2 + 0.04, 0.004, x, 0, 0));
          for (const by of [-0.115, 0.115]) for (const bz of [-0.085, 0.085]) {
            g.push(CYX(0.017, 0.022, 6, x + sx * 0.018, by, bz));
          }
        }
        return GEO.translated(GEO.merge(g), 0, 0.16, 0);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.15, colorOverride: 0x8b6a4a, roughOverride: 0.62, metalOverride: 0.72 },
        half: new THREE.Vector3(L / 2, 0.16, 0.13), mass: L * 36,
        parts: [{ shape: 'box', half: new THREE.Vector3(L / 2, 0.15, 0.12), offset: new THREE.Vector3(0, 0.16, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 64, label: 'steel beam',
      };
    }


    case 'rebar': {
      const key = 'rebar';
      // Twelve bars packed round a core rather than scattered, the outer ones
      // carrying the ribbed deformation you actually see, tied with wire at
      // three points and with the ends left deliberately uneven.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const r = new Rng(9);
        const ring = (n: number, rad: number, ribbed: boolean) => {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + rad;
            const y = Math.cos(a) * rad, z = Math.sin(a) * rad;
            const off = r.range(-0.09, 0.09);
            g.push(CYX(0.0115, 3.0, 5, off, y, z));
            if (!ribbed) continue;
            for (let k = -7; k <= 7; k++) {                                    // rolled ribs
              g.push(GEO.translated(rotG(GEO.torus(0.0125, 0.0035, 3, 6), 0, Math.PI / 2, 0.45), off + k * 0.2, y, z));
            }
          }
        };
        g.push(CYX(0.0115, 3.0, 5, r.range(-0.06, 0.06), 0, 0));
        ring(5, 0.028, false);
        ring(6, 0.058, true);
        for (const x of [-0.9, 0, 0.9]) {                                       // wire ties
          g.push(GEO.translated(rotG(GEO.torus(0.074, 0.005, 4, 14), 0, Math.PI / 2), x, 0, 0));
          g.push(CYX(0.005, 0.05, 4, x, 0.078, 0.016));
        }
        return GEO.translated(GEO.merge(g), 0, 0.11, 0);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x7a5e44, roughOverride: 0.78, metalOverride: 0.6 },
        half: new THREE.Vector3(1.5, 0.11, 0.11), mass: 120,
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 48, label: 'rebar bundle',
      };
    }

    case 'portaloo': {
      const key = 'portaloo';
      // Site toilet: ribbed panels, vent stack, door with a louvre and latch.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.10, 2.20, 1.10, 0.035, 0, 1.13, 0));
        g.push(B(1.18, 0.07, 1.18, 0, 2.26, 0));                  // roof
        g.push(B(1.14, 0.10, 1.14, 0, 0.05, 0));                  // skid base
        for (let i = 0; i < 4; i++) {                              // side ribs
          const x = -0.36 + i * 0.24;
          g.push(B(0.05, 2.00, 0.04, x, 1.15, 0.57));
          g.push(B(0.04, 2.00, 0.05, 0.57, 1.15, x));
          g.push(B(0.04, 2.00, 0.05, -0.57, 1.15, x));
        }
        g.push(RB(0.86, 1.92, 0.05, 0.015, 0, 1.12, -0.56));      // door
        for (let i = 0; i < 5; i++) g.push(B(0.60, 0.022, 0.03, 0, 1.78 + i * 0.045, -0.59)); // louvre
        g.push(B(0.06, 0.20, 0.05, 0.34, 1.10, -0.60));           // latch
        g.push(CY(0.028, 0.10, 6, 0.34, 1.02, -0.62));
        g.push(CY(0.075, 0.55, 8, 0.40, 2.50, 0.40));             // vent stack
        g.push(TP(0.11, 0.09, 0.07, 8, 0.40, 2.80, 0.40));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0x3b7ec4, roughOverride: 0.6 },
        half: new THREE.Vector3(0.58, 1.14, 0.58), mass: 85, hollow: 0.86,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.59, 1.16, 0.6), offset: new THREE.Vector3(0, 1.16, 0) }, { shape: 'cylinder', radius: 0.11, halfHeight: 0.32, offset: new THREE.Vector3(0.4, 2.55, 0.4) }],
        flags: F.BREAKABLE | F.HOLLOW, body: 'dynamic', capacity: 32, label: 'portable toilet',
      };
    }

    case 'gasCanister': {
      const key = 'gasCanister';
      // LPG cylinder: welded seam, foot ring, collar and valve.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(CY(0.19, 0.66, 12, 0, 0.38, 0));                   // shell
        g.push(GEO.sphere(0.19, 10).clone().scale(1, 0.62, 1).translate(0, 0.71, 0));
        g.push(GEO.sphere(0.19, 10).clone().scale(1, 0.55, 1).translate(0, 0.055, 0));
        g.push(RINGY(0.192, 0.014, 0, 0.38, 0, 4, 12));           // weld seam
        g.push(TP(0.175, 0.185, 0.10, 12, 0, 0.05, 0));           // foot ring
        g.push(CY(0.062, 0.10, 8, 0, 0.83, 0));                   // neck
        g.push(CY(0.038, 0.07, 6, 0, 0.90, 0));                   // valve body
        g.push(RINGY(0.055, 0.012, 0, 0.94, 0, 4, 8));            // handwheel
        // carry collar
        g.push(TP(0.115, 0.125, 0.16, 10, 0, 0.86, 0));
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          g.push(B(0.05, 0.16, 0.05, Math.cos(a) * 0.115, 0.86, Math.sin(a) * 0.115));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0xb8433a, roughOverride: 0.45, metalOverride: 0.55 },
        half: new THREE.Vector3(0.2, 0.5, 0.2), mass: 34, hollow: 0.6,
        parts: [{ shape: 'cylinder', radius: 0.2, halfHeight: 0.5, offset: new THREE.Vector3(0, 0.5, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.GAS_SOURCE, body: 'dynamic', capacity: 64, label: 'gas canister',
      };
    }


    case 'plank': {
      const L = 1.6 + (v % 4) * 0.7;
      const key = `plank${L.toFixed(1)}`;
      // A sawn board: chamfered arrises, a knot, a shake running in from one
      // end, and the nails still in it from whatever it was pulled off.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [RB(L, 0.05, 0.24, 0.012)];
        g.push(B(L * 0.5, 0.004, 0.012, L * 0.22, 0.026, 0.03));              // shake
        g.push(CY(0.028, 0.055, 8, -L * 0.18, 0.001, -0.06));                 // knot
        for (const [x, z] of [[-L / 2 + 0.09, -0.07], [-L / 2 + 0.09, 0.07], [L / 2 - 0.11, 0.05]] as const) {
          g.push(CY(0.011, 0.012, 6, x, 0.029, z));                           // nail heads
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.3, colorOverride: 0x9c7c54 },
        half: new THREE.Vector3(L / 2, 0.025, 0.12), mass: L * 5,
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'plank',
      };
    }

    case 'mattress': {
      const key = 'mattress';
      // Quilted mattress: rolled edge, tufted top, side tape and handles.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.88, 0.24, 1.33, 0.09, 0, 0, 0));
        g.push(RB(1.80, 0.06, 1.25, 0.05, 0, 0.115, 0));          // quilted top
        g.push(RB(1.80, 0.06, 1.25, 0.05, 0, -0.115, 0));
        g.push(B(1.90, 0.035, 1.35, 0, 0, 0));                    // side tape
        for (let i = 0; i < 3; i++) for (let k = 0; k < 2; k++) {
          g.push(CY(0.035, 0.02, 6, -0.6 + i * 0.6, 0.14, -0.32 + k * 0.64));  // tufts
        }
        for (const sx of [-0.55, 0.55]) g.push(B(0.22, 0.05, 0.03, sx, 0.02, 0.675)); // handles
        return GEO.translated(GEO.merge(g), 0, 0.135, 0);
      });
      return {
        key, geo, mat: MATERIALS.foam,
        matOpts: { instanced: true, vary: 0.15, colorOverride: 0xd8d2c4, roughOverride: 0.95 },
        half: new THREE.Vector3(0.95, 0.13, 0.68), mass: 26, hollow: 0.2,
        flags: F.CARRYABLE | F.FLAMMABLE | F.BREAKABLE, body: 'dynamic', capacity: 48, label: 'mattress',
      };
    }

    case 'fridge': {
      const key = 'fridge';
      // Two-door fridge: recessed door faces, bar handles, plinth and hinges.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.66, 1.66, 0.64, 0.025, 0, 0.90, 0));          // carcass
        g.push(B(0.62, 0.11, 0.62, 0, 0.055, 0));                 // plinth
        g.push(RB(0.64, 0.52, 0.06, 0.02, 0, 1.46, 0.33));        // freezer door
        g.push(RB(0.64, 1.02, 0.06, 0.02, 0, 0.66, 0.33));        // fridge door
        g.push(B(0.64, 0.025, 0.07, 0, 1.19, 0.335));             // door gap
        for (const [hy, hh] of [[1.30, 0.34], [0.92, 0.46]] as const) {
          g.push(CY(0.017, hh, 6, 0.24, hy, 0.375));              // bar handles
          g.push(B(0.03, 0.03, 0.05, 0.24, hy + hh / 2 - 0.02, 0.352));
          g.push(B(0.03, 0.03, 0.05, 0.24, hy - hh / 2 + 0.02, 0.352));
        }
        for (const hy of [0.20, 1.14, 1.60]) g.push(B(0.05, 0.06, 0.05, -0.33, hy, 0.30)); // hinges
        g.push(B(0.30, 0.16, 0.02, 0, 1.70, 0.33));               // badge panel
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.06, colorOverride: 0xdadcdd, roughOverride: 0.34, metalOverride: 0.45 },
        half: new THREE.Vector3(0.33, 0.86, 0.33), mass: 78, hollow: 0.68,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.33, 0.86, 0.33), offset: new THREE.Vector3(0, 0.86, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.HOLLOW, body: 'dynamic', capacity: 48, label: 'refrigerator',
      };
    }

    case 'desk': {
      const key = 'desk';
      // Office desk: bull-nosed top, three-drawer pedestal, modesty panel.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.45, 0.045, 0.72, 0.018, 0, 0.725, 0));        // top
        g.push(B(1.41, 0.025, 0.68, 0, 0.695, 0));                // underframe
        g.push(RB(0.52, 0.64, 0.62, 0.012, -0.43, 0.38, 0));      // pedestal carcass
        for (let i = 0; i < 3; i++) {                              // drawer fronts
          const dy = 0.16 + i * 0.22;
          g.push(RB(0.48, 0.195, 0.025, 0.008, -0.43, dy, 0.312));
          g.push(B(0.18, 0.022, 0.028, -0.43, dy, 0.33));         // handle
        }
        for (const [x, z] of [[0.66, -0.30], [0.66, 0.30]] as const) {
          g.push(B(0.05, 0.69, 0.05, x, 0.35, z));                // legs
          g.push(RB(0.09, 0.02, 0.09, 0.004, x, 0.012, z));       // feet
        }
        g.push(B(0.05, 0.05, 0.62, 0.66, 0.66, 0));               // leg rail
        g.push(B(0.72, 0.30, 0.02, 0.30, 0.52, -0.33));           // modesty panel
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plywood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x9a7d5c },
        half: new THREE.Vector3(0.73, 0.38, 0.36), mass: 42, hollow: 0.55,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.73, 0.04, 0.36), offset: new THREE.Vector3(0, 0.72, 0) },
                { shape: 'box', half: new THREE.Vector3(0.28, 0.35, 0.31), offset: new THREE.Vector3(-0.42, 0.35, 0) },
                { shape: 'box', half: new THREE.Vector3(0.035, 0.35, 0.33), offset: new THREE.Vector3(0.66, 0.35, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64, label: 'desk',
      };
    }

    case 'shelf': {
      const key = 'shelf';
      // Steel shelving bay: angle uprights, five shelves, cross bracing.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const [x, z] of [[-0.53, -0.16], [0.53, -0.16], [-0.53, 0.16], [0.53, 0.16]] as const) {
          g.push(B(0.045, 1.90, 0.045, x, 0.95, z));              // uprights
          g.push(RB(0.09, 0.012, 0.09, 0.004, x, 0.006, z));      // feet
        }
        for (let i = 0; i < 5; i++) {
          const y = 0.18 + i * 0.42;
          g.push(RB(1.10, 0.028, 0.38, 0.008, 0, y, 0));          // shelf plate
          g.push(B(1.10, 0.05, 0.02, 0, y + 0.03, 0.19));         // front lip
          g.push(B(1.10, 0.05, 0.02, 0, y + 0.03, -0.19));
        }
        g.push(STRUT(-0.53, 0.20, -0.18, 0.53, 1.85, -0.18, 0.014, 4)); // rear bracing
        g.push(STRUT(0.53, 0.20, -0.18, -0.53, 1.85, -0.18, 0.014, 4));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plywood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x7d6446 },
        half: new THREE.Vector3(0.56, 0.95, 0.19), mass: 48, hollow: 0.7,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.56, 0.95, 0.19), offset: new THREE.Vector3(0, 0.95, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64, label: 'shelving',
      };
    }

    case 'sofa': {
      const key = 'sofa';
      // Two-seater: separate seat and back cushions, rolled arms, short feet.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.95, 0.24, 0.84, 0.05, 0, 0.30, 0));           // frame deck
        g.push(RB(1.95, 0.60, 0.20, 0.07, 0, 0.74, -0.34));       // back frame
        for (const sx of [-1, 1]) {
          g.push(RB(0.22, 0.42, 0.84, 0.10, sx * 0.87, 0.60, 0)); // arms
          g.push(CYZ(0.11, 0.84, 8, sx * 0.87, 0.79, 0));         // rolled top
        }
        for (const sx of [-1, 1]) {
          g.push(RB(0.84, 0.18, 0.72, 0.07, sx * 0.42, 0.51, 0.03));   // seat cushions
          g.push(RB(0.82, 0.44, 0.16, 0.06, sx * 0.42, 0.82, -0.31));  // back cushions
        }
        g.push(B(1.90, 0.10, 0.80, 0, 0.13, 0));                  // plinth
        for (const [x, z] of [[-0.86, -0.32], [0.86, -0.32], [-0.86, 0.32], [0.86, 0.32]] as const) {
          g.push(TP(0.05, 0.035, 0.09, 6, x, 0.045, z));          // feet
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.fabric,
        matOpts: { instanced: true, vary: 0.3, colorOverride: 0x5c6470, roughOverride: 0.95 },
        half: new THREE.Vector3(0.98, 0.5, 0.45), mass: 62, hollow: 0.5,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.98, 0.5, 0.45), offset: new THREE.Vector3(0, 0.5, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 48, label: 'sofa',
      };
    }

    case 'locker': {
      const key = 'locker';
      // Two-bay steel locker: framed doors, vents, latch handles, sloped top.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.90, 1.74, 0.48, 0.015, 0, 0.90, 0));          // carcass
        g.push(B(0.94, 0.05, 0.52, 0, 1.79, 0));                  // top cap
        g.push(B(0.90, 0.10, 0.48, 0, 0.05, 0));                  // plinth
        for (const sx of [-1, 1]) {
          const x = sx * 0.225;
          g.push(RB(0.42, 1.64, 0.035, 0.01, x, 0.92, 0.25));     // door
          for (let i = 0; i < 4; i++) g.push(B(0.22, 0.016, 0.02, x, 1.58 + i * 0.045, 0.272)); // vents
          for (let i = 0; i < 4; i++) g.push(B(0.22, 0.016, 0.02, x, 0.26 + i * 0.045, 0.272));
          g.push(RB(0.05, 0.16, 0.028, 0.008, x + sx * 0.15, 1.02, 0.28));  // latch
          g.push(CY(0.022, 0.03, 6, x + sx * 0.15, 0.90, 0.285));           // lock barrel
          g.push(B(0.10, 0.07, 0.014, x, 1.48, 0.275));                     // name card holder
        }
        g.push(B(0.022, 1.64, 0.05, 0, 0.92, 0.25));              // centre stile
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.15, colorOverride: 0x6d7a72, roughOverride: 0.55, metalOverride: 0.42 },
        half: new THREE.Vector3(0.45, 0.9, 0.25), mass: 74, hollow: 0.78,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.45, 0.9, 0.25), offset: new THREE.Vector3(0, 0.9, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.HOLLOW, body: 'dynamic', capacity: 48, label: 'lockers',
      };
    }

    case 'chair': {
      const key = 'chair';
      // Stacking chair: dished seat, curved back, splayed tube legs.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.46, 0.04, 0.44, 0.018, 0, 0.45, 0.01));       // seat pan
        g.push(B(0.40, 0.03, 0.05, 0, 0.462, -0.20));             // seat lip
        // back, tipped slightly and curved across in three facets
        for (let i = -1; i <= 1; i++) {
          g.push(GEO.transformed(RB(0.155, 0.42, 0.035, 0.012),
            new THREE.Matrix4().makeRotationY(i * 0.20).multiply(new THREE.Matrix4().makeRotationX(-0.12))
              .setPosition(i * 0.145, 0.73, -0.20 + Math.abs(i) * 0.022)));
        }
        for (const [x, z] of [[-0.19, -0.17], [0.19, -0.17], [-0.19, 0.19], [0.19, 0.19]] as const) {
          g.push(STRUT(x, 0.44, z, x * 1.25, 0.01, z * 1.25, 0.017, 6));
          g.push(RB(0.045, 0.012, 0.045, 0.004, x * 1.25, 0.008, z * 1.25));
        }
        g.push(STRUT(-0.24, 0.19, -0.21, 0.24, 0.19, -0.21, 0.014, 5));  // stretchers
        g.push(STRUT(-0.24, 0.19, 0.24, 0.24, 0.19, 0.24, 0.014, 5));
        g.push(STRUT(-0.19, 0.44, -0.17, -0.19, 0.70, -0.20, 0.016, 5)); // back posts
        g.push(STRUT(0.19, 0.44, -0.17, 0.19, 0.70, -0.20, 0.016, 5));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.35, colorOverride: 0x4a5560 },
        half: new THREE.Vector3(0.24, 0.48, 0.24), mass: 6.5, hollow: 0.5,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.24, 0.48, 0.24), offset: new THREE.Vector3(0, 0.48, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 96, label: 'chair',
      };
    }

    case 'table': {
      const key = 'table';
      // Dining table: thick top with an apron and tapered legs.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.22, 0.042, 0.82, 0.014, 0, 0.738, 0));        // top
        g.push(B(1.10, 0.09, 0.70, 0, 0.672, 0));                 // apron
        g.push(B(1.16, 0.05, 0.76, 0, 0.705, 0));                 // top rail
        for (const [x, z] of [[-0.52, -0.32], [0.52, -0.32], [-0.52, 0.32], [0.52, 0.32]] as const) {
          g.push(TP(0.042, 0.030, 0.63, 6, x, 0.315, z));
          g.push(B(0.075, 0.07, 0.075, x, 0.60, z));              // leg block
        }
        g.push(STRUT(-0.52, 0.18, -0.32, -0.52, 0.18, 0.32, 0.018, 5));  // stretchers
        g.push(STRUT(0.52, 0.18, -0.32, 0.52, 0.18, 0.32, 0.018, 5));
        g.push(STRUT(-0.52, 0.18, 0, 0.52, 0.18, 0, 0.018, 5));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.25, colorOverride: 0x8a6c47 },
        half: new THREE.Vector3(0.6, 0.39, 0.4), mass: 24, hollow: 0.6,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.6, 0.06, 0.4), offset: new THREE.Vector3(0, 0.72, 0) },
                { shape: 'box', half: new THREE.Vector3(0.55, 0.36, 0.35), offset: new THREE.Vector3(0, 0.36, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64, label: 'table',
      };
    }

    case 'tv': {
      const key = 'tv';
      // Flat panel: thin bezel, thicker electronics block, pedestal stand.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(1.15, 0.68, 0.035, 0.008, 0, 0.70, 0));         // panel
        g.push(RB(0.80, 0.42, 0.045, 0.01, 0, 0.72, -0.038));     // electronics bulge
        g.push(B(1.15, 0.022, 0.05, 0, 0.365, -0.01));            // bottom edge
        g.push(B(0.14, 0.04, 0.06, 0, 0.385, -0.02));             // badge
        g.push(CY(0.035, 0.22, 8, 0, 0.27, 0));                   // neck
        g.push(GEO.translated(rotG(GEO.taper(0.30, 0.26, 0.035, 6), 0, Math.PI / 6), 0, 0.165, 0));
        g.push(RB(0.52, 0.025, 0.30, 0.008, 0, 0.152, 0));        // base plate
        for (const [cx, cy] of [[-0.30, 0.58], [-0.30, 0.66]] as const) {
          g.push(B(0.05, 0.02, 0.03, cx, cy, -0.06));             // rear sockets
        }
        return GEO.translated(GEO.merge(g), 0, -0.14, 0);
      });
      const screen = GEO.composite(`${key}_s`, () => B(1.07, 0.60, 0.02, 0, 0.57, 0.022));
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.05, colorOverride: 0x15171a, roughOverride: 0.45 },
        half: new THREE.Vector3(0.58, 0.44, 0.15), mass: 14, hollow: 0.55,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.58, 0.36, 0.06), offset: new THREE.Vector3(0, 0.56, 0) },
                { shape: 'box', half: new THREE.Vector3(0.25, 0.14, 0.15), offset: new THREE.Vector3(0, 0.14, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.GLASS, body: 'dynamic', capacity: 48,
        extras: [{ geoKey: `${key}_s`, geometry: screen, material: emissiveMat(0x2a4a6a, 0.8), capacity: 48 }],
        label: 'television',
      };
    }

    case 'bathtub': {
      const key = 'bathtub';
      // Tub with a real hollow: four walls, a rolled rim, taps and a waste.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(B(1.60, 0.08, 0.76, 0, 0.04, 0));                  // floor
        g.push(B(1.60, 0.56, 0.06, 0, 0.32, -0.35));              // long walls
        g.push(B(1.60, 0.56, 0.06, 0, 0.32, 0.35));
        g.push(B(0.06, 0.56, 0.76, -0.77, 0.32, 0));              // end walls
        g.push(B(0.06, 0.56, 0.76, 0.77, 0.32, 0));
        g.push(B(1.66, 0.05, 0.82, 0, 0.605, 0));                 // rolled rim
        g.push(B(1.54, 0.03, 0.70, 0, 0.585, 0));                 // inner rim return
        g.push(CY(0.028, 0.16, 6, -0.66, 0.68, 0));               // spout
        g.push(CYZ(0.022, 0.10, 6, -0.66, 0.74, 0.04));
        for (const sz of [-0.13, 0.13]) {
          g.push(CY(0.022, 0.07, 6, -0.66, 0.65, sz));            // taps
          g.push(CY(0.045, 0.02, 6, -0.66, 0.70, sz));
        }
        g.push(CY(0.05, 0.015, 8, 0.60, 0.086, 0));               // waste
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.ceramic,
        matOpts: { instanced: true, vary: 0.04, colorOverride: 0xeceee9, roughOverride: 0.18 },
        half: new THREE.Vector3(0.8, 0.3, 0.38), mass: 110, hollow: 0.68,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.83, 0.32, 0.41), offset: new THREE.Vector3(0, 0.32, 0) }, { shape: 'box', half: new THREE.Vector3(0.05, 0.08, 0.1), offset: new THREE.Vector3(-0.66, 0.72, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.HOLLOW, body: 'dynamic', capacity: 24, label: 'bathtub',
      };
    }

    case 'ladder': {
      const key = 'ladder';
      // Fire-escape ladder: channel stiles, round rungs, wall standoffs, cage.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const sx of [-0.26, 0.26]) {
          g.push(B(0.045, 4.0, 0.08, sx, 0, 0));                  // stiles
          g.push(B(0.02, 4.0, 0.05, sx + (sx > 0 ? 0.03 : -0.03), 0, 0.03));
        }
        for (let i = 0; i < 11; i++) {
          g.push(CYX(0.018, 0.54, 5, 0, -1.86 + i * 0.37, 0));    // rungs
        }
        for (const y of [-1.5, 0, 1.5]) {                          // wall standoffs
          g.push(CYZ(0.022, 0.24, 6, -0.26, y, -0.15));
          g.push(CYZ(0.022, 0.24, 6, 0.26, y, -0.15));
          g.push(B(0.10, 0.10, 0.03, -0.26, y, -0.28));
          g.push(B(0.10, 0.10, 0.03, 0.26, y, -0.28));
        }
        // safety hoops over the upper half
        for (let i = 0; i < 2; i++) {
          const y = 0.70 + i * 0.85;
          g.push(GEO.translated(rotG(GEO.torus(0.38, 0.016, 3, 10), 0, 0), 0, y, 0.20));
        }
        g.push(B(0.03, 1.9, 0.03, 0, 1.2, 0.56));                 // hoop stringers
        g.push(B(0.03, 1.9, 0.03, -0.35, 1.2, 0.40));
        g.push(B(0.03, 1.9, 0.03, 0.35, 1.2, 0.40));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.12, colorOverride: 0x6e7176, roughOverride: 0.6, metalOverride: 0.7 },
        half: new THREE.Vector3(0.3, 2.0, 0.09), mass: 48, hollow: 0.9,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.3, 2.0, 0.12) }],
        flags: F.BREAKABLE | F.LADDER, body: 'fixed', capacity: 96, centred: true, label: 'ladder',
      };
    }



    case 'soilBlock': {
      const s2 = 0.52;
      const key = 'soilBlock';
      // A dug clod. GEO.chunk is tuned for fractured concrete and comes out
      // spiky; earth wants shallow, rounded lumps, so this displaces an
      // icosphere gently and merges a couple of smaller clods into the sides.
      const geo = GEO.composite(key, () => {
        const clod = (r: number, seed: number, squash: number) => {
          const g = new THREE.IcosahedronGeometry(r, 1);
          const pos = g.attributes.position as THREE.BufferAttribute;
          const v = new THREE.Vector3();
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const n = 1
              + 0.14 * Math.sin(v.x / r * 3.1 + seed) * Math.sin(v.z / r * 2.7 + seed * 1.7)
              + 0.10 * Math.sin(v.y / r * 4.3 + seed * 2.3)
              + 0.06 * Math.sin(v.x / r * 7.9 + v.z / r * 6.1 + seed * 3.1);
            v.multiplyScalar(n);
            v.y *= squash;
            pos.setXYZ(i, v.x, v.y, v.z);
          }
          g.deleteAttribute('uv');
          g.computeVertexNormals();
          return g;
        };
        const g: THREE.BufferGeometry[] = [clod(s2 * 0.72, 1.3, 0.86)];
        g.push(GEO.translated(clod(s2 * 0.40, 4.1, 0.9), s2 * 0.34, -s2 * 0.12, -s2 * 0.20));
        g.push(GEO.translated(clod(s2 * 0.33, 7.7, 0.8), -s2 * 0.30, s2 * 0.16, s2 * 0.26));
        const r = new Rng(41);
        for (let i = 0; i < 3; i++) {                                          // pebbles, mostly buried
          const st = GEO.sphere(r.range(0.035, 0.062), 5).clone();
          st.scale(1, r.range(0.55, 0.8), r.range(0.85, 1.15));
          const a = r.range(0, Math.PI * 2);
          st.translate(Math.cos(a) * 0.17, r.range(-0.1, 0.13), Math.sin(a) * 0.17);
          g.push(st);
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.soil,
        matOpts: { instanced: true, vary: 0.3, flatShading: true },
        half: new THREE.Vector3(s2 / 2, s2 / 2, s2 / 2), mass: 1500 * s2 * s2 * s2,
        parts: [{ shape: 'box', half: new THREE.Vector3(s2 / 2, s2 / 2, s2 / 2) }],
        // Earth does not shatter when it is knocked about — it has to be dug.
        flags: F.DIGGABLE, body: 'dynamic', capacity: 512, label: 'earth', centred: true,
      };
    }

    // ------------------------------------------------------------------
    // Materials a shelter can be built from, and the clutter of real streets.
    // ------------------------------------------------------------------

    case 'plywood': {
      const key = 'plywood';
      // A 2440 x 1220 sheet of 12 mm ply, the plies showing as a darker band
      // round every edge.
      const T = 0.012;
      const geo = GEO.composite(key, () => GEO.merge([RB(2.44, T, 1.22, 0.003, 0, T / 2, 0)]));
      const edge = GEO.composite(`${key}_e`, () => GEO.merge([
        B(2.442, T * 0.4, 1.222, 0, T * 0.5, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.plywood,
        matOpts: { instanced: true, vary: 0.18, colorOverride: 0xc8a679, roughOverride: 0.78 },
        half: new THREE.Vector3(1.22, T / 2, 0.61), mass: 19,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.22, T / 2, 0.61), offset: new THREE.Vector3(0, T / 2, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 160, label: 'plywood sheet',
        extras: [{ geoKey: `${key}_e`, geometry: edge, material: makeMaterial(MATERIALS.plywood, { instanced: true, vary: 0.1, colorOverride: 0x8a6c49, roughOverride: 0.85 }), capacity: 160 }],
      };
    }

    case 'corrugated': {
      const key = 'corrugated';
      // Corrugated roofing: a real sine profile, 76 mm pitch, in galvanised or
      // rusted steel.
      const rust = v % 3 === 0;
      const geo = GEO.composite(key, () => {
        const W = 0.9, L = 2.4, A = 0.009, P = 0.076, n = 96;
        const pos: number[] = [], idx: number[] = [];
        for (const side of [0, 1]) {
          const off = side ? -0.0009 : 0;
          const base = pos.length / 3;
          for (let i = 0; i <= n; i++) {
            const z = -W / 2 + (i / n) * W;
            const y = A + A * Math.sin((z / P) * Math.PI * 2) + off;
            pos.push(-L / 2, y, z, L / 2, y, z);
          }
          for (let i = 0; i < n; i++) {
            const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
            if (side) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        return g.toNonIndexed();
      });
      return {
        key: rust ? `${key}R` : key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.2, colorOverride: rust ? 0x8b5a3c : 0x9ea5a8, roughOverride: rust ? 0.85 : 0.42, metalOverride: rust ? 0.3 : 0.75 },
        half: new THREE.Vector3(1.2, 0.009, 0.45), mass: 14,
        parts: [{ shape: 'box', half: new THREE.Vector3(1.2, 0.009, 0.45), offset: new THREE.Vector3(0, 0.009, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 160, label: 'corrugated sheet',
      };
    }

    case 'cinderBlock': {
      const key = 'cinderBlock';
      // A hollow concrete block: two cores straight through, so it reads as a
      // block and not a brick of solid concrete.
      const geo = GEO.composite(key, () => {
        const L = 0.39, H = 0.19, D = 0.19, t = 0.03;
        const g: THREE.BufferGeometry[] = [];
        // Only the two long faces get rounded arrises: the webs between them are
        // seen end-on or not at all, and there are hundreds of these on a site.
        for (const sz of [-1, 1]) g.push(RB(L, H, t, 0.006, 0, H / 2, sz * (D / 2 - t / 2)));
        for (const x of [-L / 2 + t / 2, 0, L / 2 - t / 2]) g.push(B(x === 0 ? 0.026 : t, H, D - 2 * t + 0.004, x, H / 2, 0));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.concrete,
        matOpts: { instanced: true, vary: 0.14, colorOverride: 0x8f8b84, roughOverride: 0.95, chamfer: true, chamferSize: 0.004 },
        half: new THREE.Vector3(0.195, 0.095, 0.095), mass: 14,
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 640, label: 'cinder block',
      };
    }

    case 'scaffoldPole': {
      const L = [3.0, 4.0, 5.0][v % 3];
      const key = `spole${L}`;
      // A loose scaffold tube with a coupler still clamped to one end.
      const geo = GEO.composite(key, () => GEO.merge([
        CYX(0.024, L, 8, 0, 0.024, 0),
        CYX(0.0255, 0.03, 8, -L / 2 + 0.015, 0.024, 0),
        CYX(0.0255, 0.03, 8, L / 2 - 0.015, 0.024, 0),
        RB(0.07, 0.07, 0.08, 0.01, L / 2 - 0.3, 0.024, 0),
        CY(0.008, 0.06, 6, L / 2 - 0.3, 0.06, 0.03),
      ]));
      return {
        key, geo, mat: MATERIALS.steel,
        matOpts: { instanced: true, vary: 0.18, colorOverride: 0x9aa0a4, roughOverride: 0.5, metalOverride: 0.8 },
        half: new THREE.Vector3(L / 2, 0.024, 0.024), mass: 4.4 * L,
        parts: [{ shape: 'box', half: new THREE.Vector3(L / 2, 0.024, 0.024), offset: new THREE.Vector3(0, 0.024, 0) },
                { shape: 'box', half: new THREE.Vector3(0.035, 0.035, 0.05), offset: new THREE.Vector3(L / 2 - 0.3, 0.035, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 128, label: 'scaffold tube',
      };
    }

    case 'scaffoldBoard': {
      const key = 'scaffoldBoard';
      // A 3.9 m scaffold board, grey with weather, steel hoops over each end.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [RB(3.9, 0.038, 0.225, 0.008, 0, 0.019, 0)];
        for (const sx of [-1, 1]) g.push(B(0.03, 0.042, 0.229, sx * 1.9, 0.019, 0));
        return GEO.merge(g);
      });
      const hoops = GEO.composite(`${key}_h`, () => GEO.merge([
        B(0.034, 0.043, 0.23, -1.9, 0.019, 0), B(0.034, 0.043, 0.23, 1.9, 0.019, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.22, colorOverride: 0x9a8a70, roughOverride: 0.9 },
        half: new THREE.Vector3(1.95, 0.019, 0.113), mass: 16,
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'scaffold board',
        extras: [{ geoKey: `${key}_h`, geometry: hoops, material: paintMat(0x7c8186, 0.5, 0.7), capacity: 128 }],
      };
    }

    case 'timberPost': {
      const L = [2.4, 3.0][v % 2];
      const key = `post${L}`;
      // Sawn 90 x 90 timber, the kind a shelter frame is made of.
      const geo = GEO.composite(key, () => GEO.merge([
        RB(L, 0.09, 0.09, 0.008, 0, 0.045, 0),
        CY(0.006, 0.004, 6, L * 0.3, 0.091, 0.01),
        CY(0.006, 0.004, 6, -L * 0.35, 0.091, -0.02),
      ]));
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.25, colorOverride: 0xa98a5f, roughOverride: 0.85 },
        half: new THREE.Vector3(L / 2, 0.045, 0.045), mass: L * 4.4,
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'timber post',
      };
    }

    case 'tyre': {
      const key = 'tyre';
      // A car tyre off its rim: tread, sidewalls and the bead, lying flat.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        const t = GEO.torus(0.255, 0.09, 8, 22).clone();
        t.rotateX(Math.PI / 2);
        t.scale(1, 1.1, 1);
        t.translate(0, 0.1, 0);
        g.push(t);
        // tread blocks round the crown
        for (let i = 0; i < 22; i++) {
          const a = (i / 22) * Math.PI * 2;
          g.push(GEO.transformed(B(0.05, 0.16, 0.012),
            new THREE.Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * 0.343, 0.1, Math.sin(a) * 0.343)));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.rubber,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0x1d1e20, roughOverride: 0.88 },
        half: new THREE.Vector3(0.35, 0.1, 0.35), mass: 9,
        parts: [{ shape: 'cylinder', radius: 0.35, halfHeight: 0.1, offset: new THREE.Vector3(0, 0.1, 0) }],
        flags: F.CARRYABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'tyre',
      };
    }

    case 'cardboardBox': {
      const size = [[0.32, 0.24, 0.26], [0.46, 0.34, 0.36], [0.6, 0.44, 0.46]][v % 3];
      const [w, h, d] = size;
      const key = `cbox${v % 3}`;
      // A taped carton: flaps meeting down the middle of the lid, tape over
      // the seam and down both ends.
      const geo = GEO.composite(key, () => GEO.merge([
        RB(w, h, d, 0.006, 0, h / 2, 0),
        B(w - 0.02, 0.004, d * 0.49, 0, h + 0.001, d * 0.25),     // lid flaps, slightly lifted
        B(w - 0.02, 0.004, d * 0.49, 0, h + 0.001, -d * 0.25),
      ]));
      const tape = GEO.composite(`${key}_t`, () => GEO.merge([
        B(w + 0.004, 0.003, 0.05, 0, h + 0.004, 0),
        B(0.003, h * 0.3, 0.05, w / 2 + 0.002, h * 0.85, 0),
        B(0.003, h * 0.3, 0.05, -w / 2 - 0.002, h * 0.85, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.cardboard,
        matOpts: { instanced: true, vary: 0.16, colorOverride: 0xb28c5e, roughOverride: 0.95 },
        half: new THREE.Vector3(w / 2, h / 2, d / 2), mass: 1.2 + w * h * d * 60,
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 256, label: 'cardboard box',
        extras: [{ geoKey: `${key}_t`, geometry: tape, material: makeMaterial(MATERIALS.plastic, { instanced: true, vary: 0.05, colorOverride: 0xcfc4a8, roughOverride: 0.45 }), capacity: 256 }],
      };
    }

    case 'trashBag': {
      const dark = v % 3 === 0;
      const key = dark ? 'trashBagD' : 'trashBag';
      // A full rubbish bag: slumped, lumpy, the neck twisted into a knot with
      // two ears. Tokyo's are mostly the translucent white kind.
      const geo = GEO.composite('trashBag', () => {
        const g: THREE.BufferGeometry[] = [];
        const bag = GEO.beveledBox(0.46, 0.42, 0.4, 0.15, 3).clone();
        const pos = bag.attributes.position as THREE.BufferAttribute;
        const p = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i);
          const up = (p.y + 0.21) / 0.42;                   // 0 at the base, 1 at the top
          const lump = 1 + 0.07 * Math.sin(p.x * 17 + p.z * 11) * Math.sin(p.y * 13);
          const sag = 1 + 0.1 * (1 - up);                   // it spreads where it sits
          p.x *= sag * lump * (1 - 0.3 * up * up); p.z *= sag * lump * (1 - 0.3 * up * up);
          p.y = p.y * 0.92 - 0.02 * (1 - up);
          pos.setXYZ(i, p.x, p.y, p.z);
        }
        bag.computeVertexNormals();
        g.push(GEO.translated(bag, 0, 0.2, 0));
        g.push(GEO.translated(GEO.sphere(0.045, 8).clone(), 0, 0.42, 0));                  // knot
        for (const sx of [-1, 1]) {
          const ear = GEO.sphere(0.04, 6).clone();
          ear.scale(1.4, 0.6, 0.8);
          g.push(GEO.transformed(ear, new THREE.Matrix4().makeRotationZ(sx * 0.6).setPosition(sx * 0.06, 0.46, 0)));
        }
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.1, colorOverride: dark ? 0x23282b : 0xd9ddd8, roughOverride: 0.35, metalOverride: 0.02 },
        half: new THREE.Vector3(0.25, 0.23, 0.22), mass: 3.5,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.23, 0.2, 0.21), offset: new THREE.Vector3(0, 0.2, 0) },
                { shape: 'ball', radius: 0.06, offset: new THREE.Vector3(0, 0.43, 0) }],
        flags: F.CARRYABLE | F.FLAMMABLE, body: 'dynamic', capacity: 320, label: 'rubbish bag',
      };
    }

    case 'bucket': {
      const col = [0xd9661f, 0x2d6fb8, 0x46443f, 0xe0c23a][v % 4];
      const key = `bucket${col.toString(16)}`;
      // A builder's bucket: tapered wall with a real inside, a rolled rim and a
      // wire handle.
      const geo = GEO.composite('bucket', () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(GEO.taper(0.13, 0.155, 0.3, 16, false).clone().translate(0, 0.15, 0));
        const inner = GEO.taper(0.122, 0.147, 0.29, 16, false).clone();
        inner.scale(-1, 1, 1);                              // inside out, so it faces in
        g.push(inner.translate(0, 0.155, 0));
        g.push(GEO.cylinder(0.13, 0.012, 16).clone().translate(0, 0.006, 0));
        g.push(RINGY(0.155, 0.009, 0, 0.3, 0, 4, 16));
        g.push(GEO.tube([
          new THREE.Vector3(-0.155, 0.27, 0), new THREE.Vector3(-0.11, 0.4, 0),
          new THREE.Vector3(0, 0.44, 0), new THREE.Vector3(0.11, 0.4, 0), new THREE.Vector3(0.155, 0.27, 0),
        ], 0.004, 4));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.1, colorOverride: col, roughOverride: 0.55 },
        half: new THREE.Vector3(0.155, 0.15, 0.155), mass: 1.4,
        parts: [{ shape: 'cylinder', radius: 0.155, halfHeight: 0.15, offset: new THREE.Vector3(0, 0.15, 0) },
                { shape: 'box', half: new THREE.Vector3(0.155, 0.07, 0.01), offset: new THREE.Vector3(0, 0.37, 0) }],
        flags: F.CARRYABLE | F.FLAMMABLE, body: 'dynamic', capacity: 128, label: 'bucket',
      };
    }

    case 'jerryCan': {
      const key = 'jerryCan';
      // A 20 litre fuel can: pressed X in each flank, three-bar handle, a
      // capped spout. Full, and it burns like it.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [RB(0.34, 0.44, 0.16, 0.025, 0, 0.22, 0)];
        for (const sz of [-1, 1]) {
          for (const r of [0.62, -0.62]) {
            g.push(GEO.transformed(B(0.4, 0.035, 0.012), new THREE.Matrix4().makeRotationZ(r).setPosition(0, 0.2, sz * 0.082)));
          }
        }
        for (const x of [-0.1, 0, 0.1]) g.push(B(0.03, 0.08, 0.1, x, 0.47, 0));
        g.push(B(0.26, 0.03, 0.1, 0, 0.52, 0));
        g.push(GEO.transformed(GEO.cylinder(0.03, 0.07, 8), new THREE.Matrix4().makeRotationZ(0.5).setPosition(0.15, 0.47, 0)));
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.08, colorOverride: 0xb5302a, roughOverride: 0.5 },
        half: new THREE.Vector3(0.18, 0.27, 0.085), mass: 18,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.17, 0.22, 0.085), offset: new THREE.Vector3(0, 0.22, 0) },
                { shape: 'box', half: new THREE.Vector3(0.14, 0.05, 0.05), offset: new THREE.Vector3(0, 0.49, 0) }],
        flags: F.CARRYABLE | F.FLAMMABLE | F.BREAKABLE, body: 'dynamic', capacity: 64, label: 'jerry can',
      };
    }

    case 'toolbox': {
      const key = 'toolbox';
      // A steel cantilever toolbox: lid line, latches, a folding handle.
      const geo = GEO.composite(key, () => GEO.merge([
        RB(0.5, 0.2, 0.22, 0.012, 0, 0.1, 0),
        B(0.51, 0.008, 0.225, 0, 0.16, 0),
        RB(0.48, 0.04, 0.2, 0.01, 0, 0.22, 0),
        B(0.04, 0.05, 0.02, -0.18, 0.15, 0.115), B(0.04, 0.05, 0.02, 0.18, 0.15, 0.115),
        CYX(0.012, 0.22, 6, 0, 0.29, 0),
        CY(0.009, 0.06, 6, -0.11, 0.26, 0), CY(0.009, 0.06, 6, 0.11, 0.26, 0),
      ]));
      return {
        key, geo, mat: MATERIALS.paintedSteel,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0xb3312b, roughOverride: 0.45, metalOverride: 0.6 },
        half: new THREE.Vector3(0.25, 0.15, 0.115), mass: 7,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.25, 0.12, 0.115), offset: new THREE.Vector3(0, 0.12, 0) },
                { shape: 'box', half: new THREE.Vector3(0.12, 0.03, 0.02), offset: new THREE.Vector3(0, 0.27, 0) }],
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 64, label: 'toolbox',
      };
    }

    case 'plasticCrate': {
      const col = [0xe0b22a, 0xc4362e, 0x2f67a8, 0x2f7a4c][v % 4];
      const key = `pcrate${col.toString(16)}`;
      // A bottle crate: a grid of slots on every side, open top, stackable.
      const geo = GEO.composite('pcrate', () => {
        const W = 0.46, H = 0.3, D = 0.34, t = 0.012;
        const g: THREE.BufferGeometry[] = [];
        g.push(B(W, 0.02, D, 0, 0.01, 0));                               // floor
        for (const sy of [0.02, H - 0.015]) {
          g.push(B(W, 0.03, t, 0, sy + 0.015, D / 2 - t / 2), B(W, 0.03, t, 0, sy + 0.015, -D / 2 + t / 2));
          g.push(B(t, 0.03, D, W / 2 - t / 2, sy + 0.015, 0), B(t, 0.03, D, -W / 2 + t / 2, sy + 0.015, 0));
        }
        g.push(B(W, 0.02, t, 0, H * 0.55, D / 2 - t / 2), B(W, 0.02, t, 0, H * 0.55, -D / 2 + t / 2));
        g.push(B(t, 0.02, D, W / 2 - t / 2, H * 0.55, 0), B(t, 0.02, D, -W / 2 + t / 2, H * 0.55, 0));
        for (let i = 0; i <= 5; i++) {
          const x = -W / 2 + t / 2 + (i / 5) * (W - t);
          g.push(B(0.018, H, t, x, H / 2, D / 2 - t / 2), B(0.018, H, t, x, H / 2, -D / 2 + t / 2));
        }
        for (let i = 0; i <= 4; i++) {
          const z = -D / 2 + t / 2 + (i / 4) * (D - t);
          g.push(B(t, H, 0.018, W / 2 - t / 2, H / 2, z), B(t, H, 0.018, -W / 2 + t / 2, H / 2, z));
        }
        for (const sx of [-1, 1]) g.push(B(0.01, 0.04, 0.12, sx * (W / 2 + 0.004), H - 0.06, 0));   // hand holds
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.plastic,
        matOpts: { instanced: true, vary: 0.08, colorOverride: col, roughOverride: 0.5 },
        half: new THREE.Vector3(0.23, 0.15, 0.17), mass: 2.2,
        flags: F.CARRYABLE | F.BREAKABLE, body: 'dynamic', capacity: 256, label: 'bottle crate',
      };
    }

    case 'scaffoldLadder': {
      const key = 'scaffoldLadder';
      // An aluminium ladder lashed into a scaffold bay: two stiles and rungs,
      // standing proud of the deck it serves so it can be stepped off.
      const H = 4.2;
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        for (const sx of [-0.21, 0.21]) g.push(RB(0.06, H, 0.035, 0.006, sx, H / 2, 0));
        for (let y = 0.3; y < H - 0.1; y += 0.28) g.push(CYX(0.016, 0.42, 6, 0, y, 0));
        for (const sx of [-0.21, 0.21]) g.push(RB(0.07, 0.04, 0.05, 0.008, sx, 0.02, 0));   // feet
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.aluminium,
        matOpts: { instanced: true, vary: 0.1, colorOverride: 0xa9adb1, roughOverride: 0.4, metalOverride: 0.8 },
        half: new THREE.Vector3(0.25, H / 2, 0.03), mass: 14,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.25, H / 2, 0.03), offset: new THREE.Vector3(0, H / 2, 0) }],
        flags: F.BREAKABLE | F.LADDER, body: 'fixed', capacity: 160, label: 'ladder',
      };
    }

    case 'door': {
      const key = 'door';
      // Panelled door: stiles and rails with two recessed panels, lever handle.
      const geo = GEO.composite(key, () => {
        const g: THREE.BufferGeometry[] = [];
        g.push(RB(0.86, 2.02, 0.042, 0.008, 0, 0, 0));            // leaf
        g.push(B(0.11, 2.02, 0.055, -0.375, 0, 0));               // stiles
        g.push(B(0.11, 2.02, 0.055, 0.375, 0, 0));
        g.push(B(0.86, 0.12, 0.055, 0, 0.95, 0));                 // rails
        g.push(B(0.86, 0.12, 0.055, 0, 0.06, 0));
        g.push(B(0.86, 0.20, 0.055, 0, -0.91, 0));
        g.push(B(0.64, 0.02, 0.06, 0, 0.60, 0));                  // panel mouldings
        g.push(B(0.64, 0.02, 0.06, 0, -0.55, 0));
        g.push(CYZ(0.022, 0.09, 6, 0.30, 0.02, 0.045));           // rose
        g.push(B(0.10, 0.022, 0.025, 0.255, 0.02, 0.085));        // lever
        g.push(CYZ(0.016, 0.05, 6, 0.30, -0.06, 0.04));           // keyhole escutcheon
        for (const hy of [0.80, -0.02, -0.84]) g.push(B(0.03, 0.10, 0.05, -0.43, hy, 0)); // hinges
        return GEO.merge(g);
      });
      return {
        key, geo, mat: MATERIALS.wood,
        matOpts: { instanced: true, vary: 0.2, colorOverride: 0x6f5540 },
        half: new THREE.Vector3(0.43, 1.01, 0.03), mass: 22,
        parts: [{ shape: 'box', half: new THREE.Vector3(0.43, 1.01, 0.03), offset: new THREE.Vector3() }], centred: true,
        flags: F.CARRYABLE | F.BREAKABLE | F.FLAMMABLE, body: 'dynamic', capacity: 64, label: 'door',
      };
    }
  }
}

/** Place a prop in the world at a base position (y = ground level). */
type PlaceOverride = Partial<{ body: 'dynamic' | 'fixed'; flags: number; sleeping: boolean; attachTo: unknown; live: boolean }>;

export function placeProp(spawn: Spawner, kind: PropKind, rng: Rng,
                          x: number, y: number, z: number, rotY = 0, override?: PlaceOverride): Entity {
  return placeSpec(spawn, propSpec(kind, rng), kind, x, y, z, rotY, override);
}

/** The plan footprint a prop's spec would occupy with its body origin here. */
export function footOf(spec: PropSpec, x: number, y: number, z: number, rotY: number): Foot {
  const y0 = spec.centred ? y - spec.half.y : y;
  return { x, z, hx: spec.half.x, hz: spec.half.z, rot: rotY, y0, y1: y0 + spec.half.y * 2 };
}

/**
 * Set a prop down on a surface at height `y`, but only if it would not land
 * inside something already recorded in `fp`; record it if it goes down.
 * Returns null when the spot is taken.
 */
export function tryPlaceProp(spawn: Spawner, fp: Footprints, kind: PropKind, rng: Rng,
                             x: number, y: number, z: number, rotY = 0, override?: PlaceOverride,
                             pad = 0.06): Entity | null {
  const spec = propSpec(kind, rng);
  // Something authored about its centre has to be lifted to stand on the surface.
  const oy = spec.centred ? y + spec.half.y + 0.005 : y;
  const f = footOf(spec, x, oy, z, rotY);
  if (fp.hits(f, pad)) return null;
  fp.add(f);
  return placeSpec(spawn, spec, kind, x, oy, z, rotY, override);
}

export function placeSpec(spawn: Spawner, spec: PropSpec, kind: PropKind,
                   x: number, y: number, z: number, rotY: number, override?: PlaceOverride): Entity {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const mat = spec.mat;
  const parts: ColliderPart[] = spec.parts ?? [{
    shape: 'box', half: spec.half, offset: new THREE.Vector3(0, spec.half.y, 0),
  }];
  // Props are parked as colliders on a shared body; the activation system hands
  // them a real body when the player, weather or a disaster comes near.
  const host = (override?.attachTo as never) ?? (override?.live ? null : spawn.sceneryBody);
  const authored = override?.body ?? spec.body ?? 'dynamic';
  const e = spawn.prop({
    geoKey: spec.key, geometry: spec.geo,
    material: makeMaterial(mat, spec.matOpts ?? { instanced: true, vary: 0.15 }),
    pos: new THREE.Vector3(x, y, z), quat: q,
    half: spec.half, mat, body: host ? 'fixed' : authored,
    kind: Kind.Prop, parts, flags: (override?.flags ?? spec.flags ?? 0),
    hollow: spec.hollow, massOverride: spec.mass, capacity: spec.capacity ?? 32,
    label: spec.label ?? kind, sleeping: override?.sleeping ?? true,
    extras: spec.extras, attachTo: host,
  });
  if (host && authored === 'dynamic') e.set(F.DORMANT);
  return e;
}

export { paintMat, emissiveMat, NEON };

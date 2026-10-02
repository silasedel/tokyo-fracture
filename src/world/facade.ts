// Facade panels are drawn by a shader (see MatOptions.facade in render/materials),
// so all that survives here are the standard dimensions buildings snap to.

export type FacadeStyle = 'office' | 'apartment' | 'shophouse' | 'warehouse';

export const BAY_W = [3.5, 4.5, 5.5, 6.5, 8.0, 10.0];
export const FLOOR_H = [3.2, 3.6, 4.2, 5.0];

export const snapTo = (v: number, list: number[]) => {
  let best = list[0], bd = Infinity;
  for (const c of list) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c; } }
  return best;
};

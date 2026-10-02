export interface Quality {
  name: string;
  shadowMap: number;
  shadowRadius: number;
  ao: boolean;
  bloom: boolean;
  smaa: boolean;
  pixelRatio: number;
  groundTex: number;
  rainParticles: number;
  maxDebris: number;
  particleBudget: number;
  envRefresh: number;
  waterRes: number;
  drawDistance: number;
}

export const QUALITY: Record<string, Quality> = {
  low: {
    name: 'low', shadowMap: 1024, shadowRadius: 60, ao: false, bloom: true, smaa: false,
    pixelRatio: 1, groundTex: 1024, rainParticles: 9000, maxDebris: 360,
    particleBudget: 900, envRefresh: 3.0, waterRes: 96, drawDistance: 620,
  },
  medium: {
    name: 'medium', shadowMap: 2048, shadowRadius: 85, ao: false, bloom: true, smaa: true,
    pixelRatio: 1.25, groundTex: 2048, rainParticles: 17000, maxDebris: 620,
    particleBudget: 1600, envRefresh: 2.0, waterRes: 128, drawDistance: 900,
  },
  high: {
    name: 'high', shadowMap: 3072, shadowRadius: 100, ao: true, bloom: true, smaa: true,
    pixelRatio: 1.5, groundTex: 2048, rainParticles: 26000, maxDebris: 760,
    particleBudget: 2600, envRefresh: 1.4, waterRes: 160, drawDistance: 1200,
  },
  ultra: {
    name: 'ultra', shadowMap: 4096, shadowRadius: 120, ao: true, bloom: true, smaa: true,
    pixelRatio: 2, groundTex: 4096, rainParticles: 38000, maxDebris: 1200,
    particleBudget: 4000, envRefresh: 1.0, waterRes: 192, drawDistance: 1500,
  },
};

export interface Settings {
  quality: string;
  mouseSensitivity: number;
  fov: number;
  volume: number;
  motionBlurShake: number;
  invertY: boolean;
  autoQuality: boolean;
  /** 'first' shows the arms, 'third' pulls the camera back behind the body. */
  viewMode: 'first' | 'third';
  /** 0 disables the lens distortion / grain / aberration entirely. */
  lensFx: number;
  muted: boolean;
  /** Frame rate and simulation counts in the corner. */
  showPerf: boolean;
}

/**
 * `?mute` in the URL starts the run silent without touching saved settings —
 * handy when the game is running in a background tab you are not listening to.
 * M still toggles from there; only the starting state comes from the URL.
 */
export const forceMute = (() => {
  try { return new URLSearchParams(location.search).has('mute'); } catch { return false; }
})();

// v2: wider default FOV and the new view/lens options.
const KEY = 'tokyo-fracture-settings-v2';

export function loadSettings(): Settings {
  const def: Settings = {
    quality: 'high', mouseSensitivity: 1, fov: 100, volume: 0.8,
    motionBlurShake: 0.8, invertY: false, autoQuality: true,
    viewMode: 'first', lensFx: 0.35, muted: false, showPerf: false,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...def, ...JSON.parse(raw) };
  } catch { /* storage may be unavailable */ }
  return def;
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function bestTime(): number {
  try { return Number(localStorage.getItem('tokyo-fracture-best') ?? 0) || 0; } catch { return 0; }
}
export function setBestTime(t: number) {
  try { if (t > bestTime()) localStorage.setItem('tokyo-fracture-best', String(t)); } catch { /* ignore */ }
}

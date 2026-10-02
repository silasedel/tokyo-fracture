import { clamp, clamp01, lerp } from '../util/math';

/**
 * Everything you hear is synthesised at runtime: filtered noise for rain, wind
 * and fire; shaped bursts for impacts, glass and thunder. No assets, and the
 * timbre can follow the simulation continuously.
 */
export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private beds: Record<string, { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode; filt2?: BiquadFilterNode }> = {};
  private started = false;
  volume = 0.8;
  muted = false;

  async start() {
    if (this.started) return;
    this.started = true;
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    // Gentle limiter so overlapping disasters never clip.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 7;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    const len = 4 * this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      // light pinking keeps the beds from sounding hissy
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }

    this.bed('rain', 1400, 'bandpass', 0.7);
    this.bed('wind', 420, 'bandpass', 1.4);
    this.bed('rumble', 55, 'lowpass', 1.2);
    this.bed('fire', 900, 'bandpass', 0.5);
    this.bed('water', 300, 'lowpass', 0.8);
  }

  private bed(name: string, freq: number, type: BiquadFilterType, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    const filt2 = ctx.createBiquadFilter();
    filt2.type = 'lowpass'; filt2.frequency.value = 9000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filt); filt.connect(filt2); filt2.connect(gain); gain.connect(this.master);
    src.start();
    this.beds[name] = { src, gain, filt, filt2 };
  }

  set(name: string, gain: number, freq?: number, q?: number) {
    const b = this.beds[name];
    if (!b || !this.ctx) return;
    const t = this.ctx.currentTime;
    b.gain.gain.setTargetAtTime(Math.max(0, gain) * (this.muted ? 0 : 1), t, 0.25);
    if (freq !== undefined) b.filt.frequency.setTargetAtTime(freq, t, 0.3);
    if (q !== undefined) b.filt.Q.setTargetAtTime(q, t, 0.3);
  }

  setVolume(v: number) {
    this.volume = clamp01(v);
    this.applyMaster();
  }

  /** Silence everything without tearing the graph down, so unmuting is instant. */
  setMuted(m: boolean) {
    this.muted = m;
    this.applyMaster();
  }

  private applyMaster() {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  private env(gain: GainNode, peak: number, attack: number, decay: number, t0?: number) {
    const ctx = this.ctx!;
    const t = t0 ?? ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /**
   * One-shots currently sounding. Past a few dozen, new ones are dropped: they
   * would be buried anyway, and every one is a live node graph.
   */
  private voices = 0;

  /** A shaped burst of noise — the basis of most impacts. */
  private noiseHit(peak: number, freq: number, q: number, type: BiquadFilterType,
                   attack: number, decay: number, delay = 0, sweep = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.voices > 40) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const filt = ctx.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    if (sweep !== 0) {
      filt.frequency.setValueAtTime(freq, t);
      filt.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), t + attack + decay);
    }
    const gain = ctx.createGain();
    src.connect(filt); filt.connect(gain); gain.connect(this.master);
    this.env(gain, peak, attack, decay, t);
    this.voices++;
    src.onended = () => { this.voices--; };
    src.start(t);
    src.stop(t + attack + decay + 0.06);
  }

  private tone(peak: number, f0: number, f1: number, dur: number, type: OscillatorType = 'sine', delay = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.voices > 40) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(this.master);
    this.env(gain, peak, Math.min(0.012, dur * 0.2), dur, t);
    this.voices++;
    osc.onended = () => { this.voices--; };
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // --- one-shots ----------------------------------------------------------
  //
  // Everything here is noise shaped by filters. Pure oscillators are kept for
  // the lowest thumps, where they read as weight rather than as a pitch; a sine
  // or triangle up in the midrange sounds like a synthesiser, not a collision.

  /**
   * Loudness from energy in joules, and how it carries: level falls away with
   * distance, and the air takes the top end off anything far away.
   */
  private level(energy: number, dist: number, ref = 14) {
    const e = clamp(Math.log10(Math.max(1, energy)) / 5.2, 0, 1);
    return { gain: e * (ref / (ref + Math.max(0, dist))), air: clamp(1 - dist / 170, 0.3, 1) };
  }

  /**
   * A collapse throws dozens of contacts in the same instant. Past a handful
   * they add nothing but mush, so each kind of sound gets a small budget per
   * quarter second.
   */
  private budget(kind: string, max: number, gain = 1) {
    const now = this.ctx!.currentTime;
    let b = this.budgets.get(kind);
    if (!b || now - b.t > 0.25) { b = { t: now, n: 0 }; this.budgets.set(kind, b); }
    // Once the moment is busy, only what stands out gets in: a crash beside you
    // must not lose its slot to rubble settling a block away.
    if (b.n >= max * 2) return false;
    if (b.n >= max && gain < 0.25) return false;
    if (b.n >= max / 2 && gain < 0.07) return false;
    b.n++;
    return true;
  }
  private budgets = new Map<string, { t: number; n: number }>();

  /** `size` is the object's rough radius in metres: big things ring lower. */
  impact(energy: number, material: string, dist: number, size = 0.5) {
    if (!this.ctx || this.muted) return;
    const { gain, air } = this.level(energy, dist);
    if (gain < 0.02 || !this.budget('impact', 6, gain)) return;
    const pitch = clamp(Math.sqrt(0.5 / clamp(size, 0.08, 4)), 0.45, 1.9);
    const heavy = clamp(size / 0.6, 0.6, 2.2);
    switch (material) {
      case 'glass': case 'ceramic':
        this.noiseHit(gain * 0.42, 5600 * air, 1.0, 'highpass', 0.002, 0.2);
        this.noiseHit(gain * 0.2, 7400 * air, 8, 'bandpass', 0.001, 0.08, 0.025);
        break;
      case 'steel': case 'paintedSteel': case 'aluminium': case 'chrome': {
        // A struck panel: a dull knock under two narrow, inharmonic bands.
        const f = 480 * pitch;
        this.noiseHit(gain * 0.42, 950 * air, 0.9, 'lowpass', 0.002, 0.1);
        this.noiseHit(gain * 0.26, f * air, 13, 'bandpass', 0.002, 0.3 / pitch);
        this.noiseHit(gain * 0.14, f * 2.76 * air, 17, 'bandpass', 0.002, 0.18 / pitch);
        break;
      }
      case 'wood': case 'plywood':
        this.noiseHit(gain * 0.55, 720 * pitch * air, 2.0, 'bandpass', 0.002, 0.11, 0, 0.6);
        this.noiseHit(gain * 0.3, 230 * air, 0.8, 'lowpass', 0.003, 0.09 * heavy);
        break;
      case 'concrete': case 'rebarConcrete': case 'brick': case 'stone': case 'asphalt': case 'volcanicRock':
        this.noiseHit(gain * 0.62, 250 * air, 0.8, 'lowpass', 0.004, 0.26 * heavy, 0, 0.3);
        this.noiseHit(gain * 0.22, 1600 * air, 0.9, 'bandpass', 0.002, 0.05);
        if (energy > 4000) this.tone(gain * 0.22, 60, 33, 0.3, 'sine');
        break;
      case 'water':
        this.noiseHit(gain * 0.5, 900 * air, 0.7, 'bandpass', 0.006, 0.34, 0, 2.2);
        break;
      default:
        // plastic, rubber, foam, fabric, cardboard: soft and short
        this.noiseHit(gain * 0.42, 460 * pitch * air, 0.9, 'lowpass', 0.003, 0.09 * heavy);
    }
  }

  glassBreak(dist: number) {
    if (!this.ctx || this.muted) return;
    const { gain, air } = this.level(9000, dist, 16);
    if (gain < 0.025 || !this.budget('glass', 2, gain)) return;
    this.noiseHit(gain * 0.5, 6000 * air, 0.8, 'highpass', 0.002, 0.45);
    for (let i = 0; i < 5; i++) {
      this.noiseHit(gain * 0.13, (3600 + Math.random() * 4800) * air, 6, 'bandpass', 0.001, 0.1, 0.03 + Math.random() * 0.35);
    }
  }

  thunder(dist: number, energy: number) {
    const delay = clamp(dist / 340, 0, 7);
    const near = clamp01(1 - dist / 700);
    const v = clamp(0.25 + energy * 1.1e-6, 0.25, 0.95) * lerp(0.35, 1, near);
    // crack then roll
    if (near > 0.55) this.noiseHit(v * 0.85, 2600, 0.7, 'lowpass', 0.004, 0.5, delay, 0.15);
    this.noiseHit(v * 0.9, lerp(120, 420, near), 0.6, 'lowpass', 0.08, lerp(4.5, 2.0, near), delay + 0.05, 0.2);
    this.noiseHit(v * 0.5, 70, 0.8, 'lowpass', 0.3, 5.0, delay + 0.25, 0.4);
    this.tone(v * 0.25, 48, 26, 2.4, 'sine', delay + 0.1);
  }

  explosion(energy: number, dist: number) {
    if (!this.ctx || this.muted) return;
    const { gain, air } = this.level(Math.max(100, energy) * 40, dist, 45);
    if (gain < 0.02 || !this.budget('explosion', 2)) return;
    this.noiseHit(gain * 0.95, 1400 * air, 0.6, 'lowpass', 0.003, 0.9, 0, 0.1);
    this.noiseHit(gain * 0.7, 90, 0.9, 'lowpass', 0.05, 2.6, 0.02, 0.35);
    this.tone(gain * 0.45, 62, 24, 1.6, 'sine');
  }

  collapse(volume: number, dist: number) {
    if (!this.ctx || this.muted) return;
    const { gain, air } = this.level(20000 * clamp(volume, 0.2, 8), dist, 30);
    if (gain < 0.025 || !this.budget('collapse', 1, gain)) return;
    this.noiseHit(gain * 0.55, 300 * air, 0.7, 'lowpass', 0.02, 1.4, 0, 0.25);
    this.tone(gain * 0.28, 58, 30, 1.1, 'sine');
  }

  footstep(speed: number, material: string, water: boolean) {
    const v = clamp(0.035 + speed * 0.012, 0.03, 0.11);
    if (water) { this.noiseHit(v * 1.5, 1300, 0.8, 'bandpass', 0.004, 0.2, 0, 1.8); return; }
    const hard = material === 'concrete' || material === 'asphalt' || material === 'stone' || material === 'rebarConcrete';
    this.noiseHit(v, hard ? 1500 : 700, hard ? 1.6 : 0.8, 'bandpass', 0.002, hard ? 0.07 : 0.11, 0, 0.5);
  }

  splash(energy: number, dist: number) {
    if (!this.ctx || this.muted) return;
    const { gain } = this.level(energy, dist, 14);
    if (gain < 0.02 || !this.budget('splash', 3)) return;
    this.noiseHit(Math.min(0.55, gain), 1100, 0.6, 'bandpass', 0.006, 0.5, 0, 2.6);
  }

  /** A structure straining: a narrow band of noise sagging in pitch. */
  creak(dist: number) {
    if (!this.ctx || this.muted || dist > 45) return;
    const { gain } = this.level(6000, dist, 10);
    if (!this.budget('creak', 1)) return;
    this.noiseHit(gain * 0.2, 380 + Math.random() * 180, 9, 'bandpass', 0.2, 0.9, 0, 0.5);
  }

  tear(dist: number) {
    if (!this.ctx || this.muted) return;
    const { gain, air } = this.level(6000, dist, 12);
    if (gain < 0.025 || !this.budget('tear', 2)) return;
    this.noiseHit(gain * 0.3, 2400 * air, 1.4, 'bandpass', 0.004, 0.35, 0, 0.3);
  }

  /** Air moving past a swung or thrown object. */
  whoosh(power: number) {
    const k = clamp(power, 0.05, 1);
    this.noiseHit(0.13 * k, 380 + k * 900, 0.9, 'bandpass', 0.03, 0.22 + k * 0.12, 0, 0.5);
  }

  hurt(amount: number) {
    const v = clamp(amount / 40, 0.05, 0.5);
    this.noiseHit(v * 0.5, 320, 1.2, 'lowpass', 0.006, 0.22);
    this.tone(v * 0.3, 140, 60, 0.3, 'sine');
  }

  /**
   * The warning chime: two soft falling notes, the way a public-address system
   * clears its throat. A buzzer repeating over every alert was worse than the
   * disaster, so it sounds at most once in half a minute.
   */
  alarm() {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.currentTime - this.lastChime < 30) return;
    this.lastChime = ctx.currentTime;
    this.bell(0.05, 1046.5, 1.5, 0);
    this.bell(0.05, 784.0, 2.0, 0.6);
  }
  private lastChime = -1e9;

  /** A struck bell: the fundamental with a quieter octave, fading slowly. */
  private bell(peak: number, f: number, dur: number, delay: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    for (const [mul, amp] of [[1, 1], [2, 0.28], [3.01, 0.08]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak * amp, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur / mul);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + dur / mul + 0.05);
    }
  }

  siren() {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 1.4);
    g.gain.setValueAtTime(0.06, t + 8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 12);
    osc.frequency.setValueAtTime(420, t);
    for (let i = 0; i < 6; i++) {
      osc.frequency.linearRampToValueAtTime(660, t + i * 2 + 1);
      osc.frequency.linearRampToValueAtTime(420, t + i * 2 + 2);
    }
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 12.4);
  }

  suspend() { this.ctx?.suspend().catch(() => {}); }
  resume() { this.ctx?.resume().catch(() => {}); }
  dispose() { this.ctx?.close().catch(() => {}); this.started = false; }
}

import type { Vitals } from '../player/player';
import type { Alert } from '../disasters/director';
import { clamp01 } from '../util/math';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

export function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Warning levels as the Japan Meteorological Agency colours them: an advisory
 * (注意報) is yellow, a warning (警報) red, an emergency warning (特別警報)
 * purple. Everything the city does to you is graded on that scale.
 */
type Level = '' | 'adv' | 'warn' | 'emer';

/** The run's stage names, with the word a Japanese forecast would use. */
const STAGES: Record<string, [string, Level]> = {
  'calm': ['静穏', ''],
  'light rain': ['小雨', ''],
  'heavy rain': ['大雨', 'adv'],
  'thunderstorm': ['雷雨', 'adv'],
  'tremors': ['揺れ', 'adv'],
  'storm front': ['暴風雨', 'warn'],
  'escalating': ['悪化', 'warn'],
  'severe': ['危険', 'warn'],
  'disaster': ['災害', 'emer'],
  'catastrophe': ['壊滅', 'emer'],
  'collapse': ['崩壊', 'emer'],
};

/** Ongoing hazards: the short name and its grade. */
const HAZARDS: [RegExp, string, Level][] = [
  [/tsunami/, '大津波', 'emer'],
  [/eruption|volcan|mountain/, '噴火', 'emer'],
  [/tornado/, '竜巻', 'emer'],
  [/landslide/, '土砂災害', 'emer'],
  [/aftershock/, '余震', 'adv'],
  [/earthquake|shaking/, '地震', 'warn'],
  [/typhoon/, '暴風', 'warn'],
  [/flood|water rising/, '洪水', 'warn'],
  [/torrential|rain/, '大雨', 'warn'],
  [/gas/, 'ガス漏れ', 'warn'],
  [/fire/, '火災', 'warn'],
  [/structur|collapse/, '倒壊', 'warn'],
  [/electrical|lightning|thunder/, '雷', 'adv'],
  [/hail/, '降ひょう', 'adv'],
  [/grid|power|blackout/, '停電', 'adv'],
];

/** Announcements: what the bulletin itself would be called. */
const BULLETINS: [RegExp, string, Level | 'eew'][] = [
  [/^earthquake/, '緊急地震速報', 'eew'],
  [/aftershock/, '余震', 'adv'],
  [/tsunami/, '大津波警報', 'emer'],
  [/mountain|eruption|volcan/, '噴火警報', 'emer'],
  [/tornado/, '竜巻注意情報', 'emer'],
  [/landslide/, '土砂災害警戒情報', 'emer'],
  [/typhoon/, '暴風警報', 'warn'],
  [/flood/, '洪水警報', 'warn'],
  [/torrential|rain/, '大雨警報', 'warn'],
  [/gas/, 'ガス漏れ', 'warn'],
  [/fire/, '火災', 'warn'],
  [/structure|collapse/, '倒壊の危険', 'warn'],
  [/electrical|lightning/, '雷注意報', 'adv'],
  [/hail/, '降ひょう', 'adv'],
  [/grid|power/, '停電', 'adv'],
];

function lookup<T extends string>(table: [RegExp, string, T][], text: string): [string, T] | null {
  const t = text.toLowerCase();
  for (const [re, jp, lv] of table) if (re.test(t)) return [jp, lv];
  return null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Degrees of heading per pixel of compass strip. */
const COMPASS_PX = 2.2;
const CARDINAL: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export class Hud {
  private root = $('#hud');
  private tval = $('#tval');
  private phase = $('#phase');
  private phaseEn = $('#phase .en');
  private phaseJp = $('#phase .jp');
  private alerts = $('#alerts');
  private hazards = $('#hazards');
  private hpRow = $('#hp');
  private hp = $('#hp .bar i');
  private hpV = $('#hp .v');
  private stam = $('#stam .bar i');
  private stamV = $('#stam .v');
  private breathRow = $('#breath');
  private breath = $('#breath .bar i');
  private breathV = $('#breath .v');
  private carry = $('#carry');
  private dmg = $('#dmg');
  private crosshair = $('#crosshair');
  private prompt = $('#prompt');
  private toast = $('#toast');
  private compass = $('#compass');
  private strip = $('#compass .strip');
  private fps = $('#fps');
  private shown = new Map<Alert, HTMLElement>();
  private toastT = 0;
  private lastHp = 100;
  private dmgFlash = 0;
  private lastPhase = '';
  private lastItem = '';
  private lastPrompt = '';
  private lastHazards = '';
  private compassW = 0;

  constructor() {
    // One strip, a turn and a half long, slid under a fixed caret.
    const parts: string[] = [];
    for (let a = -180; a <= 540; a += 5) {
      const d = ((a % 360) + 360) % 360;
      const x = ((a + 180) * COMPASS_PX).toFixed(1);
      const major = d % 15 === 0;
      parts.push(`<i class="t${major ? ' m' : ''}" style="left:${x}px"></i>`);
      if (CARDINAL[d] !== undefined) parts.push(`<b class="l c" style="left:${x}px">${CARDINAL[d]}</b>`);
      else if (d % 15 === 0 && d % 45 !== 0) parts.push(`<b class="l" style="left:${x}px;opacity:.55">${d}</b>`);
    }
    this.strip.innerHTML = parts.join('');
  }

  show() { this.root.style.opacity = '1'; }
  hide() { this.root.style.opacity = '0'; }

  setTime(sec: number) {
    const t = formatTime(sec);
    if (this.tval.textContent !== t) this.tval.textContent = t;
  }

  setPhase(p: string, _intensity: number) {
    if (p === this.lastPhase) return;
    this.lastPhase = p;
    const [jp, lv] = STAGES[p] ?? ['', ''];
    this.phaseEn.textContent = p;
    this.phaseJp.textContent = jp;
    this.phase.className = lv;
  }

  setVitals(v: Vitals) {
    const hp = clamp01(v.health / 100), st = clamp01(v.stamina / 100), br = clamp01(v.breath / 100);
    this.hp.style.transform = `scaleX(${hp})`;
    this.stam.style.transform = `scaleX(${st})`;
    this.breath.style.transform = `scaleX(${br})`;
    this.hpV.textContent = String(Math.ceil(v.health));
    this.stamV.textContent = String(Math.round(v.stamina));
    this.breathV.textContent = String(Math.round(v.breath));
    this.hpRow.classList.toggle('low', v.health < 30);
    this.breathRow.style.opacity = v.breath < 99.5 ? '1' : '0';
    if (v.health < this.lastHp - 0.4) this.dmgFlash = Math.min(1, this.dmgFlash + (this.lastHp - v.health) / 26);
    this.lastHp = v.health;
    const low = 1 - clamp01(v.health / 42);
    this.dmg.style.opacity = String(Math.max(this.dmgFlash, low * 0.55 + (v.heat > 0.4 ? (v.heat - 0.4) * 0.8 : 0)));
  }

  /**
   * What is in your hands, or what you are looking at: a state line, its name,
   * and a line of plain data. Empty strings clear it.
   */
  setItem(state: string, name: string, meta: string, holding = false) {
    const key = `${state}|${name}|${meta}|${holding}`;
    if (key === this.lastItem) return;
    this.lastItem = key;
    this.carry.innerHTML = name
      ? `<div class="st${holding ? ' on' : ''}">${esc(state)}</div><div class="nm">${esc(name)}</div><div class="mt">${esc(meta)}</div>`
      : '';
  }

  /** Key hints under the reticle, as pairs of key and action. */
  setPrompt(parts: [string, string][] | null) {
    const html = parts ? parts.map(([k, a]) => `<span><kbd>${k}</kbd>${a}</span>`).join('') : '';
    if (html === this.lastPrompt) return;
    this.lastPrompt = html;
    this.prompt.classList.toggle('hide', !html);
    this.prompt.innerHTML = html;
  }

  setCrosshair(active: boolean) {
    this.crosshair.classList.toggle('active', active);
  }

  /** Ring around the reticle showing how far a throw has been wound up. */
  setCharge(v: number) {
    const c = clamp01(v);
    this.crosshair.classList.toggle('charging', c > 0.02);
    if (c > 0.02) this.crosshair.style.setProperty('--c', `${c.toFixed(3)}turn`);
  }

  setHazards(list: string[]) {
    // "Shaking" is the quake you are standing in; say it once, under its name.
    if (list.some((h) => /earthquake|aftershock/i.test(h))) list = list.filter((h) => h !== 'Shaking');
    const key = list.join('|');
    if (key === this.lastHazards) return;
    this.lastHazards = key;
    this.hazards.innerHTML = list.map((h) => {
      const [jp, lv] = lookup(HAZARDS, h) ?? ['', 'warn' as Level];
      const tag = lv === 'adv' ? '注意報' : lv === 'emer' ? '特別警報' : '警報';
      return `<div class="hz ${lv}"><b>${tag}</b><span class="en">${esc(h)}</span>${jp ? `<span class="jp">${jp}</span>` : ''}</div>`;
    }).join('');
  }

  syncAlerts(alerts: Alert[]) {
    for (const [a, el] of this.shown) {
      if (!alerts.includes(a)) { el.remove(); this.shown.delete(a); }
    }
    for (const a of alerts) {
      if (this.shown.has(a)) continue;
      const el = document.createElement('div');
      const found = lookup(BULLETINS, a.title);
      let lv: Level | 'eew' = found ? found[1] : (a.crit ? 'warn' : 'adv');
      if (lv === 'adv' && a.crit) lv = 'warn';
      if (lv === 'warn' && a.crit && /flood|typhoon/i.test(a.title)) lv = 'emer';
      const jp = found?.[0] ?? '';
      let en = a.title, sub = a.sub ?? '';
      if (lv === 'eew') {
        const m = /M\s?(\d+(?:\.\d)?)/.exec(a.title);
        en = 'Earthquake early warning';
        sub = `${m ? `Magnitude ${m[1]} · ` : ''}${sub}`;
      }
      el.className = `alert ${lv}`;
      el.innerHTML = `<i></i><div class="b"><div class="h">${jp ? `<span class="jp">${jp}</span>` : ''}`
        + `<span class="en">${esc(en.toLowerCase())}</span>${lv === 'eew' ? '<span class="dot"></span>' : ''}</div>`
        + `${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
      this.alerts.appendChild(el);
      this.shown.set(a, el);
    }
  }

  say(text: string, seconds = 3) {
    this.toast.textContent = text;
    this.toast.style.opacity = '1';
    this.toastT = seconds;
  }

  setCompass(yaw: number) {
    // yaw 0 faces -Z (north)
    const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    if (!this.compassW) this.compassW = this.compass.clientWidth || 360;
    const x = this.compassW / 2 - (deg + 180) * COMPASS_PX;
    this.strip.style.transform = `translateX(${x.toFixed(1)}px)`;
  }

  setPerfVisible(on: boolean) { this.fps.classList.toggle('hide', !on); }
  setFps(text: string) { if (!this.fps.classList.contains('hide')) this.fps.textContent = text; }

  update(dt: number) {
    this.dmgFlash = Math.max(0, this.dmgFlash - dt * 1.6);
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toast.style.opacity = '0';
    }
  }

  /** The window changed size: the compass has to re-measure itself. */
  resize() { this.compassW = 0; }

  reset() {
    this.alerts.innerHTML = '';
    this.shown.clear();
    this.hazards.innerHTML = '';
    this.lastHazards = '';
    this.lastPhase = '';
    this.lastHp = 100;
    this.dmgFlash = 0;
    this.dmg.style.opacity = '0';
    this.setItem('', '', '');
    this.setPrompt(null);
  }
}

export class DeathScreen {
  private el = $('#death');
  private cause = $('#cause');
  private dtime = $('#dtime');
  private dbest = $('#dbest');
  private stats = $('#stats');
  onAgain: (() => void) | null = null;

  constructor() {
    $('#again').addEventListener('click', () => this.onAgain?.());
  }

  show(time: number, cause: string, best: number, stats: [string, string][]) {
    this.dtime.textContent = formatTime(time);
    this.cause.textContent = cause;
    const isBest = time >= best && time > 0;
    this.dbest.textContent = isBest ? 'New best' : `Best ${formatTime(best)}`;
    this.dbest.classList.toggle('new', isBest);
    this.stats.innerHTML = stats.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    this.el.classList.remove('hide');
  }
  hide() { this.el.classList.add('hide'); }
  get visible() { return !this.el.classList.contains('hide'); }
}

export const CAUSE_TEXT: Record<string, string> = {
  crushed: 'Crushed beneath the city',
  impact: 'Killed by flying debris',
  fall: 'Fell too far',
  drowned: 'Drowned',
  burned: 'Burned',
  electrocuted: 'Electrocuted in standing water',
  buried: 'Buried',
  exposure: 'Exposure',
  debris: 'Struck by debris',
};

import { Game } from './core/game';
import { loadSettings, saveSettings, QUALITY, forceMute } from './core/settings';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

let game: Game | null = null;
let viewSelect: HTMLSelectElement | null = null;
let muteBox: HTMLInputElement | null = null;
let canvas: HTMLCanvasElement;
const settings = loadSettings();

function setProgress(p: number, label: string) {
  const pct = Math.round(p * 100);
  ($('#bar').firstElementChild as HTMLElement).style.width = `${pct}%`;
  $('#lpct').textContent = `${pct}%`;
  $('#ltext').textContent = label.charAt(0).toUpperCase() + label.slice(1);
}

const menuOpen = () => !$('#menu').classList.contains('hide');
const pauseOpen = () => !$('#pause').classList.contains('hide');

async function createGame(seed?: number, showLoader = true) {
  if (game) { game.dispose(); game = null; }
  if (showLoader) {
    $('#loader').classList.remove('hide');
    setProgress(0, 'rebuilding');
    await new Promise((r) => setTimeout(r, 30));
  }
  canvas.style.opacity = '0';
  // `?seed=N` rebuilds the same city every time: for bug reports and testing.
  const pinned = Number(new URLSearchParams(location.search).get('seed'));
  const g = new Game(canvas, settings, seed ?? (pinned > 0 ? pinned : (Math.random() * 1e6) | 0));
  game = g;
  (window as unknown as { game: Game }).game = g;
  g.onRequestRestart = () => { void restart(); };
  // The in-game camera key and the settings dropdown are the same setting.
  g.onViewModeChange = (m) => {
    if (viewSelect) viewSelect.value = m;
    saveSettings(settings);
  };
  // Same for M and the mute checkbox.
  g.onMuteChange = (m) => {
    settings.muted = m;
    if (muteBox) muteBox.checked = m;
    saveSettings(settings);
  };
  g.audio.setMuted(settings.muted || forceMute);
  // Losing the pointer lock mid-run pauses rather than leaving the player adrift.
  g.input.onLockChange = (locked) => {
    if (!locked && g.alive && !menuOpen() && !g.death.visible) openPause(false);
  };
  await g.init({ onProgress: setProgress });
  g.hud.setPerfVisible(settings.showPerf);
  $('#loader').classList.add('hide');
  canvas.style.transition = 'opacity .5s ease';
  canvas.style.opacity = '1';
  requestAnimationFrame(g.tick);
  return g;
}

async function restart() {
  const g = game;
  if (!g) return;
  g.hud.hide();
  g.death.hide();
  const fresh = await createGame();
  fresh.viewModel.setHidden(false);
  fresh.startRun();
  fresh.input.requestLock();
}

function beginPlay() {
  const g = game;
  if (!g || !menuOpen()) return;
  closePause();
  $('#menu').classList.add('hide');
  g.viewModel.setHidden(false);
  g.startRun();
  g.input.requestLock();
}

/**
 * One panel serves as the pause screen during a run and as the settings page
 * from the menu; only its heading and its way out differ.
 */
function openPause(fromMenu: boolean) {
  const g = game;
  if (!g) return;
  $('#pause').dataset.menu = fromMenu ? '1' : '';
  $('#ptitle').textContent = fromMenu ? 'Settings' : 'Paused';
  $('#peyebrow').innerHTML = fromMenu ? 'Settings<span class="jp">設定</span>' : 'Paused<span class="jp">一時停止</span>';
  $('#resume').innerHTML = fromMenu ? '<span>Back</span><kbd>Esc</kbd>' : '<span>Resume</span><kbd>Esc</kbd>';
  $('#pause .sh').classList.toggle('hide', fromMenu);
  $('#pause').classList.remove('hide');
  if (fromMenu) $('#menu').classList.add('hide');
  else g.setPaused(true);
}

function closePause() {
  const g = game;
  if (!g || !pauseOpen()) return;
  const fromMenu = !!$('#pause').dataset.menu;
  $('#pause').classList.add('hide');
  if (fromMenu) { $('#menu').classList.remove('hide'); return; }
  g.setPaused(false);
  g.input.requestLock();
}

function buildSettingsPanel() {
  const el = $('#settings');
  el.innerHTML = '';
  const row = (label: string, control: HTMLElement, readout?: () => string) => {
    const l = document.createElement('label');
    l.innerHTML = `<span>${label}</span>`;
    const cell = document.createElement('div');
    cell.className = 'ctl-cell';
    if (readout) {
      const out = document.createElement('output');
      out.textContent = readout();
      control.addEventListener('input', () => { out.textContent = readout(); });
      cell.appendChild(out);
    }
    cell.appendChild(control);
    l.appendChild(cell);
    el.appendChild(l);
  };
  const range = (min: number, max: number, step: number, value: number) => {
    const r = document.createElement('input');
    r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step);
    r.value = String(value);
    return r;
  };
  const toggle = (on: boolean) => {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = on;
    return c;
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const sel = document.createElement('select');
  for (const k of Object.keys(QUALITY)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = k.charAt(0).toUpperCase() + k.slice(1);
    sel.appendChild(o);
  }
  sel.value = settings.quality;
  sel.onchange = () => {
    settings.quality = sel.value;
    settings.autoQuality = false;
    autoBox.checked = false;
    game?.applyQuality(sel.value);
    saveSettings(settings);
  };
  row('Graphics quality', sel);

  const autoBox = toggle(settings.autoQuality);
  autoBox.onchange = () => { settings.autoQuality = autoBox.checked; saveSettings(settings); };
  row('Adjust quality automatically', autoBox);

  const view = document.createElement('select');
  for (const [v, t] of [['first', 'First person'], ['third', 'Third person']] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    view.appendChild(o);
  }
  view.value = settings.viewMode;
  view.onchange = () => {
    settings.viewMode = view.value as 'first' | 'third';
    game?.setViewMode(settings.viewMode);
    saveSettings(settings);
  };
  viewSelect = view;
  row('Camera <kbd>V</kbd>', view);

  const fov = range(70, 130, 1, settings.fov);
  fov.oninput = () => {
    settings.fov = Number(fov.value);
    if (game) { game.camera.userData.baseFov = settings.fov; game.camera.fov = settings.fov; game.camera.updateProjectionMatrix(); }
    saveSettings(settings);
  };
  row('Field of view', fov, () => `${fov.value}°`);

  const sens = range(0.2, 3, 0.05, settings.mouseSensitivity);
  sens.oninput = () => {
    settings.mouseSensitivity = Number(sens.value);
    if (game) game.input.sensitivity = settings.mouseSensitivity;
    saveSettings(settings);
  };
  row('Mouse sensitivity', sens, () => `${Number(sens.value).toFixed(2)}×`);

  const inv = toggle(settings.invertY);
  inv.onchange = () => { settings.invertY = inv.checked; if (game) game.input.invertY = inv.checked; saveSettings(settings); };
  row('Invert look', inv);

  const shake = range(0, 1.5, 0.05, settings.motionBlurShake);
  shake.oninput = () => { settings.motionBlurShake = Number(shake.value); saveSettings(settings); };
  row('Camera shake', shake, () => pct(Number(shake.value)));

  const lens = range(0, 1, 0.05, settings.lensFx);
  lens.oninput = () => {
    settings.lensFx = Number(lens.value);
    game?.post?.setLensFx(settings.lensFx);
    saveSettings(settings);
  };
  row('Lens effects', lens, () => pct(Number(lens.value)));

  const vol = range(0, 1, 0.02, settings.volume);
  vol.oninput = () => { settings.volume = Number(vol.value); game?.audio.setVolume(settings.volume); saveSettings(settings); };
  row('Volume', vol, () => pct(Number(vol.value)));

  const mute = toggle(settings.muted || forceMute);
  mute.onchange = () => { settings.muted = mute.checked; game?.audio.setMuted(mute.checked); saveSettings(settings); };
  muteBox = mute;
  row('Mute <kbd>M</kbd>', mute);

  const perf = toggle(settings.showPerf);
  perf.onchange = () => { settings.showPerf = perf.checked; game?.hud.setPerfVisible(perf.checked); saveSettings(settings); };
  row('Show performance', perf);
}

async function boot() {
  canvas = document.createElement('canvas');
  document.body.insertBefore(canvas, document.getElementById('ui'));
  buildSettingsPanel();

  const g = await createGame(undefined, false);
  g.audio.setVolume(settings.volume);
  g.audio.setMuted(settings.muted || forceMute);
  g.viewModel.setHidden(true);
  $('#mseed').textContent = String(g.seed);
  $('#mobj').textContent = g.phys.entities.length.toLocaleString('en-US');
  $('#menu').classList.remove('hide');

  $('#play').addEventListener('click', beginPlay);
  $('#menuSettings').addEventListener('click', () => openPause(true));
  $('#resume').addEventListener('click', closePause);
  // Clicking the dimmed world beside the panel is as good as pressing resume.
  $('#pause .scrim').addEventListener('click', closePause);

  canvas.addEventListener('click', () => {
    const gm = game;
    if (!gm) return;
    if (!menuOpen() && !gm.death.visible && gm.alive && !pauseOpen()) gm.input.requestLock();
  });

  addEventListener('keydown', (e) => {
    const gm = game;
    if (!gm) return;
    if (e.code === 'KeyR' && gm.death.visible) { void restart(); return; }
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && menuOpen()) { beginPlay(); return; }
    if (e.code === 'Escape') {
      if (gm.death.visible || menuOpen()) return;
      if (pauseOpen()) closePause();
      else openPause(false);
    }
  });
}

boot().catch((e) => {
  console.error(e);
  $('#ltext').textContent = `Failed: ${e?.message ?? e}`;
  $('#ltext').style.color = '#e8392f';
});

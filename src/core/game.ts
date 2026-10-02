import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysWorld, type Impact } from '../physics/physworld';
import { Entity, F, Kind } from '../physics/entity';
import { PoolManager } from '../render/pool';
import { Spawner } from '../world/spawn';
import { Sky } from '../render/sky';
import { Post } from '../render/post';
import { G, resetGlobals } from '../render/globals';
import { setEnvironment } from '../render/materials';
import { Vfx } from '../render/vfx';
import { Funnel, StreetLights } from '../render/vfx';
import { CityPlan, SHORE_Z } from '../world/cityplan';
import { Terrain } from '../world/terrain';
import { buildCity, type CityResult } from '../world/city';
import { placeProp, type PropKind } from '../world/props';
import { StructureSystem } from '../sim/structure';
import { Activation } from '../sim/activation';
import { Wind } from '../sim/wind';
import { Water } from '../sim/water';
import { Fire } from '../sim/fire';
import { Forces } from '../sim/forces';
import { Director, runPending, clearPending } from '../disasters/director';
import { Player, type DeathCause } from '../player/player';
import { Interaction } from '../player/interaction';
import { ViewModel } from '../player/viewmodel';
import { Input } from './input';
import { Audio } from '../audio/audio';
import { Hud, DeathScreen, CAUSE_TEXT } from '../ui/hud';
import { QUALITY, setBestTime, bestTime, type Settings, type Quality } from './settings';
import { Rng, clamp, clamp01, damp, lerp } from '../util/math';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export interface GameHooks { onProgress?: (p: number, label: string) => void; }

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  post!: Post;
  sky!: Sky;
  pools!: PoolManager;
  phys!: PhysWorld;
  spawn!: Spawner;
  plan!: CityPlan;
  terrain!: Terrain;
  city!: CityResult;
  structure!: StructureSystem;
  activation!: Activation;
  wind!: Wind;
  water!: Water;
  fire!: Fire;
  forces!: Forces;
  director!: Director;
  player!: Player;
  interaction!: Interaction;
  viewModel!: ViewModel;
  vfx!: Vfx;
  plume!: Funnel;
  streetLights!: StreetLights;
  audio = new Audio();
  hud = new Hud();
  death = new DeathScreen();
  input: Input;
  quality: Quality;
  settings: Settings;
  rng: Rng;
  seed: number;

  time = 0;
  runTime = 0;
  frame = 0;
  running = false;
  paused = false;
  alive = false;
  accum = 0;
  readonly FIXED = 1 / 60;
  fps = 60;
  private frameMs = 16;
  private lastPerfAdjust = 0;
  private wetness = 0;
  private burningCache: Entity[] = [];
  private nearGroundY = 0;
  private waterTopAtCam = -Infinity;
  private cover = 1;
  private coverTarget = 1;
  private stats = { distance: 0, thrown: 0, dug: 0, collapses: 0, hazards: 0, peakDepth: 0, fires: 0 };
  private lastPos = new THREE.Vector3();
  private deathAt = 0;
  onRequestRestart: (() => void) | null = null;
  /** When set, the camera ignores the player. Used for debugging only. */
  debugCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  constructor(canvas: HTMLCanvasElement, settings: Settings, seed = (Math.random() * 1e6) | 0) {
    this.settings = settings;
    this.quality = QUALITY[settings.quality] ?? QUALITY.high;
    this.seed = seed;
    this.rng = new Rng(seed);

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false, alpha: false, depth: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.07, this.quality.drawDistance);
    this.camera.userData.baseFov = settings.fov;

    this.input = new Input(canvas);
    this.input.sensitivity = settings.mouseSensitivity;
    this.input.invertY = settings.invertY;

    addEventListener('resize', this.onResize);
    this.death.onAgain = () => this.onRequestRestart?.();
  }

  private onResize = () => {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.hud?.resize();
  };

  async init(hooks: GameHooks = {}) {
    const P = hooks.onProgress ?? (() => {});
    // The shared look uniforms outlive a Game, so a fresh city starts clear.
    resetGlobals();
    P(0.02, 'starting physics');
    await RAPIER.init();

    this.phys = new PhysWorld();
    this.pools = new PoolManager(this.scene);
    this.spawn = new Spawner(this.phys, this.pools);

    P(0.08, 'drawing the streets');
    this.plan = new CityPlan(this.seed);

    P(0.16, 'pouring the ground');
    this.terrain = new Terrain(this.plan);
    this.terrain.build(this.phys, this.scene, { groundTex: this.quality.groundTex });
    // Lets the physics world notice when something has been squeezed through
    // the street by a collapse instead of letting it fall for ever.
    this.phys.groundAt = (x, z) => this.terrain.heightAt(x, z);

    P(0.26, 'lighting the sky');
    this.sky = new Sky(this.renderer, this.scene);
    this.sky.setShadowRadius(this.quality.shadowRadius, this.quality.shadowMap);
    this.sky.update(0, new THREE.Vector3(), {}, 0, new THREE.Vector3(0, 1, 0));
    this.sky.maybeRefreshEnv(this.renderer, true);
    setEnvironment(this.sky.envTexture);
    this.scene.environment = this.sky.envTexture;

    P(0.32, 'building the city');
    this.structure = new StructureSystem(this.phys, this.spawn);
    this.activation = new Activation(this.phys);
    this.spawn.sceneryBody = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.city = await buildCity({
      spawn: this.spawn, phys: this.phys, plan: this.plan, terrain: this.terrain,
      rng: this.rng, scene: this.scene, onProgress: P,
    });
    for (const b of this.city.buildings) this.structure.add(b);
    this.activation.index(this.phys.entities);
    // Everything out of reach of the start gives up its colliders until it is needed.
    this.activation.stream(this.city.spawnPoint);

    P(0.95, 'the weather');
    this.wind = new Wind(this.plan);
    this.water = new Water(this.terrain, this.plan, this.quality.waterRes);
    this.water.build(this.scene, Math.min(200, this.quality.waterRes + 40));
    this.player = new Player(this.phys, this.city.spawnPoint);
    this.fire = new Fire(this.phys, this.wind, this.water, this.structure, this.activation);
    this.forces = new Forces(this.phys, this.wind, this.water, this.activation, this.structure);
    this.forces.indexAttachments(this.phys.entities);
    this.interaction = new Interaction(this.phys, this.player, this.activation, this.structure);
    this.viewModel = new ViewModel(this.scene, this.phys);
    this.viewModel.setMode(this.settings.viewMode);
    this.director = new Director({
      wind: this.wind, water: this.water, fire: this.fire, structure: this.structure,
      forces: this.forces, activation: this.activation, phys: this.phys, spawn: this.spawn,
      plan: this.plan, terrain: this.terrain, player: this.player, rng: this.rng,
    });
    this.vfx = new Vfx(this.scene, this.quality.particleBudget, this.quality.rainParticles);
    this.plume = new Funnel(this.scene);
    this.streetLights = new StreetLights(this.scene, this.city.lights, 8);

    this.wireEvents();

    P(0.98, 'warming shaders');
    this.post = new Post(this.renderer, this.scene, this.camera, {
      ao: this.quality.ao, bloom: this.quality.bloom, smaa: this.quality.smaa,
    });
    this.post.setSize(innerWidth, innerHeight);
    this.post.setLensFx(this.settings.lensFx);
    const fp = this.settings.viewMode === 'first';
    this.post.setOverlay(fp ? this.viewModel.fpScene : null, fp ? this.viewModel.fpCamera : null);
    this.viewModel.setEnvironment(this.sky.envTexture);
    this.renderer.compile(this.viewModel.fpScene, this.viewModel.fpCamera);
    this.player.applyCamera(this.camera, 0.016, 0);
    this.renderer.compile(this.scene, this.camera);
    P(1.0, 'ready');
    this.running = true;
  }

  // ------------------------------------------------------------------ events

  private wireEvents() {
    const cam = this.camera;

    this.phys.onImpact.push((imp: Impact) => this.onImpact(imp));

    this.structure.events.onCollapse = (e, pos, volume) => {
      this.stats.collapses++;
      this.vfx.collapseDust(pos, volume);
      const d = pos.distanceTo(cam.position);
      this.audio.collapse(volume, d);
      if (d < 40 && this.rng.bool(0.3)) this.audio.creak(d);
      void e;
    };
    this.structure.events.onFracture = (e, pos, energy) => {
      const c = new THREE.Color(e.mat.color);
      this.vfx.impactDust(pos, Math.max(500, energy), c.lerp(new THREE.Color(0.6, 0.58, 0.55), 0.5));
      this.vfx.debrisChips(pos, clamp(Math.round(e.volume * 5), 3, 18), new THREE.Color(e.mat.color), 5);
      const d = pos.distanceTo(cam.position);
      if (d < 80) this.audio.impact(Math.max(900, energy), e.mat.id, d, e.radius);
    };
    this.structure.events.onGlassBreak = (pos, size) => {
      this.vfx.glassBurst(pos, size);
      this.audio.glassBreak(pos.distanceTo(cam.position));
    };

    this.fire.events.onIgnite = () => { this.stats.fires++; };
    this.fire.events.onExplosion = (pos, energy, radius) => {
      this.vfx.explosion(pos, energy, radius);
      this.audio.explosion(energy, pos.distanceTo(cam.position));
      this.post.lens.uniforms.uBlast.value = 1;
      this.player.addShake(clamp(radius * 0.09, 0.2, 1.6));
    };

    this.forces.onTearOff = (e, force) => {
      this.audio.tear(e.pos.distanceTo(cam.position));
      this.vfx.debrisChips(e.pos, 5, new THREE.Color(e.mat.color), 3);
      void force;
    };
    this.forces.onSplash = (pos, energy) => {
      this.vfx.splash(pos, energy);
      this.audio.splash(energy, pos.distanceTo(cam.position));
    };

    this.director.onStrike = (pos, energy) => {
      if (energy > 0) {
        _v.set(pos.x + this.rng.range(-40, 40), pos.y + 260, pos.z + this.rng.range(-40, 40));
        this.vfx.bolt.strike(_v, pos, this.rng);
        this.vfx.sparks(pos, 26, 16);
        this.vfx.explosion(pos, energy * 0.1, 3.5);
      }
      this.audio.thunder(pos.distanceTo(cam.position), energy);
    };
    this.director.onAlert = (a) => {
      if (a.crit) this.audio.alarm();
      if (a.title.startsWith('TSUNAMI')) this.audio.siren();
    };
    this.director.onHazard = () => { this.stats.hazards++; };

    this.player.onFootstep = (speed, ground, water) => {
      this.audio.footstep(speed, ground?.mat.id ?? 'concrete', water);
      if (water) this.vfx.splash(_v.copy(this.player.pos).setY(this.player.waterTop), 140);
    };
    this.player.onLand = (speed) => {
      if (speed > 3) this.audio.footstep(speed * 1.6, this.player.groundEntity?.mat.id ?? 'concrete', this.player.submerged > 0.1);
      if (speed > 8) this.vfx.impactDust(_v.copy(this.player.pos).setY(this.player.pos.y - this.player.halfHeight), speed * 240);
    };
    this.player.onHurt = (amount) => {
      this.audio.hurt(amount);
      this.viewModel.hit(clamp01(amount / 26));
    };
    this.player.onDeath = (cause) => this.onDeath(cause);

    this.interaction.onDig = (pos, power, material) => {
      this.stats.dug++;
      const c = new THREE.Color(material === 'soil' ? 0x5b4a38 : 0x8a8880);
      this.vfx.digPuff(pos, power, c);
      this.audio.impact(400 * power, material, 1);
    };
    this.interaction.onThrow = (e, speed) => {
      this.stats.thrown++;
      this.audio.whoosh(clamp01(speed / 18));
      void e;
    };
    // The animation owns the timing: the blow lands when the hands arrive.
    this.interaction.requestSwing = (dur) => this.viewModel.startSwing(dur);
    this.viewModel.onStrike = () => { if (this.interaction.pendingStrike) this.interaction.strike(); };
    this.interaction.onStrikeHit = (pos, energy, material, broke) => {
      const c = new THREE.Color(material === 'soil' ? 0x5b4a38 : material === 'wood' ? 0x8a6a45 : 0x9a9790);
      this.vfx.impactDust(pos, Math.max(260, energy * 2.2), c);
      if (energy > 40) this.vfx.debrisChips(pos, broke ? 9 : 3, c, broke ? 4.5 : 2.4);
      this.audio.impact(Math.max(500, energy * 9), material, pos.distanceTo(cam.position));
      this.player.addShake(clamp(energy / 900, 0.01, 0.16));
    };
  }

  private onImpact(imp: Impact) {
    const e = imp.a;
    if (e.has(F.DEAD)) return;
    const now = this.phys.time;
    // Something that has only just been given a body — a prop woken as the
    // player walked up, a piece that has just come away from a wall — may have
    // been set down a little inside its neighbour. The solver prises them apart
    // with a large force and next to no speed. That is not a collision: it must
    // not make a sound, throw dust, or break anything.
    const settling = imp.approach < 2.5
      && (now - e.liveAt < 1.2 || (imp.b !== null && now - imp.b.liveAt < 1.2));
    if (settling) return;
    const camDist = e.pos.distanceTo(this.camera.position);

    if (e.kind === Kind.Player) {
      // Anything that hits hard enough hurts, scaled by what it was made of.
      const dmg = clamp((imp.energy - 260) / 130, 0, 100);
      if (dmg > 0.6) {
        this.player.hurt(dmg, imp.b && imp.b.mass > 320 ? 'crushed' : 'impact');
        this.player.addShake(clamp(dmg / 30, 0.1, 1.4));
        // Knockback follows momentum, not raw impulse, and is capped so a
        // collapsing building shoves you rather than launching you.
        if (imp.b) {
          const dv = clamp(imp.impulse / this.player.mass, 0, 7.5);
          this.player.push(_v2.copy(imp.normal).multiplyScalar(-dv * this.player.mass));
        }
      }
      return;
    }

    // Sound and dust come from how hard things met, not how hard they press:
    // a crate under a stack carries a big contact force and makes no noise.
    if (imp.primary) this.impactSound(imp);
    if (camDist < 70 && imp.energy > 2600 && imp.approach > 1.5) {
      this.vfx.impactDust(imp.point, imp.energy);
      if (e.mat.eConductivity > 0.5 && imp.energy > 9000) this.vfx.sparks(imp.point, 6, 7);
    }
    if (e.has(F.BREAKABLE)) this.structure.impact(e, imp.energy);
  }

  /** One sound per collision, voiced by whichever body did the moving. */
  private impactSound(imp: Impact) {
    const v = imp.approach;
    if (v < 1.1) return;
    const a = imp.a, b = imp.b;
    const src = b && b.dynamic && !a.dynamic ? b : a;
    const other = src === a ? b : a;
    const now = this.phys.time;
    // A thing rattling in a pile hits its neighbours many times a second; one
    // knock is the sound of it, the rest is a buzz.
    if (now - src.lastSoundAt < 0.3) return;
    const dist = src.pos.distanceTo(this.camera.position);
    if (dist > 95) return;
    const mEff = other && other.dynamic ? (src.mass * other.mass) / (src.mass + other.mass) : src.mass;
    const ke = 0.5 * mEff * v * v;
    if (ke < 15) return;
    src.lastSoundAt = now;
    this.audio.impact(ke, src.mat.id, dist, src.radius);
  }

  private onDeath(cause: DeathCause) {
    if (!this.alive) return;
    this.alive = false;
    this.deathAt = this.time;
    this.input.exitLock();
    // The report replaces the HUD; the arms go with it.
    this.hud.hide();
    this.viewModel.setHidden(true);
    setBestTime(this.runTime);
    const d = this.stats;
    this.death.show(this.runTime, CAUSE_TEXT[cause] ?? 'Killed', bestTime(), [
      [String(d.hazards), 'disasters'],
      [String(d.collapses), 'pieces fallen'],
      [`${Math.round(d.distance)} m`, 'travelled'],
      [String(d.thrown), 'things thrown'],
      [`${d.peakDepth.toFixed(1)} m`, 'deepest water'],
      [String(d.fires), 'fires started'],
    ]);
  }

  // -------------------------------------------------------------------- run

  /** Face the most open direction so the first thing you see is the city. */
  private faceOpenDirection() {
    const p = this.player.pos;
    let bestYaw = 0, bestFree = -1;
    for (let a = 0; a < 16; a++) {
      const yaw = (a / 16) * Math.PI * 2;
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      let d = 2;
      while (d < 60 && !this.plan.isBuilt(p.x + dx * d, p.z + dz * d)) d += 2;
      if (d > bestFree) { bestFree = d; bestYaw = yaw; }
    }
    this.player.yaw = bestYaw;
    this.player.pitch = -0.02;
  }

  startRun() {
    this.alive = true;
    this.runTime = 0;
    this.stats = { distance: 0, thrown: 0, dug: 0, collapses: 0, hazards: 0, peakDepth: 0, fires: 0 };
    this.lastPos.copy(this.player.pos);
    this.faceOpenDirection();
    this.hud.reset();
    this.hud.show();
    this.death.hide();
    this.audio.start();
    // The clock only starts when the player does. Until now the city has been
    // sitting behind the menu with the weather held at its opening state.
    clearPending();
    this.director.reset();
    this.runLive = true;
  }

  /** False while the menu is up: the city idles, the weather does not advance. */
  private runLive = false;

  // ------------------------------------------------------------------ loop

  private lastT = 0;
  tick = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    const raw = this.lastT ? (now - this.lastT) / 1000 : 0.016;
    this.lastT = now;
    const dt = clamp(raw, 0.0005, 0.1);
    this.frameMs = damp(this.frameMs, raw * 1000, 4, dt);
    this.fps = 1000 / Math.max(0.5, this.frameMs);

    if (!this.paused) {
      try {
        this.step(dt);
      } catch (err) {
        // One bad frame should not take the whole run down with it.
        if (!this.loggedError) { this.loggedError = true; console.error('simulation error', err); }
      }
    }
    this.render(dt);
    this.input.endFrame();
    this.frame++;
    if (this.settings.autoQuality) this.autoQuality();
  };

  private loggedError = false;

  /** Smoothed cost of one fixed update, in milliseconds. */
  private fixedMs = 4;

  private step(dt: number) {
    {
      this.accum += dt;
      let steps = 0;
      // Cap the physics budget per frame rather than the number of steps, so a
      // district coming down does not drag the frame rate through the floor.
      // The last step a frame can afford takes whatever time is owed, up to two
      // ticks' worth: a heavy frame costs a little accuracy instead of putting
      // the whole world — and every fall — into slow motion. Only past that
      // does the simulation start to run behind real time.
      const maxSteps = this.fixedMs > 17 ? 1 : this.fixedMs > 9 ? 2 : 3;
      while (this.accum >= this.FIXED && steps < maxSteps) {
        const h = steps === maxSteps - 1 ? Math.min(this.accum, this.FIXED * 2) : this.FIXED;
        const t0 = performance.now();
        this.fixedUpdate(h);
        this.fixedMs = this.fixedMs * 0.85 + (performance.now() - t0) * 0.15;
        this.accum -= h;
        steps++;
      }
      if (steps >= maxSteps) this.accum = Math.min(this.accum, this.FIXED);
      this.time += dt;
      if (this.alive) this.runTime += dt;
      this.variableUpdate(dt);
    }
  }

  private fixedUpdate(dt: number) {
    const player = this.player;

    if (this.runLive) {
      this.director.update(dt, player);
      runPending(this.director);
      this.director.updateElectric(dt, player);
    }

    this.water.update(dt);
    this.fire.update(dt, player);
    this.forces.update(dt, player);
    this.structure.update(dt);

    // Riding a floor that is physically swaying during a quake.
    {
      const ge = player.groundEntity;
      const b = ge && ge.has(F.STRUCTURAL) ? this.structure.buildings[ge.buildingId] : null;
      if (b && b.body && b.body.isKinematic() && this.structure.swayAmp.lengthSq() > 1e-6) {
        const t = b.body.translation();
        if (this.swayRef === b.id) {
          _v.set(t.x - this.lastSway.x, 0, t.z - this.lastSway.z);
          if (_v.lengthSq() < 4) player.ridePlatform(_v);
        }
        this.swayRef = b.id;
        this.lastSway.set(t.x, 0, t.z);
      } else {
        this.swayRef = -1;
      }
    }

    // Anything climbable within reach — ladders, scaffolding, a fire escape.
    if ((this.frame & 3) === 0) {
      player.nearLadder = null;
      const near = this.phys.queryBall(player.pos, 1.15, this.ladderScratch, 12);
      let best = Infinity;
      for (const e of near) {
        if (!e.has(F.LADDER) || e.has(F.DEAD)) continue;
        const d = e.pos.distanceToSquared(player.pos);
        if (d < best) { best = d; player.nearLadder = e; }
      }
    }
    player.update(dt, this.input, this.input.locked);
    if (this.alive) this.interaction.update(dt, this.input);

    this.phys.step(dt);
    this.phys.syncViews();
    this.phys.collect();
    this.manageDebris();

    // distance travelled
    const d = player.pos.distanceTo(this.lastPos);
    if (d < 4) this.stats.distance += d;
    this.lastPos.copy(player.pos);
    this.stats.peakDepth = Math.max(this.stats.peakDepth, player.submerged > 0.3 ? this.water.depthAt(player.pos.x, player.pos.z) : 0);

    // fell out of the world
    if (player.pos.y < -80 && this.alive) player.hurt(1000, 'fall');
  }
  private lastSway = new THREE.Vector3();
  private swayRef = -1;

  /**
   * Keep loose bodies within budget. Rubble you are standing in is always kept;
   * everything else is scored by age and distance and the worst is retired.
   */
  private manageDebris() {
    const list = this.phys.debris;
    // When the simulation is struggling, keep less wreckage around and protect a
    // smaller bubble of it. The budget recovers on its own once the district has
    // finished falling over.
    const strain = this.fixedMs > 20 ? 2 : this.fixedMs > 12 ? 1 : 0;
    const load = strain === 2 ? 0.45 : strain === 1 ? 0.7 : 1;
    const keepNear = strain === 2 ? 13 : strain === 1 ? 17 : 22;
    const keepMid = strain === 2 ? 20 : strain === 1 ? 27 : 34;
    const cap = Math.round(this.quality.maxDebris * load);
    if (list.length <= cap) return;
    const p = this.player.pos;
    let need = list.length - cap;

    // Pass 1: fragments and chips that are out of arm's reach.
    for (let i = 0; i < list.length && need > 0; i++) {
      const e = list[i];
      if (e.has(F.DEAD) || e.has(F.NO_DESPAWN) || e.has(F.HELD)) continue;
      if (e.pos.distanceToSquared(p) < keepNear * keepNear) continue;
      if (e.has(F.FRAGMENT) || e.volume < 0.3) { this.phys.destroy(e); need--; }
    }
    if (need <= 0) return;

    // Pass 2: worst-scoring wreckage, oldest and furthest away first.
    const cand = this.debrisScratch;
    cand.length = 0;
    for (const e of list) {
      if (e.has(F.DEAD) || e.has(F.NO_DESPAWN) || e.has(F.HELD)) continue;
      if (e.pos.distanceToSquared(p) < keepMid * keepMid) continue;
      cand.push(e);
    }
    // Distance dominates: wreckage you can see is the last thing to go.
    cand.sort((a, b) => {
      const sa = Math.sqrt(a.pos.distanceToSquared(p)) + (this.phys.time - a.bornAt) * 0.25;
      const sb = Math.sqrt(b.pos.distanceToSquared(p)) + (this.phys.time - b.bornAt) * 0.25;
      return sb - sa;
    });
    for (let i = 0; i < cand.length && need > 0; i++) { this.phys.destroy(cand[i]); need--; }
    cand.length = 0;
  }
  private debrisScratch: Entity[] = [];
  private ladderScratch: Entity[] = [];

  private variableUpdate(dt: number) {
    const player = this.player;
    const w = this.director.weather;
    const cam = this.camera;

    // Housekeeping runs once per frame on wall-clock time. Inside the fixed step
    // it would either stall when the simulation falls behind (exactly when rubble
    // most needs putting to sleep) or, with a wall-clock timer, fire on every
    // substep and rebuild a hundred rigid bodies at a time.
    this.activation.update(dt, player.pos);

    player.applyCamera(cam, dt, this.settings.motionBlurShake);
    this.viewModel.placeCamera(cam, player, dt);
    // Development aid: pin the camera anywhere to inspect the simulation.
    if (this.debugCam) {
      cam.position.copy(this.debugCam.pos);
      cam.lookAt(this.debugCam.target);
    }

    // ---- global look uniforms
    const rainWet = clamp01(w.rain * 1.5);
    this.wetness = damp(this.wetness, Math.max(rainWet, this.water.maxDepth > 0.05 ? 0.85 : 0), 0.12, dt);
    G.uWetness.value = this.wetness;
    G.uAsh.value = w.ash;
    G.uFlash.value = this.director.flash;
    G.uNightLights.value = clamp01(w.night * 1.25);
    G.uFogDensity.value = lerp(0.0015, 0.0052, clamp01(w.storm * 0.55 + w.ash * 0.75 + w.fogBoost));
    G.uTime.value += dt;
    G.uCamPos.value.copy(cam.position);

    // ---- water interaction with the camera
    const surf = this.water.surfaceAt(cam.position.x, cam.position.z);
    this.waterTopAtCam = surf;
    const under = surf > -1e8 && cam.position.y < surf - 0.02;
    G.uUnderwater.value = under ? 1 : 0;
    this.post.lens.uniforms.uUnderwater.value = damp(this.post.lens.uniforms.uUnderwater.value, under ? 1 : 0, 9, dt);
    this.post.lens.uniforms.uRain.value = damp(this.post.lens.uniforms.uRain.value,
      under ? 0 : clamp01(w.rain * 0.85) * clamp01(this.plan.openness(cam.position.x, cam.position.z) * 1.4), 3, dt);
    this.post.lens.uniforms.uBlast.value = Math.max(0, this.post.lens.uniforms.uBlast.value - dt * 2.4);
    const hurtFlash = Math.max(0, 1 - (this.time - player.lastDamageAt) / 0.45);
    this.post.grade.uniforms.uDamage.value = damp(
      this.post.grade.uniforms.uDamage.value,
      Math.min(0.85, clamp01(1 - player.vitals.health / 42) * 0.7 + hurtFlash * 0.38), 9, dt);
    this.post.grade.uniforms.uDesat.value = damp(this.post.grade.uniforms.uDesat.value,
      this.alive ? 0 : 0.85, 1.6, dt);
    this.renderer.toneMappingExposure = lerp(0.98, 0.80, clamp01(w.night * 0.55 + w.ash * 0.35))
      + this.director.flash * 0.10;

    // ---- sky
    this.sky.update(dt, cam.position, {
      night: w.night, cloud: w.cloud, storm: w.storm, ash: w.ash,
      wind: clamp(0.5 + w.windSpeed * 0.08, 0.5, 4),
      cityGlow: clamp01(w.night * 0.45 + this.fire.intensity * 0.7),
    }, this.director.flash, this.director.flashDir);
    if (this.frame % 3 === 0) this.refreshEnv();
    this.streetLights.update(dt, cam.position, w.night, G.uPower.value);

    // ---- the player's own body
    this.viewModel.setLighting(
      this.sky.sunDir, this.sky.sun.color, this.sky.sun.intensity,
      this.sky.fill.color, this.sky.fill.groundColor, this.sky.fill.intensity);
    this.viewModel.update(dt, player, this.interaction, cam,
      { fwd: player.moveInput.y, strafe: player.moveInput.x }, this.interaction.charge);

    // ---- vfx
    const groundY = this.terrain.heightAt(cam.position.x, cam.position.z);
    this.nearGroundY = groundY;
    // Under cover? Ask the world, not the map: one ray straight up settles it.
    if (this.frame % 6 === 0) {
      const hit = this.phys.world.castRay(
        new RAPIER.Ray({ x: cam.position.x, y: cam.position.y + 0.3, z: cam.position.z }, { x: 0, y: 1, z: 0 }),
        60, true, undefined, undefined, undefined, this.player.body);
      this.coverTarget = hit ? clamp01(0.06 + hit.timeOfImpact / 90) : 1;
    }
    this.cover = damp(this.cover, this.coverTarget, 4, dt);
    const shelter = clamp(this.plan.openness(cam.position.x, cam.position.z) * 0.45 + 0.55, 0.2, 1) * this.cover;
    this.fire.visibleFires(cam.position, 40, this.burningCache);
    const vx = this.wind.vortexAt(cam.position.x, cam.position.z);
    this.vfx.update(dt, cam, {
      rain: under ? 0 : w.rain, wind: this.wind.atPlayer, shelter,
      ash: w.ash, burning: this.burningCache, groundY,
      vortex: this.wind.vortices.length ? this.wind.vortices[0] : null,
      waterTop: surf, smoke: clamp01(this.fire.intensity * 1.2 + w.ash * 0.3),
    });

    // volcanic plume and crater glow on the horizon
    const erupting = this.director.active.find((h) => h.kind === 'eruption');
    const crater = this.scene.getObjectByName('crater') as THREE.Mesh | undefined;
    if (crater) {
      const m = crater.material as THREE.MeshBasicMaterial;
      const want = erupting ? clamp01(erupting.t / 10) * (0.5 + 0.5 * Math.sin(this.time * 1.7)) * 0.75 : 0;
      m.opacity = damp(m.opacity, want, 2.5, dt);
      crater.visible = m.opacity > 0.01;
    }
    if (erupting) {
      const volc = this.scene.getObjectByName('volcano');
      if (volc) {
        this.plume.mesh.visible = true;
        this.plume.update(dt, {
          x: volc.position.x, z: volc.position.z, radius: 260, strength: 1,
          height: 1500, vx: 0, vz: 0, life: 1, maxLife: 1,
          intensity: clamp01(erupting.t / 12) * 0.85, id: 99,
        }, volc.position.y + 780);
      }
    } else if (this.plume.mesh.visible) {
      this.plume.update(dt, null, 0);
    }

    // ---- audio beds
    // A fall is heard as much as seen: the air you are dropping through rushes
    // past like a gust, so the same bed carries it.
    const windSpeed = Math.hypot(this.wind.peakLocal, Math.max(0, -player.vel.y - 2) * 1.3);
    this.audio.set('rain', clamp01(w.rain * 0.85) * shelter * 0.5, lerp(900, 2600, clamp01(w.rain)), 0.7);
    this.audio.set('wind', clamp01((windSpeed - 3) / 45) * 0.85, lerp(260, 900, clamp01(windSpeed / 45)), lerp(1.2, 3.2, clamp01(vx.amount)));
    this.audio.set('rumble', clamp01(this.forces.quakeAccel.length() / 4) * 0.9, lerp(40, 110, clamp01(this.forces.quakeAccel.length() / 6)));
    this.audio.set('fire', clamp01(this.fire.playerHeat / 3) * 0.5, 1200, 0.6);
    const depth = this.water.depthAt(player.pos.x, player.pos.z);
    this.audio.set('water', clamp01(depth * 0.5) * 0.45 + (under ? 0.25 : 0), under ? 320 : 700, 0.7);

    // ---- HUD
    this.hud.update(dt);
    this.hud.setTime(this.runTime);
    this.hud.setPhase(this.director.phase, this.director.intensity);
    this.hud.setVitals(player.vitals);
    this.hud.syncAlerts(this.director.alerts);
    this.hud.setHazards(this.director.hazardSummary());
    this.hud.setCompass(player.yaw);
    this.updateReticle();
    if (this.frame % 15 === 0 && this.settings.showPerf) {
      const s = this.pools.stats();
      this.hud.setFps(`${this.fps.toFixed(0)} fps · ${this.phys.stats.active} active · ${this.phys.debris.length} loose · ${s.instances} inst`);
    }

    // keys
    if (this.input.hit('KeyH')) {
      this.hud.say('Hold LMB to carry, let go to drop · wheel back to wind up a throw · RMB swings · V camera · M mute', 7);
    }
    if (this.input.hit('KeyV')) {
      this.setViewMode(this.settings.viewMode === 'first' ? 'third' : 'first');
      this.hud.say(this.settings.viewMode === 'first' ? 'First person' : 'Third person', 1.6);
    }
    if (this.input.hit('KeyM')) {
      const m = !this.audio.muted;
      this.audio.setMuted(m);
      this.hud.say(m ? 'Sound muted' : 'Sound on', 1.6);
      this.onMuteChange?.(m);
    }
  }

  private updateReticle() {
    const hud = this.hud;
    const weight = (m: number) => m < 1 ? `${(m * 1000).toFixed(0)} g` : `${m.toFixed(m < 10 ? 1 : 0)} kg`;
    const held = this.interaction.info;
    if (held.entity) {
      const ch = this.interaction.charge;
      hud.setItem(held.dragging ? 'Dragging' : 'Carrying', held.label, `${weight(held.mass)} · ${held.material}`, true);
      hud.setPrompt(ch > 0.02
        ? [['Release', `Throw <b>${Math.round(ch * 100)}%</b>`]]
        : [['Release', 'Drop'], ['Wheel ↓', 'Wind up'], ['RMB', 'Swing'], ['R', 'Rotate']]);
      hud.setCharge(ch);
      hud.setCrosshair(true);
      return;
    }
    const a = this.interaction.aimEntity;
    hud.setCharge(0);
    if (a && this.interaction.aimDist < 3.0 && this.interaction.canGrab(a)) {
      hud.setItem('Within reach', a.label || 'object', `${weight(a.mass)} · ${a.mat.id}${a.mass > 62 ? ' · heavy' : ''}`);
      hud.setPrompt([['Hold LMB', a.mass > 62 ? 'Drag' : 'Pick up']]);
      hud.setCrosshair(true);
    } else if (this.player.climbing) {
      hud.setItem('', '', '');
      hud.setPrompt([['W', 'Climb'], ['Q', 'Let go'], ['Shift Space', 'Push off']]);
      hud.setCrosshair(false);
    } else if (this.player.nearLadder) {
      hud.setItem('', '', '');
      hud.setPrompt([['W', 'Climb']]);
      hud.setCrosshair(false);
    } else if (a && (a.has(F.DIGGABLE) || a.mat.hardness < 0.3)) {
      hud.setItem('', '', '');
      hud.setPrompt([['LMB', 'Dig'], ['F', 'Keep digging']]);
      hud.setCrosshair(true);
    } else if (this.interaction.aimVerb === 'strike' || this.interaction.aimVerb === 'tear') {
      hud.setItem('', '', '');
      hud.setPrompt([['LMB', this.interaction.aimVerb === 'tear' ? 'Tear loose' : 'Hit']]);
      hud.setCrosshair(true);
    } else {
      hud.setItem('', '', '');
      hud.setPrompt(null);
      hud.setCrosshair(false);
    }
  }

  protected render(dt: number) {
    this.pools.flush();
    this.renderer.info.reset();
    this.post.render(dt);
  }

  /** Slow, hysteretic quality control — it must never oscillate mid-disaster. */
  private autoQuality() {
    // The opening seconds of a run are dominated by shader compilation, not by
    // the scene, so nothing measured there is worth acting on.
    if (this.time < 30) { this.perfLow = 0; this.perfHigh = 0; return; }
    const low = this.fps < 34, high = this.fps > 82;
    this.perfLow = low ? this.perfLow + 1 : 0;
    this.perfHigh = high ? this.perfHigh + 1 : 0;
    if (this.time - this.lastPerfAdjust < 10) return;
    const order = ['low', 'medium', 'high', 'ultra'];
    const idx = order.indexOf(this.quality.name);
    if (this.perfLow > 240 && idx > 0) this.applyQuality(order[idx - 1]);
    else if (this.perfHigh > 400 && idx < 2) this.applyQuality(order[idx + 1]);
    else return;
    this.perfLow = 0; this.perfHigh = 0;
    this.lastPerfAdjust = this.time;
  }
  private perfLow = 0;
  private perfHigh = 0;

  /**
   * Development aid: lay one of every prop out on a grid and point the camera at
   * it, so the whole catalogue can be judged side by side instead of hunting for
   * one bin in a city.
   */
  propGallery(kinds: string[], spacing = 3.2, perRow = 8) {
    const base = new THREE.Vector3(this.player.pos.x, this.terrain.heightAt(this.player.pos.x, this.player.pos.z), this.player.pos.z + 12);
    const placed: { kind: string; pos: THREE.Vector3 }[] = [];
    for (let i = 0; i < kinds.length; i++) {
      const col = i % perRow, row = Math.floor(i / perRow);
      const p = new THREE.Vector3(base.x + (col - (perRow - 1) / 2) * spacing, base.y, base.z + row * spacing);
      placeProp(this.spawn, kinds[i] as PropKind, this.rng, p.x, p.y, p.z, Math.PI, { live: true, body: 'fixed' });
      placed.push({ kind: kinds[i], pos: p });
    }
    return placed;
  }

  setViewMode(m: 'first' | 'third') {
    this.settings.viewMode = m;
    this.viewModel?.setMode(m);
    // The arms scene is empty in third person; skip the pass rather than clear a
    // depth buffer and draw nothing.
    this.post?.setOverlay(m === 'first' ? this.viewModel.fpScene : null,
      m === 'first' ? this.viewModel.fpCamera : null);
    this.onViewModeChange?.(m);
  }
  /** Lets the settings panel follow the in-game toggle key. */
  onViewModeChange: ((m: 'first' | 'third') => void) | null = null;
  onMuteChange: ((m: boolean) => void) | null = null;

  applyQuality(name: string) {
    const q = QUALITY[name];
    if (!q) return;
    this.quality = q;
    this.settings.quality = name;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.post?.setQuality({ ao: q.ao, bloom: q.bloom, smaa: q.smaa });
    this.post?.setSize(innerWidth, innerHeight);
    this.sky?.setShadowRadius(q.shadowRadius, q.shadowMap);
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();
  }

  refreshEnv(force = false) {
    if (this.sky.maybeRefreshEnv(this.renderer, force)) {
      setEnvironment(this.sky.envTexture);
      this.scene.environment = this.sky.envTexture;
      this.viewModel?.setEnvironment(this.sky.envTexture);
    }
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) { this.audio.suspend(); this.input.exitLock(); }
    else { this.audio.resume(); }
  }

  get waterTopCam() { return this.waterTopAtCam; }
  get groundAtCam() { return this.nearGroundY; }
  get deathTime() { return this.deathAt; }
  get shoreZ() { return SHORE_Z; }

  dispose() {
    this.running = false;
    removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.post?.dispose();
    this.vfx?.dispose(this.scene);
    this.plume?.dispose(this.scene);
    this.water?.dispose(this.scene);
    this.pools?.dispose();
    this.terrain?.dispose(this.scene);
    this.sky?.dispose();
    this.player?.dispose();
    this.viewModel?.dispose();
    this.streetLights?.dispose(this.scene);
    this.audio.dispose();
    clearPending();
    this.renderer.dispose();
  }
}

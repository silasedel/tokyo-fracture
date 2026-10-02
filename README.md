# Tokyo Fracture

A physics-driven natural-disaster survival sandbox set in a fictionalised Tokyo.
There is one objective: **stay alive**. A timer counts up from the moment you
enter the city; the city gets progressively worse at letting you.

**Play it in the browser: https://silasedel.github.io/tokyo-fracture/**
(desktop, keyboard and mouse; a recent Chrome, Edge, Firefox or Safari).

```bash
npm install
npm run dev      # http://localhost:5180
```

`npm run build` type-checks and produces a static bundle in `dist/`.

---

## The idea

Nothing in this game is a scripted outcome. There is no "raft recipe", no
"barricade" verb, no scripted collapse animation, no safe room. There is a
physical world with consistent rules, and a director that applies forces to it.
Everything you can do falls out of the same small set of systems.

If you stack heavy furniture against a door it is hard to move, because the
combined mass, friction and contact area make it hard to move. If you lash a
few sealed drums together and stand on them they float, because their displaced
volume exceeds their weight. If you dig out the base of something unstable it
falls, because its supports changed. None of those three sentences describe a
feature — they describe the same physics being asked different questions.

---

## Architecture

```
src/
  core/        engine loop, input, settings
  physics/     Rapier wrapper, entity model, material registry
  world/       city plan, terrain, buildings, props, vehicles, street clutter
  sim/         structure, water, wind, fire, forces, activation
  disasters/   the director
  player/      character controller, generated body and its animation, interaction
  render/      sky, materials, instanced pools, particles, VFX, post
  ui/ audio/   HUD, death screen, procedural sound
```

### Materials are the source of truth

`src/physics/materials.ts` defines ~24 substances with density, toughness,
strength, hardness, brittleness, friction, restitution, flammability, ignition
temperature, burn rate, heat capacity, thermal and electrical conductivity,
absorbency, drag and heat weakening. Every system reads these numbers:

- **Mass** = density x volume (an authored mass is honoured by solving for the
  density that produces it over the object's actual colliders, so a bicycle
  weighs 14 kg and not the third of that its tubes and wheels enclose, and the
  inertia tensor stays consistent).
- **Breaking** = impact energy vs `toughness x volume`.
- **Floating** = displaced volume vs weight, including trapped air and water
  taken aboard over time.
- **Burning** = flammability, ignition temperature and remaining fuel.
- **Wind** = the object's *exact projected area* along the wind direction, so a
  flat sheet and a compact block of the same mass behave completely differently.

Shape matters independently of substance: `shapeFactors()` derives a drag boost
and an "awkwardness" from the aspect ratio, which is why a long, light plank is
harder to carry than a heavy compact crate.

### Buildings are graphs, not models

`src/world/building.ts` builds each block out of columns, floor slabs, facade
panels, partitions, stairs and parapets, and wires up which pieces hold up which
other pieces. `src/sim/structure.ts` runs the consequences:

- Shaking loads every element in proportion to its height above the base and its
  material strength, scaled by a per-building construction quality. Timber-framed
  low-rise fails long before a steel-framed tower.
- When an element fails it either **detaches in one piece** (it simply lost its
  supports — a slab tips, slides and lands as a ramp) or **fractures** into real
  chunks that conserve the parent's momentum.
- Its dependents are re-checked a fraction of a second later, which is what makes
  collapse cascade rather than happen all at once.
- What is left is real geometry. Sloped slabs, rubble piles and half-floors are
  all climbable, and the holes are real holes.

Intact buildings carry all of their colliders on a *single* fixed body. A piece
gets a body of its own only at the moment it comes loose. That is the difference
between a 27 ms physics step and a 3 ms one.

### Most of the city is asleep

Thousands of props sit as colliders on one shared static body with a `DORMANT`
flag. `src/sim/activation.ts` hands an object a real rigid body when the player,
the weather, a fire or a blast actually needs it to move, and freezes settled
wreckage back to static once it is far away and at rest. This is also why distant
rubble piles never jitter.

Beyond about 110 m even the colliders go: a parked prop keeps its place, its look
and its mass, but costs the broadphase, the narrowphase and the query tree
nothing until the player comes within 90 m. Anything that needs it sooner — a
quake, a flood, a tornado, a blast, the wind tearing it loose — gets its
colliders back first, and a blast query finds parked props as well as live ones.
With more than 23,000 objects in the city, that took the physics step on the
development machine from 13 ms to 8.5.

### Water

`src/sim/water.ts` is a shallow-water height field over the whole map (a 3–4 m
grid, solved at 20 Hz). Rain lands on it, storm drains pull it away at a limited
rate, the river feeds it, and the bay is a boundary condition — which means a
**tsunami is just that boundary being raised**, with a drawback first and a wall
of water afterwards. It floods along the real terrain and around real buildings.

Every dynamic body samples the same grid for buoyancy (applied at the centroid of
the *submerged* part, so things right themselves or tip over on their own), drag
against the local current, and angular damping. Sealed volumes take on water over
time, so a car floats for a while and then goes down.

### Wind

`src/sim/wind.ts` is one field sampled by everything: a boundary-layer profile
that is sheltered at street level and full strength above the roofs, gusts from
3D noise, channelling along street canyons, and Rankine vortices for tornadoes
(solid-body core, 1/r outside, inflow near the ground, updraft in the wall).

Bolted-on objects — signage, air conditioners, ladders, downpipes — have a real
fixing strength that fatigues under repeated loading and eventually lets go. What
was a sign becomes a 40 kg object travelling at the wind speed.

### Fire

`src/sim/fire.ts` tracks temperature and remaining fuel per object. Burning
objects radiate to their neighbours with an inverse-square falloff, biased upward
and downwind; anything whose material can take it ignites, chars, weakens and
heats its own neighbours. Rain and floodwater wet things and put them out. In a
gale, embers spot fires across a street.

Roughly half of the older low-rise stock is timber-framed, so it burns *and* it
is structurally weaker — which is what turns one ignition into a district fire.

### The director

`src/disasters/director.ts` picks hazards that fit the current danger level, with
cooldowns and weights, and wires up the cascades: a quake ruptures gas mains and
drops buildings, a big one may be followed by a tsunami warning, aftershocks
arrive minutes later, flooding shorts the grid, lightning in standing water
electrifies it. It does not follow a script — each run is a different sequence.

What *is* authored is the pace, as keyframed timelines rather than a formula,
because the opening has to be felt:

| from | stage | what it feels like |
|---|---|---|
| 0:00 | calm | a city, some traffic, a breeze |
| 0:45 | light rain | overcast, drizzle starting |
| 1:40 | heavy rain | proper downpour, wind rising |
| 2:50 | thunderstorm | lightning, gusts, standing water |
| 4:10 | tremors | the first small quakes — things rattle and fall |
| 6:20 | storm front / escalating | typhoon winds, flooding, fire, gas, blackouts |
| 11:00 | severe | major quakes, tornadoes, landslides, collapse |
| 14:00+ | disaster / catastrophe | eruption, tsunami, everything at once |

Every hazard's `minIntensity` is a point on that line, so the first tremor cannot
arrive during the drizzle and a tsunami cannot arrive before the city has already
had a bad night.

### The player's body

`src/player/body.ts` generates the body — no modelling package, no assets. One
skeleton drives skinned meshes for skin, jacket, trousers, shoes, hair and eyes,
each swept as rings of vertices along the bones in their rest pose and weighted
across every joint, so an elbow, a knee or a knuckle bends as one surface. The
hands have three-jointed fingers with nails, a thumb that swings across the
palm, and the pads of the palm; the jacket has a zip, yoke, pockets, ribbed
cuffs and a hood rolled behind a collar that sits low at the throat.

`src/player/character.ts` poses it from what the simulation is doing, with no
animation clips. First person drives the *hands*: each state names where the
hands should be in front of the face and a two-bone IK solves the arms to reach
there, which is the only way to keep them on screen at any field of view; the
wrists are then set by where the hand should point in the view, not by joint
angles. Carrying something puts the palms onto its sides; winding up a throw
pulls one hand back past the ear; a swing is a three-point arc with a real
contact frame that tells the interaction system when the blow lands. Third
person places the feet on the ground and solves the legs to reach them, so a
stride plants each foot flat and a crouch folds the knees instead of sinking the
legs into the pavement.

The arms are drawn in their own scene on top of the world with a fresh depth
buffer (`OverlayPass` in `render/post.ts`), which is the only reliable way to keep
near-field geometry out of walls.

The player falls under the same 9.81 m/s² as every crate and slab in the city,
with quadratic air drag that tops out near 55 m/s: a 3 m drop takes 0.78 s, a
40 m one just under three seconds. A jump clears about 55 cm, as people do, and
in the air there is almost no steering — you keep the speed you left the ground
with. Only a real obstruction takes fall speed away: the character controller
used to keep a fifth of it whenever it came up a rounding error short, which
turned every fall into a parachute drop. Landing sinks the view on the knees,
the air rushes louder the faster you drop, and injury starts at roughly a 3 m
fall; from about 13 m it is fatal.

When a frame runs long, the last physics step it can afford takes up to two
ticks' worth of time rather than letting the world fall behind real time, so a
heavy moment costs a little accuracy instead of slow motion.

### Forces are per step, not for ever

Rapier's `addForce` and `addTorque` are *persistent*: whatever you apply keeps
being applied on every later timestep until it is cleared. Everything here —
buoyancy, current drag, wind, the earthquake pseudo-force, the hands carrying a
crate — recomputes its force from scratch each step, so every one of them clears
the accumulator immediately before writing to it. Without that a breeze
integrates up over a few seconds and throws a crate a kilometre into the sky,
and a carried object launches the moment you let go of it.

Three related rules keep the simulation honest under a collapse:

- The ground only shakes what it is holding up. A body already in flight gets no
  quake force, or it gains energy on every step it stays airborne.
- Anything moving fast enough to step past a thin collider in one frame is given
  continuous collision until it slows down.
- Anything that still ends up under the street has been squeezed through it, and
  is retired rather than left to free-fall for ever.

### Rendering

- Instanced pools keyed by geometry + material; the whole city draws in a few
  hundred calls.
- One unit cube renders most of the built world. Its chamfer is computed **in
  world units in the shader**, so a 6 x 0.26 x 6 slab and a 0.4 x 3 x 0.4 column
  share a geometry and both still look right.
- One procedural facade shader draws storeys, windows, mullions, sills, tiling,
  grime, shopfronts and lit rooms for every wall in the city, from a single-storey
  panel to a whole distant tower, laid out in metres from the instance's own scale.
- Shared uniforms (`render/globals.ts`) mean weather changes the entire world at
  once: wetness darkens and sharpens every surface, ash settles on every up-facing
  polygon, lightning lifts everything, and the seismic sway is a travelling wave
  through the city computed in the vertex shader — mirrored exactly on the CPU for
  the building the player is standing in, so its colliders move with what you see.
- Procedural sky with three parallaxed cloud shells feeding a PMREM environment
  map, so reflections always match the weather.
- GPU particle system (one buffer, shader-integrated motion) for dust, sparks,
  embers, smoke, splashes and ash; rain is a single instanced draw with a
  camera-following wrapping volume.
- Every prop is modelled rather than blocked out: a vending machine is a cabinet
  with a real opening, a backlit panel and rows of cans standing in front of it;
  a bicycle has a frame, spoked wheels, a basket and a kickstand; a utility pole
  carries crossarms, pin insulators and a transformer. Cars are a body, a raked
  greenhouse, arches, wheels with rims and spokes, bumpers, lights and mirrors.
- Streets are lived in (`world/clutter.ts`). Shop and house fronts collect bottle
  crates stacked in mixed colours, cartons with the big ones at the bottom,
  bicycles racked nose-in where the street is wide enough, buckets, planters and
  vending machines; rubbish bags wait in heaps at the kerbside collection points;
  interiors have boxes, crates, tools and fuel cans as well as furniture. A few
  buildings are under repair, wrapped up one face in scaffolding you can climb —
  standards, ledgers, boarded decks, guard rails, bracing, ladders and netting —
  with a coned-off yard at its foot stocked with scaffold boards and tubes, sheets
  of ply and corrugated iron, sawn posts, pallets of cinder blocks, sandbags and a
  skip. Building sites are stocked the same way. It is all real, loose and
  carryable: the raw material for a shelter. Every group is laid out as it would
  have been set down, each piece resting squarely on the one below, and the whole
  city is placed against a footprint record of every wall, doorset, step and fire
  escape at street level, so nothing starts inside anything else, no doorway is
  blocked, and nothing jumps when it wakes.
- A separate architectural pass (`world/detail.ts`) gives every building things a
  shader cannot: shopfront awnings you can stand under, sign boards, pilasters and
  thresholds, cornices and string courses, balconies you can climb onto, window
  heads, parapet coping, roof stair housings and external fire escapes that
  actually reach the roof. All of it is real — collider, mass, material, wired
  into the support graph of the wall it hangs on — so it comes down with that wall.
- Post: GTAO, bloom, heat-shimmer and lens-water distortion, filmic grade. The
  "camera artefact" layer (grain, vignette, colour fringing, water on the lens) is
  a single slider and starts low, because a permanently warped picture is not
  atmosphere.
- Reflective surfaces evaluate the sky analytically from the same uniforms the sky
  dome uses, rather than sampling the environment map. The env map is a PMREM — a
  2D texture with cube-UV packing — and sampling it as a `samplerCube` makes the
  whole draw call fail silently, which is how a river ends up looking like a hole
  in the ground.

### Interface

The interface borrows the visual language Japan already uses for disasters.
Hazards are graded in the Japan Meteorological Agency's own colours — yellow
for an advisory (注意報), red for a warning (警報), purple for an emergency
warning (特別警報) — and every bulletin carries the name it would be broadcast
under, so an earthquake arrives as a red 緊急地震速報 banner, as it does on
Japanese television. Everything else is kept quiet: IBM Plex in three cuts,
warm white on near-black, one signal red, numbers in monospace, no glows and no
gradients on type. The menu sits over the live city rather than a picture of
it, and shows the seed and the number of objects being simulated.

### Audio

Everything is synthesised at runtime — filtered noise beds for rain, wind, fire
and rumble, shaped bursts for impacts, glass, thunder and explosions. No assets.

---

## Controls

| | |
|---|---|
| `W A S D` | move |
| `Shift` | sprint |
| `Space` | jump, swim up, climb |
| `Ctrl` | crouch, dive |
| **Hold** `Mouse 1` | pick something up and keep hold of it |
| **Release** | let go — it drops where it is |
| `Wheel` back | while holding, wind up a throw |
| **Release** | with a wind-up, throws |
| `Mouse 1` | with nothing in hand: hit, dig, break |
| `Mouse 2` | swing whatever is in your hands |
| `R` + mouse | rotate held object |
| `Shift` | steady the load |
| `Wheel` forward | push the held object further away |
| `E` | grab / release, for anyone who prefers a toggle |
| `F` | keep digging |
| `V` | first / third person |
| `M` | mute · also `?mute` in the URL to start silent |
| `?seed=N` | in the URL: build the same city every time |
| `Enter` | on the menu: enter the city |
| `Esc` | pause · `H` controls reminder |

**Hitting** is a real swing of a real mass. The arm accelerates whatever is in
your hand, and how fast it can do that depends on how heavy that is: a brick
swings almost as fast as a fist, a desk barely moves. At the contact frame the
blow delivers `½mv²`, discounted by how much of the tool concentrates on the
point of impact, into the same impact system that decides whether a falling slab
breaks. A bare fist on a concrete wall does nothing at all. A steel beam on a
shop window does not.

Carrying is *held*, not toggled: the button keeps your grip closed, and letting
go of it is letting go of the object. Winding the wheel back while you hold
something draws your arm behind your shoulder, and releasing the button at that
point throws it instead of dropping it.

**Carrying** is a force problem, not a state. Under about 60 kg you can hold
something up; above that the target sinks to the floor and you are dragging it;
above about 600 kg you can only shove it by walking into it. Awkward objects
resist being aimed. Throw strength is energy-limited and scales with the
wind-up, so a brick flies and a filing cabinet barely leaves your hands. A long
thing taken by its far end — a sheet of ply, a scaffold board — is drawn into
your hands first; it only slips if it snags and starts getting further away.

## Things that work because the physics works

- Strip a scaffold yard and build a lean-to: posts, a sheet of ply or tin across
  them, sandbags or blocks on the edges to hold it down in the wind.
- Stack furniture against a door and it is genuinely hard to push through.
- Tip a vending machine over a gap and walk across it.
- Lash floating debris together in the flood and ride it.
- Shelter behind a concrete parapet from tornado debris — the parapet is real mass.
- Dig into a spoil heap to get under something, or dig yourself out from under it.
- Climb a fire escape, cross a roof, and drop into the next building through the
  hole the earthquake made.
- Break a window to get inside, then watch the fire follow you through it.
- Stay out of standing water when the lines come down.

None of those are features. They are consequences.

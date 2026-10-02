import * as THREE from 'three';

/**
 * Uniform objects shared by *every* patched material in the world. Updating one
 * of these values changes the look of the entire city in a single assignment —
 * rain wets all surfaces, ash settles on every up-facing polygon, a lightning
 * flash lifts everything at once.
 */
export const G = {
  uTime: { value: 0 },
  /** 0..1 surface wetness. Darkens albedo and sharpens reflections. */
  uWetness: { value: 0 },
  /** 0..1 volcanic ash coverage. Accumulates on up-facing surfaces. */
  uAsh: { value: 0 },
  /** Additive sky-flash from lightning, 0..~2. */
  uFlash: { value: 0 },
  uFlashColor: { value: new THREE.Color(0.75, 0.85, 1.0) },
  /** World height of the water surface used for cheap underwater tinting. */
  uWaterY: { value: -999 },
  uUnderwater: { value: 0 },
  /** Fog: colour, density, and a height falloff for the ground-hugging layer. */
  uFogColor: { value: new THREE.Color(0.42, 0.48, 0.56) },
  uFogDensity: { value: 0.0016 },
  uFogHeight: { value: 55.0 },
  uFogGround: { value: 0.22 },
  uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3) },
  uSunColor: { value: new THREE.Color(1, 0.94, 0.86) },
  uCamPos: { value: new THREE.Vector3() },
  /** Rising smoke/haze factor from fires — pushes the grade warmer and murkier. */
  uSmoke: { value: 0 },
  /** Earthquake sway: xz amplitude in metres, z = angular frequency. */
  uQuake: { value: new THREE.Vector4(0, 0, 5.6, 0) },
  /** 0..1 — how many interior lights are on. Drives the night city glow. */
  uNightLights: { value: 0 },
  /** Mains power: drops to 0 when the grid fails, killing every lit window. */
  uPower: { value: 1 },
  /** Sky gradient, so water and glass can reflect it without an env map. */
  uSkyHorizon: { value: new THREE.Color(0.52, 0.58, 0.70) },
  uSkyZenith: { value: new THREE.Color(0.115, 0.225, 0.46) },
};

/**
 * Put the world back to a clear, powered, undamaged day.
 *
 * `G` is module state shared by every material, so it outlives a Game instance.
 * Without this, dying during a blackout starts the next run in a city with no
 * mains power, ash on every up-facing surface and the ground still shaking.
 */
export function resetGlobals() {
  G.uTime.value = 0;
  G.uWetness.value = 0;
  G.uAsh.value = 0;
  G.uFlash.value = 0;
  G.uWaterY.value = -999;
  G.uUnderwater.value = 0;
  G.uFogDensity.value = 0.0016;
  G.uSmoke.value = 0;
  G.uQuake.value.set(0, 0, 5.6, 0);
  G.uNightLights.value = 0;
  G.uPower.value = 1;
}

export const SHARED_DECL = /* glsl */`
uniform float uTime;
uniform float uWetness;
uniform float uAsh;
uniform float uFlash;
uniform vec3  uFlashColor;
uniform float uWaterY;
uniform float uUnderwater;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogGround;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCamPos;
uniform float uSmoke;
uniform vec4  uQuake;
uniform float uNightLights;
uniform float uPower;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyZenith;

/**
 * The sky in a given direction, evaluated analytically. Reflective surfaces use
 * this instead of sampling the environment map: the env map is a PMREM (a 2D
 * texture with cube-UV packing), and sampling it as a samplerCube makes the
 * whole draw call fail silently.
 */
vec3 skyLook(vec3 d) {
  vec3 dn = normalize(d);
  float up = clamp(dn.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(up, 0.62));
  float sd = max(dot(dn, normalize(uSunDir)), 0.0);
  c += uSunColor * (pow(sd, 64.0) * 1.2 + pow(sd, 6.0) * 0.14);
  // Below the horizon you see the city, not the sky.
  c = mix(uFogColor * 0.62, c, smoothstep(-0.12, 0.05, dn.y));
  c += uFlashColor * uFlash * 0.5;
  return c;
}
`;

/** Distance + height fog, evaluated in world space. Replaces three's fog chunk. */
export const FOG_FRAG = /* glsl */`
{
  vec3 wp = vWorldPos;
  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  // Exponential-squared distance fog
  float f = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  // Extra ground-hugging haze that thins out with altitude
  float hFade = exp(-max(0.0, wp.y) / uFogHeight) * exp(-max(0.0, uCamPos.y) / (uFogHeight * 1.7));
  float ground = 1.0 - exp(-dist * uFogDensity * uFogGround * (0.35 + hFade));
  f = clamp(max(f, ground * 0.92), 0.0, 1.0);

  vec3 fogCol = uFogColor;
  // Sun-facing haze picks up warmth; the sky behind stays cool.
  vec3 vd = -toCam / max(dist, 1e-3);
  float sunAmt = max(0.0, dot(vd, normalize(uSunDir)));
  fogCol = mix(fogCol, fogCol * 1.15 + uSunColor * 0.30, pow(sunAmt, 4.0) * 0.8);
  fogCol = mix(fogCol, vec3(0.20, 0.17, 0.155), uSmoke * 0.6);

  if (uUnderwater > 0.5) {
    float d2 = clamp(dist / 26.0, 0.0, 1.0);
    vec3 uw = vec3(0.045, 0.14, 0.17);
    gl_FragColor.rgb = mix(gl_FragColor.rgb * mix(vec3(1.0), vec3(0.45,0.8,0.9), d2), uw, d2 * 0.94);
  } else {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, f);
  }
  gl_FragColor.rgb += uFlashColor * uFlash * (1.0 - f * 0.55);
}
`;

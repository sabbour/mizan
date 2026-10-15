import { IDENTITY, mul, read, trs, type Asset, type MaterialView, type Node, type Vec3 } from './kitAsset'
import {
  positionForStringFret, visualStatePriority,
  type FrettedInstrumentConfig, type FrettedPosition, type FrettedTabNote, type FrettedVisualState,
} from './fretboard'
import type { FrettedStyle } from './frettedStyles'
import { styleIndex } from './frettedStyles'
import { FINGER_COLORS, planFrettedHand, selectHandNotes, type FrettedHandFinger, type FrettedHandMemory, type FrettedHandPlan, type HandVector } from './frettedHand'
import {
  restingPickingHand,
  type FrettedHandAssets,
  type FrettedHandPose,
  type FrettedHandPoseContact,
  type RestingHand,
} from './frettedHandAsset'
import type { HandSolveJob, HandWorkerResponse } from './frettedHandWorker'

type Item = {
  name: string
  data: Float32Array
  indices: Uint16Array | Uint32Array
  type: number
  frame: Float32Array
  materials: MaterialView[]
  clearcoats: number[]
  string?: number
  lod: number
}
export type FrettedMarker = {
  index: number
  x: number
  y: number
  anchorX: number
  anchorY: number
  label: string
  state: 'playback' | 'upcoming' | FrettedVisualState
  position: FrettedPosition
}
export type FrettedStringLabel = {
  string: number; name: string; x: number; y: number; anchorX: number; anchorY: number
}
export type FrettedFretLabel = { fret: number; x: number; y: number }
export type FrettedVibration = { string: number; fret: number; amplitude: number; activeStartX: number }
export type FrettedStringCue = { string: number; fret: number; state: 'playback' | 'upcoming' }
export type FrettedPluck = {
  index: number; string: number; conventionalStringNumber: number; name: string; x: number; y: number
}
export type FrettedPick = {
  x: number; y: number; angle: number; size: number; string: number | null; index: number | null; active: boolean
}
export type FrettedStringGuide = {
  string: number
  name: string
  visible: string[]
  hidden: string[]
}
export type FrettedHandContact = {
  finger: FrettedHandFinger
  string: number
  fret: number
  source: 'lesson' | 'suggested'
  x: number
  y: number
  barre: boolean
  center: HandVector
  surface: HandVector
  radius: number
}
export type FrettedFingerLabel = {
  finger: FrettedHandFinger
  x: number
  y: number
  pressed: boolean
}
export type FrettedHand = {
  state: 'pressed' | 'preview' | 'relaxed'
  assetSide: 'left' | 'right'
  contacts: FrettedHandContact[]
  fingerLabels: FrettedFingerLabel[]
  /** The pressing fingers whose tips are tinted, with the colour each uses (the same as its marker). */
  tints: { finger: FrettedHandFinger; color: string }[]
  thumb: HandVector | null
  fingers: FrettedHandPose['fingers']
  mesh: {
    triangles: number
    detailTriangles: number
    surfaceGap: number
    rendered: boolean
    viewBounds: { left: number; right: number; top: number; bottom: number } | null
    contactTips: (FrettedHandPose['contactTips'][number] & { screen: [number, number] })[]
    boneLengths: FrettedHandPose['boneLengths']
  }
}
export type FrettedOpenTarget = {
  index: number; string: number; conventionalStringNumber: number; name: string; pitchName: string
  state: 'playback' | 'upcoming'; x: number; y: number
}
export type FrettedFretRegion = { fret: number; state: 'playback' | 'upcoming'; points: [number, number][] }
export type FrettedFrame = {
  /** Where the exact string and fret point is on screen (canvas pixels), for checks; fret 0 is the open-string ring. */
  projectFret: (string: number, fret: number) => [number, number] | null
  markers: FrettedMarker[]
  openTargets: FrettedOpenTarget[]
  fretRegions: FrettedFretRegion[]
  bounds: { left: number; right: number; top: number; bottom: number } | null
  stringLabels: FrettedStringLabel[]
  fretLabels: FrettedFretLabel[]
  stringCues: FrettedStringCue[]
  plucks: FrettedPluck[]
  pick: FrettedPick | null
  stringGuides: FrettedStringGuide[]
  vibrations: FrettedVibration[]
  hand: FrettedHand | null
  handUnavailable: boolean
  handPending: boolean
  /** True when a fretting-hand mesh was drawn this frame (including the last valid pose while a new one is prepared). */
  handDrawn: boolean
  /** Why the hand is or is not drawn: ready, stale (new pose still being prepared), blending, off, none, unavailable. */
  handReason: 'ready' | 'stale' | 'blending' | 'off' | 'none' | 'unavailable'
  /** True while the hand is still blending toward a new pose, so the view keeps drawing frames. */
  handBlending: boolean
  /** True when the drawn pose is the one for the current target (false while an earlier pose is still shown). */
  handCurrent: boolean
  /** The picking and fretting hands, each with a short faded wrist, are drawn. */
  handsVisible: boolean
  triangles: number
}
type Viewport = { x: number; y: number; width: number; height: number }
type HandDrawGeometry = { skin: Float32Array; skinIndices: Uint16Array }

/** How many coming onsets, at most, have their hand poses solved ahead of the playhead. */
const PREFETCH_ONSETS = 48

const vertexSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat4 uModel;
uniform float uVibration;
uniform float uFretX;
uniform float uTime;
uniform float uAmplitude;
uniform float uStringBoost;
uniform float uOutlineWidth;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
void main() {
  vec3 localPosition = aPosition + aNormal * (uStringBoost + uOutlineWidth);
  vec4 world = uModel * vec4(localPosition, 1.0);
  if (uVibration > 0.5) {
    float active = 1.0 - step(uFretX, world.x);
    float envelope = sin(3.14159265 * clamp(world.x / max(uFretX, 0.001), 0.0, 1.0));
    world.y += sin(uTime * 52.0) * uAmplitude * active * envelope;
  }
  vPosition = world.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUv = aUv;
  gl_Position = uMvp * vec4(localPosition + vec3(0.0, world.y - (uModel * vec4(localPosition, 1.0)).y, 0.0), 1.0);
}`

const fragmentSource = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec4 uBase;
uniform float uMetal;
uniform float uRough;
uniform vec3 uCameraPosition;
uniform vec3 uEmissive;
uniform float uClearcoat;
uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
uniform sampler2D uOrmMap;
uniform float uHasTexture;
uniform float uHasNormal;
uniform float uHasOrm;
uniform float uNormalScale;
uniform float uStyle;
uniform vec3 uStateColor;
uniform float uState;
uniform float uIsString;
uniform float uStringThick;
uniform float uInk;
uniform float uIsHand;
uniform float uHandAlpha;
uniform vec3 uTintA[4];
uniform vec3 uTintB[4];
uniform vec3 uTintColor[4];
uniform float uTintCount;
uniform float uStudio;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c));
}
vec3 studioReflection(vec3 direction, float rough) {
  float spread = mix(0.025, 0.32, rough);
  float strip = exp(-pow((direction.x + 0.38) / (0.18 + spread), 2.0)) *
    smoothstep(-0.3 - spread, 0.1, direction.y);
  float softbox = exp(-pow((direction.x - 0.65) / (0.22 + spread), 2.0) -
    pow((direction.y + 0.25) / (0.48 + spread), 2.0));
  vec3 room = mix(vec3(0.045, 0.035, 0.028), vec3(0.23, 0.27, 0.32),
    smoothstep(-0.55, 0.65, direction.y));
  return room + vec3(1.0, 0.93, 0.82) * strip + vec3(0.65, 0.78, 1.0) * softbox;
}
vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) /
    (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}
vec3 perturbNormal(vec3 n, vec3 p, vec2 uv, vec3 texel, float scale) {
#ifdef GL_OES_standard_derivatives
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
  // The determinant sign keeps the frame right-handed when the screen is mirrored.
  float orientation = sign(duv1.x * duv2.y - duv1.y * duv2.x);
  vec3 t = (dp2perp * duv1.x + dp1perp * duv2.x) * orientation;
  vec3 b = (dp2perp * duv1.y + dp1perp * duv2.y) * orientation;
  float invMax = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
  vec3 map = texel * 2.0 - 1.0;
  map.xy *= scale;
  map.y = -map.y;
  return normalize(mat3(t * invMax, b * invMax, n) * map);
#else
  return n;
#endif
}
float distributionGgx(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-5);
}
float visibilitySmith(float nv, float nl, float a) {
  float k = a * 0.5;
  return 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k) + 1e-4);
}
vec3 studioEnvironment(vec3 d, float rough) {
  float r = mix(0.02, 0.5, rough);
  vec3 color = mix(vec3(0.030, 0.024, 0.020), vec3(0.20, 0.17, 0.14), smoothstep(-0.7, 0.8, d.y));
  color += vec3(0.16, 0.15, 0.14) * smoothstep(0.0, 1.0, d.z) * 0.5;
  float key = dot(d, normalize(vec3(0.5, 0.66, 0.56)));
  color += vec3(1.0, 0.92, 0.80) * 5.0 * smoothstep(0.84 - r * 0.7, 0.96, key);
  float strip = dot(d, normalize(vec3(-0.78, 0.18, 0.60)));
  color += vec3(0.62, 0.74, 1.0) * 0.9 * smoothstep(0.88 - r * 0.7, 0.97, strip);
  float rim = dot(d, normalize(vec3(-0.2, 0.7, -0.68)));
  color += vec3(1.0, 0.86, 0.7) * 1.2 * smoothstep(0.7 - r * 0.5, 0.95, rim);
  return color;
}
vec3 studioLight(vec3 n, vec3 v, vec3 l, vec3 radiance, vec3 f0, vec3 diffuseColor,
  float a, float wrap, float coat, float coatA) {
  vec3 h = normalize(l + v);
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 1e-3);
  float nh = max(dot(n, h), 0.0);
  float vh = max(dot(v, h), 0.0);
  float fresnel = pow(1.0 - vh, 5.0);
  vec3 f = f0 + (1.0 - f0) * fresnel;
  vec3 spec = f * distributionGgx(nh, a) * visibilitySmith(nv, nl, a) * 3.14159265;
  float fc = (0.04 + 0.96 * fresnel) * coat;
  vec3 coatSpec = vec3(fc * distributionGgx(nh, coatA) * visibilitySmith(nv, nl, coatA) * 3.14159265);
  float diffuse = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
  return radiance * (diffuseColor * diffuse * (1.0 - fc) + (spec * (1.0 - fc) + coatSpec) * nl);
}
vec3 studioShade(vec3 n, vec3 v, vec3 base, float metal, float rough, float ao, float coat) {
  vec3 key = normalize(vec3(0.5, 0.66, 0.56));
  vec3 fill = normalize(vec3(-0.78, 0.18, 0.60));
  vec3 rim = normalize(vec3(-0.2, 0.7, -0.68));
  float a = max(rough * rough, 0.012);
  float coatA = 0.19 * 0.19;
  vec3 f0 = mix(vec3(0.04), base, metal);
  vec3 diffuseColor = base * (1.0 - metal);
  vec3 color = studioLight(n, v, key, vec3(1.0, 0.94, 0.84) * 2.3, f0, diffuseColor, a, 0.25, coat, coatA);
  color += studioLight(n, v, fill, vec3(0.80, 0.86, 1.0) * 0.32, f0, diffuseColor, a, 0.3, coat, coatA);
  color += studioLight(n, v, rim, vec3(1.0, 0.82, 0.62) * 0.7, f0, diffuseColor, a, 0.2, 0.0, coatA);
  vec3 sky = mix(vec3(0.06, 0.05, 0.045), vec3(0.34, 0.31, 0.28), n.y * 0.5 + 0.5);
  color += diffuseColor * sky * ao * 0.9;
  float nv = max(dot(n, v), 1e-3);
  vec3 reflected = studioEnvironment(reflect(-v, n), rough);
  vec3 envF = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  color += reflected * envF * ao * (1.0 - coat * 0.04);
  color += studioEnvironment(reflect(-v, n), 0.2) * (0.04 + 0.96 * pow(1.0 - nv, 5.0)) * coat * ao;
  return color;
}
vec3 skinShade(vec3 n, vec3 v, vec3 base) {
  vec3 key = normalize(vec3(0.5, 0.66, 0.56));
  vec3 fill = normalize(vec3(-0.78, 0.18, 0.60));
  float wrapKey = clamp((dot(n, key) + 0.55) / 1.55, 0.0, 1.0);
  float wrapFill = clamp((dot(n, fill) + 0.55) / 1.55, 0.0, 1.0);
  vec3 scatter = vec3(0.95, 0.30, 0.16) * pow(1.0 - clamp(dot(n, key) * 0.5 + 0.5, 0.0, 1.0), 2.0) * 0.20;
  vec3 color = base * (vec3(1.0, 0.93, 0.84) * 1.3 * wrapKey + vec3(0.8, 0.86, 1.0) * 0.28 * wrapFill +
    mix(vec3(0.05, 0.04, 0.035), vec3(0.20, 0.17, 0.15), n.y * 0.5 + 0.5));
  color += base * scatter * 2.0;
  float nv = max(dot(n, v), 0.0);
  vec3 h = normalize(key + v);
  float nh = max(dot(n, h), 0.0);
  color += vec3(0.04) * pow(nh, 18.0) * max(dot(n, key), 0.0);
  color += vec3(0.30, 0.22, 0.18) * pow(1.0 - nv, 3.0) * 0.16;
  return color;
}
vec3 fingerTint(vec3 color) {
  if (uIsHand < 0.5) return color;
  float shade = max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.18);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uTintCount) break;
    vec3 ab = uTintB[i] - uTintA[i];
    float t = clamp(dot(vPosition - uTintA[i], ab) / dot(ab, ab), 0.0, 1.0);
    float d = length(vPosition - (uTintA[i] + ab * t));
    float k = 1.0 - smoothstep(0.011, 0.019, d);
    color = mix(color, uTintColor[i] * min(shade * 2.4, 1.0), k * 0.82);
  }
  return color;
}
void main() {
  if (uInk > 0.5) {
    // The forearm's last centimetres sit inside the hand's wrist; skipping their outline leaves no seam ring.
    if (uIsHand > 0.5 && vUv.x > 1.5 && vUv.y > 0.93) discard;
    vec3 ink = uIsHand > 0.5 && uStyle < 2.5
      ? uStyle > 0.5 ? vec3(0.32, 0.22, 0.17) : vec3(0.28, 0.16, 0.12)
      : vec3(0.08, 0.15, 0.27);
    gl_FragColor = vec4(ink, 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 base = uBase.rgb * (uHasTexture > 0.5 ? srgbToLinear(texture2D(uTexture, vUv).rgb) : vec3(1.0));
  if (uStudio > 0.5) {
    vec3 v = normalize(uCameraPosition - vPosition);
    vec3 shaded;
    if (uIsHand > 0.5) {
      shaded = fingerTint(skinShade(n, v, base));
    } else if (uIsString > 0.5) {
      vec3 steel = mix(vec3(0.62, 0.63, 0.64), vec3(0.55, 0.52, 0.48), smoothstep(0.25, 0.55, uStringThick));
      shaded = studioShade(n, v, steel, 1.0, mix(0.26, 0.38, uStringThick), 1.0, 0.0);
      shaded = mix(shaded, vec3(dot(shaded, vec3(0.2126, 0.7152, 0.0722))), 0.7);
      shaded = mix(shaded, uStateColor, clamp(uState, 0.0, 0.6));
      gl_FragColor = vec4(linearToSrgb(toneMap(max(shaded, vec3(0.0)))), 1.0);
      return;
    } else {
      float rough = clamp(uRough, 0.05, 1.0);
      float metal = uMetal;
      float ao = 1.0;
      if (uHasOrm > 0.5) {
        vec3 orm = texture2D(uOrmMap, vUv).rgb;
        ao = mix(1.0, orm.r, 0.75);
        rough = clamp(rough * (0.55 + orm.g), 0.05, 1.0);
        metal = metal * orm.b;
      }
      if (uHasNormal > 0.5) n = perturbNormal(n, vPosition, vUv, texture2D(uNormalMap, vUv).rgb, uNormalScale);
      shaded = studioShade(n, v, base, metal, rough, ao, uClearcoat);
      shaded += uEmissive;
      shaded = mix(shaded, uStateColor, clamp(uState, 0.0, 0.82));
    }
    float forearmFade = (uIsHand > 0.5 || uStringThick < -0.5) && vUv.x > 1.5 ? 1.0 - smoothstep(0.2, 1.0, vUv.x - 2.0) : 1.0;
    float studioAlpha = (uIsHand > 0.5 ? uHandAlpha : uBase.a) * forearmFade;
    gl_FragColor = vec4(linearToSrgb(toneMap(max(shaded, vec3(0.0)))), studioAlpha);
    return;
  }
  vec3 key = normalize(vec3(-0.38, 0.62, 0.78));
  vec3 fill = normalize(vec3(0.72, -0.32, 0.62));
  vec3 view = normalize(uCameraPosition - vPosition);
  float keyDiffuse = max(dot(n, key), 0.0);
  float fillDiffuse = max(dot(n, fill), 0.0);
  float rough = clamp(uRough, 0.08, 1.0);
  float exponent = mix(128.0, 5.0, rough);
  float keySpec = pow(max(dot(n, normalize(key + view)), 0.0), exponent) * keyDiffuse;
  float fillSpec = pow(max(dot(n, normalize(fill + view)), 0.0), exponent) * fillDiffuse;
  vec3 f0 = mix(vec3(0.04), base, uMetal);
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, view), 0.0), 5.0);
  vec3 specular = f0 * (keySpec * 2.0 + fillSpec * 1.25);
  specular += vec3(0.04) * pow(max(dot(n, normalize(key + view)), 0.0), 32.0) * uClearcoat * 3.0;
  vec3 diffuse = base * (1.0 - uMetal) *
    (vec3(0.15, 0.13, 0.11) + vec3(0.82, 0.78, 0.72) * keyDiffuse +
      vec3(0.22, 0.25, 0.30) * fillDiffuse);
  vec3 reflected = studioReflection(reflect(-view, n), rough);
  vec3 environment = base * (1.0 - uMetal) * 0.08 +
    reflected * fresnel * (1.0 - rough * 0.45);
  environment += studioReflection(reflect(-view, n), 0.12) * 0.04 * uClearcoat;
  vec3 color = diffuse + environment + specular;
  if (uIsString > 0.5) {
    float glint = pow(1.0 - abs(dot(n, view)), 5.0);
    vec3 silver = uStyle > 2.5
      ? vec3(0.30, 0.39, 0.51) : vec3(0.33, 0.37, 0.41);
    color = silver + vec3(0.72, 0.79, 0.88) * glint * 0.32;
    color = mix(color, uStateColor, clamp(uState, 0.0, 0.56));
    gl_FragColor = vec4(linearToSrgb(toneMap(max(color, vec3(0.0)))), 1.0);
    return;
  }
  if (uStyle > 0.5 && uStyle < 1.5) {
    float band = floor((0.35 + 0.65 * (keyDiffuse * 0.75 + fillDiffuse * 0.25)) * 4.0) / 4.0;
    color = base * mix(0.58, 1.12, band) * vec3(1.04, 0.97, 0.88);
  } else if (uStyle > 2.5 && uStyle < 3.5) {
    float materialValue = dot(base, vec3(0.2126, 0.7152, 0.0722));
    vec3 paperFill = mix(vec3(0.52, 0.62, 0.73), vec3(0.82, 0.87, 0.92),
      smoothstep(0.04, 0.88, materialValue));
    float facing = abs(dot(n, view));
    float crease = length(fwidth(n));
    float edgeLine = smoothstep(0.12, 0.48, crease);
    color = paperFill * (0.92 + 0.08 * abs(dot(n, key)));
    color = mix(color, vec3(0.12, 0.22, 0.37), edgeLine * 0.76);
    color = mix(color, vec3(0.20, 0.34, 0.49), pow(1.0 - facing, 2.0) * 0.13);
  }
  color += uEmissive;
  color = fingerTint(color);
  color = mix(color, uStateColor, clamp(uState, 0.0, 0.82));
  float alpha = uIsHand > 0.5 ? uHandAlpha * (vUv.x > 1.5 ? 1.0 - smoothstep(0.2, 1.0, vUv.x - 2.0) : 1.0) :
    uStyle > 2.5 && uStyle < 3.5 ? 0.92 : uBase.a;
  gl_FragColor = vec4(linearToSrgb(toneMap(max(color, vec3(0.0)))), alpha);
}`

const backgroundVertexSource = `
attribute vec2 aCorner;
varying vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`

const backgroundFragmentSource = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uCenter;
uniform vec3 uEdge;
uniform vec2 uGlow;
void main() {
  vec2 p = (vUv - uGlow) * vec2(1.25, 1.0);
  vec3 color = mix(uCenter, uEdge, smoothstep(0.02, 0.9, length(p)));
  float vignette = smoothstep(0.5, 1.15, length((vUv - 0.5) * vec2(1.5, 1.0) * 1.15));
  color *= 1.0 - 0.42 * vignette;
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(color + (noise - 0.5) / 255.0, 1.0);
}`

const STUDIO_OVERRIDES: Record<string, { base?: [number, number, number, number]; rough?: number }> = {
  MAT_Pickguard_Cream: { base: [0.52, 0.50, 0.44, 1], rough: 0.55 },
  MAT_Pickup_Cream: { base: [0.56, 0.52, 0.43, 1], rough: 0.5 },
  MAT_Pickup_Bobbin: { base: [0.07, 0.06, 0.05, 1] },
  MAT_ControlPlastic_Cream: { base: [0.80, 0.76, 0.66, 1], rough: 0.4 },
  MAT_FretMetal: { base: [0.80, 0.80, 0.78, 1], rough: 0.3 },
}

// The seated pose is only implied: it is not drawn, and no body or arm geometry exists.

const STYLE_TONES: Record<FrettedStyle, [number, number, number]> = {
  Realistic: [0.16, 0.48, 0.95],
  ClayStudyModel: [0.15, 0.54, 0.91],
  TechnicalBlueprint: [0.05, 0.32, 0.72],
}

export const frettedStringDisplayThicknessPx = (gaugeInches: number, minGaugeInches: number, maxGaugeInches: number) => {
  const range = Math.max(0.001, maxGaugeInches - minGaugeInches)
  return 2.8 + Math.min(1, Math.max(0, (gaugeInches - minGaugeInches) / range)) * 1.7
}

const FEEDBACK_COLOR: Record<FrettedVisualState, [number, number, number]> = {
  'incorrectly-played': [1, 0.15, 0.12],
  'correctly-played': [0.13, 0.82, 0.35],
  'current-played': [0.18, 0.75, 1],
  'current-target': [1, 0.75, 0.12],
  upcoming: [1, 0.8, 0.18],
  held: [0.3, 0.83, 0.96],
  muted: [0.52, 0.55, 0.6],
  open: [0.62, 0.84, 0.97],
  scale: [0.2, 0.68, 0.38],
  chord: [0.6, 0.4, 0.9],
  root: [1, 0.55, 0.13],
  'suggested-finger': [0.5, 0.7, 1],
  selected: [0.18, 0.6, 1],
}

const normalise = (v: number[]) => { const length = Math.hypot(...v); return v.map((x) => x / length) }

const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}
// Camera basis for an eye placed along `direction` from the target; `up` only fixes the roll.
const cameraBasis = (direction: number[], up: number[]) => {
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = normalise(direction)
  const x = normalise(cross(up, z))
  const y = cross(z, x)
  return { x, y, z }
}
const viewFromBasis = (basis: { x: number[]; y: number[]; z: number[] }, eye: number[]) => {
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const { x, y, z } = basis
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}
const perspective = (tanHalfX: number, tanHalfY: number, near: number, far: number) =>
  new Float32Array([1 / tanHalfX, 0, 0, 0, 0, 1 / tanHalfY, 0, 0,
    0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0])
const clamped = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

export class FrettedRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffers: { vertex: WebGLBuffer; index: WebGLBuffer }[] = []
  private readonly textures: WebGLTexture[] = []
  private readonly locations: Record<string, WebGLUniformLocation | null> = {}
  private items: Item[] = []
  private readonly config: FrettedInstrumentConfig
  private handAssets: FrettedHandAssets | null
  private viewProjection = IDENTITY
  private cameraPosition: [number, number, number] = [0, 0, 2.15]
  private readonly stringCenterlines = new Map<number, { center: HandVector; slopeY: number; slopeZ: number }>()
  private teachingFrame = { startFret: 1, endFret: 5, startX: 0, endX: 0 }
  private stringGuideKey = ''
  private cachedStringGuides: FrettedStringGuide[] = []
  private handBuffers: Partial<Record<string, { vertex: WebGLBuffer; index: WebGLBuffer }>> | null = null
  private uploadedSlots: Partial<Record<string, HandDrawGeometry>> = {}
  private pickingRest = new Map<'left' | 'right', RestingHand>()
  private shownHand: {
    pose: FrettedHandPose; state: FrettedHand['state']; key: string; from: Float32Array | null; start: number
    vertices: Float32Array; geometry: HandDrawGeometry; fresh: boolean
  } | null = null
  private handWorker: Worker | null = null
  private readonly handPoses = new Map<string, FrettedHandPose>()

  private readonly pendingHandPoses = new Map<string, boolean>()
  private instrumentBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  private neckProfile = { nutX: 0, heelX: 0, nutWidth: 0, heelWidth: 0, depth: 0 }
  private silhouette: HandVector[] = []
  private mirrored = false
  private studio = false
  private perspectiveW = 1
  private mirrorFitCache: { key: string; eye: HandVector; distance: number; matrix: Float32Array } | null = null
  private guides = true
  private pickingX = 0.1
  private handsOn = true
  private prefetchPlan: readonly FrettedTabNote[] | null = null
  private readonly prefetchTargets = new Map<number, ReturnType<FrettedRenderer['poseTargetAt']>>()
  private prefetchStarts: number[] = []
  private currentPoseKey: string | null = null
  private prefetchWindow = ''
  setGuides(visible: boolean) { this.guides = visible }
  setHands(visible: boolean) { this.handsOn = visible }
  private background: {
    program: WebGLProgram; buffer: WebGLBuffer; uniforms: Record<string, WebGLUniformLocation | null>
  } | null = null

  constructor(
    gl: WebGLRenderingContext,
    asset: Asset,
    config: FrettedInstrumentConfig,
    images: (ImageBitmap | null)[],
    handAssets: FrettedHandAssets | null = null,
    onHandUpdate?: (error?: Error) => void,
  ) {
    this.gl = gl
    this.config = config
    this.handAssets = handAssets
    const fragment = gl.getExtension('OES_standard_derivatives')
      ? fragmentSource
      : fragmentSource.replace('#extension GL_OES_standard_derivatives : enable', '')
        .replace('length(fwidth(n))', '0.0')
    this.program = this.makeProgram(vertexSource, fragment)
    for (const name of ['uMvp', 'uModel', 'uVibration', 'uFretX', 'uTime', 'uAmplitude', 'uBase', 'uMetal',
      'uCameraPosition',
      'uRough', 'uEmissive', 'uClearcoat', 'uTexture', 'uHasTexture', 'uStyle', 'uStateColor', 'uState',
      'uStringBoost', 'uOutlineWidth', 'uIsString', 'uInk', 'uIsHand', 'uHandAlpha', 'uNormalMap', 'uOrmMap',
      'uHasNormal', 'uHasOrm', 'uNormalScale', 'uStringThick', 'uStudio', 'uTintCount', 'uTintA[0]', 'uTintB[0]',
      'uTintColor[0]'])
      this.locations[name] = gl.getUniformLocation(this.program, name)
    gl.useProgram(this.program)
    gl.uniform1i(this.locations.uTexture, 0)
    gl.uniform1i(this.locations.uNormalMap, 1)
    gl.uniform1i(this.locations.uOrmMap, 2)
    this.textures = this.loadTextures(asset, images)
    const variantNames = asset.json.extensions?.KHR_materials_variants?.variants.map((variant) => variant.name) ?? []
    const root = asset.json.scenes[asset.json.scene ?? 0].nodes[0]
    this.visit(asset, root, IDENTITY, variantNames)
    for (let index = 0; index < asset.json.nodes.length; index++)
      if (asset.json.nodes[index].extras?.lodLevel === 1 || asset.json.nodes[index].extras?.lodLevel === 2)
        this.visit(asset, index, IDENTITY, variantNames)
    this.findStringCenterlines()
    this.findPickingZone(asset)
    this.findNeckProfile()
    this.findInstrumentBounds()
    this.buildSilhouette()
    this.buildBackground()
    if (handAssets) this.attachHands(handAssets, onHandUpdate)
    this.onHandUpdate = onHandUpdate
  }

  // Fingertip segments (world metres) and linear colours of the fingers pressing now, drawn as a tint on the skin.
  private handTints: { from: number[]; to: number[]; color: number[] }[] = []
  private onHandUpdate: ((error?: Error) => void) | undefined

  /** Start the pose worker once the hand models are available; hands are loaded only when they are switched on. */
  attachHands(handAssets: FrettedHandAssets, onHandUpdate: ((error?: Error) => void) | undefined = this.onHandUpdate) {
    if (this.handWorker) return
    this.handAssets = handAssets
    this.onHandUpdate = onHandUpdate
    {
      const worker = new Worker(new URL('./frettedHandWorker.ts', import.meta.url), { type: 'module' })
      this.handWorker = worker
      worker.onmessage = (event: MessageEvent<HandWorkerResponse>) => {
        const result = event.data
        const needed = this.pendingHandPoses.get(result.key) === false || result.key === this.currentPoseKey
        this.pendingHandPoses.delete(result.key)
        if (result.kind === 'discarded') return

        if (result.kind === 'error') {
          console.error('The fretting hand could not be prepared.', result.message)
          this.onHandUpdate?.(new Error(result.message))
          return
        }
        // A pose that is already cached stays, so the picture does not blend again.
        if (this.handPoses.has(result.key)) return
        this.handPoses.set(result.key, result.pose)
        if (this.handPoses.size > 256) this.handPoses.delete(this.handPoses.keys().next().value!)
        // Poses solved ahead of time wait in the cache; only the one on screen asks for a new frame.
        if (needed) this.onHandUpdate?.()
      }
      worker.onerror = (event) => {
        console.error('The fretting-hand worker failed.', event.message)
        this.onHandUpdate?.(new Error(event.message))
      }
      worker.postMessage({ kind: 'init', assets: handAssets })
    }
    this.onHandUpdate?.()
  }

  // The strumming zone lies between the end of the fretboard and the middle pickup (guitar) or between the
  // neck and bridge pickups (bass): the midpoint of the neck pickup and the next pickup toward the bridge.
  private findPickingZone(asset: Asset) {
    const nodes = asset.json.nodes as { name?: string; translation?: number[] }[]
    const at = (name: string) => nodes.find((node) => node.name === name)?.translation?.[0]
    const neck = at('COL_Pickup_Neck') ?? 0.14
    const next = at('COL_Pickup_Middle') ?? at('COL_Pickup_Bridge') ?? 0.05
    this.pickingX = (neck + next) / 2
  }

  private findInstrumentBounds() {
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    for (const item of this.items.filter((part) => part.lod === 0))
      for (let index = 0; index < item.data.length; index += 8) {
        const [x, y, z] = [item.data[index], item.data[index + 1], item.data[index + 2]]
        const worldX = item.frame[0] * x + item.frame[4] * y + item.frame[8] * z + item.frame[12]
        const worldY = item.frame[1] * x + item.frame[5] * y + item.frame[9] * z + item.frame[13]
        bounds.minX = Math.min(bounds.minX, worldX); bounds.maxX = Math.max(bounds.maxX, worldX)
        bounds.minY = Math.min(bounds.minY, worldY); bounds.maxY = Math.max(bounds.maxY, worldY)
      }
    if (Number.isFinite(bounds.minX + bounds.maxX + bounds.minY + bounds.maxY)) this.instrumentBounds = bounds
  }

  private buildSilhouette() {
    const items = this.items.filter((part) => part.lod === 0)
    const total = items.reduce((sum, item) => sum + item.data.length / 8, 0)
    const step = Math.max(1, Math.ceil(total / 6000))
    const points: HandVector[] = []
    for (const item of items) {
      const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity]
      for (let index = 0; index < item.data.length; index += 8) {
        for (let axis = 0; axis < 3; axis++) {
          low[axis] = Math.min(low[axis], item.data[index + axis])
          high[axis] = Math.max(high[axis], item.data[index + axis])
        }
        if ((index / 8) % step === 0) points.push(this.worldVertex(item, index))
      }
      if (!Number.isFinite(low[0] + high[0] + low[1] + high[1] + low[2] + high[2])) continue
      for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
        const frame = item.frame
        points.push([
          frame[0] * x + frame[4] * y + frame[8] * z + frame[12],
          frame[1] * x + frame[5] * y + frame[9] * z + frame[13],
          frame[2] * x + frame[6] * y + frame[10] * z + frame[14],
        ])
      }
    }
    this.silhouette = points
  }

  private buildBackground() {
    const gl = this.gl
    const program = this.makeProgram(backgroundVertexSource, backgroundFragmentSource)
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('WebGL could not allocate the studio backdrop.')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    for (const name of ['uCenter', 'uEdge', 'uGlow']) uniforms[name] = gl.getUniformLocation(program, name)
    this.background = { program, buffer, uniforms }
  }

  private drawBackground(style: FrettedStyle) {
    const gl = this.gl
    const background = this.background
    if (!background) return
    const palette: Record<FrettedStyle, [number[], number[]]> = {
      Realistic: [[0.40, 0.32, 0.25], [0.11, 0.085, 0.07]],
      ClayStudyModel: [[0.90, 0.86, 0.79], [0.62, 0.57, 0.50]],
      TechnicalBlueprint: [[0.95, 0.97, 0.99], [0.79, 0.85, 0.91]],
    }
    gl.useProgram(background.program)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    for (let index = 0; index < 8; index++) gl.disableVertexAttribArray(index)
    const location = gl.getAttribLocation(background.program, 'aCorner')
    gl.bindBuffer(gl.ARRAY_BUFFER, background.buffer)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    gl.uniform3fv(background.uniforms.uCenter, palette[style][0])
    gl.uniform3fv(background.uniforms.uEdge, palette[style][1])
    gl.uniform2f(background.uniforms.uGlow, 0.42, 0.55)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disableVertexAttribArray(location)
    gl.useProgram(this.program)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }

  // Long-lens (about 85 mm full-frame) view of the guitar's front face, rolled so the neck
  // rises toward the headstock; the camera distance is solved so the whole guitar fits.
  private fitMirrorCamera(width: number, height: number, handedness: 'right' | 'left') {
    const key = `${width}x${height}:${handedness}`
    if (this.mirrorFitCache?.key === key) return this.mirrorFitCache
    const box = this.instrumentBounds
    const target: HandVector = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, 0.02]
    // Wide, short stages lay the neck flatter so the guitar can fill more of the width; the rise stays visible.
    const aspectRatio = width / Math.max(1, height)
    const roll = (aspectRatio > 2.6 ? 15 - Math.min(10, (aspectRatio - 2.6) * 4) : 15) * Math.PI / 180
    const direction = [-0.04, 0.13, 1]
    const basis = cameraBasis(direction, [Math.sin(roll), Math.cos(roll), 0])
    const tanX = 18 / 100
    const tanY = tanX * Math.max(1, height) / Math.max(1, width)
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const extents = (distance: number) => {
      const eye = [0, 1, 2].map((axis) => target[axis] + basis.z[axis] * distance)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      // The picking forearm reaches past the body edge on the hand side; keep it inside the frame.
      const reach: HandVector[] = [[0.17, 0.12, -0.2]]
      for (const point of [...this.silhouette, ...reach]) {
        const offset = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]
        const depth = -dot(basis.z, offset)
        const x = dot(basis.x, offset) / depth / tanX
        const y = dot(basis.y, offset) / depth / tanY
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
      return { eye, minX, maxX, minY, maxY }
    }
    const fitsInside = (distance: number) => {
      const e = extents(distance)
      return e.maxX - e.minX <= 2 * 0.97 && e.maxY - e.minY <= 2 * 0.95
    }
    let near = 0.6, far = 30
    for (let iteration = 0; iteration < 36; iteration++) {
      const middle = (near + far) / 2
      if (fitsInside(middle)) far = middle
      else near = middle
    }
    const distance = far
    const final = extents(distance)
    const eye: HandVector = [final.eye[0], final.eye[1], final.eye[2]]
    const clipNear = Math.max(0.1, distance - 1.2), clipFar = distance + 1.2
    const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
      -(final.minX + final.maxX) / 2, -(final.minY + final.maxY) / 2, 0, 1])
    const matrix = multiply(shift, multiply(perspective(tanX, tanY, clipNear, clipFar),
      viewFromBasis(basis, eye)))
    this.mirrorFitCache = { key, eye, distance, matrix }
    return this.mirrorFitCache
  }

  // Places the pinched hand so the pick points along `forward` and the pick tip lands on `tip`.
  // The hand orientation follows from the pick orientation: the thumb pad and index side squeeze
  // the pick along `squeeze`.
  private placePickingHand(rest: RestingHand, forward: number[], squeeze: number[], tip: HandVector) {
    const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const localThird = cross(rest.forward, rest.squeeze)
    const worldThird = cross(forward, squeeze)
    const turn = (v: readonly number[]): HandVector => {
      const a = dot(v, rest.forward), b = dot(v, rest.squeeze), c = dot(v, localThird)
      return [forward[0] * a + squeeze[0] * b + worldThird[0] * c,
        forward[1] * a + squeeze[1] * b + worldThird[1] * c,
        forward[2] * a + squeeze[2] * b + worldThird[2] * c]
    }
    const pickReach = 0.016
    const tipLocal = [rest.anchor[0] + rest.forward[0] * pickReach, rest.anchor[1] + rest.forward[1] * pickReach,
      rest.anchor[2] + rest.forward[2] * pickReach]
    const handScale = 0.85
    const tipTurned = turn(tipLocal).map((value) => value * handScale)
    const offset = [tip[0] - tipTurned[0], tip[1] - tipTurned[1], tip[2] - tipTurned[2]]
    const place = (v: readonly number[]): HandVector => {
      const p = turn(v)
      return [p[0] * handScale + offset[0], p[1] * handScale + offset[1], p[2] * handScale + offset[2]]
    }
    const skin = new Float32Array(rest.vertices.length)
    for (let index = 0; index < rest.vertices.length; index += 8) {
      const position = place([rest.vertices[index], rest.vertices[index + 1], rest.vertices[index + 2]])
      const normal = turn([rest.vertices[index + 3], rest.vertices[index + 4], rest.vertices[index + 5]])
      skin.set([...position, ...normal, rest.vertices[index + 6], rest.vertices[index + 7]], index)
    }
    // The pick: a thin rounded triangle between thumb and index, its point just beyond the fingers.
    const side = cross(rest.squeeze, rest.forward)
    const outline: [number, number][] = [[0, 0.016], [0.0075, 0.011], [0.0135, 0.001], [0.012, -0.008],
      [0.006, -0.0115], [-0.006, -0.0115], [-0.012, -0.008], [-0.0135, 0.001], [-0.0075, 0.011]]
    const half = 0.0006
    const vertices: number[] = []
    const indices: number[] = []
    const local = (u: number, f: number, s: number) => [
      rest.anchor[0] + side[0] * u + rest.forward[0] * f + rest.squeeze[0] * s,
      rest.anchor[1] + side[1] * u + rest.forward[1] * f + rest.squeeze[1] * s,
      rest.anchor[2] + side[2] * u + rest.forward[2] * f + rest.squeeze[2] * s]
    const push = (point: number[], normal: number[]) => {
      vertices.push(...place(point), ...turn(normal), 0, 0)
      return vertices.length / 8 - 1
    }
    const topCenter = push(local(0, 0, half), rest.squeeze)
    const bottomCenter = push(local(0, 0, -half), rest.squeeze.map((value) => -value))
    const top = outline.map(([u, f]) => push(local(u, f, half), rest.squeeze))
    const bottom = outline.map(([u, f]) => push(local(u, f, -half), rest.squeeze.map((value) => -value)))
    const edgeTop: number[] = [], edgeBottom: number[] = []
    for (const [u, f] of outline) {
      const outward = normalise([side[0] * u + rest.forward[0] * (f - 0.0015), side[1] * u + rest.forward[1] * (f - 0.0015),
        side[2] * u + rest.forward[2] * (f - 0.0015)])
      edgeTop.push(push(local(u, f, half), outward))
      edgeBottom.push(push(local(u, f, -half), outward))
    }
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length
      indices.push(topCenter, top[i], top[j], bottomCenter, bottom[j], bottom[i])
      indices.push(edgeTop[i], edgeBottom[i], edgeBottom[j], edgeTop[i], edgeBottom[j], edgeTop[j])
    }
    const center = place(local(0, 0, 0))
    const lateral = place(local(0.0135, 0, 0)), lateralOther = place(local(-0.0135, 0, 0))
    return {
      hand: { skin, skinIndices: rest.indices } as HandDrawGeometry,
      pick: { skin: Float32Array.from(vertices), skinIndices: Uint16Array.from(indices) } as HandDrawGeometry,
      center, tip: place(tipLocal), lateral, lateralOther,
      wrist: place(rest.wrist), anchor: place(rest.anchor), knuckles: place(rest.knuckles), across: turn(rest.across),
    }
  }

  // A smooth rounded tube through the given points. `radius` and `fade` take the 0..1 position along it;
  // fade >= 0 marks the soft transparent end (uv.x = 2 + fade is read by the shader).
  private tubeGeometry(points: readonly HandVector[], radius: (t: number) => number,
    fade: (t: number) => number, squash: number | ((t: number) => number) = 1, sampleCount = 30,
    across: readonly number[] = [0, 0, 1], markEnd = false): HandDrawGeometry {
    const samples = sampleCount, sides = 14
    const path: HandVector[] = []
    const padded = [points[0], ...points, points[points.length - 1]]
    for (let sample = 0; sample <= samples; sample++) {
      const position = sample / samples * (points.length - 1)
      const index = Math.min(points.length - 2, Math.floor(position))
      const u = position - index
      const [p0, p1, p2, p3] = [padded[index], padded[index + 1], padded[index + 2], padded[index + 3]]
      path.push([0, 1, 2].map((axis) => 0.5 * (2 * p1[axis] + (-p0[axis] + p2[axis]) * u +
        (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * u * u +
        (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * u ** 3)) as HandVector)
    }
    const vertices: number[] = []
    const indices: number[] = []
    let previousSide = [...across]
    path.forEach((point, ring) => {
      const next = path[Math.min(path.length - 1, ring + 1)], before = path[Math.max(0, ring - 1)]
      const tangent = normalise([next[0] - before[0], next[1] - before[1], next[2] - before[2]])
      let sideAxis = previousSide.map((value, axis) => value - tangent[axis] * (previousSide[0] * tangent[0] +
        previousSide[1] * tangent[1] + previousSide[2] * tangent[2]))
      if (Math.hypot(...sideAxis) < 1e-4) sideAxis = [1, 0, 0]
      sideAxis = normalise(sideAxis)
      previousSide = sideAxis
      const upAxis = [tangent[1] * sideAxis[2] - tangent[2] * sideAxis[1], tangent[2] * sideAxis[0] - tangent[0] * sideAxis[2],
        tangent[0] * sideAxis[1] - tangent[1] * sideAxis[0]]
      const t = ring / samples
      for (let step = 0; step < sides; step++) {
        const angle = step / sides * Math.PI * 2
        const radial = [Math.cos(angle) * sideAxis[0] + Math.sin(angle) * upAxis[0],
          Math.cos(angle) * sideAxis[1] + Math.sin(angle) * upAxis[1], Math.cos(angle) * sideAxis[2] + Math.sin(angle) * upAxis[2]]
        const r = radius(t)
        const flatten = 1 + ((typeof squash === 'function' ? squash(t) : squash) - 1) * Math.abs(Math.sin(angle))
        vertices.push(point[0] + radial[0] * r * flatten, point[1] + radial[1] * r * flatten,
          point[2] + radial[2] * r * flatten, radial[0], radial[1], radial[2], 2 + Math.min(1, Math.max(0, fade(t))), markEnd ? t : 0)
      }
    })
    for (let ring = 0; ring < samples; ring++) for (let step = 0; step < sides; step++) {
      const a = ring * sides + step, b = ring * sides + (step + 1) % sides
      indices.push(a, b, a + sides, b, b + sides, a + sides)
    }
    return { skin: Float32Array.from(vertices), skinIndices: Uint16Array.from(indices) }
  }

  // A short wrist for a hand: the same skin and wrist section as the hand mesh, reaching 5 cm past the wrist joint
  // and fading out, so the hand ends softly instead of at a cut or an arm.
  private wristGeometry(wrist: HandVector, direction: readonly number[], across: readonly number[]) {
    const unit = normalise([...direction])
    const at = (distance: number): HandVector => [wrist[0] + unit[0] * distance, wrist[1] + unit[1] * distance,
      wrist[2] + unit[2] * distance]
    return this.tubeGeometry([at(0.05), at(0.015), at(-0.015)], (t) => 0.026 - 0.003 * (1 - t),
      (t) => 1 - t, (t) => 1 - 0.36 * t * t, 12, across, true)
  }
  private silhouetteBounds(width: number, height: number) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (const point of this.silhouette) {
      const [x, y] = this.projected(point, width, height)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
    }
    return Number.isFinite(left + right + top + bottom) ? { left, right, top, bottom } : null
  }

  private findNeckProfile() {
    const points: HandVector[] = []
    for (const item of this.items.filter((part) => part.name === 'Neck_Mesh' || part.name === 'Fretboard'))
      for (let index = 0; index < item.data.length; index += 8) {
        const [x, y, z] = [item.data[index], item.data[index + 1], item.data[index + 2]]
        points.push([
          item.frame[0] * x + item.frame[4] * y + item.frame[8] * z + item.frame[12],
          item.frame[1] * x + item.frame[5] * y + item.frame[9] * z + item.frame[13],
          item.frame[2] * x + item.frame[6] * y + item.frame[10] * z + item.frame[14],
        ])
      }
    if (!points.length) throw new Error('The instrument model has no neck surface for the hand guide.')
    const nutX = Math.max(...points.map((point) => point[0]))
    const heelX = Math.min(...points.map((point) => point[0]))
    const widthAt = (x: number) => Math.max(...points.filter((point) => Math.abs(point[0] - x) < 0.005)
      .map((point) => Math.abs(point[1])))
    this.neckProfile = { nutX, heelX, nutWidth: widthAt(nutX), heelWidth: widthAt(heelX),
      depth: Math.max(...points.map((point) => point[2])) - Math.min(...points.map((point) => point[2])) }
  }

  private requestHandPose(key: string, side: 'left' | 'right',
    contacts: FrettedHandPoseContact[], state: 'pressed' | 'preview' | 'relaxed', ahead = false) {
    if (!this.handWorker || this.handPoses.has(key)) return
    const queuedAhead = this.pendingHandPoses.get(key)
    // A pose that is already queued as "ahead" is promoted when it is needed now.
    if (queuedAhead !== undefined && (ahead || !queuedAhead)) return
    const x = mean(contacts.map((contact) => contact.center[0]))
    const profile = this.neckProfile
    const t = clamped((profile.nutX - x) / (profile.nutX - profile.heelX), 0, 1)
    const request: HandSolveJob = { kind: 'solve', key, side, contacts, state, ahead,
      neck: { halfWidth: profile.nutWidth + (profile.heelWidth - profile.nutWidth) * t, depth: profile.depth } }
    this.pendingHandPoses.set(key, ahead)
    this.handWorker.postMessage(request)
  }

  // Solves the hand for the coming onsets in time order (the loop wraps around), so each pose is ready, and cached
  // by its key, long before its notes arrive. Onsets that share a grip share one pose, so a repeating pattern costs
  // only a few solves. The worker's queue is replaced whenever the playhead passes an onset or the plan changes.
  private prefetchPoses(plan: readonly FrettedTabNote[], beat: number,
    loop: { start: number; end: number } | null, memory?: FrettedHandMemory) {
    if (!this.handWorker) return
    if (this.prefetchPlan !== plan) {
      this.prefetchPlan = plan
      this.prefetchTargets.clear()
      this.prefetchWindow = ''
      this.prefetchStarts = [...new Set(plan.filter((note) => note.position).map((note) => note.startBeat))]
        .sort((a, b) => a - b)
    }
    const inLoop = loop ? this.prefetchStarts.filter((start) => start >= loop.start - 1e-8 && start < loop.end)
      : this.prefetchStarts
    const ahead = inLoop.filter((start) => start > beat + 1e-8)
    const coming = (loop ? [...ahead, ...inLoop.filter((start) => start <= beat + 1e-8)] : ahead).slice(0, PREFETCH_ONSETS)
    const signature = coming.join(',')
    if (signature === this.prefetchWindow) return
    this.prefetchWindow = signature
    const jobs: HandSolveJob[] = []
    const queued = new Set<string>()
    // Finger memory evolves onset by onset on a copy, so looking ahead never changes what the playhead sees.
    const scratch = memory ? new Map(memory) : undefined
    for (const onset of coming) {
      let target = this.prefetchTargets.get(onset)
      if (target === undefined) {
        target = this.poseTargetAt(plan, onset, scratch)
        this.prefetchTargets.set(onset, target)
        if (this.prefetchTargets.size > 800) this.prefetchTargets.delete(this.prefetchTargets.keys().next().value!)
      }
      if (!target || this.handPoses.has(target.key) || queued.has(target.key) || this.pendingHandPoses.get(target.key) === false) continue
      queued.add(target.key)
      const profile = this.neckProfile
      const x = mean(target.contacts.map((contact) => contact.center[0]))
      const t = clamped((profile.nutX - x) / (profile.nutX - profile.heelX), 0, 1)
      jobs.push({ kind: 'solve', key: target.key, side: 'left', contacts: target.contacts, state: target.state, ahead: true,
        order: jobs.length, neck: { halfWidth: profile.nutWidth + (profile.heelWidth - profile.nutWidth) * t, depth: profile.depth } })
    }
    for (const [key, isAhead] of [...this.pendingHandPoses]) if (isAhead && !queued.has(key)) this.pendingHandPoses.delete(key)
    for (const job of jobs) this.pendingHandPoses.set(job.key, true)
    this.handWorker.postMessage({ kind: 'window', jobs })
  }
  // The pose key and contacts the hand will need while the notes sounding at `beat` play.
  private poseTargetAt(plan: readonly FrettedTabNote[], beat: number, memory?: FrettedHandMemory) {
    const sounding = plan.filter((note) => note.position && note.startBeat <= beat + 1e-8 &&
      beat < note.startBeat + note.beats - 1e-8)
    const selected = selectHandNotes(sounding, this.config)
    if (selected.unavailable) return null
    const contacts: FrettedHandPoseContact[] = []
    let state: 'pressed' | 'relaxed' = 'pressed'
    if (selected.notes.length) {
      const grip = planFrettedHand(selected.notes, this.config, memory)
      if (grip.unavailable) return null
      for (const contact of grip.contacts) {
        const note = selected.notes.find((item) => item.index === contact.index)
        const point = note?.position && this.stringPointAtX(contact.string, this.pressX(note.position))
        if (!point) return null
        const radius = this.config.strings[contact.string - 1].gaugeInches * 0.0254 / 2
        contacts.push({ finger: contact.finger, string: contact.string, fret: contact.fret, barre: contact.barre,
          center: point, surface: [point[0], point[1], point[2] + radius], radius })
      }
    } else if (sounding.length) {
      state = 'relaxed'
      const stringNumber = Math.ceil(this.config.strings.length / 2)
      const position = positionForStringFret(stringNumber, this.relaxedFret(plan, beat), this.config)
      const point = position && this.stringPointAtX(stringNumber, this.pressX(position))
      if (!position || !point) return null
      const radius = this.config.strings[stringNumber - 1].gaugeInches * 0.0254 / 2
      contacts.push({ finger: 1, string: stringNumber, fret: position.fret, barre: false,
        center: point, surface: [point[0], point[1], point[2] + radius], radius })
    } else return null
    if (!contacts.length) return null
    const key = JSON.stringify(['right', state, contacts.map((contact) =>
      [contact.finger, contact.string, contact.fret, contact.barre, ...contact.center, ...contact.surface, contact.radius])])
    return { key, state, contacts }
  }

  private makeProgram(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('WebGL could not allocate a guitar shader.')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const reason = gl.getShaderInfoLog(shader) ?? 'shader compilation failed'
        gl.deleteShader(shader)
        throw new Error(reason)
      }
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, vertex)
    const fs = compile(gl.FRAGMENT_SHADER, fragment)
    const program = gl.createProgram()
    if (!program) throw new Error('WebGL could not allocate a guitar program.')
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    gl.deleteShader(vs); gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const reason = gl.getProgramInfoLog(program) ?? 'program link failed'
      gl.deleteProgram(program)
      throw new Error(reason)
    }
    return program
  }

  private loadTextures(asset: Asset, images: (ImageBitmap | null)[]): WebGLTexture[] {
    const gl = this.gl
    return asset.json.images.map((_image, index) => {
      const texture = gl.createTexture()
      if (!texture) throw new Error('WebGL could not allocate a guitar material texture.')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      const bitmap = images[index]
      if (bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([190, 160, 120, 255]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
      gl.generateMipmap(gl.TEXTURE_2D)
      return texture
    })
  }

  private visit(asset: Asset, index: number, parent: Float32Array, variantNames: string[]) {
    const gl = this.gl
    const gltf = asset.json
    const node = gltf.nodes[index]
    const world = mul(parent, trs(node))
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh]
      for (const primitive of mesh.primitives) {
        const materialIndices = variantNames.map((_variant, style) =>
          primitive.extensions?.KHR_materials_variants?.mappings.find((entry) =>
            entry.variants.includes(style))?.material ?? primitive.material)
        const materials = materialIndices.map((materialIndex) => this.readMaterial(gltf.materials[materialIndex]))
        const clearcoats = materialIndices.map((materialIndex) => this.clearcoat(gltf.materials[materialIndex]))
        const position = read(asset, primitive.attributes.POSITION) as Float32Array
        const normal = read(asset, primitive.attributes.NORMAL) as Float32Array
        const uv = primitive.attributes.TEXCOORD_0 === undefined
          ? new Float32Array(position.length / 3 * 2) : read(asset, primitive.attributes.TEXCOORD_0) as Float32Array
        const rawIndices = read(asset, primitive.indices) as Uint32Array
        const indices = rawIndices.every((value) => value < 65536) ? Uint16Array.from(rawIndices) : rawIndices
        const data = new Float32Array(position.length / 3 * 8)
        for (let i = 0; i < position.length / 3; i++)
          data.set([position[i * 3], position[i * 3 + 1], position[i * 3 + 2],
            normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]], i * 8)
        const vertex = gl.createBuffer(), element = gl.createBuffer()
        if (!vertex || !element) throw new Error('WebGL could not allocate guitar geometry buffers.')
        gl.bindBuffer(gl.ARRAY_BUFFER, vertex); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, element); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
        this.buffers.push({ vertex, index: element })
        this.items.push({ name: node.name, data, indices, type: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
          frame: world, materials, clearcoats, string: this.stringNumber(node),
          lod: typeof node.extras?.lodLevel === 'number' ? node.extras.lodLevel : 0 })
      }
    }
    for (const child of node.children ?? []) this.visit(asset, child, world, variantNames)
  }

  private readMaterial(source: Asset['json']['materials'][number]): MaterialView {
    return {
        name: source.name,
        base: (source.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]) as MaterialView['base'],
        metal: source.pbrMetallicRoughness?.metallicFactor ?? 0,
        rough: source.pbrMetallicRoughness?.roughnessFactor ?? 0.6,
        emissive: (source.emissiveFactor ?? [0, 0, 0]) as Vec3,
        baseTex: source.pbrMetallicRoughness?.baseColorTexture ? source.pbrMetallicRoughness.baseColorTexture.index : -1,
        ormTex: source.pbrMetallicRoughness?.metallicRoughnessTexture?.index ?? -1,
        normalTex: source.normalTexture?.index ?? -1,
        emissiveTex: -1,
        normalScale: source.normalTexture?.scale ?? 1,
        blend: false,
    }
  }

  private clearcoat(material: Asset['json']['materials'][number]) {
    return (material as typeof material & { extensions?: { KHR_materials_clearcoat?: { clearcoatFactor?: number } } })
      .extensions?.KHR_materials_clearcoat?.clearcoatFactor ?? 0
  }

  private stringNumber(node: Node): number | undefined {
    const value = node.extras?.stringNumber
    return typeof value === 'number' && node.name.startsWith('String_') ? value : undefined
  }

  private worldVertex(item: Item, offset: number): [number, number, number] {
    const [x, y, z] = item.data.subarray(offset, offset + 3)
    const frame = item.frame
    return [
      frame[0] * x + frame[4] * y + frame[8] * z + frame[12],
      frame[1] * x + frame[5] * y + frame[9] * z + frame[13],
      frame[2] * x + frame[6] * y + frame[10] * z + frame[14],
    ]
  }

  private findStringCenterlines() {
    for (const string of this.config.strings) {
      const item = this.items.find((candidate) => candidate.string === string.string)
      if (!item) continue
      const points: HandVector[] = []
      for (let offset = 0; offset < item.data.length; offset += 8)
        points.push(this.worldVertex(item, offset))
      // Only the span between bridge and nut is playable; the headstock run to the tuning post bends away.
      const playable = points.filter((point) => point[0] <= this.config.scaleLength + 0.002)
      if (playable.length >= 2) { points.length = 0; points.push(...playable) }
      const center: HandVector = [
        mean(points.map((point) => point[0])),
        mean(points.map((point) => point[1])),
        mean(points.map((point) => point[2])),
      ]
      let varianceX = 0, covarianceY = 0, covarianceZ = 0
      for (const point of points) {
        const dx = point[0] - center[0]
        varianceX += dx * dx
        covarianceY += dx * (point[1] - center[1])
        covarianceZ += dx * (point[2] - center[2])
      }
      if (varianceX <= 0) throw new Error(`String ${string.string} has no playable length.`)
      // These straight string meshes need a continuous axis, not the nearest ring of vertices.
      this.stringCenterlines.set(string.string, {
        center, slopeY: covarianceY / varianceX, slopeZ: covarianceZ / varianceX,
      })
    }
  }

  private stringPointAtX(string: number, x: number): HandVector | undefined {
    const axis = this.stringCenterlines.get(string)
    if (!axis) return
    const dx = x - axis.center[0]
    return [x, axis.center[1] + dx * axis.slopeY, axis.center[2] + dx * axis.slopeZ]
  }

  // Where the relaxed fretting hand rests: the nearest fretted note before or after now, else around frets 1-3.
  private relaxedFret(plan: readonly FrettedTabNote[], beat: number): number {
    let before: FrettedTabNote | undefined, after: FrettedTabNote | undefined
    for (const note of plan) {
      if (!note.position || note.position.fret < 1) continue
      if (note.startBeat <= beat + 1e-8) { if (!before || note.startBeat > before.startBeat) before = note }
      else if (!after || note.startBeat < after.startBeat) after = note
    }
    const near = before && after ? (beat - before.startBeat <= after.startBeat - beat ? before : after) : before ?? after
    if (!near) return 2
    const frets = plan.filter((note) => note.startBeat === near.startBeat && note.position && note.position.fret > 0)
      .map((note) => note.position!.fret)
    return clamped(Math.round(mean(frets)), 1, Math.max(1, this.config.frets - 3))
  }

  private fretLineX(fret: number) {
    return this.config.scaleLength * 2 ** (-fret / 12)
  }

  // A fingertip presses just behind the fret wire, not in the middle of the fret space.
  private pressX(position: FrettedPosition) {
    if (position.fret === 0) return position.fretboardCoordinate
    const wire = this.fretLineX(position.fret)
    return wire + (this.fretLineX(position.fret - 1) - wire) * 0.3
  }

  private pose(
    handedness: 'right' | 'left',
    width: number,
    height: number,
  ) {
    const startX = this.fretLineX(0)
    const endX = this.fretLineX(this.config.frets)
    this.teachingFrame = { startFret: 0, endFret: this.config.frets, startX, endX }
    const fit = this.fitMirrorCamera(width, height, handedness)
    // The camera looks at the guitar's front face like an audience member; a right-handed
    // player sees that picture reflected, as in a mirror. Only the screen is reflected.
    this.mirrored = handedness === 'right'
    const reflect = this.mirrored
      ? new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
      : IDENTITY
    this.cameraPosition = [...fit.eye]
    this.perspectiveW = fit.distance
    this.viewProjection = multiply(reflect, fit.matrix)
  }

  private stringBoost(stringNumber: number, height: number): number {
    const string = this.config.strings[stringNumber - 1]
    if (!string) return 0
    const canvas = this.gl.canvas as HTMLCanvasElement
    const cssHeight = canvas.clientHeight || height
    const pixelsPerMeter = cssHeight * 0.5 *
      Math.hypot(this.viewProjection[1], this.viewProjection[5], this.viewProjection[9]) / this.perspectiveW
    if (pixelsPerMeter <= 0) return 0
    const gaugeMeters = string.gaugeInches * 0.0254
    const gaugeRange = this.config.strings.map((item) => item.gaugeInches)
    const visibleDiameter = frettedStringDisplayThicknessPx(string.gaugeInches,
      Math.min(...gaugeRange), Math.max(...gaugeRange)) * (this.studio ? 0.72 : 1)
    return Math.max(0, (visibleDiameter / pixelsPerMeter - gaugeMeters) / 2)
  }

  private stringOutlineWidth(stringNumber: number, height: number): number {
    const canvas = this.gl.canvas as HTMLCanvasElement
    const cssHeight = canvas.clientHeight || height
    const pixelsPerMeter = cssHeight * 0.5 *
      Math.hypot(this.viewProjection[1], this.viewProjection[5], this.viewProjection[9]) / this.perspectiveW
    return pixelsPerMeter > 0 && this.config.strings[stringNumber - 1] ? 0.8 / pixelsPerMeter : 0
  }

  private drawHandGeometry(geometry: HandDrawGeometry, style: FrettedStyle, _state: FrettedHand['state'],
    slot: string = 'skin', fabric?: [number, number, number]): boolean {
    const gl = this.gl
    if (!this.handBuffers) this.handBuffers = {}
    if (!this.handBuffers[slot]) {
      const vertex = gl.createBuffer(), index = gl.createBuffer()
      if (!vertex || !index) return false
      this.handBuffers[slot] = { vertex, index }
    }
    const target = this.handBuffers[slot]!
    if (this.uploadedSlots[slot] !== geometry) {
      gl.bindBuffer(gl.ARRAY_BUFFER, target.vertex)
      gl.bufferData(gl.ARRAY_BUFFER, geometry.skin, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, target.index)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.skinIndices, gl.DYNAMIC_DRAW)
      this.uploadedSlots[slot] = geometry
    }
    const program = this.program
    const bind = (buffers: { vertex: WebGLBuffer; index: WebGLBuffer }) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.vertex)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index)
      for (const [attribute, offset, size] of [['aPosition', 0, 3], ['aNormal', 3, 3], ['aUv', 6, 2]] as const) {
        const location = gl.getAttribLocation(program, attribute)
        if (location >= 0) {
          gl.enableVertexAttribArray(location)
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset * 4)
        }
      }
    }
    const tone: Record<FrettedStyle, [number, number, number]> = {
      Realistic: [0.38, 0.22, 0.15],
      ClayStudyModel: [0.52, 0.34, 0.26],
      TechnicalBlueprint: [0.30, 0.43, 0.57],
    }
    const applyHandMaterial = (base: [number, number, number], opacity: number) => {
      gl.uniformMatrix4fv(this.locations.uModel, false, IDENTITY)
      gl.uniformMatrix4fv(this.locations.uMvp, false, this.viewProjection)
      gl.uniform4fv(this.locations.uBase, [...base, 1])
      gl.uniform1f(this.locations.uMetal, 0)
      gl.uniform1f(this.locations.uRough, 0.72)
      gl.uniform3fv(this.locations.uEmissive, [0, 0, 0])
      gl.uniform1f(this.locations.uClearcoat, 0.035)
      gl.uniform1f(this.locations.uStyle, styleIndex(style))
      gl.uniform1f(this.locations.uHasTexture, 0)
      gl.uniform1f(this.locations.uHasNormal, 0)
      gl.uniform1f(this.locations.uHasOrm, 0)
      gl.uniform1f(this.locations.uIsString, 0)
      gl.uniform1f(this.locations.uStringBoost, 0)
      gl.uniform1f(this.locations.uStringThick, 0)
      gl.uniform1f(this.locations.uOutlineWidth, 0)
      gl.uniform1f(this.locations.uVibration, 0)
      gl.uniform1f(this.locations.uFretX, 0)
      gl.uniform1f(this.locations.uTime, 0)
      gl.uniform1f(this.locations.uAmplitude, 0)
      gl.uniform3fv(this.locations.uCameraPosition, this.cameraPosition)
      gl.uniform3fv(this.locations.uStateColor, [0, 0, 0])
      gl.uniform1f(this.locations.uState, 0)
      gl.uniform1f(this.locations.uInk, 0)
      gl.uniform1f(this.locations.uIsHand, 1)
      gl.uniform1f(this.locations.uHandAlpha, opacity)
      const tints = slot === 'skin' ? this.handTints : []
      gl.uniform1f(this.locations.uTintCount, tints.length)
      if (tints.length) {
        const pad = (values: number[]) => Float32Array.from([...values, ...new Array(12 - values.length).fill(0)])
        gl.uniform3fv(this.locations['uTintA[0]'], pad(tints.flatMap((item) => item.from)))
        gl.uniform3fv(this.locations['uTintB[0]'], pad(tints.flatMap((item) => item.to)))
        gl.uniform3fv(this.locations['uTintColor[0]'], pad(tints.flatMap((item) => item.color)))
      }
    }
    gl.useProgram(program)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(true)
    gl.disable(gl.CULL_FACE)
    if (fabric) {
      applyHandMaterial(fabric, 1)
      gl.uniform1f(this.locations.uIsHand, 0)
      gl.uniform1f(this.locations.uClearcoat, 0)
      gl.uniform1f(this.locations.uStringThick, -1)
      gl.uniform1f(this.locations.uRough, 0.92)
      bind(target)
      gl.drawElements(gl.TRIANGLES, geometry.skinIndices.length, gl.UNSIGNED_SHORT, 0)
      gl.enable(gl.CULL_FACE)
      gl.disable(gl.BLEND)
      return true
    }
    if (slot === 'plectrum') {
      // The pick is a separate glossy plastic object, drawn without the skin outline.
      applyHandMaterial([0.95, 0.62, 0.08], 1)
      gl.uniform1f(this.locations.uIsHand, 0)
      gl.uniform1f(this.locations.uRough, 0.32)
      gl.uniform1f(this.locations.uClearcoat, 0.5)
      bind(target)
      gl.drawElements(gl.TRIANGLES, geometry.skinIndices.length, gl.UNSIGNED_SHORT, 0)
      gl.enable(gl.CULL_FACE)
      gl.disable(gl.BLEND)
      return true
    }
    applyHandMaterial(tone[style], 0.99)
    bind(target)
    gl.drawElements(gl.TRIANGLES, geometry.skinIndices.length, gl.UNSIGNED_SHORT, 0)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.FRONT)
    gl.depthMask(false)
    gl.uniform1f(this.locations.uOutlineWidth,
      style === 'TechnicalBlueprint' ? 0.0012 : style === 'ClayStudyModel' ? 0.0013 : 0.0015)
    gl.uniform1f(this.locations.uInk, 1)
    bind(target)
    gl.drawElements(gl.TRIANGLES, geometry.skinIndices.length, gl.UNSIGNED_SHORT, 0)
    gl.uniform1f(this.locations.uOutlineWidth, 0)
    gl.uniform1f(this.locations.uInk, 0)
    gl.depthMask(true)
    gl.cullFace(gl.BACK)
    gl.enable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
    return true
  }

  private projected(point: [number, number, number], width: number, height: number): [number, number] {
    const [x, y] = this.projectedDepth(point, width, height)
    return [x, y]
  }

  private projectedDepth(point: HandVector, width: number, height: number): HandVector {
    const m = this.viewProjection
    const [x, y, z] = point
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
    return [(cx / cw * 0.5 + 0.5) * width, (0.5 - cy / cw * 0.5) * height, cz / cw]
  }

  private handOcclusion(width: number, height: number, geometry: HandDrawGeometry) {
    const projected = Array.from({ length: geometry.skin.length / 8 }, (_, index) =>
      this.projectedDepth([
        geometry.skin[index * 8], geometry.skin[index * 8 + 1], geometry.skin[index * 8 + 2],
      ], width, height))
    const triangles: {
      a: HandVector; b: HandVector; c: HandVector; denominator: number
      minX: number; maxX: number; minY: number; maxY: number
    }[] = []
    for (let index = 0; index < geometry.skinIndices.length; index += 3) {
      const a = projected[geometry.skinIndices[index]]
      const b = projected[geometry.skinIndices[index + 1]]
      const c = projected[geometry.skinIndices[index + 2]]
      const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
      if (Math.abs(denominator) < 1e-8) continue
      triangles.push({ a, b, c, denominator,
        minX: Math.min(a[0], b[0], c[0]), maxX: Math.max(a[0], b[0], c[0]),
        minY: Math.min(a[1], b[1], c[1]), maxY: Math.max(a[1], b[1], c[1]) })
    }
    return (point: HandVector) => {
      const [x, y, depth] = this.projectedDepth(point, width, height)
      for (const { a, b, c, denominator, minX, maxX, minY, maxY } of triangles) {
        if (x < minX || x > maxX || y < minY || y > maxY) continue
        const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator
        const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator
        if (u >= 0 && v >= 0 && u + v <= 1 &&
          u * a[2] + v * b[2] + (1 - u - v) * c[2] < depth - 1e-6) return true
      }
      return false
    }
  }

  private stringGuides(
    width: number,
    height: number,
    geometry: HandDrawGeometry | null,
    handPoseKey: string | null = null,
  ): FrettedStringGuide[] {
    const key = JSON.stringify([width, height, [...this.viewProjection], geometry ? handPoseKey : null])
    if (key === this.stringGuideKey) return this.cachedStringGuides
    const sampleCount = 96
    const startX = this.teachingFrame.startX
    const endX = this.teachingFrame.endX
    const occluded = geometry ? this.handOcclusion(width, height, geometry) : () => false
    const guides = this.config.strings.map((string) => {
      const points = Array.from({ length: sampleCount + 1 }, (_, index) => {
        const x = startX + (endX - startX) * index / sampleCount
        const center = this.stringPointAtX(string.string, x)
        if (!center) return null
        const radius = string.gaugeInches * 0.0254 / 2
        const point: HandVector = [center[0], center[1], center[2] + radius + 0.0004]
        const projected = this.projected(point, width, height)
        return {
          screen: `${projected[0].toFixed(1)},${projected[1].toFixed(1)}`,
          hidden: occluded(point),
        }
      })
      const visible: string[] = []
      const hidden: string[] = []
      let currentState: boolean | null = null
      let current: string[] = []
      const flush = () => {
        if (current.length < 2) return
        ;(currentState ? hidden : visible).push(current.join(' '))
      }
      for (let index = 0; index < points.length - 1; index++) {
        const first = points[index], second = points[index + 1]
        if (!first || !second) { flush(); current = []; currentState = null; continue }
        const state = first.hidden || second.hidden
        if (currentState !== state) {
          flush()
          currentState = state
          current = [first.screen]
        }
        current.push(second.screen)
      }
      flush()
      return { string: string.string, name: string.name, visible, hidden }
    })
    this.stringGuideKey = key
    this.cachedStringGuides = guides
    return guides
  }

  draw(
    width: number,
    height: number,
    style: FrettedStyle,
    time: number,
    plan: readonly FrettedTabNote[],
    beat: number,
    secondsPerBeat: number,
    playing: boolean,
    countingIn: boolean,
    loop: { start: number; end: number } | null,
    feedback: Readonly<Record<string, FrettedVisualState | undefined>> = {},
    reducedMotion = false,
    handedness: 'right' | 'left' = 'right',
    _beatsPerBar = 4,
    viewport: Viewport = { x: 0, y: 0, width, height },
    handMemory?: FrettedHandMemory,
  ): FrettedFrame {
    const gl = this.gl
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height)
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height)
    gl.clearColor(style === 'TechnicalBlueprint' ? 0.91 : 0.96,
      style === 'TechnicalBlueprint' ? 0.94 : 0.94, style === 'TechnicalBlueprint' ? 0.97 : 0.93, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(this.program)
    this.pose(handedness, width, height)
    // A left-handed mirror is the right-handed scene without the screen reflection (the mirror image of a left-handed player).
    const worldHand: 'right' | 'left' = 'right'
    this.studio = style === 'Realistic'
    this.drawBackground(style)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
    // A reflected screen reverses triangle winding; swapping the front face keeps culling and lighting correct.
    gl.frontFace(this.mirrored ? gl.CW : gl.CCW)
    gl.uniform1f(this.locations.uStudio, this.studio ? 1 : 0)
    const blueprint = style === 'TechnicalBlueprint'
    if (blueprint) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    } else gl.disable(gl.BLEND)
    gl.depthMask(true)
    const lod = width < 520 ? 1 : 0
    const drawItems = this.items.filter((item) =>
      (item.name === 'Body_Mesh' ? lod === 0 :
        item.name === 'Body_Mesh_LOD1' ? lod === 1 : item.lod === 0) &&
      true)
    const triangles = drawItems.reduce((sum, item) => sum + item.indices.length / 3, 0)
    const activeNotes = countingIn ? [] : plan.filter((note) =>
      note.position && note.startBeat <= beat + 1e-8 && beat < note.startBeat + note.beats - 1e-8)
    const distanceTo = (note: FrettedTabNote) => {
      if (!note.position) return Infinity
      if (loop) {
        if (note.startBeat >= loop.end) return Infinity
        if (countingIn)
          return note.startBeat >= beat - 1e-8 ? Math.max(0, note.startBeat - beat) : Infinity
        if (note.startBeat > beat + 1e-8) return note.startBeat - beat
        if (beat < loop.start || note.startBeat < loop.start) return Infinity
        return loop.end - beat + note.startBeat - loop.start
      }
      return countingIn ? note.startBeat - beat : note.startBeat > beat + 1e-8 ? note.startBeat - beat : Infinity
    }
    const futureNotes = plan.filter((note) => note.position && (loop || !activeNotes.includes(note)) &&
      distanceTo(note) >= -1e-8)
    const nextDistance = futureNotes.reduce((nearest, note) => Math.min(nearest, distanceTo(note)), Infinity)
    const nextNotes = futureNotes.filter((note) => Math.abs(distanceTo(note) - nextDistance) < 1e-8)
    const byString = new Map<number, FrettedTabNote>()
    for (const note of activeNotes) if (note.position) {
      const previous = byString.get(note.position.string)
      if (!previous || previous.startBeat < note.startBeat) byString.set(note.position.string, note)
    }
    const stringCues: FrettedStringCue[] = []
    for (const [string, note] of byString) if (note.position)
      stringCues.push({ string, fret: note.position.fret, state: 'playback' })
    const vibrations: FrettedVibration[] = []
    const plucks: FrettedPluck[] = []
    if (playing && !countingIn) {
      const recentByString = new Map<number, { note: FrettedTabNote; age: number }>()
      for (const note of plan) if (note.position &&
        (!loop || note.startBeat < loop.end && (note.startBeat >= loop.start || beat < loop.start)) &&
        note.startBeat <= beat + 1e-8) {
        const age = Math.max(0, (beat - note.startBeat) * secondsPerBeat)
        const previous = recentByString.get(note.position.string)
        if (age < 0.45 && (!previous || previous.note.startBeat < note.startBeat))
          recentByString.set(note.position.string, { note, age })
      }
      for (const { note } of recentByString.values()) {
        const position = note.position!
        const point = this.stringPointAtX(position.string, this.pickingX)
        if (!point) continue
        const [x, y] = this.projected([point[0], point[1], point[2] + 0.006], width, height)
        const string = this.config.strings[position.string - 1]
        plucks.push({ index: note.index, string: position.string,
          conventionalStringNumber: string.conventionalStringNumber, name: string.name, x, y })
      }
    }
    const stateColor: [number, number, number] = STYLE_TONES[style]
    const stateFor = (item: Item) => {
      const key = item.string ? `String_${item.string}` : item.name
      const explicit = feedback[key]
      return explicit ? FEEDBACK_COLOR[explicit] : stateColor
    }
    const program = this.program
    const drawItem = (item: Item) => {
      const stringNote = item.string ? byString.get(item.string) : undefined
      const noteState = stringNote?.position
        ? feedback[`Position_S${stringNote.position.string}_F${stringNote.position.fret}`] : undefined
      const stringState = feedback[item.string ? `String_${item.string}` : item.name]
      const isVibrating = !!stringNote?.position && playing && !countingIn && !reducedMotion
      const age = stringNote ? Math.max(0, (beat - stringNote.startBeat) * secondsPerBeat) : 0
      const amplitude = isVibrating ? 0.002 * Math.exp(-age * 2.6) : 0
      const activeStartX = stringNote?.position
        ? this.config.scaleLength - stringNote.position.fretDistanceFromNut : this.config.scaleLength
      if (item.string && stringNote?.position && isVibrating)
        vibrations.push({ string: item.string, fret: stringNote.position.fret, amplitude, activeStartX })
      const itemIndex = this.items.indexOf(item)
      const selectedMaterial = item.materials[styleIndex(style)] ?? item.materials[0]
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[itemIndex].vertex)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers[itemIndex].index)
      for (const [attribute, offset, size] of [['aPosition', 0, 3], ['aNormal', 3, 3], ['aUv', 6, 2]] as const) {
        const location = gl.getAttribLocation(program, attribute)
        if (location >= 0) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset * 4) }
      }
      const model = item.frame
      gl.uniformMatrix4fv(this.locations.uModel, false, model)
      gl.uniformMatrix4fv(this.locations.uMvp, false, multiply(this.viewProjection, model))
      gl.uniform1f(this.locations.uVibration, isVibrating && item.string ? 1 : 0)
      gl.uniform1f(this.locations.uFretX, activeStartX)
      gl.uniform1f(this.locations.uTime, time / 1000)
      gl.uniform1f(this.locations.uAmplitude, amplitude)
      const override = this.studio ? STUDIO_OVERRIDES[selectedMaterial.name?.replace(/_(Clay|Neon|Technical).*$/, '')] : undefined
      gl.uniform4fv(this.locations.uBase, override?.base ?? selectedMaterial.base)
      gl.uniform1f(this.locations.uMetal, selectedMaterial.metal)
      gl.uniform3fv(this.locations.uCameraPosition, this.cameraPosition)
      gl.uniform1f(this.locations.uRough, override?.rough ?? selectedMaterial.rough)
      gl.uniform3fv(this.locations.uEmissive, selectedMaterial.emissive)
      gl.uniform1f(this.locations.uClearcoat, item.clearcoats[styleIndex(style)] ?? 0)
      gl.uniform1f(this.locations.uStyle, styleIndex(style))
      gl.uniform1f(this.locations.uIsString, item.string ? 1 : 0)
      gl.uniform1f(this.locations.uIsHand, 0)
      gl.uniform1f(this.locations.uStringBoost, item.string ? this.stringBoost(item.string, height) : 0)
      gl.uniform1f(this.locations.uOutlineWidth, 0)
      gl.uniform1f(this.locations.uInk, 0)
      const explicitState = noteState ?? stringState
      const stringTint = this.studio && !!item.string
      const noteTint = explicitState ? FEEDBACK_COLOR[explicitState] :
        stringNote ? stringTint ? [0.2, 0.85, 1] as [number, number, number] : stateColor :
          stateFor(item)
      gl.uniform3fv(this.locations.uStateColor, noteTint)
      const hideTint = !this.guides
      const chordMember = byString.size > 1
      const amount = hideTint ? 0 : item.string
        ? explicitState ? 0.34 : stringNote ? (stringTint ? chordMember ? 0.22 : 0.6 : 0.5) : 0
        : explicitState ? 0.54 : stringNote ? 0.86 : 0
      gl.uniform1f(this.locations.uState, amount)
      const baseTex = selectedMaterial.baseTex
      gl.uniform1f(this.locations.uHasTexture, baseTex >= 0 ? 1 : 0)
      if (baseTex >= 0 && this.textures[baseTex]) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[baseTex]) }
      // The shared wood normal and packed occlusion/roughness/metal maps only belong on textured wood parts.
      const normalTex = this.studio && baseTex >= 0 ? selectedMaterial.normalTex : -1
      const ormTex = this.studio && baseTex >= 0 ? selectedMaterial.ormTex : -1
      gl.uniform1f(this.locations.uHasNormal, normalTex >= 0 && this.textures[normalTex] ? 1 : 0)
      gl.uniform1f(this.locations.uHasOrm, ormTex >= 0 && this.textures[ormTex] ? 1 : 0)
      gl.uniform1f(this.locations.uNormalScale, selectedMaterial.normalScale)
      if (normalTex >= 0 && this.textures[normalTex]) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.textures[normalTex])
      }
      if (ormTex >= 0 && this.textures[ormTex]) {
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.textures[ormTex])
      }
      gl.activeTexture(gl.TEXTURE0)
      const stringConfig = item.string ? this.config.strings[item.string - 1] : undefined
      const gauges = this.config.strings.map((entry) => entry.gaugeInches)
      gl.uniform1f(this.locations.uStringThick, stringConfig
        ? (stringConfig.gaugeInches - Math.min(...gauges)) / Math.max(0.001, Math.max(...gauges) - Math.min(...gauges))
        : 0)
      if (item.string) {
        gl.uniform1f(this.locations.uStringBoost, this.stringBoost(item.string, height))
        gl.uniform1f(this.locations.uOutlineWidth, this.stringOutlineWidth(item.string, height))
        if (!this.studio) {
          gl.uniform1f(this.locations.uInk, 1)
          gl.depthMask(false)
          gl.drawElements(gl.TRIANGLES, item.indices.length, item.type, 0)
          gl.depthMask(true)
        }
        gl.uniform1f(this.locations.uOutlineWidth, 0)
        gl.uniform1f(this.locations.uInk, 0)
        gl.uniform1f(this.locations.uOutlineWidth, this.stringOutlineWidth(item.string, height) * 0)
      }
      gl.drawElements(gl.TRIANGLES, item.indices.length, item.type, 0)
      if (blueprint && !item.string) {
        gl.disable(gl.BLEND)
        gl.depthMask(false)
        gl.cullFace(gl.FRONT)
        gl.uniform1f(this.locations.uState, 0)
        gl.uniform1f(this.locations.uInk, 1)
        gl.uniform1f(this.locations.uOutlineWidth, 0.0011)
        gl.drawElements(gl.TRIANGLES, item.indices.length, item.type, 0)
        gl.uniform1f(this.locations.uOutlineWidth, 0)
        gl.uniform1f(this.locations.uInk, 0)
        gl.cullFace(gl.BACK)
        gl.depthMask(true)
        gl.enable(gl.BLEND)
      }
    }
    const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1)
    const markers: FrettedMarker[] = []
    const markerRank = (state: FrettedMarker['state']) =>
      state === 'playback' ? 5.5 : state === 'upcoming' ? visualStatePriority('upcoming') : visualStatePriority(state)
    const addMarker = (note: FrettedTabNote, state: FrettedMarker['state']) => {
      if (!note.position || note.position.fret === 0) return
      const x = this.pressX(note.position)
      const point = this.stringPointAtX(note.position.string, x)
      const [px, py] = this.projected(point ? [point[0], point[1], point[2] + 0.0012] : [x, 0, 0.058], width, height)
      const positionState = feedback[`Position_S${note.position.string}_F${note.position.fret}`]
      const resolved = positionState && visualStatePriority(positionState) > markerRank(state) ? positionState : state
      const existing = markers.find((marker) => marker.position.string === note.position!.string && marker.position.fret === note.position!.fret)
      if (existing) {
        const duplicate = markers.find((marker) => marker.position.string === note.position!.string &&
          marker.position.fret === note.position!.fret && marker.state === resolved)
        const active = markers.find((marker) => marker.position.string === note.position!.string &&
          marker.position.fret === note.position!.fret && marker.state === 'playback')
        if (resolved === 'upcoming' && active && !duplicate) {
          active.y = py + 12 * pixelRatio
          markers.push({ index: note.index, x: px, y: py - 12 * pixelRatio, anchorX: px, anchorY: py,
            label: String(note.position.fret), state: resolved, position: note.position })
        } else if (duplicate) {
          if (duplicate.index < 0 && note.index >= 0) duplicate.index = note.index
        } else if (markerRank(resolved) > markerRank(existing.state)) existing.state = resolved
      } else {
        markers.push({ index: note.index, x: px, y: py, anchorX: px, anchorY: py,
          label: String(note.position.fret),
          state: resolved, position: note.position })
      }
    }
    for (const note of activeNotes) addMarker(note, 'playback')
    // The next note is not drawn on the 3D instrument: it is only shown in the NEXT text below the view.
    for (const [name, state] of Object.entries(feedback)) {
      if (!state) continue
      const match = /^Position_S([1-6])_F(\d+)$/.exec(name)
      if (!match) continue
      const fret = Number(match[2])
      const position = positionForStringFret(Number(match[1]), fret, this.config)
      if (!position) continue
      const note = { index: -1, midi: position.midi, startBeat: beat, beats: 1, position }
      addMarker(note, state)
    }
    const clusters: FrettedMarker[][] = []
    for (const marker of markers) {
      const cluster = clusters.find((items) => items.some((other) =>
        other.position.string !== marker.position.string &&
        Math.hypot(other.anchorX - marker.anchorX, other.anchorY - marker.anchorY) < 26 * pixelRatio))
      if (cluster) cluster.push(marker)
      else clusters.push([marker])
    }
    for (const cluster of clusters.filter((items) => items.length > 1)) {
      cluster.sort((a, b) => a.anchorY - b.anchorY)
      const centerY = cluster.reduce((sum, marker) => sum + marker.anchorY, 0) / cluster.length
      cluster.forEach((marker, index) => { marker.y = centerY + (index - (cluster.length - 1) / 2) * 28 * pixelRatio })
    }
    const box = this.instrumentBounds
    const silhouette = this.silhouetteBounds(width, height)
    const instrumentLeft = silhouette ? silhouette.left
      : Math.min(...[box.minX, box.maxX].map((x) => this.projected([x, (box.minY + box.maxY) / 2, 0], width, height)[0]))
    const labelX = silhouette
      ? clamped(this.mirrored ? silhouette.left - 46 * pixelRatio : silhouette.right + 46 * pixelRatio,
        46 * pixelRatio, width - 46 * pixelRatio)
      : Math.max(46 * pixelRatio, Math.min(width - 46 * pixelRatio, instrumentLeft - 36 * pixelRatio))
    const projectedStringLabels = this.config.strings.flatMap((string) => {
      const point = this.stringPointAtX(string.string, this.teachingFrame.startX)
      if (!point) return []
      const [anchorX, anchorY] = this.projected(
        [point[0], point[1], point[2] + 0.004], width, height)
      return [{ string: string.string, name: `${string.conventionalStringNumber} · ${string.name}`,
        x: labelX, y: anchorY, anchorX, anchorY }]
    }).sort((a, b) => a.anchorY - b.anchorY)
    const stringLabelSpacing = 20 * Math.min(2, globalThis.devicePixelRatio || 1)
    const stringLabelMargin = 12 * Math.min(2, globalThis.devicePixelRatio || 1)
    const labelStackHeight = Math.max(0, projectedStringLabels.length - 1) * stringLabelSpacing
    const labelStackTop = clamped(mean(projectedStringLabels.map((label) => label.anchorY)) -
      labelStackHeight / 2, stringLabelMargin, height - stringLabelMargin - labelStackHeight)
    const stringLabels = projectedStringLabels.map((label, index) => ({
      ...label, y: labelStackTop + index * stringLabelSpacing,
    }))
    const fretLabels: FrettedFretLabel[] = []
    const stringY = mean(this.config.strings.flatMap((string) =>
      this.stringPointAtX(string.string, this.teachingFrame.startX)?.[1] ?? []))
    for (let fret = Math.max(1, this.teachingFrame.startFret + 1);
      fret <= this.teachingFrame.endFret; fret++) {
      const x = this.fretLineX(fret)
      const [px, py] = this.projected([x, stringY + 0.018, 0.06], width, height)
      fretLabels.push({ fret, x: px, y: py })
    }

    // The hand holds the grip of the newest onset until the next one arrives, so one onset means one pose.
    const gripBeat = activeNotes.length ? Math.max(...activeNotes.map((note) => note.startBeat)) : beat
    const gripNotes = activeNotes.length ? plan.filter((note) => note.position && note.startBeat <= gripBeat + 1e-8 &&
      gripBeat < note.startBeat + note.beats - 1e-8) : []
    const selectedHand = selectHandNotes(gripNotes, this.config)
    const frettedNow = selectedHand.notes
    let handNotes = frettedNow
    let handState: FrettedHand['state'] = 'pressed'
    let relaxedFret: number | null = null
    if (!handNotes.length) {
      const nextFretted = nextNotes.filter((note) => note.position && note.position.fret > 0)
      const nearest = nextFretted.reduce<typeof nextFretted[number] | undefined>((best, note) =>
        !best || distanceTo(note) < distanceTo(best) ? note : best, undefined)
      if (!activeNotes.length && nearest) {
        // A rest or count-in before a fretted note: the hand hovers over where it plays next.
        handNotes = nextFretted.filter((note) => note.startBeat === nearest.startBeat)
        handState = 'preview'
      } else {
        // Open strings, or nothing left to fret: a relaxed hand rests near the neighbouring fretted notes.
        handState = 'relaxed'
        relaxedFret = this.relaxedFret(plan, gripBeat)
      }
    }
    let hand: FrettedHand | null = null
    this.handTints = []
    let handGeometry: HandDrawGeometry | null = null
    let handPoseKey: string | null = null
    let handUnavailable = false
    let handPending = false
    let handDrawn = false
    let handReason: FrettedFrame['handReason'] = this.handsOn ? 'none' : 'off'
    let handBlending = false
    type SolveContact = FrettedHandPoseContact & { index: number; x: number; y: number }
    let solveContacts: SolveContact[] = []
    const relaxedContacts = (fret: number): SolveContact[] => {
      const stringNumber = Math.ceil(this.config.strings.length / 2)
      const position = positionForStringFret(stringNumber, fret, this.config)
      const point = position && this.stringPointAtX(stringNumber, this.pressX(position))
      if (!position || !point) return []
      const radius = this.config.strings[stringNumber - 1].gaugeInches * 0.0254 / 2
      return [{ finger: 1, string: stringNumber, fret, barre: false, index: -1, x: 0, y: 0,
        center: point, surface: [point[0], point[1], point[2] + radius], radius }]
    }
    if (this.handsOn && relaxedFret !== null) solveContacts = relaxedContacts(relaxedFret)
    else if (this.handsOn && handNotes.length) {
      let grip: ReturnType<typeof planFrettedHand> = selectedHand.unavailable && handState === 'pressed'
        ? { contacts: [], unavailable: true } : planFrettedHand(handNotes, this.config, handMemory)
      // The grip already planned and solved ahead of time for this onset is used as is, so its pose is ready and its
      // key stays the same however the finger memory has moved since.
      const planned = handState === 'pressed' && !selectedHand.unavailable && this.prefetchPlan === plan
        ? this.prefetchTargets.get(gripBeat) : undefined
      if (planned) {
        const mapped = planned.contacts.map((contact) => {
          const note = handNotes.find((item) => item.position?.string === contact.string && item.position.fret === contact.fret)
          return note && { finger: contact.finger as FrettedHandFinger, string: contact.string, fret: contact.fret,
            index: note.index, barre: contact.barre }
        })
        if (mapped.length === handNotes.filter((note) => note.position && note.position.fret > 0).length &&
          mapped.every((contact) => contact)) grip = { contacts: mapped as FrettedHandPlan['contacts'], unavailable: false }
      }
      handUnavailable = grip.unavailable
      if (!grip.unavailable) for (const contact of grip.contacts) {
        const note = handNotes.find((item) => item.index === contact.index)
        if (!note?.position) continue
        const point = this.stringPointAtX(contact.string, this.pressX(note.position))
        if (!point) continue
        const radius = this.config.strings[contact.string - 1].gaugeInches * 0.0254 / 2
        const [x, y] = this.projected([point[0], point[1], point[2] + 0.0012], width, height)
        solveContacts.push({ finger: contact.finger, string: contact.string, fret: contact.fret,
          barre: contact.barre, center: point, surface: [point[0], point[1], point[2] + radius], radius,
          index: contact.index, x, y })
      }
    }
    const handAsset = this.handAssets?.[worldHand === 'right' ? 'left' : 'right']
    if (this.handsOn && solveContacts.length && !handAsset) handUnavailable = true
    // With no fretting grip to show, the last valid pose stays; before there is one, a relaxed hand is shown instead.
    const resolvePose = () => {
      handPoseKey = JSON.stringify([worldHand, handState, solveContacts.map((contact) =>
        [contact.finger, contact.string, contact.fret, contact.barre, ...contact.center, ...contact.surface,
          contact.radius])])
      const prepared = this.handPoses.get(handPoseKey)
      if (!prepared) {
        handPending = true
        this.requestHandPose(handPoseKey, worldHand === 'right' ? 'left' : 'right', solveContacts, handState)
      } else if (prepared.unavailable) handUnavailable = true
      else if (this.shownHand?.pose !== prepared) {
        // The new pose fades in over the last drawn one; with reduced motion it simply replaces it.
        const from = this.shownHand ? this.shownHand.geometry.skin : null
        this.shownHand = { pose: prepared, state: handState, key: handPoseKey, from: reducedMotion ? null : from,
          start: time, vertices: prepared.vertices, geometry: { skin: prepared.vertices, skinIndices: prepared.indices },
          fresh: true }
      }
    }
    if (this.handsOn && handAsset) {
      if (solveContacts.length) resolvePose()
      if ((handUnavailable || !solveContacts.length) && !this.shownHand) {
        handState = 'relaxed'
        solveContacts = relaxedContacts(this.relaxedFret(plan, beat))
        handPoseKey = null
        if (solveContacts.length) resolvePose()
      }
    }
    this.currentPoseKey = handPoseKey
    if (this.handsOn && handAsset) this.prefetchPoses(plan, beat, loop, handMemory)
    if (this.handsOn && this.shownHand) {
      const shown = this.shownHand
      const blend = shown.from ? clamped((time - shown.start) / 100, 0, 1) : 1
      if (shown.from && blend < 1) {
        const mixed = new Float32Array(shown.pose.vertices)
        const ease = blend * blend * (3 - 2 * blend)
        const from = shown.from
        for (let index = 0; index < mixed.length; index += 8)
          for (let axis = 0; axis < 6; axis++)
            mixed[index + axis] = from[index + axis] + (mixed[index + axis] - from[index + axis]) * ease
        shown.geometry = { skin: mixed, skinIndices: shown.pose.indices }
        handBlending = true
      } else if (shown.from) {
        shown.from = null
        shown.geometry = { skin: shown.pose.vertices, skinIndices: shown.pose.indices }
      }
      handGeometry = shown.geometry
      handDrawn = true
      handReason = handBlending ? 'blending' : handPending ? 'stale' : 'ready'
      const pose = shown.pose
      const ready = !handPending && shown.key === handPoseKey
      const showContacts = ready && shown.state !== 'relaxed'
      const fingerLabels: FrettedFingerLabel[] = showContacts ? pose.fingers.map((finger) => {
        const [x, y] = this.projected(finger.joints[2], width, height)
        return { finger: finger.finger, x, y, pressed: finger.pressed }
      }) : []
      // Only fingers pressing now are tinted, each in its own colour (a barre tints the whole index digit).
      const pressing = showContacts ? pose.fingers.filter((finger) => finger.pressed && finger.finger < 5) : []
      const tints = pressing.map((finger) => ({ finger: finger.finger as FrettedHandFinger, color: FINGER_COLORS[finger.finger as FrettedHandFinger] }))
      this.handTints = pressing.map((finger) => {
        const [r, g, b] = [1, 3, 5].map((offset) => (parseInt(FINGER_COLORS[finger.finger as FrettedHandFinger].slice(offset, offset + 2), 16) / 255) ** 2.2)
        const from = finger.joints[finger.barre ? 2 : 3], tip = finger.joints[4]
        const run = normalise([tip[0] - from[0], tip[1] - from[1], tip[2] - from[2]])
        return { from: [...from], to: [tip[0] + run[0] * 0.006, tip[1] + run[1] * 0.006, tip[2] + run[2] * 0.006], color: [r, g, b] }
      })
      hand = {
        state: ready ? shown.state : 'relaxed',
        assetSide: handedness === 'right' ? 'left' : 'right',
        contacts: showContacts ? solveContacts.map(({ index: _index, ...contact }) => ({
          ...contact,
          source: handNotes.find((item) => item.index === _index)?.finger === contact.finger ? 'lesson' as const : 'suggested' as const,
        })) : [],
        fingerLabels,
        tints,
        thumb: pose.thumbTip,
        fingers: pose.fingers,
        mesh: {
          triangles: pose.triangles,
          detailTriangles: 0,
          surfaceGap: Math.max(0, ...pose.contactTips.map((contact) => contact.gap)),
          rendered: false,
          viewBounds: null,
          contactTips: pose.contactTips.map((tip) => {
            const [screenX, screenY] = this.projected(tip.skinPoint, width, height)
            return { ...tip, screen: [screenX, screenY] as [number, number] }
          }),
          boneLengths: pose.boneLengths,
        },
      }
    } else if (this.handsOn && !handUnavailable && !solveContacts.length) handReason = 'none'
    if (this.handsOn && handUnavailable) handReason = 'unavailable'
    for (const item of drawItems) drawItem(item)
    gl.depthMask(true)
    gl.disable(gl.BLEND)
    if (hand && handGeometry && this.shownHand) {
      hand.mesh.rendered = this.drawHandGeometry(handGeometry, style, hand.state)
      const pose = this.shownHand.pose
      const wrist = pose.wrist
      if (wrist) {
        const knuckles = pose.fingers.map((finger) => finger.joints[0])
        const centre = [0, 1, 2].map((axis) => mean(knuckles.map((joint) => joint[axis])))
        const direction = [wrist[0] - centre[0], wrist[1] - centre[1], wrist[2] - centre[2]]
        const across = [0, 1, 2].map((axis) => pose.fingers[3].joints[0][axis] - pose.fingers[0].joints[0][axis])
        this.drawHandGeometry(this.wristGeometry(wrist, direction, across), style, hand.state, 'forearm')
      }
    }
    const stringGuides = this.stringGuides(width, height, handGeometry, handPoseKey)
    gl.disable(gl.SCISSOR_TEST)
    let pick: FrettedPick | null = null
    const openTargets: FrettedOpenTarget[] = []
    const fretRegions: FrettedFretRegion[] = []
    {
      // The pick strikes the strings in the strumming zone between the end of the fretboard and the middle pickup.
      const pickX = this.pickingX
      const points = this.config.strings.flatMap((string) => {
        const point = this.stringPointAtX(string.string, pickX)
        return point ? [{ string: string.string, point }] : []
      })
      const recent = playing && !countingIn
        ? plan.filter((note) => note.position && note.startBeat <= beat + 1e-8 &&
          (!loop || note.startBeat >= loop.start && note.startBeat < loop.end) &&
          (beat - note.startBeat) * secondsPerBeat < 0.45)
          .reduce<FrettedTabNote | undefined>((best, note) =>
            !best || note.startBeat >= best.startBeat ? note : best, undefined)
        : undefined
      // The picking action comes from the lesson: several strings at once is a downstroke from
      // the low string toward the high string; one string is a single-string pick; none is a rest.
      const focus = activeNotes.length ? activeNotes : nextNotes
      const focusStrings = [...new Set(focus.flatMap((note) => note.position ? [note.position.string] : []))]
      const onset = activeNotes.length ? Math.min(...activeNotes.map((note) => note.startBeat)) : beat
      const age = Math.max(0, (beat - onset) * secondsPerBeat)
      const moving = playing && !countingIn && !reducedMotion && activeNotes.length > 0
      const lowY = points[0]?.point[1] ?? 0, highY = points[points.length - 1]?.point[1] ?? 0
      const meanZ = mean(points.map((item) => item.point[2]))
      const centerY = mean(points.map((item) => item.point[1]))
      let tipY = centerY, hover = 0.024, sweep = 0.5
      const chosen = focusStrings.length === 1 ? points.find((item) => item.string === focusStrings[0]) : undefined
      if (focusStrings.length > 1) {
        const progress = moving ? clamped(age / 0.2, 0, 1) : 0
        sweep = progress * progress * (3 - 2 * progress)
        tipY = lowY + 0.014 + (highY - 0.012 - (lowY + 0.014)) * sweep
        hover = moving && progress > 0.04 && progress < 0.96 ? -0.001 : 0.012
      } else if (chosen) {
        tipY = chosen.point[1]
        hover = 0.012 - (moving ? 0.013 * Math.exp(-age * 8) : 0)
      }
      const base: HandVector = chosen?.point ?? [pickX, tipY, meanZ]
      const pickerSide = worldHand
      const pickerAsset = this.handAssets?.[pickerSide]
      let [x, y] = this.projected([pickX, tipY, meanZ + hover], width, height)
      let size = 0
      if (pickerAsset && this.handsOn) {
        let rest = this.pickingRest.get(pickerSide)
        if (!rest) { rest = restingPickingHand(pickerAsset); this.pickingRest.set(pickerSide, rest) }
        const sign = worldHand === 'right' ? 1 : -1
        // The pick points down toward the strings and across them; the forearm arrives from the body's edge.
        const forward = normalise([0.3, -sign * (0.45 + 0.25 * (sweep - 0.5)), -0.84])
        const squeezeSeed = [0, 0, 1]
        const along = squeezeSeed[0] * forward[0] + squeezeSeed[1] * forward[1] + squeezeSeed[2] * forward[2]
        const squeeze = normalise(squeezeSeed.map((value, axis) => value - forward[axis] * along))
        const placed = this.placePickingHand(rest, forward, squeeze, [pickX, tipY, meanZ + hover])
        this.drawHandGeometry(placed.hand, style, 'pressed', 'pick')
        const pickArm = [placed.wrist[0] - placed.knuckles[0], placed.wrist[1] - placed.knuckles[1], placed.wrist[2] - placed.knuckles[2]]
        // The wrist continues back along the hand, 5 cm, and fades out.
        this.drawHandGeometry(this.wristGeometry(placed.wrist, pickArm, placed.across), style, 'pressed', 'pickForearm')
        this.drawHandGeometry(placed.pick, style, 'pressed', 'plectrum');
        [x, y] = this.projected(placed.tip, width, height)
        const [leftX, leftY] = this.projected(placed.lateral, width, height)
        const [rightX, rightY] = this.projected(placed.lateralOther, width, height)
        size = Math.hypot(leftX - rightX, leftY - rightY)
      }
      const [neckX, neckY] = this.projected([base[0] + 0.05, base[1], base[2] + 0.004], width, height)
      pick = { x, y, angle: Math.atan2(neckY - y, neckX - x) * 180 / Math.PI, size,
        string: chosen?.string ?? null, index: recent?.index ?? null, active: !!recent }
      const openSeen = new Set<number>()
      for (const [notes, state] of [[activeNotes, 'playback']] as const)
        for (const note of notes) {
          const position = note.position
          if (!position || position.fret !== 0 || openSeen.has(position.string)) continue
          const point = this.stringPointAtX(position.string, this.fretLineX(0) + 0.012)
          if (!point) continue
          openSeen.add(position.string)
          const [px, py] = this.projected([point[0], point[1], point[2] + 0.006], width, height)
          openTargets.push({ index: note.index, string: position.string,
            conventionalStringNumber: position.conventionalStringNumber,
            name: this.config.strings[position.string - 1].name, pitchName: position.pitchName,
            state, x: px, y: py })
        }
      const first = this.config.strings[0], last = this.config.strings[this.config.strings.length - 1]
      const regionFrets = new Set<number>()
      for (const [notes, state] of [[activeNotes, 'playback']] as const)
        for (const note of notes) {
          const fret = note.position?.fret ?? 0
          if (fret < 1 || regionFrets.has(fret)) continue
          const corner = (x: number, edge: typeof first, side: number): [number, number] | null => {
            const point = this.stringPointAtX(edge.string, x)
            return point ? this.projected([x, point[1] + side * 0.0065, point[2] + 0.004], width, height) : null
          }
          const x0 = this.fretLineX(fret - 1), x1 = this.fretLineX(fret)
          const points = [corner(x0, first, 1), corner(x1, first, 1), corner(x1, last, -1), corner(x0, last, -1)]
          if (points.some((point) => !point)) continue
          regionFrets.add(fret)
          fretRegions.push({ fret, state, points: points as [number, number][] })
        }
    }
    const projectFret = (string: number, fret: number): [number, number] | null => {
      const point = this.stringPointAtX(string, fret === 0 ? this.fretLineX(0) + 0.012 : this.pressX({ fret } as FrettedPosition))
      return point ? this.projected([point[0], point[1], point[2] + (fret === 0 ? 0.006 : 0.0012)], width, height) : null
    }
    return { projectFret, markers, openTargets, fretRegions, bounds: silhouette, stringLabels, fretLabels, stringCues, plucks,
      pick, stringGuides, vibrations, hand, handUnavailable, handPending, handDrawn, handReason, handBlending,
      handCurrent: !handDrawn || handPoseKey === null || this.shownHand?.key === handPoseKey,
      handsVisible: this.handsOn, triangles }
  }

  dispose() {
    this.handWorker?.terminate()
    this.handWorker = null
    this.pendingHandPoses.clear()
    this.handPoses.clear()
    this.prefetchWindow = ''
    const gl = this.gl
    for (const buffer of this.buffers) { gl.deleteBuffer(buffer.vertex); gl.deleteBuffer(buffer.index) }
    for (const buffers of Object.values(this.handBuffers ?? {})) {
      if (!buffers) continue
      gl.deleteBuffer(buffers.vertex)
      gl.deleteBuffer(buffers.index)
    }
    for (const texture of this.textures) gl.deleteTexture(texture)
    if (this.background) {
      gl.deleteBuffer(this.background.buffer)
      gl.deleteProgram(this.background.program)
      this.background = null
    }
    this.mirrorFitCache = null
    this.silhouette = []
    gl.deleteProgram(this.program)
    this.items = []
    this.buffers.length = 0
    this.textures.length = 0
    this.handBuffers = null
    this.uploadedSlots = {}
    this.shownHand = null
    this.stringCenterlines.clear()
    this.cachedStringGuides = []
    this.stringGuideKey = ''
  }
}

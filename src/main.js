import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FlowSystem, shared } from './flow.js';
import { initHeroFlow } from './hero-flow.js';
import './styles.css';

const $ = (s) => document.querySelector(s);
const MOBILE = matchMedia('(max-width: 700px)').matches;
const TEST = location.search.includes('test');
const DBG = new URLSearchParams(location.search).get('dbg') || '';
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const state = {
  speed: 100, density: 1.225, area: 2.2, phase: 0, riblets: true, owlEdges: true,
  mode: 'split', time: 0, pointerX: 0, pointerY: 0, targetPointerX: 0, targetPointerY: 0,
  layers: { streams: true, particles: true, smoke: true },
};

const controls = { speed: $('#speedRange'), density: $('#densityRange'), area: $('#areaRange'), phase: $('#phaseRange'), riblets: $('#ribletToggle'), owlEdges: $('#owlToggle') };
const outputs = {
  speed: $('#speedValue'), density: $('#densityValue'), area: $('#areaValue'), phase: $('#phaseValue'), phaseLabel: $('#flowPhaseLabel'),
  bioDrag: $('#bioDragValue'), conventionalDrag: $('#conventionalDragValue'), reduction: $('#dragReductionValue'), acoustic: $('#acousticValue'), saved: $('#savedDragValue'),
};

const fmt = (v, d = 0) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---- animated numeric readouts ------------------------------------------
const tweened = [];
function tweenTo(el, target, digits = 0) {
  if (!el) return;
  if (el._cur === undefined) { el._cur = target; el.textContent = fmt(target, digits); }
  el._target = target; el._digits = digits;
  if (!tweened.includes(el)) tweened.push(el);
}
function stepTweens() {
  for (let i = tweened.length - 1; i >= 0; i -= 1) {
    const el = tweened[i];
    el._cur += (el._target - el._cur) * 0.18;
    if (Math.abs(el._target - el._cur) < Math.pow(10, -el._digits) * 0.5) { el._cur = el._target; tweened.splice(i, 1); }
    el.textContent = fmt(el._cur, el._digits);
  }
}

// ---- physics (unchanged conceptual model) ---------------------------------
function calculateDrag(cd) { const v = state.speed / 3.6; return 0.5 * state.density * v ** 2 * cd * state.area; }
function calculateCoefficient() { let c = 0.24; if (!state.riblets) c += 0.018; if (!state.owlEdges) c += 0.012; return c; }

// ---- noise model (conceptual, educational) ---------------------------------
// Reference: 100 km/h, 1.225 kg/m3, 2.2 m2, still air -> 68 dBA for the normal car.
// Every variable ADDS or REMOVES decibels relative to that reference:
//   speed      55·log10(v/100)   (aeroacoustic power rises roughly with v^5.5)
//   density    10·log10(rho/1.225)
//   area       10·log10(A/2.2)
//   turbulence +0.35 dB per airflow-phase step
// Bio features then REMOVE noise from the normal car's level; their benefit grows with wake energy (speed)
// and shrinks a little in highly turbulent inflow.
const NOISE_REF = 68;
function noiseModel() {
  const v = state.speed, ph = state.phase;
  const terms = {
    speed: 55 * Math.log10(v / 100),
    density: 10 * Math.log10(state.density / 1.225),
    area: 10 * Math.log10(state.area / 2.2),
    turbulence: 0.35 * ph,
  };
  const added = terms.speed + terms.density + terms.area + terms.turbulence;
  const conv = Math.max(28, NOISE_REF + added);
  const vf = clamp(0.6 + 0.4 * (v / 100), 0.7, 1.2);
  const tf = 1 - 0.012 * ph;
  terms.owl = state.owlEdges ? -8 * vf * tf : 0;
  terms.riblets = state.riblets ? -3 * vf : 0;
  const bio = Math.max(26, conv + terms.owl + terms.riblets);
  return { terms, conv, bio, added, reduced: conv - bio };
}
let NOISE = noiseModel();
let lastBioNoise = null, deltaTimer = 0;
const NOISE_ROWS = [
  ['speed', 'Vehicle speed'], ['density', 'Air density'], ['area', 'Frontal area'], ['turbulence', 'Airflow turbulence'],
  ['riblets', 'Shark riblets'], ['owl', 'Owl edge'],
];
const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;

function buildNoiseRows() {
  const host = $('#noiseBreakdown'); if (!host) return;
  host.innerHTML = NOISE_ROWS.map(([k, label]) => `<div class="noise-row" data-k="${k}"><span class="nr-label">${label}</span><span class="nr-track"><i></i></span><b class="nr-val">0.0</b></div>`).join('');
}

function renderNoise(changed) {
  const n = NOISE;
  const pct = (db) => clamp((db - 25) / 75, 0, 1) * 100;
  const set = (id, fn) => { const el = $(id); if (el) fn(el); };
  set('#noiseConvBar', (el) => { el.style.width = `${pct(n.conv)}%`; });
  set('#noiseBioBar', (el) => { el.style.width = `${pct(n.bio)}%`; });
  set('#noiseConvValue', (el) => tweenTo(el, Math.round(n.conv)));
  set('#noiseBioValue', (el) => tweenTo(el, Math.round(n.bio)));
  set('#noiseSavedValue', (el) => { el.textContent = n.reduced.toFixed(1); });
  set('#noiseAddedValue', (el) => { el.textContent = signed(n.added); el.dataset.dir = n.added > 0.05 ? 'up' : n.added < -0.05 ? 'down' : 'flat'; });
  set('#hudConv', (el) => { el.textContent = Math.round(n.conv); });
  set('#hudBio', (el) => { el.textContent = Math.round(n.bio); });
  document.querySelectorAll('.noise-row').forEach((row) => {
    const v = n.terms[row.dataset.k] || 0, fill = row.querySelector('i');
    const w = clamp(Math.abs(v) / 22, 0, 1) * 50;
    fill.style.width = `${w}%`; fill.style.left = v >= 0 ? '50%' : `${50 - w}%`;
    fill.className = v > 0.05 ? 'add' : v < -0.05 ? 'cut' : '';
    row.querySelector('.nr-val').textContent = signed(v);
  });
  // live "noise added / reduced" badge: change in the bio car's level caused by the last control move
  if (lastBioNoise !== null && changed) {
    const d = n.bio - lastBioNoise;
    const names = { speed: 'speed', density: 'air density', area: 'frontal area', phase: 'turbulence', riblets: 'riblets', owl: 'owl edge', reset: 'reset' };
    ['#noiseDelta', '#hudDelta'].forEach((id) => {
      const el = $(id); if (!el) return;
      if (Math.abs(d) < 0.05) { el.textContent = `no change · ${names[changed]}`; el.dataset.dir = 'flat'; }
      else { el.textContent = `${d > 0 ? '▲ noise added' : '▼ noise reduced'} ${signed(d)} dB · ${names[changed]}`; el.dataset.dir = d > 0 ? 'up' : 'down'; }
      el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    });
  }
  lastBioNoise = n.bio;
  applyAudio();
}

// ---- optional audible wake noise (Web Audio, off until the viewer turns it on) ----
const audio = { ctx: null, on: false, src: 'bio' };
function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
  const ctx = audio.ctx = new AC();
  const len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // pink noise
  for (let i = 0; i < len; i += 1) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 7;
  const body = ctx.createGain(), tone = ctx.createGain(), master = ctx.createGain(), comp = ctx.createDynamicsCompressor();
  body.gain.value = 0; tone.gain.value = 0; master.gain.value = 0.9;
  const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain(); lfo.frequency.value = 4; lfoAmt.gain.value = 0;
  lfo.connect(lfoAmt); lfoAmt.connect(body.gain); lfo.start();
  src.connect(hp); hp.connect(lp); lp.connect(body); body.connect(master);
  hp.connect(bp); bp.connect(tone); tone.connect(master);
  master.connect(comp); comp.connect(ctx.destination); src.start();
  Object.assign(audio, { lp, bp, body, tone, lfo, lfoAmt });
  return true;
}
function applyAudio() {
  if (!audio.ctx) return;
  const n = NOISE, t = audio.ctx.currentTime, isBio = audio.src === 'bio';
  const level = isBio ? n.bio : n.conv, p = isBio ? params.bio : params.conv;
  const amp = audio.on ? Math.min(0.6, 0.9 * Math.pow(10, (level - 85) / 20)) : 0;
  const owlCut = isBio && state.owlEdges ? 0.72 : 1;
  audio.body.gain.setTargetAtTime(amp, t, 0.08);
  audio.tone.gain.setTargetAtTime(amp * 0.9 * p.ws, t, 0.08);              // wake whistle follows wake strength
  audio.lp.frequency.setTargetAtTime((350 + state.speed * 9) * owlCut, t, 0.08); // faster -> brighter hiss
  audio.bp.frequency.setTargetAtTime(900 + state.speed * 6, t, 0.08);
  audio.lfo.frequency.setTargetAtTime(3 + state.phase * 0.4, t, 0.1);
  audio.lfoAmt.gain.setTargetAtTime(amp * 0.35 * (state.phase / 20), t, 0.1);  // turbulence flutter
}
function setSound(on) {
  if (on && !audio.ctx && !startAudio()) { const b = $('#soundToggle'); if (b) b.checked = false; return; }
  audio.on = on;
  if (audio.ctx) { if (on) audio.ctx.resume(); applyAudio(); }
  document.querySelectorAll('.src-chip').forEach((c) => c.classList.toggle('active', c.dataset.src === audio.src));
}
document.addEventListener('visibilitychange', () => { if (audio.ctx) { if (document.hidden) audio.ctx.suspend(); else if (audio.on) audio.ctx.resume(); } });

function updateRangeFill(input) {
  const p = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.background = `linear-gradient(90deg, var(--acid) 0%, var(--acid) ${p}%, #35433b ${p}%, #35433b 100%)`;
}

function flowParams(bio) {
  const turb = 0.25 + (state.phase / 20) * 1.75;
  let ws = 1;
  if (bio) ws = 0.34 + (state.riblets ? 0 : 0.2) + (state.owlEdges ? 0 : 0.3);
  const owl = bio && state.owlEdges;
  const f = clamp((ws - 0.3) / 0.7, 0, 1);
  return {
    ws, turb, bl: bio && state.riblets ? 0.2 : bio ? 0.3 : 0.38,
    wh: 0.4 + 0.22 * f, ww: 0.75 + 0.25 * f, lw: 2.4 + 1.8 * f, rec: 0.5 + 0.85 * f,
    k: owl ? 5.4 : 2.7, amp: 0.5 * turb * (owl ? 0.55 : 1), omega: 4,
  };
}
const params = { conv: flowParams(false), bio: flowParams(true) };

function updateReadout(changed) {
  const conv = calculateDrag(0.30), bio = calculateDrag(calculateCoefficient());
  const saved = conv - bio, red = conv > 0 ? (saved / conv) * 100 : 0;
  NOISE = noiseModel();
  const acoustic = NOISE.bio;
  outputs.speed.textContent = fmt(state.speed);
  outputs.density.textContent = state.density.toFixed(3);
  outputs.area.textContent = state.area.toFixed(1);
  outputs.phase.textContent = String(state.phase).padStart(2, '0');
  outputs.phaseLabel.textContent = `PHASE ${String(state.phase).padStart(2, '0')}`;
  tweenTo(outputs.bioDrag, Math.round(bio)); tweenTo(outputs.conventionalDrag, Math.round(conv));
  tweenTo(outputs.reduction, red, 1); tweenTo(outputs.acoustic, Math.round(acoustic)); tweenTo(outputs.saved, Math.round(saved));
  Object.values(controls).forEach((c) => { if (c.type === 'range') updateRangeFill(c); });
  params.conv = flowParams(false); params.bio = flowParams(true);
  updateLabels();
  renderNoise(changed);
}

function updateLabels() {
  const wake = (p) => Math.round(p.ws * 100);
  const feat = state.riblets && state.owlEdges ? 'RIBLETS + OWL EDGE' : state.riblets ? 'RIBLETS ONLY' : state.owlEdges ? 'OWL EDGE ONLY' : 'FEATURES OFF';
  $('#labelConvSub').textContent = `BASELINE BODY · WAKE ${wake(params.conv)} · ${Math.round(NOISE.conv)} dBA`;
  $('#labelBioSub').textContent = `${feat} · WAKE ${wake(params.bio)} · ${Math.round(NOISE.bio)} dBA`;
  $('#wakeBarConv').style.width = `${wake(params.conv)}%`;
  $('#wakeBarBio').style.width = `${wake(params.bio)}%`;
}

function bindControls() {
  controls.speed.addEventListener('input', () => { state.speed = Number(controls.speed.value); updateReadout('speed'); });
  controls.density.addEventListener('input', () => { state.density = Number(controls.density.value); updateReadout('density'); });
  controls.area.addEventListener('input', () => { state.area = Number(controls.area.value); updateReadout('area'); });
  controls.phase.addEventListener('input', () => { state.phase = Number(controls.phase.value); updateReadout('phase'); });
  controls.riblets.addEventListener('change', () => { state.riblets = controls.riblets.checked; updateReadout('riblets'); });
  controls.owlEdges.addEventListener('change', () => { state.owlEdges = controls.owlEdges.checked; updateReadout('owl'); });
  $('#resetButton').addEventListener('click', () => {
    Object.assign(state, { speed: 100, density: 1.225, area: 2.2, phase: 0, riblets: true, owlEdges: true });
    controls.speed.value = 100; controls.density.value = 1.225; controls.area.value = 2.2; controls.phase.value = 0;
    controls.riblets.checked = true; controls.owlEdges.checked = true; updateReadout('reset');
  });
  document.querySelectorAll('.mode-button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.mode-button').forEach((i) => i.classList.remove('active'));
    b.classList.add('active'); state.mode = b.dataset.mode; applyMode();
  }));
  document.querySelectorAll('.layer-chip').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.layer; state.layers[k] = !state.layers[k]; b.classList.toggle('active', state.layers[k]);
    flows.forEach((f) => f.setLayers(state.layers));
  }));
  const snd = $('#soundToggle'); if (snd) snd.addEventListener('change', () => setSound(snd.checked));
  document.querySelectorAll('.src-chip').forEach((c) => c.addEventListener('click', () => { audio.src = c.dataset.src; setSound(audio.on); }));
  const wrap = $('#sceneWrap');
  wrap.addEventListener('pointermove', (e) => { const r = wrap.getBoundingClientRect(); state.targetPointerX = (e.clientX - r.left) / r.width - 0.5; state.targetPointerY = (e.clientY - r.top) / r.height - 0.5; });
  wrap.addEventListener('pointerleave', () => { state.targetPointerX = 0; state.targetPointerY = 0; });
}

// ===========================================================================
// Three.js scene
// ===========================================================================
const canvas = $('#sceneCanvas');
const wrap = $('#sceneWrap');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = TEST ? 0.8 : Math.min(window.devicePixelRatio, MOBILE ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const BG = 0x060d0b;
scene.background = new THREE.Color(BG);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(30, 1.4, 0.1, 100);
camera.position.set(-4.2, 4.6, 13.2);
const orbit = new OrbitControls(camera, canvas);
orbit.enablePan = false; orbit.enableDamping = true; orbit.dampingFactor = 0.06;
orbit.minDistance = 6; orbit.maxDistance = 22; orbit.maxPolarAngle = Math.PI * 0.485;
orbit.target.set(0.35, 0.5, 0);
orbit.autoRotate = true; orbit.autoRotateSpeed = 0.25;
orbit.addEventListener('start', () => { orbit.autoRotate = false; });

// lights
scene.add(new THREE.HemisphereLight(0x9fe8d6, 0x0b1612, 0.7));
const key = new THREE.DirectionalLight(0xe8fff2, 2.4); key.position.set(-5, 8, 6); scene.add(key);
const rimC = new THREE.DirectionalLight(0xff8a63, 2.0); rimC.position.set(5, 3, -6); scene.add(rimC);
const rimB = new THREE.DirectionalLight(0xb8ff6a, 1.6); rimB.position.set(-6, 2, -4); scene.add(rimB);

// ---- floor: rolling road ------------------------------------------------
const floorMat = new THREE.ShaderMaterial({
  uniforms: { uScroll: { value: 0 }, uTime: shared.uTime, uL0: { value: -2 }, uL1: { value: 2 }, uBg: { value: new THREE.Color(BG) }, uSplit: { value: 1 } },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
    uniform float uScroll; uniform float uTime; uniform float uL0; uniform float uL1; uniform vec3 uBg; uniform float uSplit;
    varying vec3 vW;
    float h(float n){ return fract(sin(n*127.1)*43758.5453); }
    void main(){
      vec2 p = vW.xz;
      float dist = length(p*vec2(0.62,1.0));
      float fade = 1.0 - smoothstep(3.5, 13.0, dist);
      vec2 g = vec2(p.x - uScroll, p.y);
      vec2 f = abs(fract(g) - 0.5);
      float lx = smoothstep(0.478,0.5,f.x), lz = smoothstep(0.488,0.5,f.y);
      float grid = max(lx*0.55, lz*0.3);
      float l0 = exp(-pow((p.y - uL0)/1.25,2.0)) * uSplit;
      float l1 = exp(-pow((p.y - uL1)/1.25,2.0));
      vec3 base = vec3(0.028,0.055,0.047);
      vec3 col = base + vec3(1.0,0.45,0.28)*l0*0.10 + vec3(0.75,1.0,0.35)*l1*0.10;
      col += grid * (vec3(0.22,0.46,0.38) + vec3(1.0,0.5,0.3)*l0*0.5 + vec3(0.75,1.0,0.3)*l1*0.5) * 0.55;
      float row = floor(p.y*5.0);
      float dash = step(0.93 - 0.0, fract(p.x*0.22 - uScroll*0.9*(0.6+h(row)) + h(row+3.0))) * step(0.55, h(row)) * (l0+l1);
      col += dash * vec3(0.55,0.95,0.85) * 0.5;
      float rim = (exp(-pow((abs(p.y-uL0)-1.2)/0.03,2.0))*uSplit + exp(-pow((abs(p.y-uL1)-1.2)/0.03,2.0)))*0.5;
      col += rim*vec3(0.5,0.9,0.7)*0.35;
      gl_FragColor = vec4(mix(uBg, col, fade), 1.0);
    }`,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), floorMat);
floor.rotation.x = -Math.PI / 2; floor.position.y = 0; scene.add(floor);

// soft contact shadow texture
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
})();

// ---- vehicles -----------------------------------------------------------
const loader = new GLTFLoader();
const vehicles = [];
const flows = [];
const toCar = { value: new THREE.Matrix4() };

function makeShellMaterial(bio) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(bio ? 0xccff66 : 0xff7a5a) }, uTime: shared.uTime, uToCar: { value: new THREE.Matrix4() },
      uRiblet: { value: bio ? 1 : 0 }, uOwl: { value: bio ? 1 : 0 }, uBio: { value: bio ? 1 : 0 }, uIntensity: { value: 1 }, uPhase: { value: bio ? 1.7 : 0 },
    },
    vertexShader: `
      uniform mat4 uToCar; varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main(){
        vec4 wp = modelMatrix*vec4(position,1.0);
        vec3 wn = mat3(modelMatrix)*normal; float wl = length(wn); wn = wl > 1e-5 ? wn/wl : vec3(0.0,1.0,0.0);
        wp.xyz += wn*0.012;
        vN = wn; vV = normalize(cameraPosition - wp.xyz); vL = (uToCar*wp).xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uRiblet; uniform float uOwl; uniform float uBio; uniform float uIntensity; uniform float uPhase;
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main(){
        float nl = length(vN), vl = length(vV);
        vec3 N = nl > 1e-4 ? vN/nl : vec3(0.0,1.0,0.0), V = vl > 1e-4 ? vV/vl : vec3(0.0,0.0,1.0);
        float fr = pow(1.0 - abs(dot(N,V)), 2.6);
        float a = fr*0.6;
        vec3 col = uColor;
        float sp = mix(-2.6, 2.6, fract(uTime*0.15 + uPhase));
        float band = exp(-pow((vL.x - sp)*2.4, 2.0));
        a += band*(0.03 + fr*0.5);
        col = mix(col, vec3(1.0), band*0.5);
        if(uBio > 0.5){
          float st = sin((vL.z + vL.y*0.35)*90.0)*0.5+0.5;
          float lines = smoothstep(0.8,0.98,st);
          float body = smoothstep(-1.8,-1.3,vL.x)*(1.0-smoothstep(1.3,1.9,vL.x));
          a += uRiblet*lines*body*(0.12 + 0.3*clamp(N.y*0.5+0.5,0.0,1.0));
          float rear = smoothstep(1.2,2.1,vL.x);
          float tri = abs(fract(vL.z*8.0 + vL.y*1.5)-0.5)*2.0;
          float teeth = step(tri, rear*1.15-0.05)*rear;
          col = mix(col, vec3(1.0,0.62,0.45), uOwl*rear);
          a += uOwl*(teeth*0.5 + rear*fr*0.6);
        }
        float aa = a*uIntensity; if (!(aa == aa)) aa = 0.0;
        gl_FragColor = vec4(clamp(col, 0.0, 4.0), clamp(aa, 0.0, 4.0));
      }`,
  });
}

const RING_N = 6;
// Which way each GLB's nose points before we orient it (scene convention: nose at -x, wind toward +x).
//   bio car (202009122216-2.glb): grille/bonnet at +x  -> rotate 180°
//   Koenigsegg GLB: front wheels/nose at +z (rear lights at -z) -> rotate -90°
const MODEL_YAW = { bio: Math.PI, conv: -Math.PI / 2 };

function createVehicle(bio) {
  const lane = new THREE.Group();
  const car = new THREE.Group(); lane.add(car);
  const shellMat = makeShellMaterial(bio);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 3.0), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; lane.add(shadow);
  const glow = new THREE.PointLight(bio ? 0xb8ff6a : 0xff7a55, 2.2, 6, 2); glow.position.set(0, 0.25, 0); lane.add(glow);

  const teethMat = new THREE.MeshBasicMaterial({ color: 0xffd2bd, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
  const teeth = new THREE.Mesh(new THREE.BufferGeometry(), teethMat); teeth.visible = false; car.add(teeth);

  // expanding "sound rings" shed from the wake; count/brightness/speed follow the live noise level
  const rings = [];
  const ringGeo = new THREE.RingGeometry(0.93, 1, 56);
  for (let i = 0; i < RING_N; i += 1) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: bio ? 0xccff66 : 0xff7a55, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.y = Math.PI / 2; m.position.set(2.2, 0.62, 0); m.renderOrder = 7; m.visible = false; lane.add(m); rings.push(m);
  }
  const meta = { bio, lane, car, shellMat, teethMat, teeth, rings, laneZ: bio ? 2 : -2, z: bio ? 2 : -2, vis: 1, rib: bio ? 1 : 0, owl: bio ? 1 : 0 };
  scene.add(lane); vehicles.push(meta);

  const url = bio ? '/models/202009122216-2.glb' : '/models/uploads_files_2792345_Koenigsegg.glb';
  loader.load(url, (gltf) => {
    const model = gltf.scene;
    // defensive: drop any leftover ground/helper planes some exports ship with
    const junk = []; model.traverse((n) => { if (/^plane0*1?$/i.test((n.name || '').replace('.', ''))) junk.push(n); });
    junk.forEach((n) => n.removeFromParent());
    model.rotation.y = bio ? MODEL_YAW.bio : MODEL_YAW.conv;
    model.updateMatrixWorld(true);
    // measure from the real vertices (ignores stray/unreferenced geometry) so centering + ground contact are exact
    const b = new THREE.Box3().setFromObject(model, true);
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const s = 4.3 / Math.max(size.x, size.z);
    model.scale.setScalar(s);
    // ground the car on its WHEELS (a stray body part hanging below them must never lift the car)
    let groundY = b.min.y;
    const wb = new THREE.Box3(); let hasWheels = false;
    model.traverse((n) => { if (/^(roda\d*|wheel.*|FL|FR|RL|RR)$/i.test(n.name || '')) { wb.expandByObject(n, true); hasWheels = true; } });
    if (hasWheels && Number.isFinite(wb.min.y)) groundY = wb.min.y;
    model.position.set(-c.x * s, -groundY * s, -c.z * s);
    const shells = [], seen = new Set();
    model.traverse((n) => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m || seen.has(m)) return; seen.add(m);          // shared materials (mirrored half, wheels) are tuned once
        if (bio && m.color) m.color.multiplyScalar(0.55);
        m.envMapIntensity = 1;
        if ('roughness' in m) m.roughness = Math.min(m.roughness ?? 0.5, 0.45);
      });
      const sh = new THREE.Mesh(n.geometry, shellMat); sh.userData.shell = true; sh.renderOrder = 3; shells.push([n, sh]);
    });
    if (!DBG.includes('noshell')) shells.forEach(([n, sh]) => n.add(sh));
    car.add(model);
    meta.model = model;
    if (bio) buildTeeth(meta);
  }, undefined, (e) => console.error('model load failed', url, e));
  return meta;
}

// serrated owl-style trailing edge, placed on the real rear deck via raycasts
function buildTeeth(meta) {
  meta.car.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(); const targets = []; meta.model.traverse((n) => { if (n.isMesh && !n.userData.shell) targets.push(n); });
  const xEdge = 1.7, count = 17, half = 0.72, w = (half * 2) / (count - 1), pos = [];
  for (let i = 0; i < count; i += 1) {
    const z = -half + i * w;
    rc.set(meta.car.localToWorld(new THREE.Vector3(xEdge, 3, z)), new THREE.Vector3(0, -1, 0));
    const hit = rc.intersectObjects(targets, false)[0]; if (!hit) continue;
    const y = meta.car.worldToLocal(hit.point.clone()).y + 0.01;
    pos.push(xEdge, y, z - w * 0.46, xEdge, y, z + w * 0.46, xEdge + 0.26, y - 0.05, z);
  }
  if (!pos.length) return;
  meta.teeth.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  meta.teeth.visible = true;
}

const conventional = createVehicle(false);
const bioInspired = createVehicle(true);
[conventional, bioInspired].forEach((v) => {
  const fs = new FlowSystem(v.bio, MOBILE); if (DBG.includes('noflow')) fs.group.visible = false; v.flow = fs; flows.push(fs); v.lane.add(fs.group);
});

function applyMode() {
  const split = state.mode === 'split';
  conventional.laneZ = -2; bioInspired.laneZ = split ? 2 : 0;
  floorMat.uniforms.uL1.value = bioInspired.laneZ;
  zoomAnim = { t: 0, from: camera.position.distanceTo(orbit.target), to: split ? 14.4 : 10.2 };
  wrap.dataset.mode = state.mode;
}
let zoomAnim = null;

// ---- post-processing -----------------------------------------------------
// Post stack is built by a function so we can rebuild a lighter one if the GPU/driver
// renders it black (HalfFloat + MSAA targets are the usual culprit on some machines).
const FINISH_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: shared.uTime },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5; float d = length(c);
      vec2 off = c*d*0.0035;
      vec4 col = vec4(texture2D(tDiffuse, vUv+off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv-off).b, 1.0);
      col.rgb *= 1.0 - smoothstep(0.35, 0.95, d)*0.55;
      float g = fract(sin(dot(vUv*vec2(1731.0,913.0) + uTime, vec2(12.9898,78.233)))*43758.5453);
      col.rgb += (g-0.5)*0.012;
      gl_FragColor = col;
    }`,
};
function buildComposer(samples, withBloom, halfFloat) {
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, samples });
  const c = new EffectComposer(renderer, rt);
  c.addPass(new RenderPass(scene, camera));
  if (withBloom && !DBG.includes('nobloom')) c.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.5, 0.8));
  c.addPass(new ShaderPass(FINISH_SHADER));
  c.addPass(new OutputPass());
  c.setPixelRatio(pixelRatio);
  const r = wrap.getBoundingClientRect(); if (r.width && r.height) c.setSize(r.width, r.height);
  return c;
}
// tier 0: full stack · 1: no MSAA, 8-bit target · 2: no post-processing at all (direct render)
const TIERS = [[MOBILE || TEST ? 0 : 4, true, true], [0, true, false], null];
let tier = DBG.includes('nopost') ? 2 : 0;
let composer = tier < 2 ? buildComposer(...TIERS[tier]) : null;
let frameNo = 0, probes = 0, blackStreak = 0;

// Reads a few pixels of what was just drawn. A live scene is never pure black (background is dark green).
function frameIsBlack() {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return true;
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(4);
  let peak = 0;
  for (const [fx, fy] of [[.5, .5], [.3, .35], [.7, .35], [.3, .7], [.7, .7], [.5, .2], [.5, .8]]) {
    gl.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    peak = Math.max(peak, px[0], px[1], px[2]);
  }
  return peak <= 2;
}
function renderFrame() {
  if (tier < 2) composer.render(); else renderer.render(scene, camera);
  frameNo += 1;
  const every = probes < 12 ? 20 : 240;
  if (frameNo % every !== 0) return;
  probes += 1;
  blackStreak = frameIsBlack() ? blackStreak + 1 : 0;
  if (blackStreak >= 2 && tier < 2) {
    tier += 1; blackStreak = 0; probes = 0;
    console.warn(`[biomotion] output was black - falling back to render tier ${tier}`);
    try { composer.dispose(); } catch (e) { /* ignore */ }
    composer = tier < 2 ? buildComposer(...TIERS[tier]) : null;
  }
}
// GPU/driver resets kill the GL context while the JS loop keeps running (black canvas, FPS still ticking).
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[biomotion] WebGL context lost'); });
canvas.addEventListener('webglcontextrestored', () => location.reload());
renderer.debug.onShaderError = (gl, program, vs, fs) => console.error('[biomotion] shader error', gl.getProgramInfoLog(program));

function resize() {
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(r.width, r.height, false);
  if (composer) { composer.setPixelRatio(pixelRatio); composer.setSize(r.width, r.height); }
  camera.aspect = r.width / r.height;
  // keep both lanes in frame on narrow screens
  const D = 14.4, W = 10.6;
  camera.fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(W / (2 * camera.aspect * D))), 30, 64);
  camera.updateProjectionMatrix();
  shared.uRes.value.set(r.width * pixelRatio, r.height * pixelRatio);
  shared.uPR.value = pixelRatio;
  shared.uPx.value = (r.height * pixelRatio * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
}

// ---- tracking labels -----------------------------------------------------
const labels = [
  { el: $('#labelConv'), v: conventional }, { el: $('#labelBio'), v: bioInspired },
];
const tmp = new THREE.Vector3();
function updateLabelPositions() {
  const r = wrap.getBoundingClientRect();
  labels.forEach(({ el, v }) => {
    const show = v.lane.visible && v.vis > 0.5;
    el.style.opacity = show ? '1' : '0';
    if (!show) return;
    tmp.set(v.bio ? 2.3 : -1.9, 1.5, v.z).project(camera);
    const x = (tmp.x * 0.5 + 0.5) * r.width, y = (-tmp.y * 0.5 + 0.5) * r.height;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  });
}

// ---- main loop -----------------------------------------------------------
let prev = performance.now(), frames = 0, fpsT = prev, started = performance.now(), degraded = false;
const visible = { v: true };
new IntersectionObserver((e) => { visible.v = e[0].isIntersecting; }, { threshold: 0 }).observe(wrap);

function animate(now) {
  requestAnimationFrame(animate);
  stepTweens();
  if (!visible.v) { prev = now; return; }
  const dt = Math.min((now - prev) / 1000, 0.05); prev = now;
  const speedFactor = 0.35 + state.speed / 110;
  const U = 3.2 * speedFactor;
  state.time += dt * (0.6 + state.speed / 200);
  shared.uTime.value = state.time;
  shared.uFlow.value = 0.2 * speedFactor;
  shared.uGlobal.value = Math.min(shared.uGlobal.value + dt * 0.7, 1);
  floorMat.uniforms.uScroll.value += dt * U;
  state.pointerX += (state.targetPointerX - state.pointerX) * 0.07;
  state.pointerY += (state.targetPointerY - state.pointerY) * 0.07;

  const split = state.mode === 'split';
  vehicles.forEach((v) => {
    const hideTarget = !split && !v.bio ? 0 : 1;
    v.vis += (hideTarget - v.vis) * 0.12;
    v.z += (v.laneZ - v.z) * 0.08;
    v.lane.position.z = v.z; v.lane.visible = v.vis > 0.02;
    v.car.rotation.y = state.pointerX * 0.16 + Math.sin(state.time * 0.55 + (v.bio ? 1 : 0)) * 0.012;
    v.car.rotation.x = state.pointerY * -0.05;
    v.car.position.y = Math.sin(state.time * 1.8 + (v.bio ? 1 : 0)) * 0.012;
    v.car.updateMatrixWorld(true);
    v.shellMat.uniforms.uToCar.value.copy(v.car.matrixWorld).invert();
    v.shellMat.uniforms.uIntensity.value = v.vis * (v.bio ? 0.9 : 0.55);
    if (v.bio) {
      v.rib += ((state.riblets ? 1 : 0) - v.rib) * 0.12; v.owl += ((state.owlEdges ? 1 : 0) - v.owl) * 0.12;
      v.shellMat.uniforms.uRiblet.value = v.rib; v.shellMat.uniforms.uOwl.value = v.owl;
      v.teethMat.opacity = v.owl * 0.85 * (0.75 + 0.25 * Math.sin(state.time * 5));
    }
    // sound rings: more + brighter + faster as the noise level (dB) rises, softer for the bio car
    const lvl = v.bio ? NOISE.bio : NOISE.conv, loud = clamp((lvl - 40) / 50, 0, 1);
    const rate = 0.16 + state.speed / 420;
    v.rings.forEach((r, i) => {
      const act = i < 2 + Math.round(loud * (RING_N - 2));
      const ph = (((state.time * rate * 2.4) + i / RING_N) % 1 + 1) % 1;
      r.visible = act && v.lane.visible;
      if (!r.visible) return;
      const sc = 0.3 + ph * (1.2 + loud * 1.4);
      r.scale.set(sc, sc * 0.62, 1);
      r.position.x = 2.2 + ph * (1.6 + loud * 2.4);
      r.material.opacity = Math.pow(1 - ph, 1.6) * (0.06 + loud * 0.5) * v.vis;
    });
    v.flow.group.visible = v.lane.visible && !DBG.includes('noflow');
    v.flow.group.children.forEach((c) => { if (c.material?.uniforms?.uOpacity) c.material.uniforms.uOpacity.value = v.vis; });
    if (v.lane.visible) v.flow.update(dt, v.bio ? params.bio : params.conv, state.time, U);
  });
  floorMat.uniforms.uSplit.value = conventional.vis;

  if (zoomAnim) {
    zoomAnim.t = Math.min(zoomAnim.t + dt / 1.1, 1);
    const e = zoomAnim.t * zoomAnim.t * (3 - 2 * zoomAnim.t), want = lerp(zoomAnim.from, zoomAnim.to, e);
    const off = camera.position.clone().sub(orbit.target); off.setLength(want); camera.position.copy(orbit.target).add(off);
    if (zoomAnim.t >= 1) zoomAnim = null;
  }
  orbit.update();
  renderFrame();
  updateLabelPositions();

  frames += 1;
  if (now - fpsT > 1000) {
    const fps = Math.round(frames * 1000 / (now - fpsT));
    $('#fpsReadout').textContent = String(fps); fpsT = now; frames = 0;
    if (!degraded && now - started > 4000 && fps < 24 && pixelRatio > 1) { degraded = true; pixelRatio = 1; resize(); }
  }
}

// ---- boot ---------------------------------------------------------------
function setupReveal() {
  if (TEST) return;
  const targets = document.querySelectorAll('.section-heading, .intro-strip, .metric-card, .principle-card, .method-section, .equation-row, .lab-layout');
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  targets.forEach((t, i) => { t.classList.add('reveal'); t.style.setProperty('--d', `${(i % 4) * 70}ms`); io.observe(t); });
}

window.addEventListener('resize', resize);
bindControls();
buildNoiseRows();
updateReadout();
applyMode();
zoomAnim = null;
camera.position.set(-4.2, 4.6, 13.2);
resize();
const heroCanvas = $('#heroFlow'); if (heroCanvas) initHeroFlow(heroCanvas);
setupReveal();
requestAnimationFrame(animate);

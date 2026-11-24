/* =======================================================================
   PhytoHelios — 3D phototropism simulator
   Two potted plants on either side of an opaque partition. Sun A is fixed
   overhead (control); Sun B travels along an arc set by the dial
   (treatment). Each shoot bends toward its sun in the vertex shader.
   ======================================================================= */

const $ = (id) => document.getElementById(id);
const statusEl = $("stageStatus");
let loadDone = 0;
function setProgress(pct, step) {
  const bar = $("loaderBar"), lab = $("loaderStep"), box = $("loader");
  if (bar) bar.style.width = pct + "%";
  if (lab && step) lab.textContent = step;
  if (box) box.setAttribute("aria-valuenow", String(Math.round(pct)));
}
function track(promise, name) {
  return promise.then((v) => { loadDone++; setProgress(16 + (loadDone / 6) * 80, `${name} ready`); return v; });
}
const buzz = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* not supported */ } };
function fail(err) {
  console.error("[PhytoHelios]", err);
  statusEl.textContent = location.protocol === "file:"
    ? "Open this page through a web server (for example GitHub Pages), not as a local file."
    : "The 3D scene needs WebGL and an internet connection.";
}

/* ---------------- Simulation model ---------------- */
const BASE_LAG  = 4.5;     // hours before curvature starts at optimal fluence
const MAX_BEND  = 55;      // degrees
const MAX_HOURS = 360;
const PLAY_DURATION_MS = 90000;  // full 360 h run takes 90 s (4 h per second)
const SUN_ANGLE_CAP = 55;
const SUN_A_ANGLE = 0;

const toRad = (d) => (d * Math.PI) / 180;
const smoothstep = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const clampBend = (a) => Math.max(-MAX_BEND, Math.min(MAX_BEND, a));
// Blue-light fluence rate (µmol m⁻² s⁻¹): response peaks near 1, weakens when
// very dim, and above 1 the lag lengthens and curvature is attenuated.
const fluenceGain = (I) => { const L = Math.log10(I); return L <= 0 ? Math.exp(-(L * L) / (2 * 0.9 * 0.9)) : Math.exp(-(L * L) / (2 * 1.4 * 1.4)); };
const lagFor = (I) => BASE_LAG * (1 + 0.55 * Math.max(0, Math.log10(I)));
const curLag = () => lagFor(sim.fluence);

/* Photogravitropic model (after Bastien, Douady & Moulia 2015; Galland et al. 2002).
   u   = W(λ)·g(I)·sin(φ − θ)   lateral light signal, from the light the apex
                                 perceived one lag earlier (0 while the light is off)
   ds/dt = (u − s) / τs          auxin asymmetry builds and decays with τs
   dθ/dt = Kp·s − Kg·sin θ       shaded flank outgrows the lit flank; gravity
                                 straightens (sine law)
   The shoot settles at the photogravitropic equilibrium, smaller than φ. */
const KP = 0.15, KG = 0.05, DT = 0.1, TAU_S = 1.5;   // rad h⁻¹, rad h⁻¹, h, h
const PULSE_H = 1, PULSE_BOOST = 4;                 // pulse length (h); higher sensitivity of first-positive curvature (illustrative)
// Relative phototropic effectiveness by colour (phototropin action spectrum: blue peak, red/yellow ineffective).
const SPECTRUM = { blue: { w: 1, nm: 450, hex: 0x6f9bff, css: "#3d7bff", name: "Blue" }, green: { w: 0.08, nm: 530, hex: 0x7cff8e, css: "#2fbf5a", name: "Green" }, red: { w: 0, nm: 660, hex: 0xff6a55, css: "#ff4d3d", name: "Red" } };
const equilibriumDeg = (phiDeg, I, col = sim.colour, mode = sim.mode) => {
  if (mode === "pulse") return 0;                    // a pulse leaves no lasting signal
  const p = KP * fluenceGain(I) * SPECTRUM[col].w, f = toRad(phiDeg);
  return (Math.atan2(p * Math.sin(f), KG + p * Math.cos(f)) * 180) / Math.PI;
};
// Settings are logged against simulated time, so the history is replayed exactly.
const events = [];
function settingsAt(h) {
  let lo = 0, hi = events.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (events[mid].t <= h + 1e-9) lo = mid; else hi = mid - 1; }
  return events[lo];
}
const pulses = [];                                   // start times (h) of light pulses
function lightOn(h, ev) {
  if (ev.mode !== "pulse") return true;
  for (let i = pulses.length - 1; i >= 0; i--) { const p = pulses[i]; if (p <= h + 1e-9) return h < p + PULSE_H; }
  return false;
}
// Five seedlings per room with natural variation (fixed, so runs are repeatable).
const SEEDLINGS = [
  { kp: 1.00, kg: 1.00, lag: 1.00 },
  { kp: 1.28, kg: 0.86, lag: 0.88 },
  { kp: 0.74, kg: 1.18, lag: 1.15 },
  { kp: 1.12, kg: 1.22, lag: 0.94 },
  { kp: 0.88, kg: 0.80, lag: 1.07 },
];
const traj = { A: null, B: null, Bset: [], Aset: [], Bmean: null, Bsd: null, Amean: null, Asd: null, rateB: null, dirty: true };
function runSeedling(phiOf, sp) {
  const N = Math.round(MAX_HOURS / DT), out = new Float32Array(N + 1);
  let th = 0, s = 0;
  for (let i = 1; i <= N; i++) {
    const h = i * DT;
    const now = settingsAt(h);
    const lag = lagFor(now.I) * sp.lag;
    let u = 0;
    if (h > lag) {
      const seen = settingsAt(h - lag);
      if (lightOn(h - lag, seen)) {
        const boost = seen.mode === "pulse" ? PULSE_BOOST : 1;
        u = SPECTRUM[seen.col].w * fluenceGain(seen.I) * boost * Math.sin(toRad(phiOf(seen)) - th);
      }
    }
    s += ((u - s) / TAU_S) * DT;
    th += (KP * sp.kp * s - KG * sp.kg * Math.sin(th)) * DT;
    out[i] = (th * 180) / Math.PI;
  }
  return out;
}
function stats(set) {
  const n = set.length, N = set[0].length, mean = new Float32Array(N), sd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0; for (const a of set) m += a[i]; m /= n;
    let v = 0; for (const a of set) v += (a[i] - m) ** 2;
    mean[i] = m; sd[i] = Math.sqrt(v / (n - 1));
  }
  return { mean, sd };
}
function integrate() {
  traj.Aset = SEEDLINGS.map((sp) => runSeedling(() => SUN_A_ANGLE, sp));
  traj.Bset = SEEDLINGS.map((sp) => runSeedling((ev) => ev.sun, sp));
  const a = stats(traj.Aset), b = stats(traj.Bset);
  traj.Amean = a.mean; traj.Asd = a.sd; traj.Bmean = b.mean; traj.Bsd = b.sd;
  traj.A = traj.Aset[0]; traj.B = traj.Bset[0];
  // Turning rate of B (° h⁻¹), for the flank-growth view.
  const src = sim.reps === 5 ? traj.Bmean : traj.B;
  const r = new Float32Array(src.length);
  const w = Math.round(1 / DT);   // ±1 h window
  for (let i = 0; i < src.length; i++) { const a = Math.max(0, i - w), b = Math.min(src.length - 1, i + w); r[i] = b > a ? (src[b] - src[a]) / ((b - a) * DT) : 0; }
  traj.rateB = r;
  traj.dirty = false;
}
const angleAt = (arr, h) => {
  const x = Math.max(0, Math.min(MAX_HOURS, h)) / DT, i = Math.floor(x), f = x - i;
  return i >= arr.length - 1 ? arr[arr.length - 1] : arr[i] * (1 - f) + arr[i + 1] * f;
};
// The trajectory a room shows: seedling 1, or the mean of five.
const showA = () => (sim.reps === 5 ? traj.Amean : traj.A);
const showB = () => (sim.reps === 5 ? traj.Bmean : traj.B);
function logSettings(firePulse = false) {
  const h = sim.hours;
  while (events.length > 1 && events[events.length - 1].t > h + 1e-9) events.pop(); // a change rewrites the future
  while (pulses.length && pulses[pulses.length - 1] > h + 1e-9) pulses.pop();
  const last = events[events.length - 1];
  const rec = { sun: sim.sunB, I: sim.fluence, col: sim.colour, mode: sim.mode };
  if (events.length > 1 && h - last.t < 1.0) Object.assign(last, rec);   // one drag = one change
  else if (Math.abs(last.t - h) < 1e-6) Object.assign(last, rec);
  else events.push({ t: h, ...rec });
  if (firePulse) pulses.push(h);
  traj.dirty = true;
}
const growthScale = (h) => 0.14 + 0.86 * Math.pow(Math.max(0, Math.min(1, h / MAX_HOURS)), 0.8);

const sim = {
  hours: 0,
  playing: false,
  playStart: 0,
  sunB: 22,                      // dial angle; the sun follows instantly
  fluence: 1,                    // light, µmol m⁻² s⁻¹ (both suns)
  colour: "blue",                // blue | green | red
  mode: "cont",                  // cont | pulse
  reps: 1,                       // 1 plant or 5 seedlings per room
};

events.push({ t: 0, sun: sim.sunB, I: sim.fluence, col: sim.colour, mode: sim.mode });

/* ---------------- Scene layout (world units) ---------------- */
const MODEL_SCALE  = 2.0;
const PLANT_ORIGIN = [0.125, 0.24, 0.057];   // stem base on the soil, model units
const SOIL_Y       = (0.24 + 0.03) * MODEL_SCALE; // pot base sits on the floor
const POT_X        = 1.4;
const SUN_ARC_R    = 1.45;
const SUN_RADIUS   = 0.14;
const BEND_ZONE_START = 0.12;

/* ---------------- 3D ---------------- */
let THREE, GLTFLoader, OrbitControls, RoundedBoxGeometry, RoomEnvironment;

// Model files, relative to the site root. A host can override any of them
// by setting window.PHYTO_MODELS before this script loads.
const MODELS = Object.assign({
  glbPlant: "assets/models/avocado.glb",
  glbSun: "assets/models/sun.glb",
  glbMag: "assets/models/magnifier.glb",
  glbStem: "assets/models/stem.glb",
  glbSundial: "assets/models/sundial.glb",
}, window.PHYTO_MODELS || {});
const modelURL = (path) => (/^(\/|https?:)/.test(path) ? path : new URL(`../${path}`, import.meta.url).href);
const modelCache = {};
function loadBuffer(key) {
  if (!modelCache[key]) {
    modelCache[key] = fetch(modelURL(MODELS[key])).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${MODELS[key]} (${r.status})`);
      return r.arrayBuffer();
    });
  }
  return modelCache[key];
}
// Each call gets its own copy, since a parsed buffer can't be shared by two scenes.
const parseGLB = (key) => loadBuffer(key).then((buf) => new Promise((res, rej) => new GLTFLoader().parse(buf.slice(0), "", res, rej)));

function toFloatAttr(attr) {
  const n = attr.count, s = attr.itemSize, arr = new Float32Array(n * s);
  for (let i = 0; i < n; i++) {
    arr[i * s] = attr.getX(i);
    if (s > 1) arr[i * s + 1] = attr.getY(i);
    if (s > 2) arr[i * s + 2] = attr.getZ(i);
    if (s > 3) arr[i * s + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(arr, s);
}

// Bake every mesh into one space: stem base at the origin, y up.
function bakeModel(root) {
  root.updateMatrixWorld(true);
  const pot = [], shoot = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = new THREE.BufferGeometry();
    ["position", "normal", "uv", "uv1", "color"].forEach((k) => { if (o.geometry.attributes[k]) g.setAttribute(k, toFloatAttr(o.geometry.attributes[k])); });
    if (o.geometry.index) g.setIndex(o.geometry.index);
    g.applyMatrix4(o.matrixWorld);
    g.translate(-PLANT_ORIGIN[0], -PLANT_ORIGIN[1], -PLANT_ORIGIN[2]);
    g.scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    const name = (o.material && o.material.name) || "";
    if (/stebel|vetvi/i.test(name)) g.computeVertexNormals(); // simplified bark: smooth shading
    (/gorshok|material_0/i.test(name) ? pot : shoot).push({ geometry: g, material: o.material });
  });
  const box = new THREE.Box3();
  shoot.forEach((p) => { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); });
  return { pot, shoot, height: box.max.y };
}

const BEND_GLSL_HEAD = "uniform float uBend;\nuniform float uH;\nuniform float uY0;\n";
const BEND_NORMAL = `#include <beginnormal_vertex>
  {
    float nk = uBend / max(uH - uY0, 1e-4);
    float na = nk * max(position.y - uY0, 0.0);
    objectNormal = vec3(objectNormal.x * cos(na) + objectNormal.y * sin(na),
                        -objectNormal.x * sin(na) + objectNormal.y * cos(na),
                        objectNormal.z);
  }`;
const BEND_POSITION = `#include <begin_vertex>
  {
    float bk = uBend / max(uH - uY0, 1e-4);
    if (abs(bk) > 1e-5 && transformed.y > uY0) {
      float ba = bk * (transformed.y - uY0);
      float br = 1.0 / bk;
      float bx = transformed.x;
      transformed.x = br - (br - bx) * cos(ba);
      transformed.y = uY0 + (br - bx) * sin(ba);
    }
  }`;

function injectBend(material, uniforms, withNormals) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    let vs = BEND_GLSL_HEAD + sh.vertexShader.replace("#include <begin_vertex>", BEND_POSITION);
    if (withNormals) vs = vs.replace("#include <beginnormal_vertex>", BEND_NORMAL);
    sh.vertexShader = vs;
  };
  material.customProgramCacheKey = () => "phytohelios-bend-" + (withNormals ? "n" : "d");
}

function makePlant(baked) {
  const uniforms = { uBend: { value: 0 }, uH: { value: baked.height }, uY0: { value: baked.height * BEND_ZONE_START } };
  const root = new THREE.Group();
  baked.pot.forEach((p) => {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.castShadow = true; m.receiveShadow = true;
    root.add(m);
  });
  const shoot = new THREE.Group();
  baked.shoot.forEach((p) => {
    const mat = p.material.clone();
    mat.side = THREE.DoubleSide;
    injectBend(mat, uniforms, true);
    const mesh = new THREE.Mesh(p.geometry, mat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mat.map || null, alphaTest: mat.alphaTest || 0 });
    injectBend(depth, uniforms, false);
    mesh.customDepthMaterial = depth;
    shoot.add(mesh);
  });
  root.add(shoot);
  return { root, shoot, uniforms, height: baked.height };
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,236,170,0.95)");
  grd.addColorStop(0.25, "rgba(255,210,110,0.45)");
  grd.addColorStop(1, "rgba(255,190,80,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSun(gltf, glowTex) {
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const r = Math.max(...box.getSize(new THREE.Vector3()).toArray()) / 2;
  model.position.sub(box.getCenter(new THREE.Vector3()));
  model.traverse((o) => {
    if (o.isMesh && o.material) {
      const m = o.material;
      if (m.map) { m.emissiveMap = m.map; m.emissive = new THREE.Color(0xffffff); m.emissiveIntensity = 1.15; }
      else m.emissive = new THREE.Color(0xffcc55);
      m.toneMapped = false;
    }
  });
  const spin = new THREE.Group(); spin.add(model);
  const body = new THREE.Group(); body.add(spin); body.scale.setScalar(SUN_RADIUS / r);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(SUN_RADIUS * 7);
  const holder = new THREE.Group(); holder.add(body, glow);

  // Light shaft toward the plant.
  const shaftGeo = new THREE.CylinderGeometry(SUN_RADIUS * 0.7, 0.42, 1, 48, 1, true);
  shaftGeo.translate(0, -0.5, 0);
  // Fades from the sun toward the plant (cylinder uv.y: 1 at the sun, 0 at the plant).
  const shaft = new THREE.Mesh(shaftGeo, new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0.06 }, color: { value: new THREE.Color(0xffe2a0) } },
    vertexShader: "varying float vT; void main(){ vT = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform float opacity; uniform vec3 color; varying float vT; void main(){ gl_FragColor = vec4(color, opacity * smoothstep(0.0, 0.85, vT)); }",
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));

  const light = new THREE.SpotLight(0xfff1d6, 16, 4.6, 0.5, 0.6, 2);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.02;
  light.shadow.camera.near = 0.3; light.shadow.camera.far = 12;
  return { holder, spin, glow, shaft, light };
}

// Magnifier: rotate the model so the lens faces +Z and the handle points
// down-right, then normalise the lens rim radius to 1.
function makeMagnifier(gltf) {
  const LENS_N = new THREE.Vector3(-0.46275, 0.37837, 0.80168).normalize();
  const HANDLE = new THREE.Vector3(0.47965, -0.65367, 0.58537).normalize();
  const LENS_C = new THREE.Vector3(-0.0062, 0.0085, -0.0076);
  const LENS_R = 1.0;
  const E = new THREE.Matrix4().makeBasis(HANDLE, new THREE.Vector3().crossVectors(LENS_N, HANDLE), LENS_N);
  const f1 = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0), f3 = new THREE.Vector3(0, 0, 1);
  const F = new THREE.Matrix4().makeBasis(f1, new THREE.Vector3().crossVectors(f3, f1), f3);
  const R = F.multiply(E.transpose());
  const model = gltf.scene;
  const inner = new THREE.Group();
  inner.add(model);
  model.position.copy(LENS_C).multiplyScalar(-1);
  inner.applyMatrix4(R);
  inner.scale.multiplyScalar(1 / LENS_R);
  model.traverse((o) => { if (o.isMesh) { o.renderOrder = 10; o.material.depthTest = false; } });
  const holder = new THREE.Group();
  holder.add(inner);
  return holder;
}

async function init() {
  const [plantGltf, sunA_gltf, sunB_gltf, magGltf, stemGltf, sundialGltf] = await Promise.all([
    track(parseGLB("glbPlant"), "Plant"), track(parseGLB("glbSun"), "Sun A"), track(parseGLB("glbSun"), "Sun B"),
    track(parseGLB("glbMag"), "Magnifier"), track(parseGLB("glbStem"), "Stem section"), track(parseGLB("glbSundial"), "Sundial"),
  ]);

  const stage = $("stage");
  const canvas = $("glCanvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;   // refreshed only when plants or suns move

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171c);
  scene.fog = new THREE.Fog(0x15171c, 8, 16);
  scene.add(new THREE.HemisphereLight(0xd6deff, 0x2a1f14, 1.35));
  const fill = new THREE.DirectionalLight(0xbfcfff, 0.55);
  fill.position.set(0, 3, 8);
  scene.add(fill);

  // Floor and partition.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 96), new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.95 }));
  const hemi = scene.children.find((o) => o.isHemisphereLight);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(makeDivider(envTex));

  // Plants.
  const baked = bakeModel(plantGltf.scene);
  const plants = {
    left: makePlant(baked),
    right: makePlant(baked),
  };
  plants.left.root.position.set(-POT_X, SOIL_Y, 0);
  plants.right.root.position.set(POT_X, SOIL_Y, 0);
  plants.right.root.rotation.y = 0; // both face the camera identically
  scene.add(plants.left.root, plants.right.root);

  // Suns.
  const glowTex = glowTexture();
  const suns = { A: makeSun(sunA_gltf, glowTex), B: makeSun(sunB_gltf, glowTex) };
  Object.values(suns).forEach((s) => scene.add(s.holder, s.shaft, s.light, s.light.target));

  // Magnifier.
  const mag = makeMagnifier(magGltf);
  const lens = makeStemSection(stemGltf);
  const lensRT = new THREE.WebGLRenderTarget(1024, 1024, { samples: 4 });
  lensRT.texture.anisotropy = 4;
  lensRT.texture.colorSpace = THREE.SRGBColorSpace;
  const lensDisc = new THREE.Mesh(new THREE.CircleGeometry(0.94, 72), new THREE.MeshBasicMaterial({ map: lensRT.texture, depthTest: false, toneMapped: false, transparent: true }));
  lensDisc.renderOrder = 11;   // over the glass, so the view isn't tinted
  mag.add(lensDisc);
  mag.visible = false;
  scene.add(mag);
  const lensDefault = () => (stage.clientWidth < 560 ? 0.6 : 0.46);
  const magState = { on: false, pos: new THREE.Vector3(0.6, 1.62, 0.55), radius: 0.46, dragging: false, locked: null };

  // Camera.
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  const TARGET = new THREE.Vector3(0, 1.1, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minPolarAngle = toRad(52);
  controls.maxPolarAngle = toRad(92);
  controls.minAzimuthAngle = toRad(-55);
  controls.maxAzimuthAngle = toRad(55);

  // Views: whole bench, or one room. Distances fit the current aspect ratio.
  let view = null;           // null (whole bench) | "left" | "right"
  let camAnim = null;
  const VIEW_DIR = new THREE.Vector3(0, 0.22, 1).normalize();
  function viewPose(which) {
    const vHalf = toRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    if (!which) {
      const d = Math.max(2.85 / Math.tan(hHalf), 1.35 / Math.tan(vHalf)) + 0.7;
      return { target: TARGET.clone(), pos: TARGET.clone().addScaledVector(VIEW_DIR, d), dist: d };
    }
    const tgt = new THREE.Vector3(which === "left" ? -POT_X : POT_X, 1.15, 0);
    const d = Math.max(1.6 / Math.tan(hHalf), 1.15 / Math.tan(vHalf)) + 0.6;
    return { target: tgt, pos: tgt.clone().addScaledVector(VIEW_DIR, d), dist: d };
  }
  function goTo(which, animate = true) {
    const pose = viewPose(which);
    const overview = viewPose(null);
    controls.minDistance = Math.min(pose.dist, overview.dist) * 0.55;
    controls.maxDistance = overview.dist * 1.35;
    if (!animate) {
      camera.position.copy(pose.pos);
      controls.target.copy(pose.target);
      controls.update();
      camAnim = null;
      return;
    }
    camAnim = { t0: performance.now(), dur: 950, p0: camera.position.clone(), t0v: controls.target.clone(), p1: pose.pos, t1v: pose.target };
  }
  const easeOutBack = (x) => { const c1 = 1.3, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  function stepCamAnim(now) {
    if (!camAnim) return;
    const k = Math.min(1, (now - camAnim.t0) / camAnim.dur);
    const e = easeOutBack(k);
    camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
    controls.target.lerpVectors(camAnim.t0v, camAnim.t1v, e);
    if (k >= 1) camAnim = null;
  }

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved) goTo(view, false);
  }
  let userMoved = false;
  controls.addEventListener("start", () => { userMoved = true; camAnim = null; });
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  /* ---------- Room switch ---------- */
  const roomSwitch = $("roomSwitch"), roomThumb = $("roomThumb");
  function setRoom(which, animate = true) {
    const prev = view;
    view = which;
    roomSwitch.dataset.room = which || "";
    roomSwitch.querySelectorAll(".room-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.room === which)));
    if (which && prev !== which) buzz(12);
    if (which && prev !== which && roomThumb.animate) {
      roomThumb.animate(
        [{ scale: "1 1" }, { scale: "1.14 0.86", offset: 0.35 }, { scale: "0.95 1.05", offset: 0.7 }, { scale: "1 1" }],
        { duration: 620, easing: "ease-out" }
      );
    }
    userMoved = false;
    goTo(which, animate);
    if (which) {
      magState.pos.set((which === "left" ? -POT_X : POT_X) - 0.72, 1.55, 0.6);
      magState.locked = null;
    }
  }
  roomSwitch.querySelectorAll(".room-opt").forEach((b) => b.addEventListener("click", () => setRoom(view === b.dataset.room ? null : b.dataset.room)));

  /* ---------- Navigation pad + arrow keys ---------- */
  let navHold = null;
  const sph = new THREE.Spherical();
  function orbitStep(dir, amount = 1) {
    camAnim = null;
    userMoved = true;
    const off = camera.position.clone().sub(controls.target);
    sph.setFromVector3(off);
    if (dir === "left") sph.theta -= toRad(1.6) * amount;
    if (dir === "right") sph.theta += toRad(1.6) * amount;
    if (dir === "up") sph.phi -= toRad(1.1) * amount;
    if (dir === "down") sph.phi += toRad(1.1) * amount;
    sph.theta = Math.max(controls.minAzimuthAngle, Math.min(controls.maxAzimuthAngle, sph.theta));
    sph.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, sph.phi));
    camera.position.copy(controls.target).add(off.setFromSpherical(sph));
  }
  $("navPad").querySelectorAll(".nav").forEach((b) => {
    const stop = () => { navHold = null; b.classList.remove("held"); };
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); navHold = b.dataset.dir; b.classList.add("held"); b.setPointerCapture(e.pointerId); });
    b.addEventListener("pointerup", stop);
    b.addEventListener("pointercancel", stop);
    b.addEventListener("lostpointercapture", stop);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); orbitStep(b.dataset.dir, 4); } });
  });
  stage.addEventListener("keydown", (e) => {
    const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (map[e.key] && (e.target === stage || e.target === canvas)) { e.preventDefault(); orbitStep(map[e.key], 3); }
  });

  /* ---------- Reset layout ---------- */
  $("layoutBtn").addEventListener("click", () => {
    magState.pos.set(0.6, 1.62, 0.55);
    magState.radius = lensDefault();
    magState.locked = null;
    setRoom(null);
    const lb = $("layoutBtn");
    lb.classList.add("pulse");
    setTimeout(() => lb.classList.remove("pulse"), 650);
  });

  /* ---------- Screen projection helpers ---------- */
  const tmp = new THREE.Vector3();
  function toScreen(v) {
    tmp.copy(v).project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * stage.clientWidth, y: (-tmp.y * 0.5 + 0.5) * stage.clientHeight, behind: tmp.z > 1 };
  }
  // Screen-space tags stay inside the stage and step aside for the nav pad.
  const navPad = $("navPad");
  let layout = null;
  const tagSize = new Map();
  function measureLayout() {
    layout = { W: stage.clientWidth, H: stage.clientHeight, nx: navPad.offsetLeft, ny: navPad.offsetTop, nw: navPad.offsetWidth, nh: navPad.offsetHeight };
    tagSize.clear();
  }
  new ResizeObserver(() => { layout = null; }).observe(stage);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout = null; });
  function placeTag(el, v, dy = 0) {
    if (!layout) measureLayout();
    if (!tagSize.has(el)) tagSize.set(el, { w: el.offsetWidth, h: el.offsetHeight });
    const p = toScreen(v);
    const { w, h } = tagSize.get(el);
    const { W, H } = layout;
    let x = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, p.x));
    let y = Math.max(h / 2 + 4, Math.min(H - h / 2 - 4, p.y + dy));
    const { nx, ny, nw, nh } = layout;
    const overlaps = x + w / 2 > nx - 4 && x - w / 2 < nx + nw + 4 && y + h / 2 > ny - 4 && y - h / 2 < ny + nh + 4;
    if (overlaps) x = nx - w / 2 - 6;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
  }

  /* ---------- Plant apex in world space (matches the shader) ---------- */
  function apexWorld(side, bendDeg) {
    const P = plants[side];
    const s = P.shoot.scale.x;
    const H = P.height, y0 = H * BEND_ZONE_START, L = H - y0, a = toRad(bendDeg);
    let dx = 0, dy = L;
    if (Math.abs(a) > 1e-4) { const r = L / a; dx = r * (1 - Math.cos(a)); dy = r * Math.sin(a); }
    return new THREE.Vector3(P.root.position.x + dx * s, P.root.position.y + (y0 + dy) * s, 0);
  }

  /* ---------- Magnifier dragging ---------- */
  const raycaster = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();
  const hit = $("magHit");
  function pointerToWorld(e) {
    const r = stage.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const out = new THREE.Vector3();
    return raycaster.ray.intersectPlane(dragPlane, out) ? out : null;
  }
  hit.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    magState.dragging = true;
    hit.classList.add("dragging");
    hit.setPointerCapture(e.pointerId);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), magState.pos);
    magState.grab = magState.pos.clone().sub(pointerToWorld(e) || magState.pos);
  });
  hit.addEventListener("pointermove", (e) => {
    if (!magState.dragging) return;
    const p = pointerToWorld(e);
    if (!p) return;
    p.add(magState.grab);
    p.x = Math.max(-2.9, Math.min(2.9, p.x));
    p.y = Math.max(0.3, Math.min(2.8, p.y));
    p.z = Math.max(-1, Math.min(2, p.z));
    magState.pos.copy(p);
  });
  const endDrag = (e) => {
    magState.dragging = false;
    hit.classList.remove("dragging");
    if (e && hit.hasPointerCapture(e.pointerId)) hit.releasePointerCapture(e.pointerId);
  };
  hit.addEventListener("pointerup", endDrag);
  hit.addEventListener("pointercancel", endDrag);

  function setMagnifier(on) {
    if (on && !magState.on && !magState.sized) { magState.radius = lensDefault(); magState.sized = true; }
    magState.on = on;
    mag.visible = on;
    $("magLayer").style.display = on ? "block" : "none";
    $("callCard").classList.toggle("show", on);
    const btn = $("magBtn");
    btn.classList.toggle("active", on);
    btn.title = on ? "Hide magnifier" : "Show magnifier";
    btn.setAttribute("aria-label", btn.title);
  }
  $("magBtn").addEventListener("click", () => setMagnifier(!magState.on));
  $("magScaleDownBtn").addEventListener("click", () => { magState.radius = Math.max(0.24, magState.radius * 0.85); });
  $("magScaleUpBtn").addEventListener("click", () => { magState.radius = Math.min(0.85, magState.radius * 1.15); });

  /* ---------- Controls ---------- */
  function startPlay() {
    if (sim.hours >= MAX_HOURS) sim.hours = 0;
    sim.playing = true;
    sim.playStart = performance.now() - (sim.hours / MAX_HOURS) * PLAY_DURATION_MS;
    setPlayIcon(true);
    lastClockH = -1;
  }
  function setPlayIcon(on) {
    const b = $("playBtn");
    b.classList.toggle("active", on);
    b.title = on ? "Pause" : "Play";
    b.setAttribute("aria-label", b.title);
    b.innerHTML = on ? '<svg viewBox="0 0 24 24" fill="none"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"></rect><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"></rect></svg>' : '<svg viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5Z" fill="currentColor"></path></svg>';
  }
  function stopPlay() { sim.playing = false; setPlayIcon(false); lastClockH = -1; }
  $("playBtn").addEventListener("click", () => (sim.playing ? stopPlay() : startPlay()));
  /* ---------- Time clock: one full turn = 250 h, ticks mark days ---------- */
  {
    const ticks = [];
    for (let h = 0; h < MAX_HOURS; h += 24) {
      const a = (h / MAX_HOURS) * Math.PI * 2;
      const major = h % 120 === 0;
      const r1 = major ? 23 : 26, r2 = 31;
      ticks.push(`<line x1="${(50 + Math.sin(a) * r1).toFixed(1)}" y1="${(50 - Math.cos(a) * r1).toFixed(1)}" x2="${(50 + Math.sin(a) * r2).toFixed(1)}" y2="${(50 - Math.cos(a) * r2).toFixed(1)}" stroke="rgba(255,255,255,${major ? 0.55 : 0.28})" stroke-width="${major ? 1.8 : 1.2}" stroke-linecap="round"></line>`);
    }
    $("clockTicks").innerHTML = ticks.join("");
    const clock = $("timeClock");
    let dragging = false;
    const setFromPointer = (e) => {
      const r = clock.getBoundingClientRect();
      let f = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) / (Math.PI * 2);
      if (f < 0) f += 1;
      const prev = sim.hours / MAX_HOURS;
      if (prev > 0.75 && f < 0.25) f = 1;        // no wrap-around past the end
      else if (prev < 0.25 && f > 0.75) f = 0;   // or back past the start
      sim.hours = f * MAX_HOURS;
    };
    clock.addEventListener("pointerdown", (e) => { stopPlay(); dragging = true; clock.setPointerCapture(e.pointerId); setFromPointer(e); });
    clock.addEventListener("pointermove", (e) => { if (dragging) setFromPointer(e); });
    clock.addEventListener("pointerup", () => { dragging = false; });
    clock.addEventListener("pointercancel", () => { dragging = false; });
    clock.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 24 : 1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); stopPlay(); sim.hours = Math.min(MAX_HOURS, sim.hours + step); }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); stopPlay(); sim.hours = Math.max(0, sim.hours - step); }
      if (e.key === "Home") { e.preventDefault(); stopPlay(); sim.hours = 0; }
      if (e.key === "End") { e.preventDefault(); stopPlay(); sim.hours = MAX_HOURS; }
    });
  }
  let lastClockH = -1;
  function updateClock(h) {
    if (Math.abs(h - lastClockH) < 0.05) return;
    lastClockH = h;
    const f = h / MAX_HOURS;
    $("clockHand").setAttribute("transform", `rotate(${(f * 360).toFixed(2)} 50 50)`);
    $("clockArc").setAttribute("stroke-dashoffset", (238.76 * (1 - f)).toFixed(2));
    $("timeClock").setAttribute("aria-valuenow", h.toFixed(0));
    $("dayReadout").textContent = `Day ${Math.min(MAX_HOURS / 24, Math.floor(h / 24) + 1)} of ${MAX_HOURS / 24} · ${sim.playing ? "running" : "drag the hand"}`;
  }
  $("resetBtn").addEventListener("click", () => {
    stopPlay();
    sim.hours = 0; sim.sunB = 0;
    sundial.setAngle(0);
    events.length = 0; pulses.length = 0;
    events.push({ t: 0, sun: 0, I: sim.fluence, col: sim.colour, mode: sim.mode });
    if (sim.mode === "pulse") pulses.push(0);
    traj.dirty = true;
    const rb = $("resetBtn");
    rb.classList.add("pulse");
    setTimeout(() => rb.classList.remove("pulse"), 650);
  });

  ["mechanism", "credits"].forEach((name) => {
    const card = $(`${name}Card`), toggle = $(`${name}CardToggle`);
    toggle.addEventListener("click", () => {
      const ex = card.getAttribute("data-expanded") === "true";
      card.setAttribute("data-expanded", String(!ex));
      toggle.setAttribute("aria-expanded", String(!ex));
    });
  });

  const sundial = makeSundial(sundialGltf, $("sundialCanvas"), (deg) => { sim.sunB = deg; logSettings(); });
  sundial.setAngle(sim.sunB);

  setProgress(100, "Ready");
  const loader = $("loader");
  loader.style.opacity = "0";
  setTimeout(() => loader.remove(), 480);

  /* ---------- Frame loop ---------- */
  const prevText = {};
  const setText = (id, t) => { if (prevText[id] !== t) { prevText[id] = t; $(id).textContent = t; } };
  const sunPos = (side, angleDeg, out = new THREE.Vector3()) => {
    const base = plants[side].root.position;
    return out.set(base.x + Math.sin(toRad(angleDeg)) * SUN_ARC_R, base.y + Math.cos(toRad(angleDeg)) * SUN_ARC_R, 0);
  };
  const up = new THREE.Vector3(0, -1, 0);
  let lastBend = { left: 0, right: 0 };
  let chartH = -1;

  /* ---------- Theme ---------- */
  function applyTheme(theme) {
    const light = theme === "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    const btn = $("themeBtn");
    btn.title = light ? "Switch to dark theme" : "Switch to light theme";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = light
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"></path></svg>';
    const bg = light ? 0xe4e7ec : 0x15171c;
    scene.background.set(bg);
    scene.fog.color.set(bg);
    floor.material.color.set(light ? 0xd9d8d3 : 0x22252c);
    if (hemi) hemi.intensity = light ? 1.7 : 1.35;
    lens.setTheme(light);
    chartDirty = true;
    layout = null;
    try { localStorage.setItem("phytohelios-theme", light ? "light" : "dark"); } catch (e) { /* storage unavailable */ }
  }
  $("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

  /* ---------- Light colour, mode, seedlings, chart view ---------- */
  function setupSeg(id, onPick) {
    const seg = $(id);
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      onPick(b.dataset.v);
    }));
  }
  function paintLight() {
    const sp = SPECTRUM[sim.colour];
    $("lightTitle").textContent = `Light · ${sp.name} ${sp.nm} nm${sim.mode === "pulse" ? " · pulses" : ""}`;
    document.querySelector(".light-panel").style.setProperty("--lc", sp.css);
    $("pulseBtn").disabled = sim.mode !== "pulse";
  }
  setupSeg("colourSeg", (v) => { sim.colour = v; logSettings(); paintLight(); chartDirty = true; });
  setupSeg("modeSeg", (v) => { sim.mode = v; logSettings(v === "pulse"); paintLight(); chartDirty = true; if (v === "pulse") buzz(10); });
  $("pulseBtn").addEventListener("click", () => { if (sim.mode !== "pulse") return; logSettings(true); chartDirty = true; buzz(12); });
  setupSeg("repSeg", (v) => { sim.reps = +v; traj.dirty = true; setLegend(); });
  setupSeg("viewSeg", (v) => { chartView = v; setLegend(); chartDirty = true; });
  paintLight();

  /* ---------- Blue light intensity ---------- */
  const fmtFluence = (I) => (I < 0.1 ? I.toFixed(2) : I < 10 ? I.toFixed(1) : I.toFixed(0)) + " µmol m⁻² s⁻¹";
  $("fluenceSlider").addEventListener("input", (e) => {
    sim.fluence = Math.pow(10, parseFloat(e.target.value));
    logSettings();
    $("fluenceReadout").textContent = fmtFluence(sim.fluence);
    chartDirty = true;
  });

  /* ---------- Protractor ---------- */
  let protOn = false, protKey = "";
  $("protBtn").addEventListener("click", () => {
    protOn = !protOn;
    const b = $("protBtn");
    b.classList.toggle("active", protOn);
    b.title = protOn ? "Hide protractor" : "Show protractor";
    b.setAttribute("aria-label", b.title);
    $("protractor").style.display = protOn ? "block" : "none";
    protKey = "";
  });
  function drawProtractor(side, bendDeg) {
    const base = toScreen(plants[side].root.position);
    const tip = toScreen(apexWorld(side, bendDeg));
    const R = Math.max(46, Math.hypot(tip.x - base.x, tip.y - base.y) * 1.08);
    const P = (deg, r) => [base.x + Math.sin(toRad(deg)) * r, base.y - Math.cos(toRad(deg)) * r];
    const gold = getComputedStyle(document.documentElement).getPropertyValue("--sun").trim() || "#ffd966";
    const ink = document.documentElement.dataset.theme === "light" ? "16,19,26" : "255,255,255";
    let s = "";
    const [ax0, ay0] = P(-90, R), [ax1, ay1] = P(90, R);
    s += `<path d="M ${ax0} ${ay0} A ${R} ${R} 0 0 1 ${ax1} ${ay1} Z" fill="rgba(${ink},0.05)" stroke="rgba(${ink},0.55)" stroke-width="1.2"></path>`;
    for (let d = -90; d <= 90; d += 5) {
      const len = d % 30 === 0 ? 10 : d % 10 === 0 ? 6 : 3;
      const [x1, y1] = P(d, R), [x2, y2] = P(d, R - len);
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(${ink},0.7)" stroke-width="1"></line>`;
      if (d % 30 === 0) {
        const [tx, ty] = P(d, R - 20);
        s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="9.5" fill="rgba(${ink},0.85)" text-anchor="middle" dominant-baseline="middle">${Math.abs(d)}°</text>`;
      }
    }
    const [vx, vy] = P(0, R);
    s += `<line x1="${base.x.toFixed(1)}" y1="${base.y.toFixed(1)}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" stroke="rgba(${ink},0.45)" stroke-dasharray="4 4"></line>`;
    const a = bendDeg;
    if (Math.abs(a) > 0.5) {
      const r2 = R * 0.42;
      const [wx, wy] = P(a, r2), [w0x, w0y] = P(0, r2);
      s += `<path d="M ${base.x} ${base.y} L ${w0x} ${w0y} A ${r2} ${r2} 0 0 ${a > 0 ? 1 : 0} ${wx} ${wy} Z" fill="${gold}" fill-opacity="0.28"></path>`;
    }
    const [mx, my] = P(a, R);
    s += `<line x1="${base.x.toFixed(1)}" y1="${base.y.toFixed(1)}" x2="${mx.toFixed(1)}" y2="${my.toFixed(1)}" stroke="${gold}" stroke-width="2"></line>`;
    s += `<circle cx="${base.x.toFixed(1)}" cy="${base.y.toFixed(1)}" r="3" fill="${gold}"></circle>`;
    const [lx, ly] = P(a >= 0 ? a + 14 : a - 14, R + 16);
    s += `<g transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})"><rect x="-30" y="-11" width="60" height="22" rx="11" fill="rgba(12,14,18,0.78)" stroke="rgba(${ink},0.2)"></rect><text x="0" y="1" font-size="12" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="middle">θ ${Math.abs(a).toFixed(1)}°</text></g>`;
    $("protractor").innerHTML = s;
  }

  /* ---------- Data panel ---------- */
  const readings = [];
  let chartDirty = true, chartLast = 0;
  const chart = $("chart");
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let chartView = "bend";
  const GOLD = "#ffc933", GREY = "#9aa0aa", ORANGE = "#ff8a3d";
  function setLegend() {
    const L = $("legend");
    L.innerHTML = chartView === "bend"
      ? `<span style="--c:${GREY}">A · Control</span><span style="--c:${GOLD}">B · Experimental</span>${sim.reps === 5 ? `<span class="band" style="--c:${GOLD}">± 1 SD (n = 5)</span>` : ""}<span class="tri">Setting changed</span>`
      : `<span style="--c:${GOLD}">B · left flank</span><span style="--c:${ORANGE}">B · right flank</span><span style="--c:${GREY}">A · both flanks</span>`;
    $("dataTitle").innerHTML = chartView === "bend" ? "Bend angle over time <small>(+ right, − left)</small>" : "Flank elongation rate <small>(% of control)</small>";
  }
  function drawChart(target = chart, scale = Math.min(window.devicePixelRatio || 1, 2), withBg = false) {
    const W = target === chart ? chart.clientWidth : target.width / scale;
    const H = target === chart ? chart.clientHeight : target.height / scale;
    if (target === chart) { chart.width = Math.round(W * scale); chart.height = Math.round(H * scale); }
    const g = target.getContext("2d");
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.clearRect(0, 0, W, H);
    if (withBg) { g.fillStyle = cssVar("--surface") || "#131519"; g.fillRect(0, 0, W, H); }
    const ink3 = cssVar("--ink-3"), line = cssVar("--line"), font = "11px 'IBM Plex Sans', Roboto, sans-serif";
    const m = { l: 42, r: 10, t: 10, b: 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const growth = chartView === "growth";
    const yMin = growth ? 40 : -60, yMax = growth ? 160 : 60;
    const X = (h) => m.l + (h / MAX_HOURS) * pw;
    const Y = (v) => m.t + ph - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * ph;
    g.font = font; g.lineWidth = 1;
    const ticks = growth ? [40, 70, 100, 130, 160] : [-60, -30, 0, 30, 60];
    ticks.forEach((d) => {
      g.strokeStyle = (growth ? d === 100 : d === 0) ? ink3 : line;
      g.beginPath(); g.moveTo(m.l, Y(d) + 0.5); g.lineTo(W - m.r, Y(d) + 0.5); g.stroke();
      g.fillStyle = ink3; g.textAlign = "right"; g.textBaseline = "middle";
      g.fillText(growth ? d + "%" : (d > 0 ? "+" : "") + d + "°", m.l - 6, Y(d));
    });
    g.textBaseline = "top";
    for (let h = 0; h <= MAX_HOURS; h += (W < 520 ? 120 : 48)) {
      g.textAlign = h === 0 ? "left" : h >= MAX_HOURS ? "right" : "center";
      g.fillText(h + " h", X(h), H - m.b + 10);
    }
    // Lag after the latest change (shaded) and pulse windows (light bars on the axis).
    const lastEv = events[events.length - 1];
    const lagEnd = Math.min(MAX_HOURS, lastEv.t + lagFor(lastEv.I));
    g.fillStyle = cssVar("--hover"); g.fillRect(X(lastEv.t), m.t, Math.max(1, X(lagEnd) - X(lastEv.t)), ph);
    g.fillStyle = ink3; g.textAlign = "left"; g.textBaseline = "top"; g.fillText("lag", X(lagEnd) + 3, m.t + 2);
    pulses.forEach((p) => { g.fillStyle = SPECTRUM[settingsAt(p).col].css; g.fillRect(X(p), m.t + ph - 3, Math.max(2, X(p + PULSE_H) - X(p)), 3); });
    events.forEach((ev, i) => {
      if (i === 0) return;
      const x = X(ev.t);
      g.fillStyle = GOLD;
      g.beginPath(); g.moveTo(x, m.t + ph + 1); g.lineTo(x - 4, m.t + ph + 7); g.lineTo(x + 4, m.t + ph + 7); g.closePath(); g.fill();
    });
    const path = (fn, from, to, c, dashed, w = 2.4) => {
      g.strokeStyle = c; g.lineWidth = dashed ? 1.4 : w; g.globalAlpha = dashed ? 0.45 : 1; g.setLineDash(dashed ? [5, 5] : []);
      g.beginPath();
      for (let h = from, k = 0; h <= to + 1e-6; h += 0.5, k++) { const x = X(h), y = Y(fn(h)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke(); g.globalAlpha = 1; g.setLineDash([]);
    };
    const dot = (v, c) => { g.fillStyle = c; g.beginPath(); g.arc(X(sim.hours), Y(v), 4, 0, Math.PI * 2); g.fill(); };
    if (!growth) {
      const A = showA(), B = showB();
      if (sim.reps === 5) {
        // ±1 SD band for B (A stays at 0 for every seedling).
        g.fillStyle = GOLD; g.globalAlpha = 0.16; g.beginPath();
        for (let h = 0; h <= MAX_HOURS; h += 1) g.lineTo(X(h), Y(angleAt(B, h) + angleAt(traj.Bsd, h)));
        for (let h = MAX_HOURS; h >= 0; h -= 1) g.lineTo(X(h), Y(angleAt(B, h) - angleAt(traj.Bsd, h)));
        g.closePath(); g.fill(); g.globalAlpha = 1;
        traj.Bset.forEach((arr) => path((h) => angleAt(arr, h), 0, sim.hours, GOLD, false, 0.8));
      }
      const eq = equilibriumDeg(sim.sunB, sim.fluence);
      if (sim.mode !== "pulse") {
        g.setLineDash([2, 4]); g.strokeStyle = GOLD; g.globalAlpha = 0.6; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(X(sim.hours), Y(eq)); g.lineTo(W - m.r, Y(eq)); g.stroke();
        g.globalAlpha = 1; g.setLineDash([]);
        g.fillStyle = GOLD; g.textAlign = "right"; g.textBaseline = eq >= 0 ? "bottom" : "top";
        g.fillText(`eq. ${eq >= 0 ? "+" : "−"}${Math.abs(eq).toFixed(1)}°`, W - m.r, Y(eq) + (eq >= 0 ? -3 : 3));
      }
      path((h) => angleAt(A, h), 0, sim.hours, GREY, false);
      path((h) => angleAt(B, h), sim.hours, MAX_HOURS, GOLD, true);
      path((h) => angleAt(B, h), 0, sim.hours, GOLD, false);
      dot(angleAt(A, sim.hours), GREY); dot(angleAt(B, sim.hours), GOLD);
      readings.forEach((r, i) => {
        g.strokeStyle = GOLD; g.lineWidth = 1.6; g.fillStyle = cssVar("--surface") || "#131519";
        if (r.bSd) { g.beginPath(); g.moveTo(X(r.t), Y(r.b - r.bSd)); g.lineTo(X(r.t), Y(r.b + r.bSd)); g.stroke(); }
        g.beginPath(); g.arc(X(r.t), Y(r.b), 5, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = ink3; g.font = "600 10px 'IBM Plex Sans', Roboto, sans-serif"; g.textAlign = "center"; g.textBaseline = r.b >= 0 ? "bottom" : "top";
        g.fillText(String(i + 1), X(r.t), Y(r.b) + (r.b >= 0 ? -8 - (r.bSd ? 6 : 0) : 8 + (r.bSd ? 6 : 0)));
        g.font = font;
      });
    } else {
      // Differential growth: turning right means the left flank is outgrowing the right.
      const C = 6, R = traj.rateB;
      const left = (h) => 100 + C * angleAt(R, h), right = (h) => 100 - C * angleAt(R, h);
      path(() => 100, 0, sim.hours, GREY, false);
      path(left, sim.hours, MAX_HOURS, GOLD, true); path(right, sim.hours, MAX_HOURS, ORANGE, true);
      path(left, 0, sim.hours, GOLD, false); path(right, 0, sim.hours, ORANGE, false);
      dot(100, GREY); dot(left(sim.hours), GOLD); dot(right(sim.hours), ORANGE);
      g.fillStyle = ink3; g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText("faster", m.l + 4, Y(160) + 12); g.textBaseline = "top"; g.fillText("slower", m.l + 4, Y(40) - 12);
    }
  }
  new ResizeObserver(() => { chartDirty = true; }).observe(chart);
  setLegend();

  function updateReasoning() {
    const h = sim.hours, I = sim.fluence, g = fluenceGain(I), lag = lagFor(I);
    const spec = SPECTRUM[sim.colour];
    const phi = sim.sunB, th = lastBend.right;
    const eq = equilibriumDeg(phi, I);
    const seen = settingsAt(h - lag);
    const fmt = (x) => `${Math.abs(x).toFixed(1)}° ${x >= 0 ? "right" : "left"}`;
    const sg = (x, d, paren = false) => { const s = (x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "°"; return paren && x < 0 ? `(${s})` : s; };
    const rate = angleAt(traj.rateB, h);
    const P = [];
    P.push(`<p><strong>Why B is at ${fmt(th)}${sim.reps === 5 ? ` (mean of 5, SD ${sdNow("B").toFixed(1)}°)` : ""}</strong></p>`);
    if (spec.w === 0) {
      P.push(`<p>The suns are giving red light (${spec.nm} nm). Phototropins absorb blue and UV-A light, so red light gives no lateral signal: auxin stays even and the shoot grows straight. ${Math.abs(th) > 0.5 ? "Any bend left from earlier light is being straightened by gravitropism." : ""}</p>`);
    } else {
      P.push(`<p>Sun B is ${Math.abs(phi).toFixed(0)}° from vertical. The phototropic signal is proportional to sin(${sg(seen.sun, 0)} − ${sg(th, 1, true)}) = ${Math.sin(toRad(seen.sun - th)).toFixed(2)}, the light's sideways component across the apex. It shrinks as the shoot turns toward the light.</p>`);
      P.push(`<p>${spec.name} light (${spec.nm} nm) is ${(spec.w * 100).toFixed(0)}% as effective as blue${spec.w < 1 ? ", because phototropins absorb mainly blue light" : ""}. At ${fmtFluence(I)} the intensity gain is ${(g * 100).toFixed(0)}% of its peak${g < 0.95 ? (Math.log10(I) > 0 ? " (strong light lengthens the lag and weakens the response)" : " (dim light gives a weak response)") : ""}.</p>`);
      if (sim.mode === "pulse") {
        P.push(`<p>Pulse mode: each ${PULSE_H} h flash sets up a short-lived auxin asymmetry. After the lag the shoot curves briefly (first positive curvature), then gravitropism straightens it, because no lasting light signal remains. Tap the ⚡ button to give another pulse.</p>`);
      } else {
        P.push(`<p>Gravitropism pulls back toward vertical in proportion to sin(${sg(th, 1)}) = ${Math.sin(toRad(th)).toFixed(2)} (the sine law). The shoot stops where the two balance: the photogravitropic equilibrium, here ${fmt(eq)}, always less than the sun's angle.</p>`);
      }
    }
    let state;
    if (h <= lag) state = `Lag phase (${lag.toFixed(1)} h at this light level): the apex has sensed the light but auxin has not yet moved.`;
    else if (Math.abs(rate) < 0.05) state = "Not turning now: the shaded and lit flanks are growing at the same rate.";
    else state = `Turning ${Math.abs(rate).toFixed(2)}° per hour to the ${rate >= 0 ? "right" : "left"}: the ${rate >= 0 ? "left" : "right"} flank is elongating about ${(6 * Math.abs(rate)).toFixed(0)}% faster than the control, the other flank that much slower (see Flank growth).`;
    P.push(`<p>${state}</p>`);
    if (sim.reps === 5) P.push(`<p>Five seedlings differ slightly in sensitivity and lag, as real seedlings do. The line is their mean and the band is ±1 standard deviation.</p>`);
    P.push(`<p>Plant A has light from directly above, so there is no sideways component and it stays upright.</p>`);
    $("reasoning").innerHTML = P.join("");
  }

  function renderReadings() {
    const wrap = $("resultsWrap");
    if (!readings.length) { wrap.innerHTML = '<p class="results-empty">No readings yet. Pause at any time and tap the record button.</p>'; return; }
    wrap.innerHTML = `<div class="scroll"><table class="results"><thead><tr><th>#</th><th>Time (h)</th><th>A (°)</th><th>B (°)</th><th>B eq. (°)</th><th>Sun B (°)</th><th>Light</th></tr></thead><tbody>${
      readings.map((r, i) => `<tr><td>${i + 1}</td><td>${r.t.toFixed(1)}</td><td>${r.a.toFixed(1)}</td><td>${r.b.toFixed(1)}${r.n === 5 ? ` ± ${r.bSd.toFixed(1)}` : ""}</td><td>${r.mode === "pulse" ? "—" : r.eq.toFixed(1)}</td><td>${r.sun.toFixed(0)}</td><td>${SPECTRUM[r.col].name}${r.mode === "pulse" ? " pulse" : ""}, ${r.I < 10 ? r.I.toFixed(2) : r.I.toFixed(0)}</td></tr>`).join("")
    }</tbody></table></div>`;
  }
  const csv = () => ["reading,time_h,n_seedlings,bend_A_deg,bend_B_mean_deg,bend_B_sd_deg,equilibrium_B_deg,sunB_angle_deg,light_colour,wavelength_nm,light_mode,fluence_umol_m2_s"]
    .concat(readings.map((r, i) => [i + 1, r.t.toFixed(2), r.n, r.a.toFixed(2), r.b.toFixed(2), r.n === 5 ? r.bSd.toFixed(2) : "", r.mode === "pulse" ? "" : r.eq.toFixed(2), r.sun.toFixed(1), r.col, SPECTRUM[r.col].nm, r.mode === "pulse" ? "pulse" : "continuous", r.I.toFixed(3)].join(","))).join("\n");
  const note = (msg) => { $("dataNote").textContent = msg; };
  $("freezeBtn").addEventListener("click", () => {
    const prev = readings[readings.length - 1];
    if (prev && Math.abs(prev.t - sim.hours) < 0.05 && prev.sun === sim.sunB && prev.I === sim.fluence && prev.col === sim.colour && prev.mode === sim.mode && prev.n === sim.reps) {
      return note(`Already recorded at t = ${sim.hours.toFixed(1)} h. Move the clock or change a setting first.`);
    }
    readings.push({ t: sim.hours, a: lastBend.left, b: lastBend.right, bSd: sim.reps === 5 ? sdNow("B") : 0, n: sim.reps,
      sun: sim.sunB, I: sim.fluence, col: sim.colour, mode: sim.mode, eq: equilibriumDeg(sim.sunB, sim.fluence) });
    renderReadings(); chartDirty = true; buzz(15);
    note(`Reading ${readings.length} recorded at t = ${sim.hours.toFixed(1)} h.`);
  });
  $("clearBtn").addEventListener("click", () => { readings.length = 0; renderReadings(); chartDirty = true; note("Readings cleared."); });
  $("copyCsvBtn").addEventListener("click", async () => {
    if (!readings.length) return note("Record at least one reading first.");
    try { await navigator.clipboard.writeText(csv()); note("CSV copied. Paste it into a spreadsheet."); }
    catch (e) { note("Copy was blocked here. Use “Save CSV”, or select the table and copy it."); }
  });
  // Published page: the viewer's download capability. Standalone file: a plain link.
  const dlReady = (window.claude && window.claude.use) ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
  async function download(name, blob) {
    const dl = await dlReady;
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); note(`${name} saved.`); }
      catch (e) {
        const code = e && e.code;
        note(code === "declined" ? "Save cancelled." : code === "host_unavailable" ? "This app can't save files. Open the page in a browser to save, or use Copy CSV." : "Saving isn't available here. Use Copy CSV instead.");
      }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    note(`${name} saved.`);
  }
  $("saveCsvBtn").addEventListener("click", () => {
    if (!readings.length) return note("Record at least one reading first.");
    download("phyto-helios-readings.csv", new Blob([csv()], { type: "text/csv" }));
  });
  $("savePngBtn").addEventListener("click", () => {
    const sc = 2, W = Math.max(640, chart.clientWidth), H = 300;
    const c = document.createElement("canvas"); c.width = W * sc; c.height = H * sc;
    drawChart(c, sc, true);
    c.toBlob((blob) => { if (blob) download("phyto-helios-chart.png", blob); }, "image/png");
  });

  /* ---------- Performance: pause when hidden, adapt resolution ---------- */
  let onScreen = true;
  new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; }).observe(stage);
  let perfT = 0, perfN = 0, perfLast = performance.now(), prCap = Math.min(window.devicePixelRatio || 1, 2);
  function adaptQuality(now) {
    perfT += now - perfLast; perfLast = now; perfN++;
    if (perfN < 90) return;
    const avg = perfT / perfN; perfT = 0; perfN = 0;
    const pr = renderer.getPixelRatio();
    if (avg > 30 && pr > 1) { prCap = Math.max(1, pr - 0.25); renderer.setPixelRatio(prCap); renderer.setSize(stage.clientWidth, stage.clientHeight, false); }
  }

  /* ---------- Text description for screen readers ---------- */
  let summaryLast = 0, summaryText = "";
  function updateSummary(now) {
    if (now - summaryLast < 2500) return;
    summaryLast = now;
    const side = (d) => (Math.abs(d) < 0.5 ? "upright" : `leaning ${Math.abs(d).toFixed(0)}° to the ${d > 0 ? "right" : "left"}`);
    const s = `At ${sim.hours.toFixed(0)} hours, plant A under Sun A overhead is ${side(lastBend.left)}. Plant B is ${side(lastBend.right)}, with Sun B at ${Math.round(sim.sunB)}° and blue light at ${fmtFluence(sim.fluence)}.`;
    if (s !== summaryText) { summaryText = s; $("sceneSummary").textContent = s; }
  }

  let savedTheme = "dark";
  try { savedTheme = localStorage.getItem("phytohelios-theme") || "dark"; } catch (e) { /* storage unavailable */ }
  applyTheme(savedTheme);

  const _aim = new THREE.Vector3(), _dir = new THREE.Vector3(), _edge = new THREE.Vector3(), _right = new THREE.Vector3();
  const _sunA = new THREE.Vector3(), _sunB = new THREE.Vector3();
  const _tagCtl = new THREE.Vector3(-POT_X, 0, 0.75), _tagExp = new THREE.Vector3(POT_X, 0, 0.75);
  let shadowKey = "", lensLast = 0, hiddenAt = 0;
  function frame(now) {
    if (!onScreen || document.hidden) {
      if (!hiddenAt) hiddenAt = now;          // freeze the play clock while off screen
      perfLast = now; requestAnimationFrame(frame); return;
    }
    if (hiddenAt) { if (sim.playing) sim.playStart += now - hiddenAt; hiddenAt = 0; }
    adaptQuality(now);
    // Time and the eased plant response.
    if (sim.playing) {
      sim.hours = Math.min(MAX_HOURS, ((now - sim.playStart) / PLAY_DURATION_MS) * MAX_HOURS);
      if (sim.hours >= MAX_HOURS) stopPlay();
    }
    if (traj.dirty) { integrate(); chartDirty = true; }

    const bend = { left: angleAt(showA(), sim.hours), right: angleAt(showB(), sim.hours) };
    lastBend = bend;
    const gs = growthScale(sim.hours);
    for (const side of ["left", "right"]) {
      plants[side].shoot.scale.setScalar(gs);
      plants[side].uniforms.uBend.value = toRad(bend[side]);
    }

    // Suns travel on their arcs; each light and shaft aims at its plant.
    const evNow = settingsAt(sim.hours);
    const lit = lightOn(sim.hours, evNow);
    const lightK = lit ? 0.45 + 0.55 * ((Math.log10(sim.fluence) + 2) / 4) : 0.04;
    const sunWorld = { A: sunPos("left", SUN_A_ANGLE, _sunA), B: sunPos("right", sim.sunB, _sunB) };
    for (const [key, side] of [["A", "left"], ["B", "right"]]) {
      const s = suns[key];
      const p = sunWorld[key];
      const aim = _aim.copy(plants[side].root.position); aim.y += plants[side].height * gs * 0.55;
      s.holder.position.copy(p);
      s.spin.rotation.y = now * 0.00035 + (key === "B" ? 1.4 : 0);
      s.glow.scale.setScalar(SUN_RADIUS * 7 * (1 + Math.sin(now / 900 + (key === "B" ? 1.7 : 0)) * 0.06));
      s.light.position.copy(p);
      s.light.intensity = 16 * lightK;
      s.light.color.setHex(SPECTRUM[sim.colour].hex);
      s.shaft.material.uniforms.color.value.setHex(SPECTRUM[sim.colour].hex);
      s.glow.material.color.setHex(SPECTRUM[sim.colour].hex);
      s.glow.material.opacity = lit ? 1 : 0.25;
      s.light.target.position.copy(aim);
      const dir = _dir.copy(aim).sub(p);
      s.shaft.position.copy(p);
      s.shaft.scale.set(1, dir.length() * 1.15, 1);
      s.shaft.quaternion.setFromUnitVectors(up, dir.normalize());
      s.shaft.material.uniforms.opacity.value = (0.11 + Math.sin(now / 1100 + (key === "B" ? 2 : 0)) * 0.02) * lightK;
    }

    if (navHold) orbitStep(navHold);
    stepCamAnim(now);
    controls.update();

    // Magnifier faces the camera.
    let lensPx = 0, lensC = null;
    if (magState.on) {
      mag.position.copy(magState.pos);
      mag.quaternion.copy(camera.quaternion);
      mag.scale.setScalar(magState.radius);
      lensC = toScreen(magState.pos);
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(magState.radius);
      const edge = toScreen(_edge.copy(magState.pos).add(_right));
      lensPx = Math.hypot(edge.x - lensC.x, edge.y - lensC.y);
    }

    // Lens: ~30 fps, and the shaded side follows the light the apex actually perceived.
    if (magState.on && now - lensLast > 32) {
      lensLast = now;
      const side = magState.locked;
      const seenSun = side === "right" ? settingsAt(sim.hours - curLag()).sun : 0;
      lens.update(side, side ? bend[side] : 0, seenSun, now);
      renderer.setRenderTarget(lensRT);
      renderer.render(lens.scene, lens.camera);
      renderer.setRenderTarget(null);
    }
    // Shadows: only when the plants, suns or light level change.
    const sk = `${gs.toFixed(3)}|${bend.left.toFixed(2)}|${bend.right.toFixed(2)}|${sim.sunB.toFixed(1)}|${sim.fluence.toFixed(3)}|${sim.colour}|${lit}`;
    if (sk !== shadowKey) { shadowKey = sk; renderer.shadowMap.needsUpdate = true; }
    renderer.render(scene, camera);

    // Screen-space labels.
    placeTag($("tagSunA"), sunWorld.A, -Math.max(22, toScreenRadius(sunWorld.A) + 14));
    placeTag($("tagSunB"), sunWorld.B, -Math.max(22, toScreenRadius(sunWorld.B) + 14));
    placeTag($("tagControl"), _tagCtl, 18);
    placeTag($("tagExperimental"), _tagExp, 18);

    // Readouts.
    setText("hoursReadout", `t = ${sim.hours.toFixed(1)} h`);
    updateClock(sim.hours);
    setText("controlStat", statText(SUN_A_ANGLE, bend.left));
    setText("experimentalStat", statText(sim.sunB, bend.right));

    if (magState.on) updateCellView(lensC, lensPx, { left: apexWorld("left", bend.left), right: apexWorld("right", bend.right) }, bend);
    if (protOn) {
      const ps = view === "left" ? "left" : "right";
      const pk = `${ps}|${bend[ps].toFixed(2)}|${gs.toFixed(3)}|${camera.position.x.toFixed(3)}|${camera.position.y.toFixed(3)}|${camera.position.z.toFixed(3)}|${stage.clientWidth}|${document.documentElement.dataset.theme}`;
      if (pk !== protKey) { protKey = pk; drawProtractor(ps, bend[ps]); }
    }
    if (chartDirty || (now - chartLast > 150 && chartH !== sim.hours)) {
      drawChart(); chartDirty = false; chartLast = now; chartH = sim.hours;
      updateReasoning();
    }
    updateSummary(now);

    requestAnimationFrame(frame);
  }

  const _top = new THREE.Vector3();
  function toScreenRadius(center) {
    const a = toScreen(center);
    const ay = a.y;
    const b = toScreen(_top.copy(center).setY(center.y + SUN_RADIUS));
    return Math.abs(b.y - ay);
  }

  const sdNow = (room) => angleAt(room === "A" ? traj.Asd : traj.Bsd, sim.hours);
  function statText(sunDeg, tipDeg) {
    const side = sunDeg > 0.5 ? "right" : sunDeg < -0.5 ? "left" : "overhead";
    if (sim.hours <= curLag()) return side === "overhead" ? "0° · lag phase, light from overhead" : `0° · lag phase, light from the ${side}`;
    const eq = equilibriumDeg(sunDeg, sim.fluence);
    const pm = sim.reps === 5 ? ` ± ${sdNow(sunDeg === SUN_A_ANGLE ? "A" : "B").toFixed(1)}° (n = 5)` : "";
    if (SPECTRUM[sim.colour].w === 0 && Math.abs(tipDeg) < 0.5) return "0° · red light isn't sensed by phototropins";
    if (Math.abs(tipDeg) < 0.5 && Math.abs(eq) < 0.5) return sim.mode === "pulse" ? "0° · upright between pulses" : "0° · upright; no lateral light signal";
    const lean = tipDeg > 0 ? "right" : "left";
    if (sim.mode === "pulse") return `${Math.abs(tipDeg).toFixed(1)}° ${lean}${pm} · pulse response fades back to vertical`;
    return `${Math.abs(tipDeg).toFixed(1)}° ${lean}${pm} · equilibrium ${Math.abs(eq).toFixed(1)}° ${eq >= 0 ? "right" : "left"}`;
  }


  /* ---------- Cellular view (auxin redistribution) ---------- */
  function updateCellView(c, rPx, apex, bend) {
    hit.setAttribute("cx", c.x.toFixed(1));
    hit.setAttribute("cy", c.y.toFixed(1));
    hit.setAttribute("r", Math.max(24, rPx).toFixed(1));

    // Lock onto the nearest apex; keep the lock while it stays in range.
    const range = rPx * 2.4 + 60;
    const scr = { left: toScreen(apex.left), right: toScreen(apex.right) };
    const dist = (s) => Math.hypot(scr[s].x - c.x, scr[s].y - c.y);
    if (!magState.locked || dist(magState.locked) > range) {
      magState.locked = null;
      const best = dist("left") < dist("right") ? "left" : "right";
      if (dist(best) < range) magState.locked = best;
    }
    const lead = $("magLeaderLine"), dot = $("magApexDot");
    const side = magState.locked;
    if (side) {
      const a = scr[side];
      const d = Math.hypot(a.x - c.x, a.y - c.y) || 1;
      lead.setAttribute("x1", (c.x + ((a.x - c.x) / d) * rPx).toFixed(1));
      lead.setAttribute("y1", (c.y + ((a.y - c.y) / d) * rPx).toFixed(1));
      lead.setAttribute("x2", a.x.toFixed(1));
      lead.setAttribute("y2", a.y.toFixed(1));
      dot.setAttribute("cx", a.x.toFixed(1));
      dot.setAttribute("cy", a.y.toFixed(1));
      const show = d > rPx ? "1" : "0";
      lead.setAttribute("opacity", show);
      dot.setAttribute("opacity", show);
    } else {
      lead.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
    }
    lensText(side, side ? bend[side] : 0);
  }

  requestAnimationFrame(frame);
}

/* ---------------- Stem TS inside the lens ----------------
   A stem segment (adapted from a root model: turned apex-up, recoloured,
   cut transversely) with a cellular transverse section on top. Auxin
   accumulates on the shaded flank; cells there elongate along the stem
   axis and widen slightly, so the section tilts toward the light. */
const CLIP_Y = 1.15;     // height of the transverse cut (segment radius = 1)
const SEG_E  = 0.5;     // extra segment elongation on the shaded flank at full auxin
const CELL_E = 6.0;      // extra cell elongation on the shaded flank at full auxin
const WEDGE_MIN = 45, WEDGE_MAX = 135; // cut-away quadrant, facing the viewer

const AUX_GLSL = `
uniform float uStim;
uniform float uSide;
uniform float uE;
uniform float uClip;
float auxAt(float x) { return uStim * pow(clamp((uSide * x + 1.0) * 0.5, 0.0, 1.0), 1.5); }
`;

function makeStemSection(gltf) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d10);
  scene.add(new THREE.HemisphereLight(0xeef4ff, 0x16200f, 1.15));
  const key = new THREE.DirectionalLight(0xfff0d2, 2.4);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 3.25, 5.35);
  camera.lookAt(0, 1.12, 0);

  // Tissue labels (rendered into the lens).
  function textSprite(text, opts = {}) {
    const c = document.createElement("canvas");
    c.width = 448; c.height = 104;
    const g = c.getContext("2d");
    g.font = "700 46px 'IBM Plex Sans', Roboto, sans-serif";
    const w = Math.min(440, g.measureText(text).width + 40);
    const x0 = (448 - w) / 2;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.beginPath(); g.roundRect(x0, 16, w, 72, 36); g.fill();
    g.fillStyle = opts.bg || "rgba(250,251,252,0.96)";
    g.beginPath(); g.roundRect(x0, 10, w, 72, 36); g.fill();
    g.fillStyle = opts.ink || "#12151a"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 224, 48);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(0.98, 0.2275, 1);
    s.renderOrder = 20;
    return s;
  }
  const LABELS = [
    { text: "Epidermis", r: 0.955, a: -20, dx: 0.12, dy: 0.42 },
    { text: "Cortex", r: 0.8, a: 200, dx: -0.12, dy: 0.42 },
    { text: "Vascular bundle", r: 0.53, a: 247.5, dx: -0.2, dy: 0.78 },
    { text: "Pith", r: 0.1, a: 270, dx: 0.38, dy: 0.78 },
  ];
  const labelObjs = LABELS.map((L) => {
    const sprite = textSprite(L.text);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }));
    line.renderOrder = 19;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    dot.renderOrder = 19;
    scene.add(sprite, line, dot);
    return { ...L, sprite, line, dot };
  });

  const U = { uStim: { value: 0 }, uSide: { value: -1 }, uE: { value: SEG_E }, uClip: { value: CLIP_Y } };

  // Bake the model: apex up, base centre at the origin, radius 1, cut-away facing +Z.
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  let capR = 1;
  const segment = new THREE.Group();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = new THREE.BufferGeometry();
    ["position", "normal", "uv", "uv1"].forEach((k) => { if (o.geometry.attributes[k]) g.setAttribute(k, toFloatAttr(o.geometry.attributes[k])); });
    if (o.geometry.index) g.setIndex(o.geometry.index);
    g.applyMatrix4(o.matrixWorld);
    g.rotateZ(Math.PI);
    g.translate(-0.0003, 0.0396, 0.0028);
    g.scale(1 / 0.052, 1 / 0.052, 1 / 0.052);
    g.rotateY(toRad(45));
    // Radius of the body at the cut height.
    const p = g.attributes.position;
    let rMax = 0;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - CLIP_Y) < 0.08) rMax = Math.max(rMax, Math.hypot(p.getX(i), p.getZ(i)));
    if (rMax > 0) capR = rMax;

    const mat = o.material.clone();
    mat.side = THREE.DoubleSide;
    mat.color = new THREE.Color(0.55, 1.0, 0.5); // shift the yellow-green texture to leaf green
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = AUX_GLSL + "varying float vOrigY;\n" + sh.vertexShader.replace("#include <begin_vertex>",
        `#include <begin_vertex>
         vOrigY = transformed.y;
         transformed.y *= 1.0 + uE * auxAt(transformed.x);`);
      sh.fragmentShader = "uniform float uClip;\nvarying float vOrigY;\n" + sh.fragmentShader.replace("void main() {",
        "void main() {\n  if (vOrigY > uClip) discard;");
    };
    mat.customProgramCacheKey = () => "phytohelios-stem-body";
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    segment.add(mesh);
  });
  scene.add(segment);

  // Cut surface: dark wall tissue beneath the cells, tilted with the segment.
  const capGeo = new THREE.PlaneGeometry(2.4, 2.4, 48, 48);
  capGeo.rotateX(-Math.PI / 2);
  capGeo.translate(0, CLIP_Y, 0);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x0f1d0c, roughness: 0.9, side: THREE.DoubleSide });
  capMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uCapR: { value: capR * 0.985 } });
    sh.vertexShader = AUX_GLSL + "varying vec2 vXZ;\n" + sh.vertexShader.replace("#include <begin_vertex>",
      `#include <begin_vertex>
       vXZ = transformed.xz;
       transformed.y *= 1.0 + uE * auxAt(transformed.x);`);
    sh.fragmentShader = "uniform float uCapR;\nvarying vec2 vXZ;\n" + sh.fragmentShader.replace("void main() {",
      `void main() {
        if (length(vXZ) > uCapR) discard;
        float ang = degrees(atan(vXZ.y, vXZ.x));
        if (ang > ${WEDGE_MIN.toFixed(1)} && ang < ${WEDGE_MAX.toFixed(1)}) discard;`);
  };
  capMat.customProgramCacheKey = () => "phytohelios-stem-cap";
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.frustumCulled = false;
  scene.add(cap);

  // Cells of a dicot stem TS: epidermis, cortex, ring of vascular bundles, pith.
  const cells = [];
  const inWedge = (x, z, pad = 4) => {
    const a = (Math.atan2(z, x) * 180) / Math.PI;
    return a > WEDGE_MIN - pad && a < WEDGE_MAX + pad;
  };
  const add = (r, a, fp, h, color) => {
    const x = Math.cos(a) * r * capR, z = Math.sin(a) * r * capR;
    if (inWedge(x, z)) return;
    cells.push({ x, z, fp: fp * capR, h, color: new THREE.Color(color), rot: Math.random() * Math.PI });
  };
  const ring = (r, fp, h, color, skip) => {
    const n = Math.floor((2 * Math.PI * r) / (fp * 2.15));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (!skip || !skip(a)) add(r, a, fp, h, color);
    }
  };
  const BUNDLES = 8;
  const nearBundle = (a, w) => {
    const step = (Math.PI * 2) / BUNDLES;
    const d = Math.abs(((a - step / 2) % step + step) % step - step / 2);
    return d < w;
  };
  ring(0.955, 0.03, 0.05, 0x3f7f22);                  // epidermis
  ring(0.885, 0.037, 0.06, 0x9fd46a);                   // cortex
  ring(0.8, 0.041, 0.06, 0xa9da76);
  ring(0.71, 0.041, 0.06, 0xb3df82);
  for (let b = 0; b < BUNDLES; b++) {                  // vascular bundles
    const a0 = ((b + 0.5) / BUNDLES) * Math.PI * 2;
    for (let k = -2; k <= 2; k++) add(0.615, a0 + k * 0.055, 0.024, 0.055, 0x2f5a20);      // phloem
    for (let k = -1; k <= 1; k++) add(0.555, a0 + k * 0.06, 0.022, 0.05, 0x5c8a3e);        // cambium
    for (let k = -1; k <= 1; k += 2) add(0.48, a0 + k * 0.045, 0.034, 0.05, 0xeef3d6);     // xylem
    add(0.43, a0, 0.03, 0.05, 0xe4edc6);
  }
  ring(0.56, 0.038, 0.06, 0xa9d37a, (a) => nearBundle(a, 0.17));   // medullary rays
  for (let gx = -0.42; gx <= 0.42; gx += 0.092) {                   // pith
    for (let gz = -0.42; gz <= 0.42; gz += 0.08) {
      const ox = (Math.round(gz / 0.08) % 2) * 0.046;
      const x = gx + ox, z = gz;
      if (Math.hypot(x, z) < 0.39) add(Math.hypot(x, z), Math.atan2(z, x), 0.039, 0.06, 0xd6efb4);
    }
  }

  const cellGeo = new THREE.CylinderGeometry(1, 1, 1, 7);
  cellGeo.translate(0, 0.5, 0);
  const cellMesh = new THREE.InstancedMesh(cellGeo, new THREE.MeshStandardMaterial({ roughness: 0.55 }), cells.length);
  cellMesh.frustumCulled = false;
  scene.add(cellMesh);

  // Auxin.
  const AUX_N = 14;
  // Indole-3-acetic acid: benzene + pyrrole rings with a CH2–COOH side chain.
  function iaaTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const g = c.getContext("2d");
    const glow = g.createRadialGradient(80, 80, 10, 80, 80, 78);
    glow.addColorStop(0, "rgba(255,210,80,0.55)"); glow.addColorStop(1, "rgba(255,190,60,0)");
    g.fillStyle = glow; g.fillRect(0, 0, 160, 160);
    const R = 22, hx = 60, hy = 88;                     // benzene ring centre
    const hex = [...Array(6)].map((_, i) => [hx + R * Math.cos(Math.PI / 6 + i * Math.PI / 3), hy + R * Math.sin(Math.PI / 6 + i * Math.PI / 3)]);
    // pyrrole ring shares the right-hand edge (hex[0], hex[5])
    const [ax, ay] = hex[5], [bx, by] = hex[0];
    const mx = (ax + bx) / 2 + R * 1.05, my = (ay + by) / 2;
    const pent = [[ax, ay], [ax + R * 0.95, ay - R * 0.3], [mx + R * 0.35, my], [bx + R * 0.95, by + R * 0.3], [bx, by]];
    const path = (pts, close = true) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); };
    g.lineJoin = "round"; g.lineCap = "round";
    path(hex); g.fillStyle = "#ffd24a"; g.fill(); g.lineWidth = 6; g.strokeStyle = "#5a3a00"; g.stroke();
    path(pent); g.fillStyle = "#ffbf26"; g.fill(); g.stroke();
    // N–H at the bottom of the pyrrole ring
    g.fillStyle = "#2f6bff"; g.beginPath(); g.arc(pent[3][0], pent[3][1], 7, 0, Math.PI * 2); g.fill();
    // side chain: C3 → CH2 → C(=O)OH
    const c3 = pent[1], ch2 = [c3[0] + 16, c3[1] - 22], cc = [ch2[0] + 22, ch2[1] - 6];
    path([c3, ch2, cc], false); g.lineWidth = 6; g.strokeStyle = "#5a3a00"; g.stroke();
    g.fillStyle = "#ff4d3d";
    g.beginPath(); g.arc(cc[0] + 10, cc[1] - 12, 8, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cc[0] + 12, cc[1] + 10, 8, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const iaaMat = new THREE.SpriteMaterial({ map: iaaTexture(), transparent: true, depthWrite: false });
  const auxSprites = [];
  for (let i = 0; i < AUX_N; i++) {
    const s = new THREE.Sprite(iaaMat);
    s.scale.setScalar(0.27);
    s.renderOrder = 15;
    scene.add(s);
    auxSprites.push(s);
  }
  // "IAA" label that follows the molecules.
  const iaaLabel = textSprite("IAA (auxin)", { bg: "rgba(255,201,51,0.97)", ink: "#241a0c" });
  const iaaLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const iaaLine = new THREE.Line(iaaLineGeo, new THREE.LineBasicMaterial({ color: 0xffc933, transparent: true, opacity: 0.95, depthTest: false }));
  iaaLine.renderOrder = 19;
  scene.add(iaaLabel, iaaLine);
  const aux = [];
  for (let i = 0; i < AUX_N; i++) {
    let x, z;
    do { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.85 * capR; x = Math.cos(a) * r; z = Math.sin(a) * r; } while (inWedge(x, z, 8));
    let tx, tz;
    do { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.85 * capR; tx = Math.abs(Math.cos(a) * r) * 0.75 + 0.15 * capR; tz = Math.sin(a) * r; } while (inWedge(-tx, tz, 8) || inWedge(tx, tz, 8));
    aux.push({ x, z, hx: x, hz: z, tx, tz, vx: 0, vz: 0, phase: Math.random() * 6.28 });
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const warm = new THREE.Color(0xe6e27a), tmpC = new THREE.Color();
  let stimNow = 0, sideNow = -1;
  const auxAt = (x) => stimNow * Math.pow(Math.max(0, Math.min(1, (sideNow * x / capR + 1) / 2)), 1.5);

  function update(side, tipBendDeg, sunDeg, now) {
    const shaded = sunDeg > AUXIN_THRESHOLD ? -1 : sunDeg < -AUXIN_THRESHOLD ? 1 : 0;
    const target = side && shaded !== 0 && sim.hours > curLag() ? Math.min(1, Math.abs(tipBendDeg) / MAX_BEND) : 0;
    stimNow += (target - stimNow) * 0.06;
    if (shaded !== 0) sideNow = shaded;
    U.uStim.value = stimNow;
    U.uSide.value = sideNow;

    const a = toRad(sunDeg);
    key.position.set(Math.sin(a) * 5, Math.cos(a) * 5 + 0.5, 1.2);

    cells.forEach((c, i) => {
      const k = auxAt(c.x);
      const baseY = CLIP_Y * (1 + SEG_E * k);
      const f = c.fp * (1 + 0.18 * k);
      pos.set(c.x, baseY, c.z);
      q.setFromAxisAngle(yAxis, c.rot);
      scl.set(f, c.h * (1 + CELL_E * k), f);
      cellMesh.setMatrixAt(i, m4.compose(pos, q, scl));
      cellMesh.setColorAt(i, tmpC.copy(c.color).lerp(warm, k * 0.35));
    });
    cellMesh.instanceMatrix.needsUpdate = true;

    labelObjs.forEach((L) => {
      const ax = Math.cos(toRad(L.a)) * L.r * capR, az = Math.sin(toRad(L.a)) * L.r * capR;
      const k = auxAt(ax);
      const ay = CLIP_Y * (1 + SEG_E * k) + 0.06 * (1 + CELL_E * k);
      const lx = ax + L.dx, ly = ay + L.dy, lz = az;
      L.sprite.position.set(lx, ly, lz);
      const p = L.line.geometry.attributes.position;
      p.setXYZ(0, ax, ay, az); p.setXYZ(1, lx, ly - 0.1, lz); p.needsUpdate = true;
      L.dot.position.set(ax, ay, az);
    });
    if (cellMesh.instanceColor) cellMesh.instanceColor.needsUpdate = true;

    let cx = 0, cy = 0, cz = 0;
    aux.forEach((p, i) => {
      const goalX = p.hx + ((sideNow * p.tx) - p.hx) * stimNow;
      const goalZ = p.hz + (p.tz - p.hz) * stimNow;
      p.vx += (goalX - p.x) * 0.05 + (Math.random() - 0.5) * 0.004;
      p.vz += (goalZ - p.z) * 0.05 + (Math.random() - 0.5) * 0.004;
      p.vx *= 0.85; p.vz *= 0.85;
      p.x += p.vx; p.z += p.vz;
      const k = auxAt(p.x);
      const top = CLIP_Y * (1 + SEG_E * k) + 0.06 * (1 + CELL_E * k) + 0.07 + Math.sin(now / 500 + p.phase) * 0.015;
      auxSprites[i].position.set(p.x, top + 0.05, p.z);
      cx += p.x; cy += top; cz += p.z;
    });
    cx /= AUX_N; cy /= AUX_N; cz /= AUX_N;
    const lx = Math.max(-0.75, Math.min(0.75, cx)), ly = cy + 0.95;
    iaaLabel.position.set(lx, ly, cz);
    const ip = iaaLine.geometry.attributes.position;
    ip.setXYZ(0, cx, cy + 0.12, cz); ip.setXYZ(1, lx, ly - 0.1, cz); ip.needsUpdate = true;
  }

  update(null, 0, 0, 0);
  function setTheme(light) { scene.background.set(light ? 0xe9edf2 : 0x0b0d10); }
  return { scene, camera, update, setTheme };
}

function lensText(side, tipBendDeg) {
  let label = "", l1 = "", l2 = "";
  if (side === "left") {
    label = "Stem TS · Control";
    l1 = "Sun A is directly overhead";
    l2 = "Auxin evenly distributed · uniform elongation";
  } else if (side === "right") {
    label = "Stem TS · Experimental";
    if (SPECTRUM[sim.colour].w === 0) { l1 = "Red light: not absorbed by phototropins"; l2 = "No lateral signal · auxin stays even"; }
    else if (sim.hours <= curLag()) { l1 = "Apex perceiving light direction"; l2 = "Auxin not yet redistributed"; }
    else if (Math.abs(settingsAt(sim.hours - curLag()).sun) <= AUXIN_THRESHOLD) { l1 = "Light perceived from near vertical"; l2 = "Auxin evenly distributed"; }
    else {
      const shaded = settingsAt(sim.hours - curLag()).sun > 0 ? "left" : "right";
      l1 = "Auxin accumulates on the shaded flank";
      l2 = `Cells on the shaded (${shaded}) flank elongate`;
    }
  } else {
    label = "Magnifier";
    l1 = "Drag the lens over a shoot apex";
  }
  if ($("callTitle").textContent !== label) $("callTitle").textContent = label;
  if ($("callLine1").textContent !== l1) $("callLine1").textContent = l1;
  if ($("callLine2").textContent !== l2) $("callLine2").textContent = l2;
}

const AUXIN_THRESHOLD = 3;

/* ---------------- Light-tight partition ----------------
   Matte blackout panel in an anodised aluminium frame on two T-feet. */
function boardTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const img = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const grain = Math.sin(y * 0.9 + Math.sin(x * 0.05) * 3) * 6; // faint vertical fibre
      const v = 128 + (Math.random() - 0.5) * 46 + grain;
      const i = (y * 256 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

function makeDivider(envTex) {
  const H = 2.4, D = 2.4, T = 0.045;
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const tex = boardTexture();
  const board = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.92, roughnessMap: tex, bumpMap: tex, bumpScale: 0.35 });
  const alu = new THREE.MeshStandardMaterial({ color: 0xc3c7cd, metalness: 1, roughness: 0.34, envMap: envTex, envMapIntensity: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, envMap: envTex, envMapIntensity: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.25, envMap: envTex, envMapIntensity: 1 });

  const base = 0.06;
  add(new RoundedBoxGeometry(T, H - 0.1, D - 0.1, 2, 0.01), board, 0, base + H / 2, 0);            // panel
  add(new RoundedBoxGeometry(0.075, 0.06, D, 3, 0.012), alu, 0, base + H, 0);                       // top rail
  add(new RoundedBoxGeometry(0.075, 0.06, D, 3, 0.012), alu, 0, base + 0.03, 0);                    // bottom rail
  for (const z of [-D / 2, D / 2]) {
    add(new RoundedBoxGeometry(0.075, H + 0.06, 0.06, 3, 0.012), alu, 0, base + H / 2, z);          // posts
    add(new RoundedBoxGeometry(0.06, 0.006, 0.062, 2, 0.002), dark, 0, base + H * 0.5, z);          // shadow-gap groove
    add(new RoundedBoxGeometry(0.58, 0.035, 0.1, 3, 0.012), alu, 0, 0.0175, z);                     // T-foot
    for (const x of [-0.26, 0.26]) add(new THREE.CylinderGeometry(0.03, 0.034, 0.012, 20), dark, x, 0.006, z); // rubber pads
    for (const y of [0.35, H * 0.5 + 0.06, H - 0.25]) {                                              // fixing screws
      for (const sx of [-1, 1]) {
        const s = add(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 16), steel, sx * 0.0405, base + y, z);
        s.rotation.z = Math.PI / 2;
      }
    }
  }
  // Brush seal where the panel meets the frame.
  add(new THREE.BoxGeometry(0.05, 0.012, D - 0.1), dark, 0, base + 0.065, 0);
  add(new THREE.BoxGeometry(0.05, 0.012, D - 0.1), dark, 0, base + H - 0.035, 0);
  return g;
}

/* ---------------- Sundial: Sun B angle control ----------------
   The light follows Sun B; the gnomon's shadow sweeps the dial. Drag
   horizontally (or use the arrow keys) to change the angle. */
function makeSundial(gltf, canvas, onChange) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setClearColor(0x000000, 0);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.1;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x2a2016, 0.75));
  const sunLight = new THREE.DirectionalLight(0xfff0d0, 2.6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const sc = sunLight.shadow.camera;
  sc.left = sc.bottom = -1.4; sc.right = sc.top = 1.4; sc.near = 0.5; sc.far = 10;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight, sunLight.target);

  // Dial normalised: half-width 1, base on y = 0, gnomon pointing away from the viewer.
  const model = gltf.scene;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if (o.material) { o.material.envMap = env; o.material.envMapIntensity = 0.6; }
  });
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  const body = new THREE.Group();
  const inner = new THREE.Group();
  const offset = new THREE.Group();
  offset.add(model);
  offset.position.set(-ctr.x, -box.min.y, -ctr.z);
  inner.add(offset);
  body.add(inner);
  body.scale.setScalar(2 / Math.max(size.x, size.z));
  scene.add(body);
  body.updateMatrixWorld(true);

  // Gnomon = the geometry standing well above the plate; turn the dial so it points to -Z.
  {
    const v = new THREE.Vector3();
    let sx = 0, sz = 0, n = 0, maxY = 0;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); maxY = Math.max(maxY, v.y); }
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        if (v.y > maxY * 0.55) { sx += v.x; sz += v.z; n++; }
      }
    });
    if (n) inner.rotation.y = Math.atan2(sx / n, sz / n) - Math.PI; // centroid direction → -Z
  }
  body.updateMatrixWorld(true);
  const faceY = 0.06;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
  camera.position.set(0, 3.55, 2.25);
  camera.lookAt(0, 0, 0.12);

  let angle = 0;
  function draw() {
    const a = toRad(angle);
    const dir = new THREE.Vector3(Math.sin(a), Math.cos(a) * 0.9 + 0.12, -0.42).normalize();
    sunLight.position.copy(dir).multiplyScalar(5);
    sunLight.target.position.set(0, faceY, 0);
    r.render(scene, camera);
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    draw();
  }
  new ResizeObserver(resize).observe(canvas);

  // Sun handle on an arc above the dial (SVG, 132 × 132 units).
  const HC = { x: 66, y: 76, r: 62 };
  const knob = $("sunKnob"), handleSvg = $("sunHandle");
  {
    let d = "";
    for (let a = -SUN_ANGLE_CAP; a <= SUN_ANGLE_CAP; a += 1) {
      const rad = toRad(a);
      d += (a === -SUN_ANGLE_CAP ? "M" : "L") + (HC.x + Math.sin(rad) * HC.r).toFixed(1) + " " + (HC.y - Math.cos(rad) * HC.r).toFixed(1) + " ";
    }
    $("sunArc").setAttribute("d", d.trim());
  }
  function placeKnob() {
    const rad = toRad(angle);
    const x = HC.x + Math.sin(rad) * HC.r, y = HC.y - Math.cos(rad) * HC.r;
    knob.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    const ray = $("sunRay");
    ray.setAttribute("x1", x.toFixed(1)); ray.setAttribute("y1", y.toFixed(1));
    ray.setAttribute("x2", (HC.x + (x - HC.x) * 0.25).toFixed(1)); ray.setAttribute("y2", (HC.y + (y - HC.y) * 0.25).toFixed(1));
  }
  let knobDrag = false;
  knob.addEventListener("pointerdown", (e) => { e.stopPropagation(); knobDrag = true; knob.classList.add("dragging"); knob.setPointerCapture(e.pointerId); });
  knob.addEventListener("pointermove", (e) => {
    if (!knobDrag) return;
    const pt = handleSvg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(handleSvg.getScreenCTM().inverse());
    setAngle((Math.atan2(p.x - HC.x, -(p.y - HC.y)) * 180) / Math.PI, true);
  });
  const knobEnd = () => { if (knobDrag) buzz(8); knobDrag = false; knob.classList.remove("dragging"); };
  knob.addEventListener("pointerup", knobEnd);
  knob.addEventListener("pointercancel", knobEnd);

  function setAngle(deg, notify = false) {
    angle = Math.max(-SUN_ANGLE_CAP, Math.min(SUN_ANGLE_CAP, deg));
    placeKnob();
    $("dialReadout").textContent = `${Math.round(angle)}°`;
    canvas.setAttribute("aria-valuenow", String(Math.round(angle)));
    draw();
    if (notify) onChange(angle);
  }

  // Drag horizontally to sweep the sun.
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, a: angle };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const span = canvas.clientWidth || 120;
    setAngle(drag.a + ((e.clientX - drag.x) / span) * 110, true);
  });
  const end = () => { drag = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setAngle(angle - step, true); }
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setAngle(angle + step, true); }
    if (e.key === "Home") { e.preventDefault(); setAngle(0, true); }
  });

  resize();
  return { setAngle };
}

/* ---------------- Start ---------------- */
try {
  setProgress(4, "Loading 3D engine");
  THREE = await import("three");
  setProgress(16, "Loading 3D engine");
  ({ GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"));
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
  ({ RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js"));
  ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
  await init();
} catch (e) { fail(e); }

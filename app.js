/* Sketch Viewer — 3D перегляд меблевих деталей.
   Модулі: сцена → дані → оверлеї деталі → інтерфейс → QR → офлайн. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =====================================================================
   1. КОНСТАНТИ ТА УТИЛІТИ
   ===================================================================== */

const MM = 0.001;                       // мм -> метри
const SAVED_KEY = 'sketchcab.viewer.saved';
const THEME_KEY = 'sketchcab.viewer.theme';

// Кольори сцени під кожну тему: фон, сітка, контури деталей.
const THEMES = {
  light: { bg: 0xe9edf2, grid1: 0xb6c2cf, grid2: 0xd6dde5,
           outline: 0x16202a, ground: 0xd7dee6, hemi: 1.05, key: 2.0 },
  dark:  { bg: 0x0f1216, grid1: 0x3a4552, grid2: 0x232a32,
           outline: 0xa9b8c6, ground: 0x2a2f36, hemi: 1.15, key: 2.1 }
};
const LAST_KEY = 'sketchcab.viewer.last';

// ті самі кольори, що в кромкуванні та кресленнях SketchCab
const EDGE_COLORS = {
  '0.4': '#00b400', '0.5': '#00dc00', '0.6': '#50c850',
  '0.8': '#e08000', '1.0': '#7d9aa8', '2.0': '#a000a0'
};
const EDGE_FALLBACK = '#c98bff';
const NO_EDGE = '#39434f';

// сторони — як у кромкуванні SketchCab (back/front/left/right)
const EDGE_LABELS = {
  top: 'Зад · довга сторона',
  bottom: 'Перед · довга сторона',
  left: 'Ліво · торець',
  right: 'Право · торець'
};

const HOLE_COLORS = {
  dowel: '#ff8a3d',
  confirm: '#ff5c5c',
  minifix: '#4d9bff',
  hinge: '#c98bff',
  shelf: '#4dffa1',
  through: '#ffd24d',
  other: '#8b95a3'
};

const HOLE_LABELS = {
  dowel: 'шкант',
  confirm: 'конфірмат',
  minifix: 'ексцентрик',
  hinge: 'петля',
  shelf: 'полкотримач',
  through: 'наскрізний',
  other: 'інше'
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function edgeColor(value) {
  const v = Number(value) || 0;
  if (v <= 0) return NO_EDGE;
  return EDGE_COLORS[v.toFixed(1)] || EDGE_FALLBACK;
}

function fmt(value, digits = 0) {
  const n = Number(value) || 0;
  return n.toFixed(digits).replace(/\.0+$/, '');
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2600);
}

function setLoading(active, text) {
  $('loader').hidden = !active;
  if (text) $('loaderText').textContent = text;
}

/* =====================================================================
   2. СТАН ЗАСТОСУНКУ
   ===================================================================== */

const state = {
  projectId: null,
  manifest: null,
  mode: 'assembly',
  activePartId: null,
  explode: 0,
  showHardware: true,
  scanner: null
};

/* =====================================================================
   3. СЦЕНА THREE.JS
   ===================================================================== */

const stage = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  root: null,          // поточна модель
  overlays: null,      // група оверлеїв деталі
  partObjects: [],     // { object, partId, offset }
  pickable: [],
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  grid: null,
  hemi: null,
  key: null,
  outlines: [],      // матеріали контурних ліній — перефарбовуються з темою
  hardware: null,    // група 3D-кріплення у збірці
  xray: false,       // напівпрозорі деталі
  highlighted: null
};

function initStage() {
  const canvas = $('scene');
  stage.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  stage.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  stage.renderer.toneMappingExposure = 1.05;

  stage.scene = new THREE.Scene();
  stage.scene.background = null;

  stage.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
  stage.camera.position.set(1.2, 1.0, 1.6);

  stage.controls = new OrbitControls(stage.camera, canvas);
  stage.controls.enableDamping = true;
  stage.controls.dampingFactor = 0.08;
  stage.controls.rotateSpeed = 0.9;
  stage.controls.panSpeed = 0.8;
  stage.controls.minDistance = 0.1;
  stage.controls.maxDistance = 30;

  // Навігація як у SketchUp:
  //   затиснуте колесо        — обертання
  //   Shift + колесо (або ЛКМ) — переміщення
  //   права кнопка            — переміщення
  //   прокрутка               — масштаб до курсора
  //
  // ВАЖЛИВО: OrbitControls САМ перемикає режим модифікатором — при ROTATE
  // натиснутий Shift дає Pan, а при PAN навпаки. Тому вручну підміняти
  // mouseButtons на Shift не можна: бібліотека переверне це назад, і
  // переміщення поїде на Ctrl. Лишаємо ROTATE — Shift спрацює штатно.
  stage.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: THREE.MOUSE.PAN
  };
  stage.controls.screenSpacePanning = true;
  if ('zoomToCursor' in stage.controls) stage.controls.zoomToCursor = true;
  stage.controls.zoomSpeed = 1.1;

  // середня кнопка в браузері вмикає автопрокрутку — вимикаємо
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x2a2f36, 1.15);
  stage.hemi = hemi;
  stage.scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  stage.key = key;
  key.position.set(2.4, 3.6, 2.2);
  stage.scene.add(key);

  const fill = new THREE.DirectionalLight(0xbcd3ff, 0.8);
  fill.position.set(-2.6, 1.2, -1.8);
  stage.scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffd9a0, 0.6);
  rim.position.set(0.4, -1.6, -2.4);
  stage.scene.add(rim);

  buildGrid();

  stage.root = new THREE.Group();
  stage.scene.add(stage.root);

  stage.overlays = new THREE.Group();
  stage.scene.add(stage.overlays);

  stage.hardware = new THREE.Group();
  stage.scene.add(stage.hardware);

  window.addEventListener('resize', resizeStage);
  resizeStage();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  stage.raycaster.params.Line.threshold = 0.0015;   // 1.5 мм, а не 1 метр
  stage.raycaster.params.Points.threshold = 0.0015;

  stage.renderer.setAnimationLoop(() => {
    stage.controls.update();
    stage.renderer.render(stage.scene, stage.camera);
  });
}

function themeName() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function buildGrid() {
  const t = THEMES[themeName()];
  const old = stage.grid;
  const grid = new THREE.GridHelper(6, 24, t.grid1, t.grid2);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  if (old) {
    grid.position.copy(old.position);
    grid.visible = old.visible;
    stage.scene.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
  stage.grid = grid;
  stage.scene.add(grid);
}

// Перефарбовує сцену під поточну тему: фон, сітка, світло, контури.
function updateSceneTheme() {
  if (!stage.scene) return;
  const t = THEMES[themeName()];
  stage.scene.background = new THREE.Color(t.bg);
  if (stage.hemi) {
    stage.hemi.groundColor = new THREE.Color(t.ground);
    stage.hemi.intensity = t.hemi;
  }
  if (stage.key) stage.key.intensity = t.key;
  buildGrid();
  stage.outlines.forEach((material) => material.color.set(t.outline));

  // план деталі малюється як SVG — перемальовуємо під нову тему
  const part = state.activePartId ? findPart(state.activePartId) : null;
  if (part && !$('spec').hidden) drawPlan(part);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f1216' : '#e9edf2');
  updateSceneTheme();
}

function resizeStage() {
  const canvas = $('scene');
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  stage.renderer.setSize(width, height, false);
  stage.camera.aspect = width / height;
  stage.camera.updateProjectionMatrix();
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          if (material.map) material.map.dispose();
          material.dispose();
        });
      }
    });
  }
}

function boundsOf(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { box, size, center };
}

function frameObject(object, factor = 1.5) {
  const { size, center } = boundsOf(object);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5;
  const distance = (radius / Math.tan((stage.camera.fov * Math.PI) / 360)) * factor;

  stage.camera.near = Math.max(radius / 120, 0.005);
  stage.camera.far = distance * 12;
  stage.camera.updateProjectionMatrix();

  const direction = new THREE.Vector3(0.85, 0.62, 1).normalize();
  stage.camera.position.copy(center).addScaledVector(direction, distance);
  stage.controls.target.copy(center);
  stage.controls.minDistance = radius * 0.35;
  stage.controls.maxDistance = distance * 6;
  stage.controls.update();

  if (stage.grid) {
    stage.grid.position.set(center.x, 0, center.z);
    stage.grid.visible = state.mode === 'assembly';
  }
}

// Чіткі контури: ребра геометрії малюються лініями поверх матеріалу.
// Поріг 24° — показує грані панелі, паз і торець отвору, але не тріангуляцію.
function addOutlines(root, threshold) {
  const color = THEMES[themeName()].outline;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((node) => { if (node.isMesh && node.geometry) meshes.push(node); });

  meshes.forEach((mesh) => {
    let edges;
    try {
      edges = new THREE.EdgesGeometry(mesh.geometry, threshold == null ? 24 : threshold);
    } catch (error) {
      return;
    }
    if (!edges.attributes.position || edges.attributes.position.count === 0) {
      edges.dispose();
      return;
    }
    const material = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false
    });
    const lines = new THREE.LineSegments(edges, material);
    lines.renderOrder = 1;
    lines.userData.outline = true;
    // ВАЖЛИВО: Raycaster ловить лінії з допуском Line.threshold (типово 1
    // світова одиниця = 1 метр!). Через це клік по будь-якому місцю чіплявся
    // за контур сусідньої деталі й підсвічував не ту. Контури — не клікабельні.
    lines.raycast = function () {};
    mesh.add(lines);              // успадковує трансформацію самого меша
    stage.outlines.push(material);
  });
}

const gltfLoader = new GLTFLoader();

// Усі деталі проєкту лежать в одному parts.glb (кожна — окремий вузол).
// Завантажуємо його один раз і далі беремо потрібний вузол за іменем:
// на великому виробі це один файл замість сотні.
let partsSceneCache = { url: null, scene: null };

async function loadPartsScene() {
  const url = projectAsset(state.manifest.partsGlb || 'models/parts.glb');
  if (partsSceneCache.url === url && partsSceneCache.scene) return partsSceneCache.scene;
  const scene = await loadGLB(url);
  partsSceneCache = { url, scene };
  return scene;
}

// Копія моделі однієї деталі: за іменем вузла зі спільного файлу
// або, для старих проєктів, з окремого part_XX.glb.
async function loadPartModel(part) {
  if (part.node || state.manifest.partsGlb) {
    const scene = await loadPartsScene();
    const node = scene.getObjectByName(part.node || part.id);
    if (!node) throw new Error('вузол не знайдено: ' + (part.node || part.id));
    return node.clone(true);
  }
  return loadGLB(projectAsset(part.glb));
}

async function loadGLB(url) {
  const gltf = await gltfLoader.loadAsync(url);
  return gltf.scene;
}

/* ---- підсвічування ---- */

function highlight(partId) {
  if (stage.highlighted) {
    stage.highlighted.forEach(({ material, emissive, intensity }) => {
      material.emissive.setHex(emissive);
      material.emissiveIntensity = intensity;
    });
    stage.highlighted = null;
  }
  if (!partId) return;

  const changed = [];
  stage.partObjects
    .filter((entry) => entry.partId === partId)
    .forEach((entry) => {
      entry.object.traverse((node) => {
        if (!node.isMesh) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          if (!material.emissive) return;
          if (!material.userData.sketchCloned) {
            const clone = material.clone();
            clone.userData.sketchCloned = true;
            node.material = clone;
          }
        });
        const list = Array.isArray(node.material) ? node.material : [node.material];
        list.forEach((material) => {
          if (!material.emissive) return;
          changed.push({
            material,
            emissive: material.emissive.getHex(),
            intensity: material.emissiveIntensity
          });
          material.emissive.setHex(0xf2b33d);
          material.emissiveIntensity = 0.35;
        });
      });
    });
  stage.highlighted = changed;
}

/* ---- 3D-фурнітура у збірці ---- */

// Спрощені, але впізнавані моделі: конфірмат із головкою, шкант, ексцентрик
// із штоком, чашка петлі з планкою, полицетримач. Координати й напрямки
// уже пораховані плагіном у просторі збірки (manifest.hardware).
// Отвір у збірці малюється ТАК САМО, як у режимі деталі: темна стінка
// свердління (видима зсередини), дно для глухих, тонкий обідок кольором
// за типом кріплення і чітке коло гирла. Вісь +Y дивиться вглиб матеріалу.
function assemblyHoleMesh(item) {
  const d = Math.max(Number(item.diameter) || 5, 2) * MM;
  const radius = d / 2;
  const depth = Math.min(Math.max(Number(item.depth) || 12, 4), 40) * MM;
  const dark = themeName() === 'dark' ? 0x39424d : 0x5b6672;
  const color = new THREE.Color(HOLE_COLORS[item.type] || HOLE_COLORS.other);

  const group = new THREE.Group();

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, depth, 24, 1, true),
    new THREE.MeshStandardMaterial({
      color: dark, roughness: 0.95, metalness: 0, side: THREE.BackSide
    })
  );
  wall.position.y = depth / 2;
  group.add(wall);

  if (item.type !== 'through') {
    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 24),
      new THREE.MeshStandardMaterial({ color: dark, roughness: 1, side: THREE.DoubleSide })
    );
    bottom.position.y = depth;
    bottom.rotation.x = Math.PI / 2;
    group.add(bottom);
  }

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius * 1.16, 28),
    new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    })
  );
  ring.position.y = 0.2 * MM;
  ring.rotation.x = Math.PI / 2;
  ring.renderOrder = 3;
  group.add(ring);

  const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2);
  const rim = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(40).map((p) => new THREE.Vector3(p.x, 0, p.y))
    ),
    new THREE.LineBasicMaterial({
      color: THEMES[themeName()].outline, transparent: true, opacity: 0.8
    })
  );
  rim.position.y = 0.25 * MM;
  rim.raycast = function () {};
  rim.renderOrder = 4;
  group.add(rim);

  return group;
}

function buildHardware(list) {
  clearGroup(stage.hardware);
  if (!Array.isArray(list) || !list.length) return;

  const up = new THREE.Vector3(0, 1, 0);
  list.forEach((item) => {
    const group = assemblyHoleMesh(item);
    const normal = new THREE.Vector3(
      Number(item.nx) || 0, Number(item.ny) || 0, Number(item.nz) || 0
    );
    if (normal.lengthSq() < 1e-8) normal.set(0, -1, 0);
    normal.normalize();

    // вісь моделі (+Y) — углиб матеріалу
    group.quaternion.setFromUnitVectors(up, normal);
    group.position.set(Number(item.x) || 0, Number(item.y) || 0, Number(item.z) || 0);
    group.userData.hardware = item;
    group.traverse((node) => { node.userData.hardware = item; });
    stage.hardware.add(group);
  });
}

/* ---- прозорість (рентген) ---- */

// Робить деталі напівпрозорими, щоб було видно присадку й кріплення
// всередині збірки. Контури й фурнітура лишаються непрозорими.
function setXray(enabled) {
  stage.xray = enabled;
  stage.root.traverse((node) => {
    if (!node.isMesh || node.userData.outline) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => {
      if (!material) return;
      if (material.userData.baseOpacity === undefined) {
        material.userData.baseOpacity = material.opacity;
        material.userData.baseTransparent = material.transparent;
        material.userData.baseDepthWrite = material.depthWrite;
      }
      if (enabled) {
        material.transparent = true;
        material.opacity = 0.45;
        material.depthWrite = false;
      } else {
        material.opacity = material.userData.baseOpacity;
        material.transparent = material.userData.baseTransparent;
        material.depthWrite = material.userData.baseDepthWrite;
      }
      material.needsUpdate = true;
    });
  });
  const button = $('btnXray');
  if (button) button.classList.toggle('is-on', enabled);
}

/* ---- вибір деталі кліком ---- */

let pointerStart = null;

function onPointerDown(event) {
  pointerStart = { x: event.clientX, y: event.clientY, time: Date.now() };
}

function onPointerUp(event) {
  if (!pointerStart) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  const elapsed = Date.now() - pointerStart.time;
  pointerStart = null;
  if (moved > 8 || elapsed > 700) return;

  const rect = $('scene').getBoundingClientRect();
  stage.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  stage.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  stage.raycaster.setFromCamera(stage.pointer, stage.camera);

  if (state.mode === 'part') {
    const holeHits = stage.raycaster.intersectObjects(stage.overlays.children, true);
    const hole = holeHits.find((hit) => hit.object.userData.hole);
    if (hole) {
      focusHole(hole.object.userData.holeIndex);
      return;
    }
  }

  const hits = stage.raycaster.intersectObject(stage.root, true);
  if (!hits.length) return;

  let node = hits[0].object;
  while (node && !node.userData.partId) node = node.parent;
  if (!node) return;

  selectPart(node.userData.partId, { focus: false });
}

/* =====================================================================
   4. ЗАВАНТАЖЕННЯ ДАНИХ
   ===================================================================== */

function manifestUrl(projectId) {
  return `projects/${encodeURIComponent(projectId)}/manifest.json`;
}

function projectAsset(relative) {
  return `projects/${encodeURIComponent(state.projectId)}/${relative}`;
}

async function fetchJSON(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    // мережевий збій: сервер зупинено разом зі SketchUp або змінилась адреса
    const failure = new Error('SERVER_DOWN');
    failure.code = 'SERVER_DOWN';
    throw failure;
  }
  if (!response.ok) {
    const failure = new Error(`${response.status} ${url}`);
    failure.code = response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
    throw failure;
  }
  return response.json();
}

const SERVER_HINT = 'Сервер не відповідає. У SketchUp: Plugins ▸ SketchCab В’ювер ▸ Сервер: пуск';

async function openProject(projectId, partId) {
  setLoading(true, 'Завантаження проєкту…');
  try {
    const manifest = await fetchJSON(manifestUrl(projectId));
    state.projectId = projectId;
    state.manifest = manifest;
    partsSceneCache = { url: null, scene: null };
    localStorage.setItem(LAST_KEY, projectId);

    $('projectId').textContent = manifest.projectId || projectId;
    $('projectName').textContent = manifest.projectName || 'Проєкт';
    $('partsCount').textContent = manifest.parts ? manifest.parts.length : 0;
    document.title = `${manifest.projectName || 'Sketch'} — Sketch`;

    renderPartsList();
    renderSavedList();

    if (partId) {
      await showPart(partId);
    } else {
      await showAssembly();
    }
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast(error.code === 'SERVER_DOWN'
      ? SERVER_HINT
      : 'Проєкт не знайдено. Перевірте посилання або збережіть його офлайн.');
    openPicker();
  }
}

/* ---- режим збірки ---- */

async function showAssembly() {
  state.mode = 'assembly';
  state.activePartId = null;
  syncModeUI();

  clearGroup(stage.root);
  clearGroup(stage.overlays);
  clearGroup(stage.hardware);
  stage.outlines = [];
  stage.partObjects = [];

  const parts = (state.manifest.parts || []).filter(
    (part) => (part.node || part.glb) && Array.isArray(part.instances) && part.instances.length
  );

  if (parts.length) {
    await buildAssemblyFromParts(parts);
  } else {
    await loadAssemblyFile();
  }
}

// Збірка складається з ТИХ САМИХ моделей деталей, які показує режим деталі,
// разом з їхніми отворами й пазами. Отвір — дочірній об'єкт деталі, тому
// він не може «з'їхати» відносно неї і сам їде разом з нею у вибух-схемі.
// Матриці розміщення рахує плагін (manifest.parts[].instances).
async function buildAssemblyFromParts(parts) {
  setLoading(true, 'Складання збірки…');
  const assembly = new THREE.Group();
  stage.root.add(assembly);

  for (const part of parts) {
    let scene;
    try {
      scene = await loadPartModel(part);
    } catch (error) {
      console.warn('деталь не завантажено:', part.id, error);
      continue;
    }

    const normalized = normalizePart(scene, part);
    const template = normalized.group;
    addOutlines(template, 28);
    buildGrooveOverlays(part, normalized, template);
    buildHoleOverlays(part, normalized, template);

    // Деталь лежить у сцені рівно так, як її експортовано, тому матриця
    // інстансу з маніфесту застосовується напряму, без жодних поправок.
    part.instances.forEach((values, index) => {
      const matrix = new THREE.Matrix4().fromArray(values);
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(matrix);
      holder.add(index === 0 ? template : template.clone(true));

      const mover = new THREE.Group();      // окремий рівень для вибух-схеми
      mover.userData.partId = part.id;
      mover.add(holder);
      assembly.add(mover);

      stage.partObjects.push({
        object: mover, partId: part.id,
        base: new THREE.Vector3(), offset: new THREE.Vector3()
      });
    });
  }

  assembly.updateMatrixWorld(true);
  const bounds = boundsOf(assembly);
  stage.partObjects.forEach((entry) => {
    const own = boundsOf(entry.object);
    entry.offset.copy(own.center).sub(bounds.center);
    if (entry.offset.lengthSq() < 1e-8) entry.offset.set(0, 0.001, 0);
    entry.base.copy(entry.object.position);
  });

  setHolesVisible(state.showHardware !== false);
  if (stage.xray) setXray(true);
  frameObject(assembly);
  applyExplode(state.explode);
  setLoading(false);
}

// Запасний шлях: старий assembly.glb (проєкти, експортовані раніше).
async function loadAssemblyFile() {
  const url = projectAsset(state.manifest.assemblyGlb || 'models/assembly.glb');
  setLoading(true, 'Завантаження збірки…');

  try {
    const scene = await loadGLB(url);
    stage.root.add(scene);

    const assembly = boundsOf(scene);
    scene.traverse((node) => {
      if (!node.isMesh) return;
      let holder = node;
      while (holder && !holder.userData.partId) holder = holder.parent;
      if (!holder) return;
      if (stage.partObjects.some((entry) => entry.object === holder)) return;

      const bounds = boundsOf(holder);
      const offset = bounds.center.clone().sub(assembly.center);
      if (offset.lengthSq() < 1e-8) offset.set(0, 0.001, 0);
      stage.partObjects.push({
        object: holder, partId: holder.userData.partId,
        base: holder.position.clone(), offset
      });
    });

    addOutlines(scene, 32);
    if (stage.xray) setXray(true);
    frameObject(scene);
    applyExplode(state.explode);
    setLoading(false);
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast(navigator.onLine ? SERVER_HINT : 'Збірка недоступна офлайн — збережіть проєкт у вкладці «Офлайн»');
  }
}

// Показ/приховування позначок присадки (вони живуть усередині деталей).
function setHolesVisible(visible) {
  state.showHardware = visible;
  [stage.root, stage.overlays].forEach((group) => {
    group.traverse((node) => {
      if (node.userData && node.userData.hole) node.visible = visible;
    });
  });
  const button = $('btnHardware');
  if (button) button.classList.toggle('is-on', visible);
}

function applyExplode(percent) {
  state.explode = percent;
  const factor = (percent / 100) * 0.9;
  stage.partObjects.forEach((entry) => {
    entry.object.position.copy(entry.base).addScaledVector(entry.offset, factor);
  });
  $('explodeValue').textContent = `${Math.round(percent)}%`;
}

/* ---- режим деталі ---- */

function findPart(partId) {
  if (!state.manifest || !state.manifest.parts) return null;
  return state.manifest.parts.find((part) => part.id === partId) || null;
}

async function showPart(partId) {
  const part = findPart(partId);
  if (!part) {
    toast(`Деталь ${partId} відсутня у проєкті`);
    return;
  }

  state.mode = 'part';
  state.activePartId = partId;
  syncModeUI();
  renderSpec(part);
  renderPartsList();
  updateURL();

  clearGroup(stage.root);
  clearGroup(stage.overlays);
  clearGroup(stage.hardware);
  stage.outlines = [];
  stage.partObjects = [];

  if (!part.glb && !part.node && !state.manifest.partsGlb) {
    setLoading(false);
    toast('Для цієї деталі немає 3D-моделі — показано специфікацію');
    return;
  }

  setLoading(true, 'Завантаження деталі…');
  try {
    const scene = await loadPartModel(part);
    const normalized = normalizePart(scene, part);
    stage.root.add(normalized.group);
    stage.partObjects.push({
      object: normalized.group,
      partId: part.id,
      base: normalized.group.position.clone(),
      offset: new THREE.Vector3()
    });

    addOutlines(normalized.group, 28);
    buildEdgeOverlays(part, normalized);
    buildGrooveOverlays(part, normalized);
    buildHoleOverlays(part, normalized);
    setHolesVisible(state.showHardware !== false);
    if (stage.xray) setXray(true);

    frameObject(normalized.group, 1.45);
    setLoading(false);
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast('Модель деталі недоступна офлайн');
  }
}

/* =====================================================================
   5. ОВЕРЛЕЇ ДЕТАЛІ: КРОМКА ТА ПРИСАДКА
   ===================================================================== */

/* Плагін експортує деталь у нормалізованому вигляді:
   довжина по +X, товщина по +Y, ширина по -Z (наслідок переходу Z-up → Y-up).
   Тут повертаємо деталь у зручну систему: усі три осі додатні, мінімум у нулі,
   а осі зіставляємо з габаритами з manifest.json — тож в’ювер працює
   і з файлами, експортованими іншим інструментом. */
// Деталь використовується РІВНО такою, як її експортував плагін.
// Жодних поворотів, підбору осей за розмірами й здогадок: контракт відомий.
//
//   X  = довжина,  0 … L
//   Y  = товщина,  0 … T,  лице деталі — при Y = T
//   Z  = ширина,  -W … 0   (наслідок переходу Z-up -> Y-up: +Y SketchUp = -Z glTF)
//
// Сторони: 'right' — при X = L, 'left' — при X = 0,
//          'top'   — при Z = -W, 'bottom' — при Z = 0,
//          'front' — при Y = T (лице), 'back' — при Y = 0.
function normalizePart(scene, part) {
  const group = new THREE.Group();
  group.add(scene);
  return { group, dims: part.dimensions || {} };
}

// Точка деталі за трьома розмірами в мм -> координати сцени в метрах.
function partVector(lengthMm, widthMm, thicknessMm) {
  return new THREE.Vector3(lengthMm * MM, thicknessMm * MM, -widthMm * MM);
}

function buildEdgeOverlays(part, normalized, target) {
  const edges = part.edges || {};
  const dims = normalized.dims;
  const L = Number(dims.length) || 0;
  const W = Number(dims.width) || 0;
  const T = Number(dims.thickness) || 0;
  const band = 2.2;                       // візуальна товщина смуги, мм

  const sides = {
    right:  { size: [band, W, T], center: [L + band / 2, W / 2, T / 2] },
    left:   { size: [band, W, T], center: [-band / 2, W / 2, T / 2] },
    top:    { size: [L, band, T], center: [L / 2, W + band / 2, T / 2] },
    bottom: { size: [L, band, T], center: [L / 2, -band / 2, T / 2] }
  };

  Object.entries(sides).forEach(([side, spec]) => {
    const thickness = Number(edges[side]) || 0;
    if (thickness <= 0) return;

    const size = partVector(spec.size[0], spec.size[1], spec.size[2]);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(Math.abs(size.x), 0.0004),
                            Math.max(Math.abs(size.y), 0.0004),
                            Math.max(Math.abs(size.z), 0.0004)),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(edgeColor(thickness)),
        roughness: 0.45, metalness: 0,
        emissive: new THREE.Color(edgeColor(thickness)), emissiveIntensity: 0.3
      })
    );
    mesh.position.copy(partVector(spec.center[0], spec.center[1], spec.center[2]));
    mesh.userData.edgeSide = side;
    (target || stage.overlays).add(mesh);
  });
}

// Паз: прямокутне заглиблення. Дані ті самі, що на кресленні.
function buildGrooveOverlays(part, normalized, target) {
  const grooves = part.grooves || [];
  if (!grooves.length) return;

  const dims = normalized.dims;
  const thickness = Number(dims.thickness) || 18;
  const fill = themeName() === 'dark' ? 0x3f4a57 : 0x93a3b3;

  grooves.forEach((groove) => {
    const w = Math.max(Number(groove.width) || 0, 0.5);
    const h = Math.max(Number(groove.height) || 0, 0.5);
    const cut = Number(groove.depth) || 0;

    let z0;
    let z1;

    if (cut > 0) {
      // Головне джерело — глибина паза (те саме число, що на кресленні)
      // і бік, який визначив плагін. Межі z0/z1 приходять із розмітки й
      // подекуди виходять за товщину деталі — тоді паз «висів» над пластю.
      const depth = Math.min(cut, thickness);
      if (groove.side === 'back') { z0 = 0; z1 = depth; }
      else                        { z1 = thickness; z0 = thickness - depth; }
    } else {
      z0 = Number(groove.z0) || 0;
      z1 = Number(groove.z1);
      if (!isFinite(z1) || z1 <= z0) z1 = thickness;
      // страхування: не даємо виїхати за межі деталі
      z0 = Math.min(Math.max(z0, 0), thickness);
      z1 = Math.min(Math.max(z1, 0), thickness);
      if (z1 - z0 < 0.3) { z0 = 0; z1 = thickness; }
    }

    const t = Math.max(z1 - z0, 0.5);

    const size = partVector(w, h, t);
    const center = partVector((Number(groove.x) || 0) + w / 2,
                              (Number(groove.y) || 0) + h / 2,
                              (z0 + z1) / 2);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(Math.abs(size.x), 0.0005),
                            Math.max(Math.abs(size.y), 0.0005),
                            Math.max(Math.abs(size.z), 0.0005)),
      new THREE.MeshStandardMaterial({
        color: fill, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.9
      })
    );
    mesh.position.copy(center);
    mesh.userData.groove = groove;
    (target || stage.overlays).add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 1),
      new THREE.LineBasicMaterial({
        color: THEMES[themeName()].outline, transparent: true, opacity: 0.7
      })
    );
    edges.position.copy(center);
    edges.renderOrder = 2;
    edges.raycast = function () {};
    (target || stage.overlays).add(edges);
  });
}

// Гирло отвору й вісь свердління. Координати з маніфесту:
//   front/back  — x уздовж довжини, y уздовж ширини
//   left/right  — x уздовж ширини,  y уздовж товщини
//   top/bottom  — x уздовж довжини, y уздовж товщини
function holePlacement(hole, dims) {
  const L = Number(dims.length) || 0;
  const W = Number(dims.width) || 0;
  const T = Number(dims.thickness) || 0;
  const x = Number(hole.x) || 0;
  const y = Number(hole.y) || 0;
  const depth = Math.min(Math.max(Number(hole.depth) || 12, 3), Math.max(L, W));

  switch (hole.face) {
    case 'back':
      return { mouth: [x, y, 0], axis: 'thickness', sign: 1, depth };
    case 'left':
      return { mouth: [0, x, y], axis: 'length', sign: 1, depth };
    case 'right':
      return { mouth: [L, x, y], axis: 'length', sign: -1, depth };
    case 'top':
      return { mouth: [x, W, y], axis: 'width', sign: -1, depth };
    case 'bottom':
      return { mouth: [x, 0, y], axis: 'width', sign: 1, depth };
    case 'front':
    default:
      return { mouth: [x, y, T], axis: 'thickness', sign: -1, depth };
  }
}

// Одиничний вектор осі свердління (углиб матеріалу) у координатах сцени.
function holeAxis(placement) {
  const s = placement.sign;
  switch (placement.axis) {
    case 'length':    return new THREE.Vector3(s, 0, 0);
    case 'width':     return new THREE.Vector3(0, 0, -s);
    case 'thickness':
    default:          return new THREE.Vector3(0, s, 0);
  }
}

function buildHoleOverlays(part, normalized, target) {
  const dims = normalized.dims;
  const holes = part.drilling || [];
  if (!holes.length) return;

  const dark = themeName() === 'dark' ? 0x39424d : 0x5b6672;
  const up = new THREE.Vector3(0, 1, 0);

  holes.forEach((hole, index) => {
    const placement = holePlacement(hole, dims);
    const radius = Math.max((Number(hole.diameter) || 5) / 2, 1.2) * MM;
    const depth = Math.max(placement.depth, 3) * MM;
    const color = new THREE.Color(HOLE_COLORS[hole.type] || HOLE_COLORS.other);
    const axis = holeAxis(placement);

    const group = new THREE.Group();

    // стінка свердління — видима зсередини
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, depth, 24, 1, true),
      new THREE.MeshStandardMaterial({
        color: dark, roughness: 0.95, metalness: 0, side: THREE.BackSide
      })
    );
    wall.position.y = depth / 2;
    group.add(wall);

    if (hole.type !== 'through') {
      const bottom = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 24),
        new THREE.MeshStandardMaterial({ color: dark, roughness: 1, side: THREE.DoubleSide })
      );
      bottom.position.y = depth;
      bottom.rotation.x = Math.PI / 2;
      group.add(bottom);
    }

    // обідок кольором за типом кріплення
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius * 1.16, 28),
      new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
      })
    );
    ring.position.y = 0.2 * MM;
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 3;
    group.add(ring);

    // чітке коло гирла
    const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2);
    const rim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        curve.getPoints(40).map((p) => new THREE.Vector3(p.x, 0, p.y))
      ),
      new THREE.LineBasicMaterial({
        color: THEMES[themeName()].outline, transparent: true, opacity: 0.8
      })
    );
    rim.position.y = 0.25 * MM;
    rim.raycast = function () {};
    rim.renderOrder = 4;
    group.add(rim);

    // вісь групи (+Y) -> вісь свердління
    group.quaternion.setFromUnitVectors(up, axis);
    group.position.copy(
      partVector(placement.mouth[0], placement.mouth[1], placement.mouth[2])
    );
    group.userData.hole = hole;
    group.userData.holeIndex = index;
    group.traverse((node) => {
      node.userData.hole = hole;
      node.userData.holeIndex = index;
    });
    (target || stage.overlays).add(group);
  });
}

function focusHole(index) {
  const rows = $('specHoles').querySelectorAll('tbody tr');
  rows.forEach((row) => row.classList.toggle('is-active', Number(row.dataset.index) === index));
  const row = rows[index];
  if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  openPanel(true);
  const part = findPart(state.activePartId);
  const hole = part && part.drilling ? part.drilling[index] : null;
  if (hole) toast(`${HOLE_LABELS[hole.type] || hole.type} ⌀${hole.diameter} · глибина ${hole.depth} мм`);
}

/* =====================================================================
   6. ІНТЕРФЕЙС
   ===================================================================== */

function syncModeUI() {
  const isPart = state.mode === 'part';
  $('btnBack').hidden = !isPart;
  $('explodeBox').hidden = isPart;
  if (stage.grid) stage.grid.visible = !isPart;

  document.querySelectorAll('#modeSwitch button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === state.mode);
    if (button.dataset.mode === 'part') button.disabled = !state.activePartId;
  });

  if (!isPart) {
    $('spec').hidden = true;
    $('specEmpty').hidden = false;
  }
  updateURL();
}

function updateURL() {
  if (!state.projectId) return;
  const params = new URLSearchParams();
  params.set('project', state.projectId);
  if (state.mode === 'part' && state.activePartId) params.set('part', state.activePartId);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

function renderSpec(part) {
  $('specEmpty').hidden = true;
  $('spec').hidden = false;

  $('specId').textContent = part.id.toUpperCase();
  $('specName').textContent = part.name || 'Деталь';
  $('specQty').textContent = `×${part.quantity || 1}`;

  const dims = part.dimensions || {};
  $('dimL').textContent = fmt(dims.length, 1);
  $('dimW').textContent = fmt(dims.width, 1);
  $('dimT').textContent = fmt(dims.thickness, 1);

  $('specMaterial').textContent = part.material || '—';
  $('specGrain').textContent =
    part.grain === 'length' ? 'вздовж довжини'
      : part.grain === 'width' ? 'вздовж ширини'
        : 'не важливо';
  const area = part.area != null
    ? part.area
    : ((Number(dims.length) || 0) * (Number(dims.width) || 0)) / 1e6;
  $('specArea').textContent = `${area.toFixed(3)} м²`;

  const edgesList = $('specEdges');
  edgesList.innerHTML = '';
  ['top', 'bottom', 'left', 'right'].forEach((side) => {
    const value = Number((part.edges || {})[side]) || 0;
    const item = el('li');
    const bar = el('i');
    bar.style.background = edgeColor(value);
    item.appendChild(bar);
    item.appendChild(el('b', null, (part.edgeLabels && part.edgeLabels[side]) || side.toUpperCase()));
    item.appendChild(el('span', null, EDGE_LABELS[side].split(' · ')[1] || side));
    item.appendChild(el('u', null, value > 0 ? `${fmt(value, 1)} мм` : '—'));
    edgesList.appendChild(item);
  });

  const holes = part.drilling || [];
  $('holesCount').textContent = holes.length ? `· ${holes.length}` : '· немає';
  const tbody = $('specHoles').querySelector('tbody');
  tbody.innerHTML = '';
  holes.forEach((hole, index) => {
    const row = el('tr');
    row.dataset.index = index;
    [index + 1, fmt(hole.x, 1), fmt(hole.y, 1), `⌀${fmt(hole.diameter, 1)}`,
      fmt(hole.depth, 1), hole.face, HOLE_LABELS[hole.type] || hole.type]
      .forEach((value) => row.appendChild(el('td', null, String(value))));
    row.addEventListener('click', () => focusHole(index));
    tbody.appendChild(row);
  });
  $('specHoles').hidden = holes.length === 0;

  drawPlan(part);
}

/* Підпис деталі: план з кольоровою кромкою та точками присадки. */
function drawPlan(part) {
  const svg = $('planSvg');
  const dims = part.dimensions || {};
  const L = Number(dims.length) || 100;
  const W = Number(dims.width) || 100;

  const padding = 26;
  const boxW = 320 - padding * 2;
  const boxH = 220 - padding * 2;
  const scale = Math.min(boxW / L, boxH / W);
  const w = L * scale;
  const h = W * scale;
  const x0 = (320 - w) / 2;
  const y0 = (220 - h) / 2;

  const toX = (mm) => x0 + mm * scale;
  const toY = (mm) => y0 + h - mm * scale;   // Y вгору, як у кресленні

  const dark = themeName() === 'dark';
  const cBoard  = dark ? '#232b34' : '#ffffff';
  const cStroke = dark ? '#3a4552' : '#94a3b3';
  const cGrain  = dark ? '#2f3945' : '#dbe3ea';
  const cText   = dark ? '#7e8b99' : '#5d6b7a';

  const parts = [];
  parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="2"
    fill="${cBoard}" stroke="${cStroke}" stroke-width="1"/>`);

  if (part.grain === 'length' || part.grain === 'width') {
    const step = 9;
    const lines = [];
    if (part.grain === 'length') {
      for (let y = y0 + step; y < y0 + h; y += step) {
        lines.push(`<line x1="${x0 + 3}" y1="${y}" x2="${x0 + w - 3}" y2="${y}"/>`);
      }
    } else {
      for (let x = x0 + step; x < x0 + w; x += step) {
        lines.push(`<line x1="${x}" y1="${y0 + 3}" x2="${x}" y2="${y0 + h - 3}"/>`);
      }
    }
    parts.push(`<g stroke="${cGrain}" stroke-width="1">${lines.join('')}</g>`);
  }

  const edges = part.edges || {};
  const bar = 5;
  const sides = {
    top: [x0, y0 - bar - 1, w, bar],
    bottom: [x0, y0 + h + 1, w, bar],
    left: [x0 - bar - 1, y0, bar, h],
    right: [x0 + w + 1, y0, bar, h]
  };
  Object.entries(sides).forEach(([side, [x, y, width, height]]) => {
    const value = Number(edges[side]) || 0;
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="1.5"
      fill="${edgeColor(value)}" opacity="${value > 0 ? 1 : 0.35}"/>`);
    if (value > 0) {
      const isHorizontal = side === 'top' || side === 'bottom';
      const cx = isHorizontal ? x + width / 2 : x + width / 2;
      const cy = isHorizontal ? y + height / 2 : y + height / 2;
      parts.push(`<text x="${cx}" y="${cy}" fill="#0f1216" font-size="4.5"
        font-family="ui-monospace, monospace" font-weight="700"
        text-anchor="middle" dominant-baseline="central"
        transform="${isHorizontal ? '' : `rotate(-90 ${cx} ${cy})`}">${fmt(value, 1)}</text>`);
    }
  });

  (part.drilling || []).forEach((hole, index) => {
    const face = hole.face || 'front';
    const color = HOLE_COLORS[hole.type] || HOLE_COLORS.other;
    if (face === 'front' || face === 'back') {
      const r = Math.max((Number(hole.diameter) || 5) / 2 * scale, 2.2);
      parts.push(`<circle class="hole" data-index="${index}" cx="${toX(hole.x)}" cy="${toY(hole.y)}" r="${r}"
        fill="${face === 'front' ? color : 'none'}" stroke="${color}" stroke-width="1.4"
        opacity="0.95"><title>⌀${hole.diameter} · ${hole.depth} мм · ${face}</title></circle>`);
    } else {
      let x = 0;
      let y = 0;
      if (face === 'left') { x = x0 - 8; y = toY(hole.x); }
      else if (face === 'right') { x = x0 + w + 8; y = toY(hole.x); }
      else if (face === 'top') { x = toX(hole.x); y = y0 - 8; }
      else { x = toX(hole.x); y = y0 + h + 8; }
      parts.push(`<circle class="hole" data-index="${index}" cx="${x}" cy="${y}" r="2.6"
        fill="${color}"><title>торець ${face} · ⌀${hole.diameter}</title></circle>`);
    }
  });

  parts.push(`<text x="${x0 + w / 2}" y="${y0 + h + 16}" fill="${cText}" font-size="8"
    font-family="ui-monospace, monospace" text-anchor="middle">${fmt(L, 1)}</text>`);
  parts.push(`<text x="${x0 - 12}" y="${y0 + h / 2}" fill="${cText}" font-size="8"
    font-family="ui-monospace, monospace" text-anchor="middle"
    transform="rotate(-90 ${x0 - 12} ${y0 + h / 2})">${fmt(W, 1)}</text>`);

  svg.innerHTML = parts.join('');
  svg.querySelectorAll('.hole').forEach((circle) => {
    circle.style.cursor = 'pointer';
    circle.addEventListener('click', () => focusHole(Number(circle.dataset.index)));
  });
}

function renderPartsList() {
  const list = $('partsList');
  list.innerHTML = '';
  const parts = (state.manifest && state.manifest.parts) || [];

  parts.forEach((part) => {
    const item = el('li');
    const button = el('button');
    button.className = part.id === state.activePartId ? 'is-active' : '';

    const name = el('div', 'name', part.name || part.id);
    const dims = part.dimensions || {};
    const meta = el('div', 'meta',
      `${fmt(dims.length, 1)} × ${fmt(dims.width, 1)} × ${fmt(dims.thickness, 1)} · ${part.material || '—'}`);
    const badge = el('div', 'badge', `×${part.quantity || 1}`);

    const bars = el('div', 'bars');
    ['top', 'right', 'bottom', 'left'].forEach((side) => {
      const bar = el('i');
      bar.style.background = edgeColor((part.edges || {})[side]);
      bars.appendChild(bar);
    });

    button.append(name, badge, meta, bars);
    button.addEventListener('click', () => selectPart(part.id, { focus: true }));
    item.appendChild(button);
    list.appendChild(item);
  });
}

async function selectPart(partId, { focus }) {
  const part = findPart(partId);
  if (!part) return;

  if (focus || state.mode === 'part') {
    await showPart(partId);
    openPanel(true);
    return;
  }

  state.activePartId = partId;
  highlight(partId);
  renderSpec(part);
  renderPartsList();
  syncModeUI();
  switchTab('spec');
  openPanel(true);
}

function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === name);
  });
  document.querySelectorAll('.tab-body').forEach((section) => {
    section.hidden = section.dataset.tab !== name;
  });
}

function openPanel(open) {
  $('panel').dataset.open = open ? 'true' : 'false';
}

/* ---- список проєктів ---- */

async function openPicker() {
  const list = $('projectsList');
  list.innerHTML = '';
  $('picker').hidden = false;

  try {
    const projects = await fetchJSON('projects/index.json');
    if (!projects.length) throw new Error('empty');
    projects.forEach((project) => {
      const item = el('li');
      const button = el('button');
      button.append(
        el('div', 'pname', project.name || project.id),
        el('div', 'pmeta', `${project.id} · деталей: ${project.parts || '—'}`)
      );
      button.addEventListener('click', () => {
        $('picker').hidden = true;
        openProject(project.id);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  } catch (error) {
    const saved = getSaved();
    if (saved.length) {
      saved.forEach((project) => {
        const item = el('li');
        const button = el('button');
        button.append(
          el('div', 'pname', project.name || project.id),
          el('div', 'pmeta', `${project.id} · збережено офлайн`)
        );
        button.addEventListener('click', () => {
          $('picker').hidden = true;
          openProject(project.id);
        });
        item.appendChild(button);
        list.appendChild(item);
      });
    } else {
      const message = error.code === 'SERVER_DOWN'
        ? SERVER_HINT
        : 'Список проєктів порожній. Зробіть експорт зі SketchUp або відскануйте QR-код деталі.';
      const item = el('li');
      item.style.cssText = 'color:var(--muted);font-size:13px;line-height:1.5;padding:16px 4px';
      item.textContent = message;
      list.appendChild(item);
    }
  }
}

/* =====================================================================
   7. СКАНЕР QR
   ===================================================================== */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`не завантажено: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureScannerLib() {
  if (window.Html5Qrcode) return true;
  try {
    await loadScript('vendor/html5-qrcode/html5-qrcode.min.js');
  } catch (error) {
    try {
      await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
    } catch (cdnError) {
      return false;
    }
  }
  return Boolean(window.Html5Qrcode);
}

async function openScanner() {
  $('scanner').hidden = false;
  const ok = await ensureScannerLib();
  if (!ok) {
    $('scanHint').textContent = 'Бібліотека сканера недоступна. Вставте посилання вручну.';
    return;
  }

  try {
    state.scanner = new window.Html5Qrcode('qrReader', { verbose: false });
    await state.scanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: { width: 240, height: 240 } },
      (decoded) => { closeScanner(); handleCode(decoded); },
      () => {}
    );
    $('scanHint').textContent = 'Наведіть камеру на наклейку деталі.';
  } catch (error) {
    console.error(error);
    $('scanHint').textContent =
      'Камера недоступна. Потрібен HTTPS або localhost — див. README. Можна вставити посилання вручну.';
  }
}

async function closeScanner() {
  $('scanner').hidden = true;
  if (state.scanner) {
    try {
      await state.scanner.stop();
      state.scanner.clear();
    } catch (error) { /* сканер уже зупинено */ }
    state.scanner = null;
  }
}

function parseCode(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value, location.href);
    const project = url.searchParams.get('project');
    const part = url.searchParams.get('part');
    if (project || part) return { project, part };
  } catch (error) { /* не URL — розбираємо як текст */ }

  const pair = value.match(/([\w.\-]+)\s*[|;,]\s*(part[_\-]?\w+)/i);
  if (pair) return { project: pair[1], part: pair[2] };

  if (/^part[_-]?\w+$/i.test(value)) return { project: state.projectId, part: value.toLowerCase() };
  return { project: value, part: null };
}

async function handleCode(text) {
  const parsed = parseCode(text);
  if (!parsed) { toast('Код не розпізнано'); return; }

  if (parsed.project && parsed.project !== state.projectId) {
    await openProject(parsed.project, parsed.part || undefined);
  } else if (parsed.part) {
    await showPart(parsed.part);
    openPanel(true);
  } else {
    await showAssembly();
  }
}

/* =====================================================================
   8. PWA ТА ОФЛАЙН-КЕШ
   ===================================================================== */

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  } catch (error) {
    return [];
  }
}

function setSaved(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

function renderSavedList() {
  const list = $('savedList');
  list.innerHTML = '';
  const saved = getSaved();
  if (!saved.length) {
    list.appendChild(el('li', null, 'Поки нічого не збережено'));
    return;
  }
  saved.forEach((project) => {
    const item = el('li');
    item.appendChild(el('b', null, project.name || project.id));
    item.appendChild(el('span', null, `${project.files} файл(ів) · ${project.date}`));
    list.appendChild(item);
  });
}

function projectUrls() {
  if (!state.manifest) return [];
  const urls = [manifestUrl(state.projectId)];
  if (state.manifest.partsGlb) urls.push(projectAsset(state.manifest.partsGlb));
  if (state.manifest.assemblyGlb) urls.push(projectAsset(state.manifest.assemblyGlb));
  (state.manifest.parts || []).forEach((part) => {
    if (part.glb) urls.push(projectAsset(part.glb));
  });
  return urls;
}

async function cacheProject() {
  if (!state.manifest) { toast('Спершу відкрийте проєкт'); return; }
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    toast('Service Worker ще не активний — оновіть сторінку');
    return;
  }

  const urls = projectUrls();
  const button = $('btnCacheProject');
  const progress = $('cacheProgress');
  button.disabled = true;
  progress.hidden = false;
  progress.firstElementChild.style.width = '4%';

  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === 'CACHE_PROGRESS') {
      progress.firstElementChild.style.width = `${Math.round((data.done / data.total) * 100)}%`;
    }
    if (data.type === 'CACHE_DONE') {
      button.disabled = false;
      progress.hidden = true;
      const saved = getSaved().filter((item) => item.id !== state.projectId);
      saved.unshift({
        id: state.projectId,
        name: state.manifest.projectName,
        files: data.cached,
        date: new Date().toLocaleDateString('uk-UA')
      });
      setSaved(saved);
      renderSavedList();
      toast(data.failed
        ? `Збережено ${data.cached} з ${data.total} файлів`
        : `Проєкт збережено офлайн (${data.cached} файл.)`);
    }
  };

  navigator.serviceWorker.controller.postMessage(
    { type: 'CACHE_URLS', urls, shell: true },
    [channel.port2]
  );
}

async function clearCache() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith('sketchcab-viewer-data')).map((key) => caches.delete(key)));
  setSaved([]);
  renderSavedList();
  toast('Збережені моделі видалено');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    $('swState').textContent = 'Service Worker: не підтримується браузером';
    return;
  }
  // Офлайн-режим доступний лише на localhost або https — на мережевій
  // адресі виду 192.168.x.x браузер вважає з'єднання незахищеним.
  if (!window.isSecureContext) {
    $('swState').textContent =
      'Офлайн недоступний: відкрито за мережевою адресою. На цьому ПК ' +
      'користуйся http://localhost:' + (location.port || 8080);
    $('btnCacheProject').disabled = true;
    $('offlineNote').textContent =
      'Щоб зберігати проєкти офлайн, відкрий в’ювер через localhost (на ПК) ' +
      'або налаштуй HTTPS (для телефона).';
    return;
  }
  navigator.serviceWorker.register('sw.js').then((registration) => {
    $('swState').textContent = `Service Worker: активний (${registration.scope})`;
  }).catch((error) => {
    $('swState').textContent = `Service Worker: помилка — ${error.message}`;
  });
}

function updateNetChip() {
  const chip = $('netChip');
  const online = navigator.onLine;
  chip.dataset.state = online ? 'online' : 'offline';
  chip.textContent = online ? 'онлайн' : 'офлайн';
}

/* =====================================================================
   9. ІНІЦІАЛІЗАЦІЯ
   ===================================================================== */

function bindUI() {
  $('btnBack').addEventListener('click', () => showAssembly());
  $('btnFit').addEventListener('click', () => frameObject(stage.root));
  $('btnXray').addEventListener('click', () => setXray(!stage.xray));
  $('btnHardware').addEventListener('click', () => {
    setHolesVisible(state.showHardware === false);
    toast(state.showHardware ? 'Отвори показано' : 'Отвори сховано');
  });
  $('btnScan').addEventListener('click', openScanner);
  $('btnScanClose').addEventListener('click', closeScanner);
  $('btnMenu').addEventListener('click', openPicker);
  $('btnPickerClose').addEventListener('click', () => { $('picker').hidden = true; });
  $('btnManual').addEventListener('click', () => {
    const value = $('manualCode').value;
    closeScanner();
    handleCode(value);
  });
  $('manualCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('btnManual').click();
  });

  $('explode').addEventListener('input', (event) => applyExplode(Number(event.target.value)));

  document.querySelectorAll('#modeSwitch button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.mode === 'assembly') showAssembly();
      else if (state.activePartId) showPart(state.activePartId);
    });
  });

  document.querySelectorAll('#tabs button').forEach((button) => {
    button.addEventListener('click', () => { switchTab(button.dataset.tab); openPanel(true); });
  });

  $('grabber').addEventListener('click', () => {
    openPanel($('panel').dataset.open !== 'true');
  });

  $('btnTheme').addEventListener('click', function () {
    applyTheme(themeName() === 'dark' ? 'light' : 'dark');
  });

  $('btnCacheProject').addEventListener('click', cacheProject);
  $('btnClearCache').addEventListener('click', clearCache);

  window.addEventListener('online', updateNetChip);
  window.addEventListener('offline', updateNetChip);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeScanner(); $('picker').hidden = true; }
  });
}

async function boot() {
  // тема — до створення сцени, щоб фон одразу був правильний
  const savedTheme = localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme =
    savedTheme || (window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  initStage();
  updateSceneTheme();
  bindUI();
  updateNetChip();
  registerServiceWorker();
  renderSavedList();

  const params = new URLSearchParams(location.search);
  const project = params.get('project') || localStorage.getItem(LAST_KEY);
  const part = params.get('part');

  if (project) {
    await openProject(project, part || undefined);
  } else {
    setLoading(false);
    openPicker();
  }
}

boot();

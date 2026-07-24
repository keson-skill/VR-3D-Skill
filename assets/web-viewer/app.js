import * as THREE from "three";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "./vendor/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "./vendor/jsm/controls/PointerLockControls.js";
import { VRButton } from "./vendor/jsm/webxr/VRButton.js";

const canvas = document.querySelector("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8dee0);
scene.fog = new THREE.Fog(0xd8dee0, 28, 75);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.screenSpacePanning = true;
orbit.maxPolarAngle = Math.PI / 2 - 0.02;
const walk = new PointerLockControls(camera, document.body);

scene.add(new THREE.HemisphereLight(0xffffff, 0x62706c, 2.4));
const sun = new THREE.DirectionalLight(0xfff4df, 2.5);
sun.position.set(8, 12, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const grid = new THREE.GridHelper(40, 40, 0x70817d, 0xaeb8b5);
grid.material.opacity = 0.22;
grid.material.transparent = true;
scene.add(grid);

const state = {
  mode: "orbit",
  model: null,
  manifest: null,
  keys: new Set(),
};

const projectName = document.querySelector("#project-name");
const projectMeta = document.querySelector("#project-meta");
const warning = document.querySelector("#scope-warning");
const status = document.querySelector("#status");
const modeButtons = [
  document.querySelector("#orbit-button"),
  document.querySelector("#walk-button"),
  document.querySelector("#top-button"),
];

function setStatus(message) {
  status.textContent = message;
}

function boundsCenter(bounds) {
  return new THREE.Vector3(
    (bounds.min[0] + bounds.max[0]) / 2,
    0,
    (bounds.min[1] + bounds.max[1]) / 2,
  );
}

function resetCamera() {
  const bounds = state.manifest.bounds;
  const center = boundsCenter(bounds);
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[1] - bounds.min[1];
  const distance = Math.max(width, depth, 4);
  camera.up.set(0, 1, 0);
  camera.position.set(
    center.x + distance * 0.85,
    distance * 0.72 + 2,
    center.z + distance * 0.9,
  );
  orbit.target.set(center.x, 1.1, center.z);
  orbit.update();
}

function activateMode(mode) {
  state.mode = mode;
  modeButtons.forEach((button) => button.classList.remove("active"));
  orbit.enabled = mode !== "walk";
  if (mode === "walk") {
    document.querySelector("#walk-button").classList.add("active");
    const spawn = state.manifest.xr?.spawn || [
      state.manifest.bounds.min[0] + 1,
      0,
      state.manifest.bounds.min[1] + 1,
    ];
    camera.up.set(0, 1, 0);
    camera.position.set(spawn[0], spawn[1] + 1.65, spawn[2]);
    walk.lock();
    setStatus("第一视角预览；按 Esc 退出，使用 WASD 移动");
  } else if (mode === "top") {
    document.querySelector("#top-button").classList.add("active");
    const center = boundsCenter(state.manifest.bounds);
    const width = state.manifest.bounds.max[0] - state.manifest.bounds.min[0];
    const depth = state.manifest.bounds.max[1] - state.manifest.bounds.min[1];
    camera.up.set(0, 0, -1);
    camera.position.set(center.x, Math.max(width, depth, 4) * 1.45, center.z);
    orbit.target.copy(center);
    orbit.update();
    setStatus("俯视户型模式");
  } else {
    document.querySelector("#orbit-button").classList.add("active");
    camera.up.set(0, 1, 0);
    resetCamera();
    setStatus("旋转查看模式");
  }
}

function setCategoryVisible(category, visible) {
  state.model?.traverse((object) => {
    if (object.userData?.category === category) object.visible = visible;
  });
}

document.querySelector("#orbit-button").addEventListener("click", () => activateMode("orbit"));
document.querySelector("#walk-button").addEventListener("click", () => activateMode("walk"));
document.querySelector("#top-button").addEventListener("click", () => activateMode("top"));
document.querySelector("#reset-button").addEventListener("click", () => activateMode("orbit"));
document.querySelector("#furniture-toggle").addEventListener("change", (event) => {
  setCategoryVisible("furniture", event.target.checked);
});
document.querySelector("#opening-toggle").addEventListener("change", (event) => {
  setCategoryVisible("opening", event.target.checked);
});
window.addEventListener("keydown", (event) => state.keys.add(event.code));
window.addEventListener("keyup", (event) => state.keys.delete(event.code));

function updateWalk(deltaSeconds) {
  if (state.mode !== "walk" || !walk.isLocked) return;
  const speed = 2.2 * deltaSeconds;
  if (state.keys.has("KeyW")) walk.moveForward(speed);
  if (state.keys.has("KeyS")) walk.moveForward(-speed);
  if (state.keys.has("KeyA")) walk.moveRight(-speed);
  if (state.keys.has("KeyD")) walk.moveRight(speed);
  camera.position.y = Math.max(1.65, camera.position.y);
}

async function load() {
  const manifestResponse = await fetch("./scene-manifest.json");
  if (!manifestResponse.ok) throw new Error("无法读取 scene-manifest.json");
  state.manifest = await manifestResponse.json();
  projectName.textContent = state.manifest.project.name || state.manifest.project.id;
  projectMeta.textContent = `${state.manifest.mode_label} · ${state.manifest.project.revision}`;
  if (state.manifest.approval_scope === "visualization_only") {
    warning.hidden = false;
    warning.textContent = "概念可视化：尺寸或隐藏结构尚未达到施工级确认。";
  }
  const gltf = await new GLTFLoader().loadAsync(state.manifest.scene);
  state.model = gltf.scene;
  state.model.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  scene.add(state.model);
  resetCamera();
  setStatus("场景已加载");
  document.body.appendChild(VRButton.createButton(renderer));
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  resize();
  const delta = Math.min(clock.getDelta(), 0.05);
  updateWalk(delta);
  if (orbit.enabled) orbit.update();
  renderer.render(scene, camera);
});

load().catch((error) => {
  setStatus(`加载失败：${error.message}`);
  console.error(error);
});

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
  runtime: null,
  keys: new Set(),
  selected: null,
  history: [],
  measuring: false,
  measureStart: null,
  annotations: [],
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

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, zi] = polygon[index];
    const [xj, zj] = polygon[previous];
    if ((zi > point[1]) !== (zj > point[1]) && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function canStandAt(position, excludedId = null) {
  if (!state.runtime) return true;
  const point = [position.x, position.z];
  const inRoom = state.runtime.rooms.some((room) => pointInPolygon(point, room.polygon));
  const inObstacle = state.runtime.obstacles.some((obstacle) => obstacle.id !== excludedId && pointInPolygon(point, obstacle.footprint));
  return inRoom && !inObstacle;
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
document.querySelector("#room-select").addEventListener("change", (event) => {
  const room = state.runtime?.rooms.find((item) => item.id === event.target.value);
  if (!room) return;
  camera.position.set(room.navigation_point[0], room.floor_elevation + 1.65, room.navigation_point[1]);
  orbit.target.set(room.navigation_point[0], room.floor_elevation + 1, room.navigation_point[1]);
  orbit.update();
  setStatus(`已跳转到 ${room.name}`);
});
document.querySelector("#measure-button").addEventListener("click", (event) => {
  state.measuring = !state.measuring;
  state.measureStart = null;
  event.currentTarget.setAttribute("aria-pressed", String(state.measuring));
  setStatus(state.measuring ? "测量模式：依次点击两个表面点" : "已退出测量模式");
});
document.querySelector("#annotate-button").addEventListener("click", () => {
  if (!state.selected) return setStatus("请先选择家具");
  state.annotations.push({ source_id: state.selected.userData.source_id, created_at: new Date().toISOString() });
  setStatus(`已为 ${state.selected.userData.source_id} 添加注释标记`);
});
function editSelected(kind) {
  if (!state.selected) return setStatus("请先选择可编辑家具");
  state.history.push({ object: state.selected, position: state.selected.position.clone(), rotation: state.selected.rotation.clone() });
  if (kind === "left") state.selected.position.x -= 0.1;
  if (kind === "right") state.selected.position.x += 0.1;
  if (kind === "rotate") state.selected.rotation.y += Math.PI / 12;
  if (!canStandAt(state.selected.position, state.selected.userData.source_id)) {
    const previous = state.history.pop();
    state.selected.position.copy(previous.position);
    state.selected.rotation.copy(previous.rotation);
    return setStatus("无效位置：超出房间或与障碍物冲突");
  }
  setStatus(`已${kind === "rotate" ? "旋转" : "移动"} ${state.selected.userData.source_id}`);
}
document.querySelector("#move-left-button").addEventListener("click", () => editSelected("left"));
document.querySelector("#move-right-button").addEventListener("click", () => editSelected("right"));
document.querySelector("#rotate-button").addEventListener("click", () => editSelected("rotate"));
document.querySelector("#undo-button").addEventListener("click", () => {
  const previous = state.history.pop();
  if (!previous) return setStatus("没有可撤销操作");
  previous.object.position.copy(previous.position);
  previous.object.rotation.copy(previous.rotation);
  setStatus("已撤销上一步");
});
window.addEventListener("keydown", (event) => state.keys.add(event.code));
window.addEventListener("keyup", (event) => state.keys.delete(event.code));

function updateWalk(deltaSeconds) {
  if (state.mode !== "walk" || !walk.isLocked) return;
  const speed = 2.2 * deltaSeconds;
  const previous = camera.position.clone();
  if (state.keys.has("KeyW")) walk.moveForward(speed);
  if (state.keys.has("KeyS")) walk.moveForward(-speed);
  if (state.keys.has("KeyA")) walk.moveRight(-speed);
  if (state.keys.has("KeyD")) walk.moveRight(speed);
  if (!canStandAt(camera.position)) camera.position.copy(previous);
  camera.position.y = Math.max(1.65, camera.position.y);
}

async function load() {
  const manifestResponse = await fetch("./scene-manifest.json");
  if (!manifestResponse.ok) throw new Error("无法读取 scene-manifest.json");
  state.manifest = await manifestResponse.json();
  const runtimeResponse = await fetch(state.manifest.runtime_contract);
  if (!runtimeResponse.ok) throw new Error("无法读取 runtime-contract.json");
  state.runtime = await runtimeResponse.json();
  if (!state.runtime.valid) throw new Error(`运行时合同无效：${state.runtime.errors[0]?.message}`);
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
  const roomSelect = document.querySelector("#room-select");
  state.runtime.rooms.forEach((room) => roomSelect.add(new Option(room.name, room.id)));
  resetCamera();
  setStatus("场景已加载");
  document.body.appendChild(VRButton.createButton(renderer));
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
canvas.addEventListener("click", (event) => {
  pointer.x = (event.offsetX / canvas.clientWidth) * 2 - 1;
  pointer.y = -(event.offsetY / canvas.clientHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(state.model, true)[0];
  if (!hit) return;
  if (state.measuring) {
    if (!state.measureStart) {
      state.measureStart = hit.point.clone();
      return setStatus("已记录测量起点，请点击终点");
    }
    const distance = state.measureStart.distanceTo(hit.point);
    state.measureStart = null;
    return setStatus(`测量结果：${distance.toFixed(3)} 米`);
  }
  let target = hit.object;
  while (target && !target.userData?.source_id) target = target.parent;
  if (target?.userData?.category === "furniture" && target.userData.fixed !== true) {
    state.selected = target;
    setStatus(`已选择 ${target.userData.source_id}`);
  }
});

renderer.xr.addEventListener("sessionstart", () => setStatus("XR 会话已进入"));
renderer.xr.addEventListener("sessionend", () => setStatus("XR 会话已退出，可重新进入"));
for (const index of [0, 1]) {
  const controller = renderer.xr.getController(index);
  controller.addEventListener("connected", () => setStatus(`XR 控制器 ${index + 1} 已连接`));
  controller.addEventListener("disconnected", () => setStatus(`XR 控制器 ${index + 1} 断开，正在 reconnecting`));
  scene.add(controller);
}
document.addEventListener("visibilitychange", () => setStatus(document.hidden ? "场景已暂停" : "场景已恢复"));
window.addEventListener("blur", () => setStatus("窗口失焦，输入已暂停"));
window.addEventListener("focus", () => setStatus("窗口已恢复"));

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

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../lib/cli.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = join(ROOT, "assets", "web-viewer");
const THREE = join(ROOT, "node_modules", "three");

const TEMPLATE_FILES = ["index.html", "styles.css", "app.js"];
const VENDOR_FILES = [
  ["build/three.module.js", "three.module.js"],
  ["examples/jsm/loaders/GLTFLoader.js", "jsm/loaders/GLTFLoader.js"],
  ["examples/jsm/controls/OrbitControls.js", "jsm/controls/OrbitControls.js"],
  ["examples/jsm/controls/PointerLockControls.js", "jsm/controls/PointerLockControls.js"],
  ["examples/jsm/webxr/VRButton.js", "jsm/webxr/VRButton.js"],
  ["examples/jsm/utils/BufferGeometryUtils.js", "jsm/utils/BufferGeometryUtils.js"],
];

export async function buildWebViewer(outputDirectory, manifest) {
  const vendorDirectory = join(outputDirectory, "vendor");
  await mkdir(vendorDirectory, { recursive: true });
  for (const file of TEMPLATE_FILES) {
    await copyFile(join(TEMPLATE, file), join(outputDirectory, file));
  }
  for (const [source, destination] of VENDOR_FILES) {
    try {
      await mkdir(dirname(join(vendorDirectory, destination)), {
        recursive: true,
      });
      await copyFile(join(THREE, source), join(vendorDirectory, destination));
    } catch (error) {
      throw new Error(
        `Cannot prepare Web viewer dependency ${source}: ${error.message}. Run npm install first.`,
      );
    }
  }
  await writeJson(join(outputDirectory, "scene-manifest.json"), manifest);
  return {
    directory: outputDirectory,
    entrypoint: join(outputDirectory, "index.html"),
  };
}

export async function ensureOutputParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

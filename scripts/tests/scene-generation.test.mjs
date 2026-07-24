import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGlb } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { createViewerServer } from "../serve-viewer.mjs";
import { buildViewableScene } from "../tasks/scene-generation/build-viewable-scene.mjs";
import { createTestApprovalContext } from "./helpers/p2-approval.mjs";
import { validateGlbBytes } from "../validation/validate-glb.mjs";

async function loadExample() {
  return JSON.parse(
    await readFile(
      new URL("../../examples/one-room/spatial.json", import.meta.url),
      "utf8",
    ),
  );
}

test("builds a deterministic GLB and self-contained Web viewer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-scene-"));
  try {
    const document = await loadExample();
    const result = await buildViewableScene(document, {
      outputDirectory: directory,
      mode: "furnished",
      ...createTestApprovalContext(document),
    });
    const glb = await readFile(result.sceneFile);
    assert.equal(glb.toString("ascii", 0, 4), "glTF");
    assert.equal(glb.readUInt32LE(4), 2);
    assert.equal(glb.readUInt32LE(8), glb.length);
    assert.ok(glb.length > 1000);

    const manifest = JSON.parse(
      await readFile(join(directory, "scene-manifest.json"), "utf8"),
    );
    assert.equal(manifest.approval_scope, "visualization_only");
    assert.equal(manifest.counts.rooms, 1);
    assert.equal(manifest.counts.design_objects, 3);
    assert.equal(manifest.scene_sha256.length, 64);
    assert.ok(manifest.glb_validation.triangles > 0);

    for (const path of [
      "index.html",
      "app.js",
      "styles.css",
      "vendor/three.module.js",
      "vendor/jsm/loaders/GLTFLoader.js",
      "vendor/jsm/controls/OrbitControls.js",
      "vendor/jsm/controls/PointerLockControls.js",
      "vendor/jsm/webxr/VRButton.js",
      "vendor/jsm/utils/BufferGeometryUtils.js",
      "approval-verification-report.json",
      "glb-validation-report.json",
      "scene-primitives.json",
      "validation-report.json",
      "source-manifest.json",
      "spatial-validation.json",
      "spatial-approval.json",
      "spatial.json",
    ]) {
      assert.equal((await stat(join(directory, path))).isFile(), true, path);
    }

    const server = createViewerServer(directory);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      for (const [path, contentType] of [
        ["/", "text/html"],
        ["/scene.glb", "model/gltf-binary"],
        ["/vendor/jsm/loaders/GLTFLoader.js", "text/javascript"],
        ["/vendor/jsm/utils/BufferGeometryUtils.js", "text/javascript"],
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get("content-type"), new RegExp(contentType));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiles ceilings, elevation changes, columns, beams, and stairs into a valid GLB", async () => {
  const document = await loadExample();
  document.rooms[0].floor_elevation = 0.15;
  document.rooms[0].ceiling_elevation = 3.25;
  document.envelope.architectural_elements = [
    {
      id: "column-main",
      kind: "column",
      dimensions: [0.35, 3.1, 0.35],
      transform: { position: [0.8, 1.7, 0.8] },
    },
    {
      id: "beam-main",
      kind: "beam",
      dimensions: [2.4, 0.35, 0.35],
      transform: { position: [2.5, 3.0, 0.8] },
    },
    {
      id: "stair-main",
      kind: "stair",
      dimensions: [1.1, 1.2, 1.6],
      step_count: 4,
      transform: { position: [4.0, 0.15, 2.5] },
    },
  ];
  const primitives = compileScenePrimitives(document);
  assert.equal(primitives.filter((item) => item.kind === "ceiling").length, 1);
  assert.equal(primitives.filter((item) => item.kind === "column").length, 1);
  assert.equal(primitives.filter((item) => item.kind === "beam").length, 1);
  assert.equal(primitives.filter((item) => item.kind === "stair_tread").length, 4);
  const report = validateGlbBytes(buildGlb(document, primitives), {
    expectedProject: document.project,
  });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.ok(report.summary.triangles > 0);
});

test("shell mode omits furniture proxies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-shell-"));
  try {
    const document = await loadExample();
    const result = await buildViewableScene(document, {
      outputDirectory: directory,
      mode: "shell",
      ...createTestApprovalContext(document),
    });
    assert.equal(result.manifest.counts.design_objects, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hard-furnishing mode keeps only fixed design objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-hard-"));
  try {
    const document = await loadExample();
    document.design_objects[2].fixed = true;
    const result = await buildViewableScene(document, {
      outputDirectory: directory,
      mode: "hard-furnishing",
      ...createTestApprovalContext(document),
    });
    assert.equal(result.manifest.counts.design_objects, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

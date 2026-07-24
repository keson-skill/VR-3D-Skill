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
import {
  compileScenePrimitives,
  validateWallPrimitiveTopology,
} from "../geometry/spatial-geometry.mjs";
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

async function loadP3Fixture(id) {
  const suite = JSON.parse(
    await readFile(
      new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url),
      "utf8",
    ),
  );
  return suite.fixtures.find((fixture) => fixture.id === id).spatial;
}

function gltfFromGlb(glb) {
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.toString("utf8", 20, 20 + jsonLength).trim());
}

function triangleNormalY(glb, meshName) {
  const jsonLength = glb.readUInt32LE(12);
  const gltf = gltfFromGlb(glb);
  const binaryOffset = 20 + jsonLength + 8;
  const meshIndex = gltf.meshes.findIndex((mesh) => mesh.name === meshName);
  const primitive = gltf.meshes[meshIndex].primitives[0];
  const position = gltf.accessors[primitive.attributes.POSITION];
  const indices = gltf.accessors[primitive.indices];
  const positionView = gltf.bufferViews[position.bufferView];
  const indexView = gltf.bufferViews[indices.bufferView];
  const readPosition = (index) => {
    const offset = binaryOffset + positionView.byteOffset + index * 12;
    return [glb.readFloatLE(offset), glb.readFloatLE(offset + 4), glb.readFloatLE(offset + 8)];
  };
  const readIndex = (index) =>
    glb.readUInt32LE(binaryOffset + indexView.byteOffset + index * 4);
  const [first, second, third] = [readPosition(readIndex(0)), readPosition(readIndex(1)), readPosition(readIndex(2))];
  const a = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const b = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  return a[2] * b[0] - a[0] * b[2];
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index][0] * next[1] - points[index][1] * next[0];
  }
  return area / 2;
}

function lineIntersection(start, end, clipStart, clipEnd) {
  const direction = [end[0] - start[0], end[1] - start[1]];
  const clipDirection = [clipEnd[0] - clipStart[0], clipEnd[1] - clipStart[1]];
  const denominator = direction[0] * clipDirection[1] - direction[1] * clipDirection[0];
  const offset = [clipStart[0] - start[0], clipStart[1] - start[1]];
  const ratio = (offset[0] * clipDirection[1] - offset[1] * clipDirection[0]) / denominator;
  return [start[0] + direction[0] * ratio, start[1] + direction[1] * ratio];
}

function convexIntersectionArea(subject, clip) {
  let output = subject;
  for (let index = 0; index < clip.length; index += 1) {
    const clipStart = clip[index];
    const clipEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];
    for (let cursor = 0; cursor < input.length; cursor += 1) {
      const current = input[cursor];
      const previous = input[(cursor - 1 + input.length) % input.length];
      const cross = (point) =>
        (clipEnd[0] - clipStart[0]) * (point[1] - clipStart[1]) -
        (clipEnd[1] - clipStart[1]) * (point[0] - clipStart[0]);
      const currentInside = cross(current) >= -1e-9;
      const previousInside = cross(previous) >= -1e-9;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      if (currentInside) output.push(current);
    }
  }
  return output.length >= 3 ? Math.abs(polygonArea(output)) : 0;
}

function samePoint(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]) < 1e-9;
}

function sharesOppositeEdge(left, right) {
  return left.some((point, index) => {
    const next = left[(index + 1) % left.length];
    return right.some((candidate, candidateIndex) => {
      const candidateNext = right[(candidateIndex + 1) % right.length];
      return samePoint(point, candidateNext) && samePoint(next, candidate);
    });
  });
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
      "runtime-contract.json",
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

test("writes upward-facing floors and downward-facing ceilings", async () => {
  const document = await loadExample();
  const glb = buildGlb(document, compileScenePrimitives(document));
  assert.ok(triangleNormalY(glb, "room-living-floor") > 0);
  assert.ok(triangleNormalY(glb, "room-living-ceiling") < 0);
});

test("mitered wall prisms meet without overlap at ordinary corners", async () => {
  const document = await loadExample();
  document.envelope.openings = [];
  const walls = compileScenePrimitives(document).filter(
    (primitive) => primitive.kind === "wall",
  );
  assert.equal(walls.length, 4);
  assert.ok(walls.every((primitive) => primitive.shape === "extruded_polygon"));
  assert.ok(walls.every((primitive) => primitive.mitered_start));
  assert.ok(walls.every((primitive) => primitive.mitered_end));
  for (let left = 0; left < walls.length; left += 1) {
    for (let right = left + 1; right < walls.length; right += 1) {
      const intersectionArea = convexIntersectionArea(
        walls[left].footprint,
        walls[right].footprint,
      );
      assert.ok(
        intersectionArea < 1e-9,
        `${walls[left].name} overlaps ${walls[right].name}: ${intersectionArea}`,
      );
    }
  }
  for (const [left, right] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
    assert.ok(
      sharesOppositeEdge(walls[left].footprint, walls[right].footprint),
      `${walls[left].name} and ${walls[right].name} leave a crack`,
    );
  }
});

test("T and X wall junctions use through and butt joints without wall-volume overlap", async () => {
  for (const fixtureId of ["p3-08-three-room-t", "p3-09-four-room-grid", "p3-20-complex-shared"]) {
    const primitives = compileScenePrimitives(await loadP3Fixture(fixtureId));
    const topology = validateWallPrimitiveTopology(primitives);
    assert.equal(topology.valid, true, `${fixtureId}: ${JSON.stringify(topology.errors)}`);
    const wallJoints = primitives
      .filter((primitive) => primitive.kind === "wall")
      .flatMap((primitive) => [primitive.junction_start, primitive.junction_end]);
    assert.ok(wallJoints.includes("through"), `${fixtureId} lacks a through joint`);
    assert.ok(wallJoints.includes("butt"), `${fixtureId} lacks a butt joint`);
  }
});

test("compiles P4 hard finishes and preserves PBR texture-slot metadata", async () => {
  const document = await loadExample();
  document.materials.finish_paint = {
    base_color: "#E4DDD3",
    roughness: 0.74,
    metalness: 0,
    double_sided: false,
    texture_budget_bytes: 524288,
    textures: {
      base_color: {
        uri: "materials/finish-paint.webp",
        mime_type: "image/webp",
        color_space: "srgb",
        scale_meters: 1,
      },
    },
  };
  document.hard_finishes = [
    { id: "baseboard-south", kind: "baseboard", host_wall_id: "wall-south", material_id: "finish_paint", height: 0.1, depth: 0.018 },
    { id: "trim-entry", kind: "opening_trim", opening_id: "door-entry", material_id: "finish_paint", width: 0.07, depth: 0.025 },
    { id: "ceiling-living", kind: "dropped_ceiling", room_id: "room-living", material_id: "finish_paint", drop: 0.12, thickness: 0.03 },
    { id: "cabinet-fixed", kind: "fixed_cabinet", room_id: "room-living", material_id: "finish_paint", dimensions: [1.2, 0.9, 0.45], transform: { position: [1.1, 0, 0.4] } },
  ];
  const primitives = compileScenePrimitives(document);
  const finishes = primitives.filter((primitive) => primitive.category === "hard_finish");
  assert.deepEqual(
    finishes.map((primitive) => primitive.kind).sort(),
    ["baseboard", "dropped_ceiling", "fixed_cabinet", "opening_trim", "opening_trim", "opening_trim"],
  );
  const glb = buildGlb(document, primitives);
  const report = validateGlbBytes(glb, { expectedProject: document.project });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  const material = gltfFromGlb(glb).materials.find((item) => item.name === "finish_paint");
  assert.equal(material.extras.texture_slots.base_color.color_space, "srgb");
  assert.equal(material.extras.texture_embedding, "deferred_p4_asset_pipeline");
});

test("P4 embeds local texture assets, records fallback assets, and exports punctual lights", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p4-assets-"));
  try {
    const document = await loadExample();
    document.materials.p4_finish = {
      base_color: "#D3C7B8",
      roughness: 0.7,
      textures: {
        base_color: {
          uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5L9sAAAAASUVORK5CYII=",
          mime_type: "image/png",
          color_space: "srgb",
          scale_meters: 1,
        },
        normal: {
          uri: "materials/missing-normal.png",
          mime_type: "image/png",
          color_space: "linear",
          scale_meters: 1,
        },
      },
    };
    document.envelope.walls[0].material_id = "p4_finish";
    document.lights = [
      { id: "sun-main", kind: "natural", position: [0, 4, 0], intensity: 1.2, color: "#FFF4E0" },
      { id: "downlight", kind: "area", position: [2, 2.5, 2], intensity: 45, range: 4 },
    ];
    const result = await buildViewableScene(document, {
      outputDirectory: directory,
      quality: "draft",
      ...createTestApprovalContext(document),
    });
    const gltf = gltfFromGlb(await readFile(result.sceneFile));
    const material = gltf.materials.find((item) => item.name === "p4_finish");
    assert.equal(gltf.images.length, 2);
    assert.equal(gltf.textures.length, 2);
    assert.equal(material.pbrMetallicRoughness.baseColorTexture.index >= 0, true);
    assert.equal(material.normalTexture.index >= 0, true);
    assert.equal(material.extras.texture_embedding, "p4_glb_embedded");
    assert.equal(gltf.extensions.KHR_lights_punctual.lights.length, 2);
    assert.equal(result.manifest.texture_assets.packed, 1);
    assert.equal(result.manifest.texture_assets.fallback, 1);
    assert.equal(result.glbValidation.summary.lights, 2);
    const textureReport = JSON.parse(
      await readFile(join(directory, "texture-validation-report.json"), "utf8"),
    );
    assert.equal(textureReport.quality, "draft");
    assert.equal(textureReport.assets.find((item) => item.slot === "normal").status, "fallback");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("P4 material overrides preserve source bindings while resolving replacement PBR textures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p4-override-"));
  try {
    const document = await loadExample();
    document.materials.warm_finish = {
      base_color: "#C99062",
      roughness: 0.48,
      textures: {
        base_color: {
          uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5L9sAAAAASUVORK5CYII=",
          mime_type: "image/png",
          color_space: "srgb",
          scale_meters: 0.5,
        },
      },
    };
    document.material_overrides = { wall_default: "warm_finish" };
    const result = await buildViewableScene(document, {
      outputDirectory: directory,
      ...createTestApprovalContext(document),
    });
    const gltf = gltfFromGlb(await readFile(result.sceneFile));
    const wallMaterial = gltf.materials.find((item) => item.name === "wall_default");
    assert.deepEqual(wallMaterial.pbrMetallicRoughness.baseColorFactor, [201 / 255, 144 / 255, 98 / 255, 1]);
    assert.equal(wallMaterial.pbrMetallicRoughness.baseColorTexture.index >= 0, true);
    assert.deepEqual(wallMaterial.extras.material_binding, {
      source_material_id: "wall_default",
      resolved_material_id: "warm_finish",
    });
    assert.deepEqual(result.manifest.material_overrides, { wall_default: "warm_finish" });
    assert.equal(result.textureReport[0].resolved_material_id, "warm_finish");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

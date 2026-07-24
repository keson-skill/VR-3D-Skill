import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSourceManifest } from "../ingest/build-source-manifest.mjs";
import { checkStageReadiness } from "../orchestration/check-stage-readiness.mjs";
import { buildAssetManifest } from "../processing/build-asset-manifest.mjs";
import { createAssetBrief } from "../tasks/asset-generation/create-asset-brief.mjs";
import { validateRevision } from "../validation/validate-revision.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";
import { verifyXrConfig } from "../runtime/verify-xr-config.mjs";
import {
  assertModelAvailable,
  editImage,
  generateSpatialJson,
} from "../adapters/realmrouter-openai.mjs";

function validSpatialJson() {
  return {
    schema_version: "1.0",
    project: {
      id: "project-001",
      revision: "rev-001",
      units: "meters",
      up_axis: "Y",
      forward_axis: "-Z",
      handedness: "right",
      origin: [0, 0, 0],
    },
    sources: [],
    requirements: { design_intent: { style: "warm cream" } },
    envelope: {
      floor_elevation: 0,
      walls: [
        {
          id: "wall-01",
          start: [0, 0],
          end: [4, 0],
          thickness: 0.2,
          height: 2.8,
          structural_role: "unknown",
          edit_policy: "review_required",
        },
        {
          id: "wall-02",
          start: [4, 0],
          end: [4, 4],
          thickness: 0.2,
          height: 2.8,
          structural_role: "unknown",
          edit_policy: "review_required",
        },
        {
          id: "wall-03",
          start: [4, 4],
          end: [0, 4],
          thickness: 0.2,
          height: 2.8,
          structural_role: "unknown",
          edit_policy: "review_required",
        },
        {
          id: "wall-04",
          start: [0, 4],
          end: [0, 0],
          thickness: 0.2,
          height: 2.8,
          structural_role: "unknown",
          edit_policy: "review_required",
        },
      ],
      openings: [
        {
          id: "door-01",
          kind: "hinged_door",
          host_wall_id: "wall-01",
          offset: 0.5,
          width: 0.9,
          height: 2.1,
        },
      ],
    },
    rooms: [
      {
        id: "room-living",
        type: "living",
        boundary_wall_ids: ["wall-01", "wall-02", "wall-03", "wall-04"],
      },
    ],
    circulation: {
      paths: [
        {
          id: "path-main",
          polyline: [
            [1, 0.5],
            [1, 3.5],
          ],
          minimum_width: 0.9,
        },
      ],
    },
    assets: [
      {
        id: "asset-sofa",
        uri: "assets/sofa.glb",
        format: "glb",
        source: "generated",
        license: "verify_before_distribution",
        dimensions: [2, 0.8, 0.9],
        pivot: "bottom_center",
        forward_axis: "-Z",
        optimized: true,
      },
    ],
    design_objects: [
      {
        id: "object-sofa",
        kind: "sofa",
        room_id: "room-living",
        asset_id: "asset-sofa",
        dimensions: [2, 0.8, 0.9],
        transform: {
          position: [2, 0, 3],
          rotation_euler_degrees: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
    ],
    materials: {
      wall_main: {
        base_color: "#E7E0D5",
        roughness: 0.7,
        metalness: 0,
      },
    },
    lights: [
      {
        id: "light-main",
        kind: "area",
        position: [2, 2.6, 2],
        intensity: 500,
      },
    ],
    xr: {
      spawn: [1, 0, 1],
      navigation: "teleport",
      snap_turn_degrees: 30,
      boundary_room_ids: ["room-living"],
    },
    render_profiles: {
      webxr: { quality_tier: "balanced", target_asset_format: "glb" },
    },
    assumptions: [],
    unresolved_questions: [],
    validation: { status: "approved", approved_scope: "construction_ready", checks: [] },
  };
}

test("validates an approved one-room spatial contract", () => {
  const report = validateSpatialJson(validSpatialJson(), {
    requireApproved: true,
  });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
});

test("rejects an opening outside its host wall", () => {
  const document = validSpatialJson();
  document.envelope.openings[0].offset = 3.5;
  document.envelope.openings[0].width = 1;
  const report = validateSpatialJson(document);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.code === "opening.outside_wall"));
});

test("validates stable-ID revision operations and rejects array indexes", () => {
  const document = validSpatialJson();
  const valid = validateRevision(document, {
    revision_id: "rev-002",
    base_revision: "rev-001",
    intent: "Change the sofa asset.",
    operations: [
      {
        op: "replace",
        target_id: "object-sofa",
        field_path: "/asset_id",
        value: "asset-sofa",
      },
    ],
    must_preserve_ids: ["wall-01"],
    must_preserve_paths: ["/envelope"],
    revalidate: ["asset_bindings"],
  });
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));

  const invalid = validateRevision(document, {
    revision_id: "rev-002",
    base_revision: "rev-001",
    intent: "Unsafe indexed edit.",
    operations: [
      { op: "replace", path: "/design_objects/0/asset_id", value: "x" },
    ],
  });
  assert.equal(invalid.valid, false);
});

test("builds an asset brief and web asset manifest", () => {
  const document = validSpatialJson();
  const brief = createAssetBrief(document, "object-sofa");
  assert.deepEqual(brief.target_dimensions_meters, [2, 0.8, 0.9]);
  assert.equal(brief.target_format, "glb");

  const result = buildAssetManifest([document.assets[0]], { target: "web" });
  assert.equal(result.report.valid, true, JSON.stringify(result.report.errors));
});

test("reports downstream stage and XR readiness", () => {
  const document = validSpatialJson();
  assert.equal(checkStageReadiness("preview", document).ready, true);
  assert.equal(verifyXrConfig(document).valid, true);
});

test("builds a deterministic local source manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-skill-"));
  try {
    const filePath = join(directory, "plan.json");
    await writeFile(filePath, '{"scale":"1:100"}', "utf8");
    const manifest = await buildSourceManifest([filePath]);
    assert.equal(manifest.sources.length, 1);
    assert.equal(manifest.sources[0].type, "structured_data");
    assert.equal(manifest.sources[0].sha256.length, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries transient RealmRouter failures before returning Spatial JSON", async () => {
  let calls = 0;
  const result = await generateSpatialJson({
    apiKey: "test-key",
    prompt: "Return a minimal JSON object.",
    maxRetries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNRESET", message: "connection reset" };
        throw error;
      }
      return new Response(
        JSON.stringify({
          id: "request-123",
          model: "gpt-5.6-sol",
          choices: [{ message: { content: "{\"ok\":true}" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.spatialJson, { ok: true });
});

test("bounds a hanging RealmRouter request with a hard timeout", async () => {
  await assert.rejects(
    generateSpatialJson({
      apiKey: "test-key",
      prompt: "Return a minimal JSON object.",
      timeoutMs: 5,
      maxRetries: 0,
      fetchImpl: () => new Promise(() => {}),
    }),
    /exceeded 5 ms/,
  );
});

test("rejects a configured model that is absent from the token-visible catalog", async () => {
  await assert.rejects(
    assertModelAvailable({
      apiKey: "test-key",
      model: "gpt-5.6-sol",
      routeLabel: "spatial",
      maxRetries: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /spatial model gpt-5.6-sol is not available.*gpt-5.5/,
  );
});

test("accepts a configured model that is present in the token-visible catalog", async () => {
  const catalog = await assertModelAvailable({
    apiKey: "test-key",
    model: "gpt-5.5",
    routeLabel: "spatial",
    maxRetries: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.deepEqual(catalog.modelIds, ["gpt-5.5"]);
});

test("sends reference image edits as multipart data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-skill-edit-"));
  try {
    const inputImage = join(directory, "reference.png");
    await writeFile(inputImage, "not-a-real-png", "utf8");
    let request;
    const result = await editImage({
      apiKey: "test-key",
      model: "gpt-image-2",
      prompt: "Keep the room geometry and improve lighting.",
      inputImage,
      maxRetries: 0,
      fetchImpl: async (endpoint, options) => {
        request = { endpoint, options };
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(request.endpoint, "https://realmrouter.cn/v1/images/edits");
    assert.ok(request.options.body instanceof FormData);
    assert.equal(request.options.headers["Content-Type"], undefined);
    assert.deepEqual(result.bytes, Buffer.from("image-bytes"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

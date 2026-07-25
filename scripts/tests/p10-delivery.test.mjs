import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildDeliveryManifest } from "../release/build-delivery-manifest.mjs";
import { verifyRealProjectBindings } from "../release/approve-real-project.mjs";
import { createTestApprovalContext } from "./helpers/p2-approval.mjs";

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(directory, license = "MIT") {
  const suite = JSON.parse(
    await readFile(new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url), "utf8"),
  );
  const spatial = structuredClone(suite.fixtures[0].spatial);
  spatial.validation = {
    ...(spatial.validation || {}),
    status: "approved",
    approved_scope: "visualization_only",
  };
  const approval = createTestApprovalContext(spatial);
  const documents = {
    "source-manifest.json": approval.sourceManifest,
    "spatial.json": spatial,
    "spatial-validation.json": approval.validationReport,
    "spatial-approval.json": approval.approval,
    "spatial-approval-trust.json": {},
    "asset-manifest.json": {
      schema_version: "1.0",
      assets: [{ id: "chair-001", license }],
    },
  };
  await Promise.all(
    Object.entries(documents).map(([name, value]) => writeJson(join(directory, name), value)),
  );
  await writeFile(join(directory, "scene.glb"), "fixture-scene\n", "utf8");
  return {
    projectId: spatial.project.id,
    revision: spatial.project.revision,
    bindingEntries: [
      { name: "source_manifest", path: "source-manifest.json" },
      { name: "spatial_json", path: "spatial.json" },
      { name: "validation_report", path: "spatial-validation.json" },
      { name: "approval", path: "spatial-approval.json" },
      { name: "approval_trust", path: "spatial-approval-trust.json" },
    ],
  };
}

test("delivery manifest binds approved inputs, artifacts, and resolved asset licenses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-delivery-"));
  try {
    const data = await fixture(directory);
    const manifest = await buildDeliveryManifest({
      rootDirectory: directory,
      projectId: data.projectId,
      revision: data.revision,
      scope: "visualization_only",
      mode: "furnished",
      bindingEntries: data.bindingEntries,
      assetManifestEntry: { name: "asset_manifest", path: "asset-manifest.json" },
      artifactEntries: [{ name: "scene", path: "scene.glb" }],
      limitations: ["Fixture delivery."],
    }, {
      allowTestApproval: true,
      generatedAt: "2026-07-24T00:00:00.000Z",
    });
    assert.equal(manifest.delivery_ready, true, JSON.stringify(manifest.blockers));
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.asset_licenses.passed, true);
    assert.match(manifest.delivery_manifest_sha256, /^[a-f0-9]{64}$/u);
    assert.match(manifest.limitations[0], /Visualization only/u);
    const sourceManifestBytes = await readFile(join(directory, "source-manifest.json"));
    assert.equal(
      verifyRealProjectBindings({
        sourceManifestBytes,
        deliveryManifest: manifest,
        projectId: data.projectId,
      }),
      manifest.bindings.source_manifest.sha256,
    );
    assert.throws(
      () => verifyRealProjectBindings({
        sourceManifestBytes: Buffer.from("{}\n", "utf8"),
        deliveryManifest: manifest,
        projectId: data.projectId,
      }),
      /does not match the delivery binding/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery manifest blocks unresolved licenses and paths outside the delivery root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-delivery-block-"));
  try {
    const data = await fixture(directory, "verify_before_distribution");
    const manifest = await buildDeliveryManifest({
      rootDirectory: directory,
      projectId: data.projectId,
      revision: data.revision,
      scope: "visualization_only",
      mode: "furnished",
      bindingEntries: data.bindingEntries,
      assetManifestEntry: { name: "asset_manifest", path: "asset-manifest.json" },
      artifactEntries: [{ name: "scene", path: "scene.glb" }],
    }, { allowTestApproval: true });
    assert.equal(manifest.delivery_ready, false);
    assert.ok(manifest.blockers.some((blocker) =>
      blocker.code === "delivery.asset_license_unresolved"));
    await assert.rejects(
      buildDeliveryManifest({
        rootDirectory: directory,
        projectId: data.projectId,
        revision: data.revision,
        scope: "visualization_only",
        mode: "shell",
        bindingEntries: data.bindingEntries,
        artifactEntries: [{ name: "scene", path: "../outside.glb" }],
      }, { allowTestApproval: true }),
      /escapes the delivery root/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

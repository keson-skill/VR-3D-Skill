import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSpatialApprovalRecord, verifySpatialApproval } from "../approval/spatial-approval.mjs";
import { canonicalJson } from "../lib/cli.mjs";
import { runP2Acceptance } from "../validation/run-p2-acceptance.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

async function example() {
  return JSON.parse(
    await readFile(
      new URL("../../examples/one-room/spatial.json", import.meta.url),
      "utf8",
    ),
  );
}

function approvalContext(spatialJson) {
  const sourceManifest = {
    manifest_version: "1.0",
    sources: spatialJson.sources,
  };
  const validationReport = validateSpatialJson(spatialJson);
  const approval = createSpatialApprovalRecord({
    sourceManifest,
    spatialJson,
    validationReport,
    approver: "P2 test reviewer",
    scope: spatialJson.validation.approved_scope,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvalKind: "test_fixture",
  });
  return { sourceManifest, validationReport, approval };
}

test("executes Draft 2020-12 schema before geometric validation", async () => {
  const document = await example();
  delete document.project.up_axis;
  const report = validateSpatialJson(document);
  assert.equal(report.schema_valid, false);
  assert.ok(
    report.errors.some(
      (error) =>
        error.code === "schema.required" &&
        error.path === "/project/up_axis",
    ),
  );
});

test("binds approval to source, Spatial JSON, and validation hashes", async () => {
  const document = await example();
  const context = approvalContext(document);
  assert.throws(
    () =>
      createSpatialApprovalRecord({
        sourceManifest: context.sourceManifest,
        spatialJson: document,
        validationReport: context.validationReport,
        approver: "Model process",
        scope: document.validation.approved_scope,
        approvalKind: "human",
      }),
    /only be created by the interactive TTY approval command/,
  );
  const fixtureRejected = verifySpatialApproval({
    ...context,
    spatialJson: document,
  });
  assert.equal(fixtureRejected.valid, false);
  assert.ok(
    fixtureRejected.errors.some(
      (error) => error.code === "approval.test_fixture_forbidden",
    ),
  );

  const accepted = verifySpatialApproval({
    ...context,
    spatialJson: document,
    allowTestFixture: true,
  });
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));

  const changed = structuredClone(document);
  changed.envelope.walls[0].end[0] += 0.01;
  const mismatch = verifySpatialApproval({
    ...context,
    spatialJson: changed,
    allowTestFixture: true,
  });
  assert.equal(mismatch.valid, false);
  assert.ok(
    mismatch.errors.some((error) => error.code === "approval.hash_mismatch"),
  );
});

test("requires an independent approval artifact for downstream validation", async () => {
  const document = await example();
  const missing = validateSpatialJson(document, { requireApproved: true });
  assert.equal(missing.valid, false);
  assert.ok(
    missing.errors.some(
      (error) => error.code === "approval.artifact_required",
    ),
  );

  const context = approvalContext(document);
  const approved = validateSpatialJson(document, {
    requireApproved: true,
    ...context,
    allowTestApproval: true,
  });
  assert.equal(approved.valid, true, JSON.stringify(approved.errors));
});

test("verifies human approval against an external Ed25519 trust store", async () => {
  const document = await example();
  const context = approvalContext(document);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const humanApproval = structuredClone(context.approval);
  humanApproval.approval_kind = "human";
  humanApproval.attestation.method = "interactive_tty";
  humanApproval.signature = {
    algorithm: "ed25519",
    key_id: "reviewer-test",
    value_base64: "",
  };
  const unsigned = structuredClone(humanApproval);
  delete unsigned.signature;
  humanApproval.signature.value_base64 = sign(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    privateKey,
  ).toString("base64");
  const approvalTrust = {
    schema_version: "1.0",
    kind: "spatial_approval_trust",
    keys: [
      {
        id: "reviewer-test",
        algorithm: "ed25519",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
        status: "active",
        owner: "P2 test reviewer",
      },
    ],
  };
  const verified = verifySpatialApproval({
    ...context,
    approval: humanApproval,
    approvalTrust,
    spatialJson: document,
  });
  assert.equal(verified.valid, true, JSON.stringify(verified.errors));

  humanApproval.signature.value_base64 =
    `${humanApproval.signature.value_base64.slice(0, -4)}AAAA`;
  const tampered = verifySpatialApproval({
    ...context,
    approval: humanApproval,
    approvalTrust,
    spatialJson: document,
  });
  assert.equal(tampered.valid, false);
  assert.ok(
    tampered.errors.some(
      (error) => error.code === "approval.signature_invalid",
    ),
  );
});

test("passes all five raster and five DXF P2 fixtures", async () => {
  const report = await runP2Acceptance();
  assert.equal(report.fixture_counts.raster, 5);
  assert.equal(report.fixture_counts.dxf, 5);
  assert.equal(report.aggregate.schema_and_geometry_errors, 0);
  assert.ok(report.aggregate.dxf_max_endpoint_error_meters <= 0.001);
  assert.ok(report.aggregate.raster_median_relative_wall_error <= 0.02);
  assert.ok(report.aggregate.raster_max_absolute_wall_error_meters <= 0.05);
  assert.equal(report.passed, true, JSON.stringify(report.samples));
});

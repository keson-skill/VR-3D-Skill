import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyRevision } from "../revisions/apply-revision.mjs";
import { buildDependencyPlan } from "../revisions/build-dependency-plan.mjs";
import { regenerateAffected } from "../revisions/regenerate-affected.mjs";
import {
  applyRevisionToStore,
  loadCurrentRevision,
  rollbackToRevision,
  undoCurrentRevision,
  verifyRevisionStore,
} from "../revisions/revision-store.mjs";
import {
  buildRevisionPlanningPrompt,
  planNaturalLanguageRevision,
} from "../tasks/revision-planning/plan-revision.mjs";
import { runP8Acceptance } from "../validation/run-p8-acceptance.mjs";

const FIXTURES = new URL("../../examples/p8-acceptance/fixtures.json", import.meta.url);

async function firstFixture() {
  return JSON.parse(await readFile(FIXTURES, "utf8")).fixtures[0];
}

test("passes twenty P8 apply, dependency, diff, undo, and audit fixtures", async () => {
  const report = await runP8Acceptance();
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
});

test("revision store applies, undoes, rolls back, and verifies hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p8-store-"));
  try {
    const fixture = await firstFixture();
    const applied = await applyRevisionToStore(
      directory,
      fixture.spatial,
      fixture.revision,
      { appliedAt: "2026-07-24T01:00:00.000Z" },
    );
    assert.equal(applied.persisted.current_revision, fixture.revision.revision_id);

    const undone = await undoCurrentRevision(directory, "p8-undo-rev-003", {
      actorId: "reviewer-001",
      appliedAt: "2026-07-24T02:00:00.000Z",
    });
    assert.equal(undone.result.document.materials.finish_paint.base_color, fixture.spatial.materials.finish_paint.base_color);

    const rolledBack = await rollbackToRevision(
      directory,
      fixture.revision.revision_id,
      "p8-rollback-rev-004",
      {
        actorId: "reviewer-001",
        appliedAt: "2026-07-24T03:00:00.000Z",
      },
    );
    assert.equal(rolledBack.result.document.project.revision, "p8-rollback-rev-004");
    assert.equal(
      rolledBack.result.document.materials.finish_paint.base_color,
      fixture.revision.operations[0].value,
    );
    assert.equal(rolledBack.result.requires_reapproval, true);

    const rollbackUndone = await undoCurrentRevision(
      directory,
      "p8-undo-rollback-rev-005",
      {
        actorId: "reviewer-001",
        appliedAt: "2026-07-24T04:00:00.000Z",
      },
    );
    assert.equal(
      rollbackUndone.result.document.materials.finish_paint.base_color,
      fixture.spatial.materials.finish_paint.base_color,
    );

    const current = await loadCurrentRevision(directory);
    assert.equal(current.project.revision, "p8-undo-rollback-rev-005");
    const verification = await verifyRevisionStore(directory);
    assert.equal(verification.valid, true);
    assert.equal(verification.versions, 5);
    assert.equal(verification.audit_events, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision store detects a tampered stored version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p8-tamper-"));
  try {
    const fixture = await firstFixture();
    await applyRevisionToStore(directory, fixture.spatial, fixture.revision);
    const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
    const record = index.versions[fixture.revision.revision_id];
    await writeFile(join(directory, record.file), "{}\n", "utf8");
    await assert.rejects(
      verifyRevisionStore(directory),
      (error) => error.code === "revision_store.version_hash",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("natural-language planner exposes stable IDs and validates the model contract", async () => {
  const fixture = await firstFixture();
  const prompt = buildRevisionPlanningPrompt(
    fixture.spatial,
    "把墙面改成暖奶油色，其他不动",
  );
  assert.match(prompt, /chair-1/u);
  assert.doesNotMatch(prompt, /local:\/\//u);
  const planned = await planNaturalLanguageRevision(
    fixture.spatial,
    "把墙面改成暖奶油色，其他不动",
    {
      actorId: "mock-model",
      createdAt: "2026-07-24T00:00:00.000Z",
      generate: async () => ({
        spatialJson: structuredClone(fixture.revision),
        model: "mock-model",
        requestId: "request-001",
      }),
    },
  );
  assert.equal(planned.blocked, false, JSON.stringify(planned.validation?.errors));
  const applied = applyRevision(fixture.spatial, planned.revision);
  assert.equal(applied.document.project.revision, fixture.revision.revision_id);
  assert.equal(planned.revision.provenance.request_id, "request-001");
});

test("incremental regeneration runs only affected handlers and enforces reapproval", async () => {
  const plan = buildDependencyPlan(
    ["/materials/finish_paint/base_color"],
    ["pbr"],
  );
  const calls = [];
  const handlers = Object.fromEntries(
    plan.regenerate.map((artifact) => [
      artifact,
      async () => {
        calls.push(artifact);
        return { sha256: artifact.padEnd(64, "0").slice(0, 64) };
      },
    ]),
  );
  await assert.rejects(
    regenerateAffected(plan, { handlers }),
    /Reapproval is required/u,
  );
  const result = await regenerateAffected(plan, {
    handlers,
    approvalVerified: true,
    previousManifest: {
      artifacts: {
        source_archive: { sha256: "a".repeat(64) },
        scene_glb: { sha256: "b".repeat(64) },
      },
    },
  });
  assert.deepEqual(calls, plan.regenerate);
  assert.equal(result.artifacts.source_archive.status, "reused");
  assert.equal(result.artifacts.scene_glb.status, "regenerated");
  assert.deepEqual(result.reused, ["source_archive"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { runP3Acceptance } from "../validation/run-p3-acceptance.mjs";

test("passes twenty P3 shell-geometry and GLB regression fixtures", async () => {
  const report = await runP3Acceptance();
  assert.equal(report.aggregate.fixture_count, 20);
  assert.equal(report.aggregate.spatial_errors, 0);
  assert.equal(report.aggregate.glb_errors, 0);
  assert.equal(report.aggregate.count_errors, 0);
  assert.ok(report.aggregate.minimum_alignment_f1 >= 0.84);
  assert.ok(report.aggregate.minimum_alignment_iou >= 0.72);
  assert.equal(report.passed, true, JSON.stringify(report.samples));
});

import assert from "node:assert/strict";
import test from "node:test";
import { runP6Acceptance } from "../validation/run-p6-acceptance.mjs";

test("passes twenty P6 runtime and Viewer contract fixtures", async () => {
  const report = await runP6Acceptance();
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
});

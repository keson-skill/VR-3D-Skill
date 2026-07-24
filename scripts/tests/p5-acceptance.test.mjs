import assert from "node:assert/strict";
import test from "node:test";
import { runP5Acceptance } from "../validation/run-p5-acceptance.mjs";

test("passes twenty P5 design and asset-resolution fixtures", async () => {
  const report = await runP5Acceptance();
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
});

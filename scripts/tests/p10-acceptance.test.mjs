import assert from "node:assert/strict";
import test from "node:test";
import { runP10Acceptance } from "../validation/run-p10-acceptance.mjs";

test("P10 fixed suite accepts code but cannot self-qualify production release", async () => {
  const result = await runP10Acceptance({ codeOnly: true });
  assert.equal(result.passed, true);
  assert.equal(result.code_passed, true);
  assert.equal(result.release_qualified, false);
  assert.equal(result.stage_status_recommendation, "ACCEPTANCE");
  assert.equal(result.aggregate.fixture_count, 30);
  assert.equal(result.aggregate.categories, 10);
  assert.equal(result.aggregate.fixture_errors, 0);
  assert.match(result.explicit_non_claim, /release remains unqualified/u);
});

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
import { buildGlb } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { auditScenePerformance } from "../performance/audit-scene.mjs";
import { benchmarkCore } from "../performance/benchmark-core.mjs";
import { validateQualificationRecord } from "../performance/validate-qualification.mjs";

const BUDGETS_URL = new URL("../../config/performance-budgets.json", import.meta.url);

async function loadFixture() {
  const suite = JSON.parse(
    await readFile(new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url), "utf8"),
  );
  return suite.fixtures[0].spatial;
}

test("static scene audit measures GLB delivery cost and enforces target-specific budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-scene-budget-"));
  try {
    const spatial = await loadFixture();
    const glb = buildGlb(spatial, compileScenePrimitives(spatial));
    const scene = join(directory, "scene.glb");
    await writeFile(scene, glb);
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Fixture</title>", "utf8");
    const budgets = JSON.parse(await readFile(BUDGETS_URL, "utf8"));
    const passing = await auditScenePerformance(scene, directory, budgets, "web_desktop");
    assert.equal(passing.passed, true, JSON.stringify(passing.checks));
    assert.ok(passing.metrics.triangles > 0);
    assert.ok(passing.metrics.draw_calls > 0);

    const strict = structuredClone(budgets);
    strict.profiles.web_desktop.max_glb_bytes = 1;
    const failing = await auditScenePerformance(scene, directory, strict, "web_desktop");
    assert.equal(failing.passed, false);
    assert.equal(
      failing.checks.find((check) => check.metric === "glb_bytes").passed,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualification gate rejects simulated XR evidence and accepts a complete desktop capture contract", async () => {
  const budgets = JSON.parse(await readFile(BUDGETS_URL, "utf8"));
  const base = {
    schema_version: "1.0",
    qualification_id: "qualification-desktop-001",
    target: "web_desktop",
    execution: {
      status: "executed",
      evidence_kind: "actual_device_capture",
      synthetic: false,
      captured_at: "2026-07-24T00:00:00.000Z",
      operator: "qualified-operator",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
    },
    hardware: {
      manufacturer: "Fixture Vendor",
      model: "Fixture Workstation",
      device_class: "desktop",
      os: "Fixture OS",
      os_version: "1",
      gpu: "Fixture GPU",
    },
    software: {
      browser: "Chromium",
      browser_version: "140",
    },
    measurements: {
      capture_seconds: 60,
      average_fps: 60,
      p95_frame_time_ms: 16.7,
      memory_growth_bytes: 1024,
    },
    checks: {
      launch: true,
      navigate: true,
      pause_resume: true,
      recover_failure: true,
    },
    evidence: [{ file: "capture.json", sha256: "c".repeat(64) }],
  };
  assert.equal(validateQualificationRecord(base, budgets).qualified, true);
  const sensitive = structuredClone(base);
  sensitive.execution.api_key = "must-not-be-bundled";
  const sensitiveReport = validateQualificationRecord(sensitive, budgets);
  assert.equal(sensitiveReport.qualified, false);
  assert.ok(sensitiveReport.errors.some((error) =>
    error.code === "qualification.sensitive_data"));

  const simulatedXr = structuredClone(base);
  simulatedXr.qualification_id = "qualification-xr-simulated";
  simulatedXr.target = "web_xr";
  simulatedXr.execution.synthetic = true;
  simulatedXr.hardware.device_class = "desktop";
  const xrReport = validateQualificationRecord(simulatedXr, budgets);
  assert.equal(xrReport.qualified, false);
  assert.ok(xrReport.errors.some((error) => error.code === "qualification.actual_capture"));
  assert.ok(xrReport.errors.some((error) => error.code === "qualification.xr_device"));
  assert.match(xrReport.explicit_non_claim, /does not qualify/u);
});

test("core benchmark records deterministic current-host evidence without claiming target-device FPS", async () => {
  const report = await benchmarkCore(
    new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url),
    { iterations: 1 },
  );
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
  assert.equal(report.aggregate.deterministic, true);
  assert.equal(report.evidence_kind, "ci_core_benchmark");
  assert.match(report.explicit_non_claim, /does not qualify browser FPS/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildPlatformEvidence } from "../release/write-platform-evidence.mjs";

function fixture() {
  const acceptanceBytes = Buffer.from("{}\n");
  const doctorBytes = Buffer.from("{}\n");
  return {
    acceptance: {
      stage: "P10",
      acceptance_scope: "code_only",
      passed: true,
      code_passed: true,
    },
    acceptanceBytes,
    doctor: {
      ready: true,
      selected_profile: "release",
      host: { platform: "linux" },
    },
    doctorBytes,
    commitSha: "a".repeat(40),
    workflowUrl: "https://github.com/keson-skill/VR-3D-Skill/actions/runs/123",
  };
}

test("platform evidence binds a passing CI and doctor report to the commit", () => {
  const first = buildPlatformEvidence(fixture(), {
    hostPlatform: "linux",
    hostArchitecture: "x64",
    nodeVersion: "20.19.0",
    capturedAt: "2026-07-24T00:00:00.000Z",
  });
  const second = buildPlatformEvidence(fixture(), {
    hostPlatform: "linux",
    hostArchitecture: "x64",
    nodeVersion: "20.19.0",
    capturedAt: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(first.status, "passed");
  assert.equal(first.platform, "linux");
  assert.equal(first.record_sha256, second.record_sha256);
  assert.match(first.artifact_sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.explicit_non_claim, /does not qualify/u);
});

test("platform evidence rejects mismatched host and non-GitHub workflow claims", () => {
  assert.throws(
    () => buildPlatformEvidence(fixture(), { hostPlatform: "darwin" }),
    /current platform/u,
  );
  assert.throws(
    () => buildPlatformEvidence(
      { ...fixture(), workflowUrl: "https://example.invalid/run/123" },
      { hostPlatform: "linux" },
    ),
    /GitHub Actions run URL/u,
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRelease } from "../release/build-release.mjs";
import { assembleQualificationBundle } from "../release/assemble-qualification-bundle.mjs";
import { generateSbom } from "../release/generate-sbom.mjs";
import { validateReleaseEvidence } from "../release/validate-release-evidence.mjs";
import { verifyReleaseManifest } from "../release/verify-release.mjs";
import { validateQualificationRecord } from "../performance/validate-qualification.mjs";
import {
  canonicalJsonSha256,
  sha256,
  writeJson,
} from "../lib/cli.mjs";

function platformEvidenceRecords(commit) {
  return ["linux", "darwin", "win32"].map((platform) => {
    const body = {
      schema_version: "1.0",
      platform,
      status: "passed",
      commit_sha: commit,
      captured_at: "2026-07-24T00:00:00.000Z",
      workflow_url: `https://github.com/keson-skill/VR-3D-Skill/actions/runs/123/${platform}`,
      artifact_sha256: "b".repeat(64),
      environment: {
        architecture: "fixture",
        node_version: "20.19.0",
        ci_provider: "github_actions",
      },
      inputs: {
        p10_code_acceptance: "c".repeat(64),
        doctor_release: "d".repeat(64),
      },
      explicit_non_claim: "Fixture platform evidence.",
    };
    return { ...body, record_sha256: canonicalJsonSha256(body) };
  });
}

function targetCapture(target, commit) {
  const execution = {
    status: "executed",
    evidence_kind: "actual_device_capture",
    synthetic: false,
    captured_at: "2026-07-24T00:00:00.000Z",
    operator: "fixture-operator",
    commit_sha: commit,
    artifact_sha256: "e".repeat(64),
  };
  if (target === "blender") {
    return {
      schema_version: "1.0",
      qualification_id: "qualification-blender",
      target,
      execution,
      hardware: {
        manufacturer: "Fixture",
        model: "Fixture workstation",
        device_class: "desktop",
        os: "Fixture OS",
        os_version: "1",
        cpu: "Fixture CPU",
      },
      software: {
        blender_version: "4.3.2",
        render_engine: "BLENDER_EEVEE_NEXT",
      },
      measurements: {
        rendered_frames: 4,
        average_render_seconds_per_frame: 1,
      },
      artifacts: [
        { file: "render.png", sha256: "1".repeat(64) },
        { file: "scene.blend", sha256: "2".repeat(64) },
      ],
    };
  }
  const xr = target === "web_xr";
  return {
    schema_version: "1.0",
    qualification_id: `qualification-${target}`,
    target,
    execution,
    hardware: {
      manufacturer: "Fixture",
      model: "Fixture device",
      device_class: xr
        ? "xr_headset"
        : target === "web_mobile" ? "mobile" : "desktop",
      os: "Fixture OS",
      os_version: "1",
      gpu: "Fixture GPU",
    },
    software: {
      browser: "Chromium",
      browser_version: "140",
    },
    measurements: {
      capture_seconds: xr ? 120 : 60,
      average_fps: xr ? 72 : 60,
      p95_frame_time_ms: xr ? 13 : 16.7,
      memory_growth_bytes: 1024,
    },
    checks: {
      launch: true,
      navigate: true,
      pause_resume: true,
      recover_failure: true,
      ...(xr
        ? {
            session_enter: true,
            session_exit: true,
            session_reenter: true,
            tracking_loss_recovery: true,
            controller_reconnect: true,
          }
        : {}),
    },
    evidence: [{ file: "capture.json", sha256: "3".repeat(64) }],
  };
}

function projectAcceptance(commit = "a".repeat(40)) {
  const body = {
    schema_version: "1.0",
    kind: "real_project_acceptance",
    project_id: "anonymized-project-001",
    data_classification: "anonymized_real_project",
    synthetic: false,
    accepted: true,
    commit_sha: commit,
    accepted_at: "2026-07-24T00:00:00.000Z",
    approver_id: "product-owner-001",
    source_manifest_sha256: "f".repeat(64),
    delivery_manifest_sha256: "1".repeat(64),
    privacy_review: { anonymized: true, customer_authorized_use: true },
    attestation: {
      method: "interactive_human_review",
      statement: "Fixture acceptance.",
      confirmation_digest: "2".repeat(64),
    },
    notes: "",
  };
  return {
    ...body,
    acceptance_report_sha256: canonicalJsonSha256(body),
  };
}

function completeQualificationEvidence(budgets, commit = "a".repeat(40)) {
  const platformRecords = platformEvidenceRecords(commit);
  const targetReports = [
    "web_desktop",
    "web_mobile",
    "web_xr",
    "blender",
  ].map((target) => ({
    target,
    report: validateQualificationRecord(targetCapture(target, commit), budgets),
  }));
  const projectAcceptances = [projectAcceptance(commit)];
  return {
    platformRecords,
    targetReports,
    projectAcceptances,
    bundle: assembleQualificationBundle({
      commitSha: commit,
      platformRecords,
      targetReports,
      projectAcceptances,
    }),
  };
}

test("qualification assembler verifies embedded evidence hashes and commit bindings", async () => {
  const commit = "a".repeat(40);
  const budgets = JSON.parse(await readFile(
    new URL("../../config/performance-budgets.json", import.meta.url),
    "utf8",
  ));
  const {
    platformRecords,
    targetReports,
    projectAcceptances,
    bundle,
  } = completeQualificationEvidence(budgets, commit);
  assert.deepEqual(Object.keys(bundle.platforms).sort(), ["darwin", "linux", "win32"]);
  assert.equal(bundle.projects.length, 1);
  assert.equal(bundle.targets.web_xr.capture_record.target, "web_xr");
  assert.match(bundle.qualification_bundle_sha256, /^[a-f0-9]{64}$/u);

  const tampered = structuredClone(platformRecords);
  tampered[0].artifact_sha256 = "9".repeat(64);
  assert.throws(
    () => assembleQualificationBundle({
      commitSha: commit,
      platformRecords: tampered,
      targetReports,
      projectAcceptances,
    }),
    /invalid record_sha256/u,
  );
});

test("SBOM generation is deterministic and covers all locked components", async () => {
  const [packageJson, lock] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const first = generateSbom(packageJson, lock);
  const second = generateSbom(packageJson, lock);
  assert.equal(first.document_sha256, second.document_sha256);
  for (const dependency of Object.keys(packageJson.dependencies)) {
    assert.ok(first.components.some((component) => component.name === dependency));
  }
  const lockedComponentCount = Object.entries(lock.packages)
    .filter(([path, record]) => path && record.version)
    .length;
  assert.equal(first.components.length, lockedComponentCount);
  assert.equal(
    new Set(first.components.map((component) => component["bom-ref"])).size,
    first.components.length,
  );
  assert.ok(first.dependencies.length > 1);
  const scoped = first.components.find((component) => component.name.startsWith("@"));
  assert.match(scoped.purl, /^pkg:npm\/%40[^/]+\/[^@]+@/u);
  assert.doesNotMatch(scoped.purl, /%2F/iu);
  assert.equal(first.metadata.component.version, packageJson.version);
});

test("release evidence requires embedded platform, capture, and project records", async () => {
  const commit = "a".repeat(40);
  const incomplete = validateReleaseEvidence({
    schema_version: "1.0",
    commit_sha: commit,
    platforms: {},
    targets: {},
    projects: [],
  });
  assert.equal(incomplete.passed, false);
  assert.match(incomplete.explicit_non_claim, /release candidate/u);

  const platforms = Object.fromEntries(["linux", "darwin", "win32"].map((name) => [
    name,
    {
      status: "passed",
      commit_sha: commit,
      captured_at: "2026-07-24T00:00:00.000Z",
      workflow_url: `https://example.invalid/workflow/${name}`,
      artifact_sha256: "b".repeat(64),
      record_sha256: "f".repeat(64),
    },
  ]));
  const targets = Object.fromEntries(
    ["web_desktop", "web_mobile", "web_xr", "blender"].map((target) => [
      target,
      {
        target,
        qualified: true,
        report_sha256: "c".repeat(64),
        capture_record_sha256: "d".repeat(64),
        commit_sha: commit,
        artifact_sha256: "b".repeat(64),
      },
    ]),
  );
  const forgedSummary = {
    schema_version: "1.0",
    commit_sha: commit,
    platforms,
    targets,
    projects: [{
      id: "anonymized-project-001",
      data_classification: "anonymized_real_project",
      accepted: true,
      source_manifest_sha256: "d".repeat(64),
      delivery_manifest_sha256: "e".repeat(64),
      acceptance_report_sha256: "f".repeat(64),
      accepted_at: "2026-07-24T00:00:00.000Z",
      approver_id: "product-owner-001",
    }],
  };
  const forged = validateReleaseEvidence({
    ...forgedSummary,
    qualification_bundle_sha256: canonicalJsonSha256(forgedSummary),
  }, { expectedCommit: commit });
  assert.equal(forged.passed, false);
  assert.ok(forged.errors.some((error) =>
    error.code === "release_evidence.target_capture"));

  const budgets = JSON.parse(await readFile(
    new URL("../../config/performance-budgets.json", import.meta.url),
    "utf8",
  ));
  const complete = validateReleaseEvidence(
    completeQualificationEvidence(budgets, commit).bundle,
    { expectedCommit: commit },
  );
  assert.equal(complete.passed, true, JSON.stringify(complete.errors));
});

test("release verifier binds artifact, SBOM, manifest, tag, and preflight results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-release-verify-"));
  try {
    const artifactFile = join(directory, "vr-3d-skill-1.0.0.tgz");
    const sbomFile = join(directory, "vr-3d-skill-1.0.0.sbom.cdx.json");
    const artifactBytes = Buffer.from("artifact\n", "utf8");
    await writeFile(artifactFile, artifactBytes);
    const sbomBody = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "vr-3d-skill",
          version: "1.0.0",
        },
      },
      components: [],
      dependencies: [],
    };
    await writeJson(sbomFile, {
      ...sbomBody,
      document_sha256: canonicalJsonSha256(sbomBody),
    });
    const manifest = {
      schema_version: "1.0",
      package: { name: "vr-3d-skill", version: "1.0.0", private: true },
      source: {
        available: true,
        commit_sha: "a".repeat(40),
        dirty: false,
      },
      artifact: {
        file: "vr-3d-skill-1.0.0.tgz",
        bytes: (await stat(artifactFile)).size,
        sha256: sha256(await readFile(artifactFile)),
        npm_shasum: createHash("sha1").update(artifactBytes).digest("hex"),
        npm_integrity:
          `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`,
      },
      sbom: {
        file: "vr-3d-skill-1.0.0.sbom.cdx.json",
        sha256: sha256(await readFile(sbomFile)),
        document_sha256: canonicalJsonSha256(sbomBody),
        components: 0,
      },
      preflight: {
        security_passed: true,
        doctor_release_ready: true,
        qualification_passed: true,
        clean_worktree: true,
        stable_version: true,
      },
      release_ready: true,
    };
    const manifestFile = join(directory, "release.json");
    await writeJson(manifestFile, {
      ...manifest,
      manifest_sha256: canonicalJsonSha256(manifest),
    });
    const valid = await verifyReleaseManifest(manifestFile, { tag: "v1.0.0" });
    assert.equal(valid.valid, true, JSON.stringify(valid.errors));
    await writeFile(artifactFile, "tampered\n", "utf8");
    const tampered = await verifyReleaseManifest(manifestFile, { tag: "v1.0.0" });
    assert.equal(tampered.valid, false);
    assert.ok(tampered.errors.some((error) => error.code === "release.artifact_hash"));

    const unsafeManifest = {
      ...manifest,
      artifact: {
        ...manifest.artifact,
        file: "../outside.tgz",
      },
    };
    await writeJson(manifestFile, {
      ...unsafeManifest,
      manifest_sha256: canonicalJsonSha256(unsafeManifest),
    });
    const unsafe = await verifyReleaseManifest(manifestFile, { tag: "v1.0.0" });
    assert.equal(unsafe.valid, false);
    assert.ok(unsafe.errors.some((error) => error.code === "release.artifact_missing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release builder produces a hashed candidate package while dirty or unqualified state remains explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-release-build-"));
  try {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const result = await buildRelease(root, directory, { allowDirty: true });
    assert.equal((await stat(result.artifact)).isFile(), true);
    assert.equal((await stat(result.sbomFile)).isFile(), true);
    assert.match(result.manifest.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.manifest.release_ready, false);
    assert.match(result.manifest.explicit_non_claim, /qualification bundle/u);
    assert.match(result.manifest.explicit_non_claim, /prerelease/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { buildGlb } from "../builders/glb-writer.mjs";
import { buildDoctorReport } from "../doctor.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { migrateDocument } from "../migrations/migrate-project.mjs";
import { buildProductionHandlers } from "../orchestration/production-handlers.mjs";
import { auditScenePerformance } from "../performance/audit-scene.mjs";
import { benchmarkCore } from "../performance/benchmark-core.mjs";
import { validateQualificationRecord } from "../performance/validate-qualification.mjs";
import { assembleQualificationBundle } from "../release/assemble-qualification-bundle.mjs";
import { generateSbom } from "../release/generate-sbom.mjs";
import { validateReleaseEvidence } from "../release/validate-release-evidence.mjs";
import { verifyReleaseManifest } from "../release/verify-release.mjs";
import {
  JobRuntimeError,
  JobStore,
} from "../runtime/job-runtime.mjs";
import {
  buildAuditEvent,
  containsUnredactedSecret,
} from "../runtime/redaction.mjs";
import { auditRelease } from "../security/audit-release.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p10-acceptance/fixtures.json", import.meta.url);
const DEFAULT_BUDGETS = new URL("../../config/performance-budgets.json", import.meta.url);
const DEFAULT_P3_FIXTURES = new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url);

function completeDesktopQualification() {
  return {
    schema_version: "1.0",
    qualification_id: "p10-contract-desktop",
    target: "web_desktop",
    execution: {
      status: "executed",
      evidence_kind: "actual_device_capture",
      synthetic: false,
      captured_at: "2026-07-24T00:00:00.000Z",
      operator: "fixture-operator",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
    },
    hardware: {
      manufacturer: "Fixture",
      model: "Fixture workstation",
      device_class: "desktop",
      os: "Fixture OS",
      os_version: "1",
      gpu: "Fixture GPU",
    },
    software: { browser: "Chromium", browser_version: "140" },
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
}

function completeTargetQualification(target) {
  const commit = "a".repeat(40);
  if (target === "blender") {
    return {
      schema_version: "1.0",
      qualification_id: "p10-contract-blender",
      target,
      execution: {
        status: "executed",
        evidence_kind: "actual_device_capture",
        synthetic: false,
        captured_at: "2026-07-24T00:00:00.000Z",
        operator: "fixture-operator",
        commit_sha: commit,
        artifact_sha256: "b".repeat(64),
      },
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
  const record = completeDesktopQualification();
  record.qualification_id = `p10-contract-${target}`;
  record.target = target;
  if (target === "web_mobile") {
    record.hardware.device_class = "mobile";
  } else if (target === "web_xr") {
    record.hardware.device_class = "xr_headset";
    record.measurements.capture_seconds = 120;
    record.measurements.average_fps = 72;
    record.measurements.p95_frame_time_ms = 13;
    Object.assign(record.checks, {
      session_enter: true,
      session_exit: true,
      session_reenter: true,
      tracking_loss_recovery: true,
      controller_reconnect: true,
    });
  }
  return record;
}

function completeReleaseEvidence(budgets) {
  const commit = "a".repeat(40);
  const platformRecords = ["linux", "darwin", "win32"].map((platform) => {
    const body = {
      schema_version: "1.0",
      platform,
      status: "passed",
      commit_sha: commit,
      captured_at: "2026-07-24T00:00:00.000Z",
      workflow_url:
        `https://github.com/keson-skill/VR-3D-Skill/actions/runs/123/${platform}`,
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
  const targetReports = [
    "web_desktop",
    "web_mobile",
    "web_xr",
    "blender",
  ].map((target) => ({
    target,
    report: validateQualificationRecord(
      completeTargetQualification(target),
      budgets,
    ),
  }));
  const project = {
    schema_version: "1.0",
    kind: "real_project_acceptance",
    project_id: "fixture-project",
    data_classification: "anonymized_real_project",
    synthetic: false,
    accepted: true,
    commit_sha: commit,
    source_manifest_sha256: "d".repeat(64),
    delivery_manifest_sha256: "e".repeat(64),
    accepted_at: "2026-07-24T00:00:00.000Z",
    approver_id: "fixture-approver",
    privacy_review: {
      anonymized: true,
      customer_authorized_use: true,
    },
    attestation: {
      method: "interactive_human_review",
      statement: "Fixture acceptance.",
      confirmation_digest: "f".repeat(64),
    },
    notes: "",
  };
  return assembleQualificationBundle({
    commitSha: commit,
    platformRecords,
    targetReports,
    projectAcceptances: [{
      ...project,
      acceptance_report_sha256: canonicalJsonSha256(project),
    }],
  });
}

async function writeDependencyFixture(directory, license = "MIT", secret = null) {
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    dependencies: { fixture: "1.0.0" },
  })}\n`, "utf8");
  await writeFile(join(directory, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { fixture: "1.0.0" } },
      "node_modules/fixture": {
        version: "1.0.0",
        license,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    },
  })}\n`, "utf8");
  await writeFile(
    join(directory, "fixture.mjs"),
    secret ? `export const credential = "${secret}";\n` : "export const ready = true;\n",
    "utf8",
  );
}

async function evaluateFixture(fixture, context) {
  const directory = await mkdtemp(join(tmpdir(), `vr-3d-${fixture.category}-`));
  try {
    if (fixture.category === "job_definition") {
      const store = new JobStore(directory);
      const count = fixture.case === "boundary" ? 100 : 1;
      try {
        await store.create({
          idempotencyKey: `p10-job-definition-${fixture.case}`,
          jobId: `job-definition-${fixture.case}`,
          stages: Array.from({ length: count }, (_, index) => ({
            id: fixture.case === "failure" ? "../unsafe" : `stage-${index + 1}`,
            handler: "fixture",
            parameters: {},
          })),
        });
        return true;
      } catch {
        return false;
      }
    }
    if (fixture.category === "retry_recovery") {
      const store = new JobStore(directory);
      await store.create({
        idempotencyKey: `p10-retry-${fixture.case}`,
        jobId: `job-retry-${fixture.case}`,
        retryPolicy: { max_attempts: 3, base_delay_ms: 0, max_delay_ms: 0 },
        stages: [{ id: "execute", handler: "execute", parameters: {} }],
      });
      let attempts = 0;
      const result = await store.run(`job-retry-${fixture.case}`, {
        wait: async () => {},
        handlers: {
          execute: async () => {
            attempts += 1;
            const failures = fixture.case === "normal" ? 0 : fixture.case === "boundary" ? 2 : 1;
            if (attempts <= failures) {
              throw new JobRuntimeError("fixture_failure", "Fixture failure.", {
                retryable: fixture.case !== "failure",
              });
            }
            return { outputs: { complete: true } };
          },
        },
      });
      return result.job.state === "succeeded";
    }
    if (fixture.category === "audit_redaction") {
      if (fixture.case === "failure") {
        const token = ["ghp", "A".repeat(24)].join("_");
        return !containsUnredactedSecret({ authorization: `Bearer ${token}` });
      }
      const event = buildAuditEvent({
        event: "fixture_event",
        jobId: "job-audit-fixture",
        detail: fixture.case === "boundary"
          ? { local_path: "/Users/customer/private/plan.png", email: "resident@example.com" }
          : { api_key: "fixture-secret-value" },
      });
      return !containsUnredactedSecret(event)
        && !JSON.stringify(event).includes("/Users/customer");
    }
    if (fixture.category === "migration") {
      try {
        const result = migrateDocument(
          fixture.case === "normal"
            ? { schema_version: "0.1", status: "ready", outputDirectory: "runs/job" }
            : fixture.case === "boundary"
              ? { schema_version: "1.0", stage: "prepared", routes: [] }
              : { schema_version: "0.9", project: { id: "protected" }, envelope: { walls: [] } },
        );
        return result.document.schema_version === "1.0";
      } catch {
        return false;
      }
    }
    if (fixture.category === "security_license") {
      const secret = fixture.case === "failure"
        ? ["sk", "live", "Z".repeat(28)].join("-")
        : null;
      await writeDependencyFixture(
        directory,
        fixture.case === "failure" ? "GPL-3.0-only" : "MIT",
        secret,
      );
      const report = await auditRelease(directory, {
        filePaths: ["package.json", "package-lock.json", "fixture.mjs"],
      });
      return report.passed;
    }
    if (fixture.category === "scene_budget") {
      const sceneFile = join(directory, "scene.glb");
      await writeFile(sceneFile, context.glb);
      const budgets = structuredClone(context.budgets);
      if (fixture.case === "boundary") {
        budgets.profiles.web_desktop.max_glb_bytes = context.glb.length;
      } else if (fixture.case === "failure") {
        budgets.profiles.web_desktop.max_glb_bytes = context.glb.length - 1;
      }
      return (await auditScenePerformance(
        sceneFile,
        null,
        budgets,
        "web_desktop",
      )).passed;
    }
    if (fixture.category === "device_qualification") {
      const record = completeDesktopQualification();
      if (fixture.case === "boundary") {
        record.measurements.average_fps = context.budgets.profiles.web_desktop.minimum_fps;
        record.measurements.p95_frame_time_ms =
          context.budgets.profiles.web_desktop.max_p95_frame_time_ms;
      } else if (fixture.case === "failure") {
        record.execution.synthetic = true;
      }
      return validateQualificationRecord(record, context.budgets).qualified;
    }
    if (fixture.category === "release_evidence") {
      const bundle = completeReleaseEvidence(context.budgets);
      if (fixture.case === "failure") bundle.platforms.win32.status = "pending";
      if (fixture.case === "boundary") bundle.projects = [bundle.projects[0]];
      return validateReleaseEvidence(bundle, { expectedCommit: bundle.commit_sha }).passed;
    }
    if (fixture.category === "release_manifest") {
      const artifact = join(directory, "artifact.tgz");
      const sbom = join(directory, "sbom.json");
      const artifactBytes = Buffer.from("artifact\n", "utf8");
      await writeFile(artifact, artifactBytes);
      const sbomBody = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          component: {
            type: "application",
            name: "fixture",
            version: "1.0.0",
          },
        },
        components: [],
        dependencies: [],
      };
      await writeJson(sbom, {
        ...sbomBody,
        document_sha256: canonicalJsonSha256(sbomBody),
      });
      const manifest = {
        schema_version: "1.0",
        package: { name: "fixture", version: "1.0.0" },
        source: {
          available: true,
          commit_sha: "a".repeat(40),
          dirty: false,
        },
        artifact: {
          file: "artifact.tgz",
          bytes: (await readFile(artifact)).length,
          sha256: sha256(await readFile(artifact)),
          npm_shasum: createHash("sha1").update(artifactBytes).digest("hex"),
          npm_integrity:
            `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`,
        },
        sbom: {
          file: "sbom.json",
          sha256: sha256(await readFile(sbom)),
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
      if (fixture.case === "failure") await writeFile(artifact, "tampered\n", "utf8");
      return (await verifyReleaseManifest(
        manifestFile,
        { tag: fixture.case === "boundary" ? null : "v1.0.0" },
      )).valid;
    }
    if (fixture.category === "handler_registry") {
      const handlers = buildProductionHandlers();
      if (fixture.case === "normal") {
        return ["prepare_interior_job", "validate_spatial", "await_spatial_approval"]
          .every((handler) => typeof handlers[handler] === "function");
      }
      if (fixture.case === "boundary") {
        return Object.keys(handlers).every((handler) => !handler.includes("shell"));
      }
      return typeof handlers.shell === "function";
    }
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runP10Acceptance({
  fixturesFile = DEFAULT_FIXTURES,
  qualificationBundle = null,
  codeOnly = false,
  rootDirectory = fileURLToPath(new URL("../..", import.meta.url)),
} = {}) {
  const [suite, budgets, p3Suite, packageJson, lock] = await Promise.all([
    readFile(fixturesFile, "utf8").then(JSON.parse),
    readFile(DEFAULT_BUDGETS, "utf8").then(JSON.parse),
    readFile(DEFAULT_P3_FIXTURES, "utf8").then(JSON.parse),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 30) {
    throw new Error("P10 code acceptance requires at least 30 fixtures.");
  }
  const spatial = p3Suite.fixtures[0].spatial;
  const context = {
    budgets,
    glb: buildGlb(spatial, compileScenePrimitives(spatial)),
  };
  const samples = [];
  for (const fixture of suite.fixtures) {
    let actualValid = false;
    let error = null;
    try {
      actualValid = await evaluateFixture(fixture, context);
    } catch (caught) {
      error = caught.message;
    }
    samples.push({
      id: fixture.id,
      category: fixture.category,
      case: fixture.case,
      expected_valid: fixture.expected_valid,
      actual_valid: actualValid,
      passed: actualValid === fixture.expected_valid,
      error,
    });
  }
  const [security, benchmark, doctor] = await Promise.all([
    auditRelease(resolve(rootDirectory)),
    benchmarkCore(DEFAULT_P3_FIXTURES, { iterations: 2 }),
    buildDoctorReport(),
  ]);
  const sbom = generateSbom(packageJson, lock);
  const categoryCounts = Object.fromEntries(
    [...new Set(samples.map((sample) => sample.category))].map((category) => [
      category,
      samples.filter((sample) => sample.category === category).length,
    ]),
  );
  const aggregate = {
    fixture_count: samples.length,
    categories: Object.keys(categoryCounts).length,
    category_counts: categoryCounts,
    fixture_errors: samples.filter((sample) => !sample.passed).length,
    security_blockers: security.aggregate.blockers,
    benchmark_passed: benchmark.passed,
    doctor_release_ready: doctor.capabilities.release_tooling,
    sbom_components: sbom.components.length,
  };
  const codePassed =
    aggregate.fixture_count >= 30
    && aggregate.categories >= 10
    && Object.values(categoryCounts).every((count) => count >= 3)
    && aggregate.fixture_errors === 0
    && security.passed
    && benchmark.passed
    && doctor.capabilities.release_tooling
    && sbom.components.length >= Object.keys(packageJson.dependencies || {}).length;
  const qualification = qualificationBundle
    ? validateReleaseEvidence(qualificationBundle)
    : {
        passed: false,
        errors: [{ code: "release_evidence.missing", message: "No release qualification bundle was supplied." }],
        report_sha256: null,
        explicit_non_claim: "Physical/cross-platform release qualification is pending.",
      };
  const passed = codePassed && (codeOnly || qualification.passed);
  const report = {
    schema_version: "1.0",
    stage: "P10",
    acceptance_scope: codeOnly ? "code_only" : "full_release",
    passed,
    code_passed: codePassed,
    release_qualified: qualification.passed,
    stage_status_recommendation:
      codePassed && qualification.passed ? "COMPLETED" : "ACCEPTANCE",
    aggregate,
    samples,
    evidence: {
      security_report_sha256: security.report_sha256,
      benchmark_report_sha256: benchmark.report_sha256,
      sbom_document_sha256: sbom.document_sha256,
      qualification_report_sha256: qualification.report_sha256,
    },
    qualification_errors: qualification.errors || [],
    explicit_non_claim:
      qualification.passed
        ? null
        : "P10 code is accepted, but production release remains unqualified until Windows/macOS/Linux, desktop/mobile/XR/Blender, and anonymized real-project evidence all pass.",
  };
  return {
    ...report,
    report_sha256: canonicalJsonSha256(report),
    security,
    benchmark,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    qualification: { type: "string" },
    output: { type: "string", default: "examples/p10-acceptance/automated-evidence.json" },
    "code-only": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/validation/run-p10-acceptance.mjs [--code-only] [--qualification bundle.json] [--output report.json]\n");
    return;
  }
  const qualificationBundle = options.qualification
    ? await readJson(
        options.qualification,
        "release qualification bundle",
        { maxBytes: 64 * 1024 * 1024 },
      )
    : null;
  const result = await runP10Acceptance({
    fixturesFile: options.fixtures || DEFAULT_FIXTURES,
    qualificationBundle,
    codeOnly: options["code-only"],
  });
  const { security, benchmark, ...report } = result;
  await writeJson(options.output, report);
  const evidenceDirectory = dirname(resolve(options.output));
  const outputName = basename(options.output, extname(options.output));
  const prefix = outputName === "automated-evidence" ? "" : `${outputName}-`;
  await writeJson(
    join(evidenceDirectory, `${prefix}security-audit.json`),
    security,
  );
  await writeJson(
    join(evidenceDirectory, `${prefix}core-benchmark.json`),
    benchmark,
  );
  printJson({
    outputFile: options.output,
    passed: report.passed,
    codePassed: report.code_passed,
    releaseQualified: report.release_qualified,
    stageStatusRecommendation: report.stage_status_recommendation,
    aggregate: report.aggregate,
  });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

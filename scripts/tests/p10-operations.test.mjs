import assert from "node:assert/strict";
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
import { buildDoctorReport } from "../doctor.mjs";
import {
  migrateDocument,
  migrateFile,
} from "../migrations/migrate-project.mjs";
import { runTool } from "../ingest/tool-runner.mjs";
import { computeJobDefinitionSha256 } from "../runtime/job-runtime.mjs";

test("bounded tool runner enforces output and timeout limits without a shell", async () => {
  await assert.rejects(
    runTool(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      { timeoutMs: 5000, maxOutputBytes: 1024 },
    ),
    /1024-byte output limit/u,
  );
  await assert.rejects(
    runTool(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 25, maxOutputBytes: 1024 },
    ),
    /exceeded 25 ms/u,
  );
});

test("doctor reports supported host, lockfile consistency, capabilities, and credential booleans only", async () => {
  const report = await buildDoctorReport();
  assert.equal(report.host.supported_platform, true);
  assert.equal(report.node.available, true);
  assert.equal(report.manifests.available, true, JSON.stringify(report.manifests));
  assert.equal(report.capabilities.core_spatial, true);
  assert.equal(report.capabilities.release_tooling, true);
  assert.equal(
    Object.values(report.provider_credentials_configured).every((value) => typeof value === "boolean"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(report), /Bearer\s+|PRIVATE KEY/u);
});

test("migration registry upgrades legacy prepared jobs without mutating the source in dry-run mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-migration-"));
  try {
    const input = join(directory, "job.json");
    const output = join(directory, "job-migrated.json");
    const legacy = {
      schema_version: "0.1",
      status: "ready",
      outputDirectory: "runs/job-001",
      sourceManifest: "runs/job-001/source-manifest.json",
      routes: [],
    };
    await writeFile(input, `${JSON.stringify(legacy)}\n`, "utf8");
    const dryRun = await migrateFile(input);
    assert.equal(dryRun.report.applied, false);
    assert.equal(dryRun.document.schema_version, "1.0");
    assert.deepEqual(JSON.parse(await readFile(input, "utf8")), legacy);

    const applied = await migrateFile(input, { outputFile: output, apply: true });
    assert.equal(applied.report.applied, true);
    assert.equal((await stat(output)).isFile(), true);
    const migrated = JSON.parse(await readFile(output, "utf8"));
    assert.equal(migrated.stage, "prepared");
    assert.equal(migrated.output_directory, "runs/job-001");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime migration blocks active legacy jobs for review and refuses protected or future schemas", () => {
  const migrated = migrateDocument({
    schema_version: "0.9",
    job_id: "job-legacy-001",
    kind: "interior_pipeline",
    status: "active",
    stages: [{ name: "prepare", handler: "prepare_interior_job", status: "pending" }],
  });
  assert.equal(migrated.document.state, "blocked");
  assert.equal(migrated.document.metadata.migration_review_required, true);
  assert.equal(
    migrated.document.definition_sha256,
    computeJobDefinitionSha256({
      kind: migrated.document.kind,
      stages: migrated.document.stages,
      retryPolicy: migrated.document.retry_policy,
      metadata: migrated.document.metadata,
    }),
  );
  assert.throws(
    () => migrateDocument({
      schema_version: "0.9",
      project: { id: "protected" },
      envelope: { walls: [] },
    }),
    /never auto-migrated/u,
  );
  assert.throws(
    () => migrateDocument({
      schema_version: "2.0",
      status: "ready",
      outputDirectory: "runs/future",
    }),
    /No migration path/u,
  );
  assert.throws(
    () => migrateDocument({
      schema_version: "0.9",
      job_id: "job-legacy-secret-001",
      stages: [{
        id: "provider",
        handler: "provider",
        parameters: { api_key: "must-not-migrate" },
      }],
    }),
    /credential-like parameters/u,
  );
  const completed = migrateDocument({
    schema_version: "0.9",
    job_id: "job-legacy-complete-001",
    status: "complete",
    stages: [{ id: "prepare", handler: "prepare", status: "complete" }],
  });
  assert.equal(completed.document.state, "blocked");
  assert.equal(completed.document.last_error.code, "migration_review_required");
});

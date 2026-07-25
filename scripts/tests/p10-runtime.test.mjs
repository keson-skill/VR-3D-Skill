import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  JobPauseError,
  JobRuntimeError,
  JobStore,
} from "../runtime/job-runtime.mjs";
import {
  buildAuditEvent,
  containsUnredactedSecret,
  redactValue,
} from "../runtime/redaction.mjs";
import { validateProductionJobSchema } from "../validation/json-schema.mjs";
import {
  assertWorkspaceDestination,
  validateProductionStages,
} from "../orchestration/production-handlers.mjs";

test("production job schema allows only registered handlers and bounded definitions", () => {
  const valid = validateProductionJobSchema({
    schema_version: "1.0",
    job_id: "job-schema-001",
    idempotency_key: "request-schema-001",
    kind: "interior_pipeline",
    retry_policy: { max_attempts: 3, base_delay_ms: 250, max_delay_ms: 10000 },
    metadata: { project_id: "project-001" },
    stages: [{
      id: "prepare",
      handler: "prepare_interior_job",
      parameters: {
        inputs: [{ path: "inputs/plan.png" }],
        output_directory: "runs/project-001/input",
      },
    }],
  });
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const unsafe = validateProductionJobSchema({
    schema_version: "1.0",
    idempotency_key: "request-schema-unsafe",
    stages: [{ id: "unsafe", handler: "shell", parameters: { command: "whoami" } }],
  });
  assert.equal(unsafe.valid, false);
  assert.ok(unsafe.errors.some((error) => error.path === "/stages/0/handler"));
  const parameters = validateProductionStages([{
    id: "approval",
    handler: "await_spatial_approval",
    parameters: { spatial_json: "spatial.json" },
  }]);
  assert.equal(parameters.valid, false);
  assert.ok(parameters.errors.some((error) =>
    error.path.endsWith("/approval_trust")));
  const renderParameters = validateProductionStages([{
    id: "render",
    handler: "render_blender",
    parameters: {
      spatial_json: "spatial.json",
      source_manifest: "source-manifest.json",
      validation_report: "validation.json",
      approval: "approval.json",
      approval_trust: "approval-trust.json",
      scene: "scene.glb",
      output_directory: "render",
    },
  }]);
  assert.equal(renderParameters.valid, false);
  assert.ok(renderParameters.errors.some((error) =>
    error.path.endsWith("/scene_manifest")));
  const escapedOutput = validateProductionStages([{
    id: "validate",
    handler: "validate_spatial",
    parameters: {
      input: "runs/project/spatial.json",
      output: "../outside.json",
    },
  }], { workspaceRoot: "runs" });
  assert.equal(escapedOutput.valid, false);
  assert.ok(escapedOutput.errors.some((error) =>
    error.code === "production.output_workspace"));
});

test("production workspace rejects symbolic-link output traversal", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "vr-3d-p10-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "vr-3d-p10-workspace-outside-"));
  try {
    try {
      await symlink(outside, join(workspace, "linked"), "dir");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      context.diagnostic("Directory symlink test is unavailable on this host.");
      return;
    }
    await assert.rejects(
      assertWorkspaceDestination(
        workspace,
        join(workspace, "linked", "output.json"),
        "fixture.output",
      ),
      /symbolic link/u,
    );
    const outputDirectory = join(workspace, "existing-output");
    await mkdir(outputDirectory);
    await symlink(outside, join(outputDirectory, "nested-link"), "dir");
    await assert.rejects(
      assertWorkspaceDestination(
        workspace,
        outputDirectory,
        "fixture.output_directory",
        { directoryOutput: true },
      ),
      /contains a symbolic link/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("production runtime refuses credentials in persisted definitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-credential-definition-"));
  try {
    const store = new JobStore(directory);
    await assert.rejects(
      store.create({
        idempotencyKey: "credential-job-0001",
        jobId: "job-credential-001",
        stages: [{
          id: "prepare",
          handler: "fixture",
          parameters: { nested: { api_key: "must-not-be-persisted" } },
        }],
      }),
      /must not contain credentials/u,
    );
    await assert.rejects(
      store.create({
        idempotencyKey: "invalid-retry-job-0001",
        jobId: "job-invalid-retry-001",
        retryPolicy: { max_attempts: Number.NaN },
        stages: [{ id: "prepare", handler: "fixture", parameters: {} }],
      }),
      /must be a safe integer/u,
    );
    await assert.rejects(
      store.create({
        idempotencyKey: "reserved-job-name-0001",
        jobId: "CON",
        stages: [{ id: "prepare", handler: "fixture", parameters: {} }],
      }),
      /URL-safe characters/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime enforces idempotency and rejects definition conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-idempotency-"));
  try {
    const store = new JobStore(directory);
    const definition = {
      idempotencyKey: "customer-request-0001",
      jobId: "job-idempotency-001",
      stages: [{ id: "prepare", handler: "fixture", parameters: { input_hash: "a".repeat(64) } }],
    };
    const first = await store.create(definition);
    const second = await store.create({ ...definition, jobId: "job-ignored-002" });
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.job.job_id, first.job.job_id);
    await assert.rejects(
      store.create({
        ...definition,
        stages: [{ id: "prepare", handler: "different", parameters: {} }],
      }),
      (error) => error.code === "idempotency_conflict",
    );
    await assert.rejects(
      store.create({
        ...definition,
        metadata: { project_id: "different-request" },
      }),
      (error) => error.code === "idempotency_conflict",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime never overwrites a job ID owned by another idempotency key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-job-id-conflict-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "customer-request-owner-0001",
      jobId: "job-owned-001",
      metadata: { project_id: "original-project" },
      stages: [{ id: "prepare", handler: "fixture", parameters: { input_hash: "a".repeat(64) } }],
    });
    await assert.rejects(
      store.create({
        idempotencyKey: "customer-request-other-0002",
        jobId: "job-owned-001",
        metadata: { project_id: "replacement-project" },
        stages: [{ id: "prepare", handler: "fixture", parameters: { input_hash: "b".repeat(64) } }],
      }),
      (error) => error.code === "job_id_conflict",
    );
    const original = await store.get("job-owned-001");
    assert.equal(original.metadata.project_id, "original-project");
    assert.equal(
      original.idempotency_key_sha256,
      "67e73d7f3e49dfe869c6296879467af89e81d0f2dbd6f0d33b47cbc01df99b09",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime recovers a lock-free running record after an interrupted worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-worker-recovery-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "interrupted-worker-job-0001",
      jobId: "job-worker-recovery-001",
      stages: [{ id: "prepare", handler: "prepare", parameters: {} }],
    });
    const interrupted = await store.get("job-worker-recovery-001");
    interrupted.state = "running";
    interrupted.current_stage = "prepare";
    interrupted.stages[0].status = "running";
    interrupted.stages[0].attempts = 1;
    await writeFile(
      join(directory, "jobs", "job-worker-recovery-001", "job.json"),
      `${JSON.stringify(interrupted)}\n`,
      "utf8",
    );
    const recovered = await store.run("job-worker-recovery-001", {
      handlers: {
        prepare: async () => ({ outputs: { recovered: true } }),
      },
    });
    assert.equal(recovered.job.state, "succeeded");
    assert.equal(recovered.job.stages[0].attempts, 2);
    const events = await readFile(
      join(directory, "jobs", "job-worker-recovery-001", "events.jsonl"),
      "utf8",
    );
    assert.match(events, /"event":"job_recovered"/u);
    assert.equal((await store.verify("job-worker-recovery-001")).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime blocks credential-like handler results before checkpointing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-result-redaction-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "unsafe-result-job-0001",
      jobId: "job-unsafe-result-001",
      stages: [{ id: "provider", handler: "provider", parameters: {} }],
    });
    const result = await store.run("job-unsafe-result-001", {
      handlers: {
        provider: async () => ({
          outputs: { api_key: "provider-credential-that-must-not-persist" },
        }),
      },
    });
    assert.equal(result.job.state, "failed");
    assert.equal(result.job.last_error.code, "unsafe_stage_result");
    const persisted = await readFile(
      join(directory, "jobs", "job-unsafe-result-001", "job.json"),
      "utf8",
    );
    const events = await readFile(
      join(directory, "jobs", "job-unsafe-result-001", "events.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(
      `${persisted}\n${events}`,
      /provider-credential-that-must-not-persist/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime records cooperative cancellation while a stage is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-active-cancel-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "active-cancel-job-0001",
      jobId: "job-active-cancel-001",
      stages: [{ id: "render", handler: "render", parameters: {} }],
    });
    let signalStarted;
    let releaseHandler;
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const running = store.run("job-active-cancel-001", {
      handlers: {
        render: async () => {
          signalStarted();
          await handlerGate;
          return { outputs: { render: "should-not-checkpoint" } };
        },
      },
    });
    await started;
    const requested = await store.cancel(
      "job-active-cancel-001",
      "operator_cancelled_active_render",
    );
    assert.equal(requested.cancellation_pending, true);
    releaseHandler();
    const cancelled = await running;
    assert.equal(cancelled.job.state, "cancelled");
    assert.equal(cancelled.job.stages[0].status, "cancelled");
    assert.equal(cancelled.job.stages[0].checkpoint, null);
    assert.equal((await store.verify("job-active-cancel-001")).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime never deletes a lock that changed ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-lock-owner-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "lock-owner-job-0001",
      jobId: "job-lock-owner-001",
      stages: [{ id: "render", handler: "render", parameters: {} }],
    });
    let signalStarted;
    let releaseHandler;
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const running = store.run("job-lock-owner-001", {
      handlers: {
        render: async () => {
          signalStarted();
          await handlerGate;
          return { outputs: { rendered: true } };
        },
      },
    });
    await started;
    const lockFile = join(
      directory,
      "jobs",
      "job-lock-owner-001",
      "run.lock",
    );
    const replacement = "999999\n2026-07-24T00:00:00.000Z\n00000000-0000-4000-8000-000000000000\n";
    await writeFile(lockFile, replacement, "utf8");
    releaseHandler();
    const completed = await running;
    assert.equal(completed.job.state, "succeeded");
    assert.equal(await readFile(lockFile, "utf8"), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime retries transient failures, checkpoints stages, and verifies its audit chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-retry-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "retryable-job-0001",
      jobId: "job-retry-001",
      retryPolicy: { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 2 },
      stages: [
        { id: "prepare", handler: "prepare", parameters: {} },
        { id: "compile", handler: "compile", parameters: {} },
      ],
    });
    let compileAttempts = 0;
    const result = await store.run("job-retry-001", {
      wait: async () => {},
      handlers: {
        prepare: async () => ({
          outputs: { manifest: "runs/job/source-manifest.json" },
          hashes: { manifest: "a".repeat(64) },
        }),
        compile: async () => {
          compileAttempts += 1;
          if (compileAttempts === 1) {
            throw new JobRuntimeError("provider_timeout", "Provider timed out.", {
              retryable: true,
            });
          }
          return {
            outputs: { scene: "runs/job/scene.glb" },
            request_id: "request-001",
            model: "gpt-5.5",
            hashes: { scene: "b".repeat(64) },
          };
        },
      },
    });
    assert.equal(result.job.state, "succeeded");
    assert.equal(result.job.stages[0].attempts, 1);
    assert.equal(result.job.stages[1].attempts, 2);
    assert.equal(compileAttempts, 2);
    assert.equal((await store.verify("job-retry-001")).valid, true);
    const reused = await store.run("job-retry-001", { handlers: {} });
    assert.equal(reused.reused, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual rerun of an exhausted failed stage never falls through to success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-exhausted-retry-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "exhausted-retry-job-0001",
      jobId: "job-exhausted-retry-001",
      retryPolicy: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 },
      stages: [{ id: "provider", handler: "provider", parameters: {} }],
    });
    const handlers = {
      provider: async () => {
        throw new JobRuntimeError("provider_unavailable", "Still unavailable.", {
          retryable: true,
        });
      },
    };
    const first = await store.run("job-exhausted-retry-001", { handlers });
    const second = await store.run("job-exhausted-retry-001", { handlers });
    assert.equal(first.job.state, "failed");
    assert.equal(second.job.state, "failed");
    assert.equal(second.job.stages[0].attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job runtime pauses for approval and resumes only the incomplete stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-pause-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "approval-job-0001",
      jobId: "job-approval-001",
      stages: [
        { id: "prepare", handler: "prepare", parameters: {} },
        { id: "approval", handler: "approval", parameters: {} },
      ],
    });
    let approved = false;
    let preparationRuns = 0;
    const handlers = {
      prepare: async () => {
        preparationRuns += 1;
        return { outputs: { prepared: true } };
      },
      approval: async () => {
        if (!approved) {
          throw new JobPauseError(
            "human_approval_required",
            "Independent Spatial approval is required.",
            { state: "awaiting_approval" },
          );
        }
        return { outputs: { approved: true } };
      },
    };
    const paused = await store.run("job-approval-001", { handlers });
    assert.equal(paused.job.state, "awaiting_approval");
    approved = true;
    const completed = await store.run("job-approval-001", { handlers });
    assert.equal(completed.job.state, "succeeded");
    assert.equal(preparationRuns, 1);
    assert.equal(completed.job.stages[1].attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit redaction removes secrets, paths, and personal contact data", () => {
  const redacted = redactValue({
    api_key: "sk-example-secret-1234567890",
    authorization: "Bearer fixture-token-value-123456789",
    email: "resident@example.com",
    local_path: "/Users/resident/projects/private/plan.png",
    safe: "stage-ready",
  });
  assert.equal(redacted.api_key, "[REDACTED_SECRET]");
  assert.equal(redacted.authorization, "[REDACTED_SECRET]");
  assert.equal(redacted.email, "[REDACTED_CUSTOMER_DATA]");
  assert.equal(redacted.local_path, "[REDACTED_CUSTOMER_DATA]");
  assert.equal(redacted.safe, "stage-ready");
  const event = buildAuditEvent({
    event: "stage_failed",
    jobId: "job-redaction-001",
    error: new Error("Cannot read /Users/resident/private/plan.png for resident@example.com"),
    detail: { api_key: "sk-example-secret-1234567890" },
  });
  assert.equal(containsUnredactedSecret(event), false);
  assert.doesNotMatch(JSON.stringify(event), /resident@example\.com|Users\/resident|top-secret/u);
});

test("job verification detects checkpoint and audit tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-tamper-"));
  try {
    const store = new JobStore(directory);
    await store.create({
      idempotencyKey: "tamper-job-0001",
      jobId: "job-tamper-001",
      stages: [{ id: "prepare", handler: "prepare", parameters: {} }],
    });
    await store.run("job-tamper-001", {
      handlers: { prepare: async () => ({ outputs: { prepared: true } }) },
    });
    const job = await store.get("job-tamper-001");
    const checkpoint = join(
      directory,
      "jobs",
      "job-tamper-001",
      job.stages[0].checkpoint.file,
    );
    await writeFile(checkpoint, "{}\n", "utf8");
    const eventsFile = join(directory, "jobs", "job-tamper-001", "events.jsonl");
    const events = await readFile(eventsFile, "utf8");
    await writeFile(eventsFile, events.replace("job_succeeded", "job_success_tampered"), "utf8");
    job.stages[0].parameters.tampered = true;
    await writeFile(
      join(directory, "jobs", "job-tamper-001", "job.json"),
      `${JSON.stringify(job)}\n`,
      "utf8",
    );
    const verification = await store.verify("job-tamper-001");
    assert.equal(verification.valid, false);
    assert.ok(verification.errors.some((error) => error.code === "job.parameters_hash"));
    assert.ok(verification.errors.some((error) => error.code === "job.checkpoint_hash"));
    assert.ok(verification.errors.some((error) => error.code === "job.audit_hash"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

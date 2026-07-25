import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  buildAuditEvent,
  containsCredentialField,
  containsUnredactedSecret,
  sanitizeError,
} from "./redaction.mjs";
import {
  canonicalJsonSha256,
  sha256,
} from "../lib/cli.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const STAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const TERMINAL_STATES = new Set(["succeeded", "cancelled"]);
const RUNNABLE_STATES = new Set([
  "queued",
  "running",
  "failed",
  "blocked",
  "awaiting_approval",
]);
const TRANSITIONS = new Map([
  ["queued", new Set(["running", "cancelled"])],
  ["running", new Set(["succeeded", "failed", "blocked", "awaiting_approval", "cancelled"])],
  ["failed", new Set(["running", "cancelled"])],
  ["blocked", new Set(["running", "cancelled"])],
  ["awaiting_approval", new Set(["running", "cancelled"])],
  ["succeeded", new Set()],
  ["cancelled", new Set()],
]);

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function idempotencyHash(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 512) {
    throw new Error("idempotencyKey must contain 8 to 512 characters.");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function assertJobId(jobId) {
  const windowsStem = String(jobId).split(".")[0].toUpperCase();
  if (
    !JOB_ID_PATTERN.test(jobId)
    || jobId.endsWith(".")
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsStem)
  ) {
    throw new Error("jobId must be 3 to 80 URL-safe characters.");
  }
}

function checkpointRelativePath(stageId) {
  return `checkpoints/stage-${sha256(Buffer.from(stageId, "utf8")).slice(0, 24)}.json`;
}

function resolveCheckpointPath(directory, stage) {
  const expected = checkpointRelativePath(stage.id);
  if (stage.checkpoint?.file !== expected) {
    throw new JobRuntimeError(
      "unsafe_checkpoint_path",
      `Checkpoint path for stage ${stage.id} is invalid.`,
    );
  }
  return join(directory, expected);
}

function assertJsonSize(value, label, maximumBytes = 1024 * 1024) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable.`);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
  return serialized;
}

function normalizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > 100) {
    throw new Error("A job requires 1 to 100 stages.");
  }
  const ids = new Set();
  return stages.map((stage, index) => {
    if (!STAGE_ID_PATTERN.test(stage?.id || "")) {
      throw new Error(`Stage ${index + 1} has an invalid stable ID.`);
    }
    if (ids.has(stage.id)) throw new Error(`Duplicate stage ID ${stage.id}.`);
    ids.add(stage.id);
    if (!STAGE_ID_PATTERN.test(stage.handler || "")) {
      throw new Error(`Stage ${stage.id} has an invalid handler ID.`);
    }
    if (containsCredentialField(stage.parameters || {})) {
      throw new Error(`Stage ${stage.id} parameters must not contain credentials.`);
    }
    assertJsonSize(stage.parameters || {}, `Stage ${stage.id} parameters`, 256 * 1024);
    return {
      id: stage.id,
      handler: stage.handler,
      parameters: structuredClone(stage.parameters || {}),
      parameters_sha256: canonicalJsonSha256(stage.parameters || {}),
      status: "pending",
      attempts: 0,
      started_at: null,
      completed_at: null,
      duration_ms: null,
      checkpoint: null,
      outputs: null,
      error: null,
    };
  });
}

export function normalizeJobRetryPolicy(retryPolicy = {}) {
  if (!retryPolicy || typeof retryPolicy !== "object" || Array.isArray(retryPolicy)) {
    throw new Error("retryPolicy must be an object.");
  }
  const values = {
    max_attempts: retryPolicy.max_attempts ?? 3,
    base_delay_ms: retryPolicy.base_delay_ms ?? 250,
    max_delay_ms: retryPolicy.max_delay_ms ?? 10000,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`retryPolicy.${name} must be a safe integer.`);
    }
  }
  return {
    max_attempts: Math.max(1, Math.min(10, values.max_attempts)),
    base_delay_ms: Math.max(0, Math.min(60000, values.base_delay_ms)),
    max_delay_ms: Math.max(0, Math.min(300000, values.max_delay_ms)),
  };
}

export function computeJobDefinitionSha256({
  kind,
  stages,
  retryPolicy,
  metadata,
}) {
  return canonicalJsonSha256({
    kind,
    retry_policy: retryPolicy,
    metadata,
    stages: stages.map(({ id, handler, parameters_sha256 }) => ({
      id,
      handler,
      parameters_sha256,
    })),
  });
}

async function readJsonFile(filePath, label) {
  const { bytes } = await readBoundedFile(filePath, {
    label,
    maxBytes: 4 * MiB,
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

async function atomicWriteJson(filePath, value) {
  const serialized = `${assertJsonSize(value, basename(filePath), 4 * 1024 * 1024)}\n`;
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function acquireLock(
  lockFile,
  {
    timeoutMs = 10000,
    staleMs = 15 * 60 * 1000,
  } = {},
) {
  const started = Date.now();
  while (true) {
    try {
      const ownerToken = randomUUID();
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(
          `${process.pid}\n${new Date().toISOString()}\n${ownerToken}\n`,
        );
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockFile).catch(() => {});
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => {});
      }, Math.max(1000, Math.min(60000, Math.floor(staleMs / 3))));
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await handle.close();
        try {
          const current = await readBoundedFile(lockFile, {
            label: "Runtime lock",
            maxBytes: 4096,
          });
          const currentOwner = current.bytes.toString("utf8").split(/\r?\n/u)[2];
          if (currentOwner === ownerToken) {
            await unlink(lockFile).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        } catch {
          // An absent, altered or unsafe lock is deliberately not deleted by
          // path alone; only the matching owner token authorizes removal.
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const observed = await readBoundedFile(lockFile, {
          label: "Runtime lock",
          maxBytes: 4096,
        });
        const observedOwner = observed.bytes.toString("utf8").split(/\r?\n/u)[2];
        if (
          /^[a-f0-9-]{36}$/u.test(observedOwner || "")
          && Date.now() - observed.metadata.mtimeMs > staleMs
        ) {
          const confirmed = await readBoundedFile(lockFile, {
            label: "Runtime lock",
            maxBytes: 4096,
          });
          if (
            confirmed.metadata.mtimeMs === observed.metadata.mtimeMs
            && confirmed.bytes.equals(observed.bytes)
          ) {
            await unlink(lockFile);
            continue;
          }
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        // A just-created, altered or unsafe lock is not a stale-lock
        // candidate. Wait for its owner or for the normal timeout.
      }
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`Timed out waiting for runtime lock ${basename(lockFile)}.`);
        timeout.code = "RUNTIME_LOCK_TIMEOUT";
        throw timeout;
      }
      await sleep(25);
    }
  }
}

function transition(job, nextState) {
  if (job.state === nextState) return;
  if (!TRANSITIONS.get(job.state)?.has(nextState)) {
    throw new Error(`Illegal job transition ${job.state} -> ${nextState}.`);
  }
  job.state = nextState;
  job.updated_at = new Date().toISOString();
  job.revision += 1;
}

function retryDelay(policy, attempt) {
  const base = policy.base_delay_ms;
  const exponential = base * (2 ** Math.max(0, attempt - 1));
  return Math.min(policy.max_delay_ms, exponential);
}

export class JobRuntimeError extends Error {
  constructor(code, message, { retryable = false, detail = null } = {}) {
    super(message);
    this.name = "JobRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export class JobPauseError extends JobRuntimeError {
  constructor(code, message, { state = "blocked", detail = null } = {}) {
    if (!["blocked", "awaiting_approval"].includes(state)) {
      throw new Error("Pause state must be blocked or awaiting_approval.");
    }
    super(code, message, { retryable: false, detail });
    this.pauseState = state;
  }
}

export class JobStore {
  constructor(rootDirectory) {
    this.root = resolve(rootDirectory);
    this.jobsDirectory = join(this.root, "jobs");
    this.idempotencyDirectory = join(this.root, "idempotency");
  }

  async initialize() {
    await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.idempotencyDirectory, { recursive: true, mode: 0o700 });
  }

  jobDirectory(jobId) {
    assertJobId(jobId);
    return join(this.jobsDirectory, jobId);
  }

  async create({
    idempotencyKey,
    kind = "interior_pipeline",
    stages,
    jobId = `job-${randomUUID()}`,
    retryPolicy = {},
    metadata = {},
  }) {
    await this.initialize();
    assertJobId(jobId);
    if (!STAGE_ID_PATTERN.test(kind)) throw new Error("Job kind is invalid.");
    const normalizedStages = normalizeStages(stages);
    if (containsCredentialField(metadata)) {
      throw new Error("Job metadata must not contain credentials.");
    }
    assertJsonSize(metadata, "Job metadata", 256 * 1024);
    const policy = normalizeJobRetryPolicy(retryPolicy);
    const keyHash = idempotencyHash(idempotencyKey);
    const definitionHash = computeJobDefinitionSha256({
      kind,
      stages: normalizedStages,
      retryPolicy: policy,
      metadata,
    });
    const idempotencyFile = join(this.idempotencyDirectory, `${keyHash}.json`);
    const release = await acquireLock(`${idempotencyFile}.lock`);
    try {
      try {
        const existing = await readJsonFile(idempotencyFile, "Idempotency record");
        const job = await this.get(existing.job_id);
        if (existing.definition_sha256 !== definitionHash) {
          throw new JobRuntimeError(
            "idempotency_conflict",
            "The idempotency key is already bound to a different job definition.",
          );
        }
        return { job, reused: true };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const directory = this.jobDirectory(jobId);
      const now = new Date().toISOString();
      const job = {
        schema_version: "1.0",
        job_id: jobId,
        kind,
        state: "queued",
        revision: 1,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
        idempotency_key_sha256: keyHash,
        definition_sha256: definitionHash,
        retry_policy: policy,
        metadata: structuredClone(metadata),
        current_stage: null,
        stages: normalizedStages,
        audit_head_sha256: null,
        last_error: null,
      };
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let existingJob;
        try {
          existingJob = await this.get(jobId);
        } catch (readError) {
          if (readError.code !== "ENOENT") throw readError;
          throw new JobRuntimeError(
            "job_id_conflict",
            "The jobId is already reserved by an incomplete job record.",
          );
        }
        if (
          existingJob.job_id !== jobId
          || existingJob.idempotency_key_sha256 !== keyHash
          || existingJob.definition_sha256 !== definitionHash
        ) {
          throw new JobRuntimeError(
            "job_id_conflict",
            "The jobId is already bound to a different request.",
          );
        }
        await atomicWriteJson(idempotencyFile, {
          schema_version: "1.0",
          idempotency_key_sha256: keyHash,
          definition_sha256: definitionHash,
          job_id: jobId,
        });
        return { job: existingJob, reused: true };
      }
      await mkdir(join(directory, "checkpoints"), { mode: 0o700 });
      await atomicWriteJson(join(directory, "job.json"), job);
      await atomicWriteJson(idempotencyFile, {
        schema_version: "1.0",
        idempotency_key_sha256: keyHash,
        definition_sha256: definitionHash,
        job_id: jobId,
      });
      await this.appendEvent(job, {
        event: "job_created",
        state: job.state,
        detail: { kind, definition_sha256: definitionHash },
      });
      await atomicWriteJson(join(directory, "job.json"), job);
      return { job, reused: false };
    } finally {
      await release();
    }
  }

  async get(jobId) {
    return readJsonFile(join(this.jobDirectory(jobId), "job.json"), "Job record");
  }

  async list() {
    await this.initialize();
    const entries = await readdir(this.jobsDirectory, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      if (!JOB_ID_PATTERN.test(entry.name)) continue;
      try {
        jobs.push(await this.get(entry.name));
      } catch {
        // A partial directory is reported by verify(), not returned as a valid job.
      }
    }
    return jobs.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async appendEvent(job, fields) {
    const event = buildAuditEvent({
      ...fields,
      jobId: job.job_id,
      previousEventSha256: job.audit_head_sha256,
    });
    if (containsUnredactedSecret(event)) {
      throw new Error("Refusing to write an audit event containing an unredacted secret.");
    }
    await appendFile(
      join(this.jobDirectory(job.job_id), "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    job.audit_head_sha256 = event.event_sha256;
    return event;
  }

  async applyCancellationRequest(job) {
    const requestFile = join(this.jobDirectory(job.job_id), "cancel-request.json");
    let request;
    try {
      request = await readJsonFile(requestFile, "Cancellation request");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (TERMINAL_STATES.has(job.state)) {
      await unlink(requestFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return false;
    }
    if (job.current_stage) {
      const stage = job.stages.find((item) => item.id === job.current_stage);
      if (stage && stage.status !== "succeeded") {
        stage.status = "cancelled";
        stage.completed_at = new Date().toISOString();
      }
    }
    transition(job, "cancelled");
    job.completed_at = new Date().toISOString();
    await this.appendEvent(job, {
      event: "job_cancelled",
      stage: job.current_stage,
      state: job.state,
      detail: { reason: request.reason || "cancelled_by_operator" },
    });
    await atomicWriteJson(join(this.jobDirectory(job.job_id), "job.json"), job);
    await unlink(requestFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }

  async run(
    jobId,
    {
      handlers,
      wait = sleep,
      now = () => Date.now(),
    },
  ) {
    if (!handlers || typeof handlers !== "object") {
      throw new Error("run requires a handler registry.");
    }
    const directory = this.jobDirectory(jobId);
    const release = await acquireLock(join(directory, "run.lock"), {
      timeoutMs: 1000,
      staleMs: 30 * 60 * 1000,
    });
    try {
      const job = await this.get(jobId);
      if (await this.applyCancellationRequest(job)) {
        return { job, reused: false };
      }
      if (TERMINAL_STATES.has(job.state)) return { job, reused: true };
      if (!RUNNABLE_STATES.has(job.state)) {
        throw new JobRuntimeError("job_not_runnable", `Job state ${job.state} is not runnable.`);
      }
      const recovering = job.state === "running";
      transition(job, "running");
      job.started_at ||= new Date().toISOString();
      job.completed_at = null;
      job.last_error = null;
      await this.appendEvent(job, {
        event: recovering ? "job_recovered" : "job_started",
        state: job.state,
      });
      await atomicWriteJson(join(directory, "job.json"), job);

      for (const stage of job.stages) {
        if (stage.status === "succeeded") continue;
        if (await this.applyCancellationRequest(job)) {
          return { job, reused: false };
        }
        const handler = handlers[stage.handler];
        if (typeof handler !== "function") {
          throw new JobPauseError(
            "handler_unavailable",
            `No registered handler for ${stage.handler}.`,
            { state: "blocked", detail: { handler: stage.handler } },
          );
        }
        job.current_stage = stage.id;
        let stageFinished = false;
        let attemptsThisRun = 0;
        while (
          !stageFinished
          && attemptsThisRun < job.retry_policy.max_attempts
        ) {
          attemptsThisRun += 1;
          stage.attempts += 1;
          stage.status = "running";
          stage.started_at = new Date().toISOString();
          stage.error = null;
          const started = now();
          await this.appendEvent(job, {
            event: "stage_started",
            stage: stage.id,
            state: job.state,
            attempt: stage.attempts,
          });
          await atomicWriteJson(join(directory, "job.json"), job);
          try {
            const result = await handler({
              job: structuredClone(job),
              stage: structuredClone(stage),
              parameters: structuredClone(stage.parameters),
              checkpoint: stage.checkpoint
                ? await readJsonFile(
                    resolveCheckpointPath(directory, stage),
                    `Checkpoint for ${stage.id}`,
                  )
                : null,
            });
            if (await this.applyCancellationRequest(job)) {
              return { job, reused: false };
            }
            assertJsonSize(result || {}, `Stage ${stage.id} result`, 1024 * 1024);
            if (
              containsCredentialField(result || {})
              || containsUnredactedSecret(result || {})
            ) {
              throw new JobRuntimeError(
                "unsafe_stage_result",
                `Stage ${stage.id} returned credential-like data and was not persisted.`,
              );
            }
            const checkpoint = {
              schema_version: "1.0",
              job_id: job.job_id,
              stage_id: stage.id,
              attempt: stage.attempts,
              completed_at: new Date().toISOString(),
              result: result || {},
            };
            const checkpointRelative = checkpointRelativePath(stage.id);
            await atomicWriteJson(join(directory, checkpointRelative), checkpoint);
            const checkpointBytes = await readFile(join(directory, checkpointRelative));
            stage.status = "succeeded";
            stage.completed_at = checkpoint.completed_at;
            stage.duration_ms = Math.max(0, now() - started);
            stage.checkpoint = {
              file: checkpointRelative.replaceAll("\\", "/"),
              sha256: sha256(checkpointBytes),
            };
            stage.outputs = structuredClone(result?.outputs || null);
            stage.error = null;
            await this.appendEvent(job, {
              event: "stage_succeeded",
              stage: stage.id,
              state: job.state,
              attempt: stage.attempts,
              durationMs: stage.duration_ms,
              requestId: result?.request_id || null,
              model: result?.model || null,
              assetVersions: result?.asset_versions || [],
              hashes: {
                ...(result?.hashes || {}),
                checkpoint: stage.checkpoint.sha256,
              },
            });
            await atomicWriteJson(join(directory, "job.json"), job);
            stageFinished = true;
          } catch (error) {
            const sanitized = sanitizeError(error);
            stage.error = sanitized;
            stage.duration_ms = Math.max(0, now() - started);
            if (await this.applyCancellationRequest(job)) {
              return { job, reused: false };
            }
            if (error instanceof JobPauseError) {
              stage.status = error.pauseState;
              transition(job, error.pauseState);
              job.last_error = sanitized;
              await this.appendEvent(job, {
                event: "stage_paused",
                stage: stage.id,
                state: job.state,
                attempt: stage.attempts,
                durationMs: stage.duration_ms,
                error,
                detail: error.detail,
              });
              await atomicWriteJson(join(directory, "job.json"), job);
              return { job, reused: false };
            }
            const canRetry =
              error?.retryable === true
              && attemptsThisRun < job.retry_policy.max_attempts;
            stage.status = canRetry ? "retry_wait" : "failed";
            await this.appendEvent(job, {
              event: canRetry ? "stage_retry_scheduled" : "stage_failed",
              stage: stage.id,
              state: job.state,
              attempt: stage.attempts,
              durationMs: stage.duration_ms,
              error,
              detail: error?.detail,
            });
            await atomicWriteJson(join(directory, "job.json"), job);
            if (canRetry) {
              await wait(retryDelay(job.retry_policy, attemptsThisRun));
              if (await this.applyCancellationRequest(job)) {
                return { job, reused: false };
              }
            } else {
              transition(job, "failed");
              job.last_error = sanitized;
              job.current_stage = stage.id;
              await this.appendEvent(job, {
                event: "job_failed",
                stage: stage.id,
                state: job.state,
                error,
              });
              await atomicWriteJson(join(directory, "job.json"), job);
              return { job, reused: false };
            }
          }
        }
      }
      transition(job, "succeeded");
      job.current_stage = null;
      job.completed_at = new Date().toISOString();
      await this.appendEvent(job, { event: "job_succeeded", state: job.state });
      await atomicWriteJson(join(directory, "job.json"), job);
      return { job, reused: false };
    } catch (error) {
      if (error instanceof JobPauseError) {
        const job = await this.get(jobId);
        if (job.state === "running") {
          transition(job, error.pauseState);
          job.last_error = sanitizeError(error);
          await this.appendEvent(job, {
            event: "job_paused",
            stage: job.current_stage,
            state: job.state,
            error,
            detail: error.detail,
          });
          await atomicWriteJson(join(directory, "job.json"), job);
        }
        return { job, reused: false };
      }
      throw error;
    } finally {
      await release();
    }
  }

  async cancel(jobId, reason = "cancelled_by_operator") {
    const directory = this.jobDirectory(jobId);
    const existing = await this.get(jobId);
    if (TERMINAL_STATES.has(existing.state)) return existing;
    const safeReason = sanitizeError(new Error(reason)).message;
    await atomicWriteJson(join(directory, "cancel-request.json"), {
      schema_version: "1.0",
      job_id: jobId,
      requested_at: new Date().toISOString(),
      reason: safeReason,
    });
    let release;
    try {
      release = await acquireLock(join(directory, "run.lock"), { timeoutMs: 100 });
    } catch (error) {
      if (error.code !== "RUNTIME_LOCK_TIMEOUT") throw error;
      return {
        ...await this.get(jobId),
        cancellation_pending: true,
      };
    }
    try {
      const job = await this.get(jobId);
      await this.applyCancellationRequest(job);
      return job;
    } finally {
      await release();
    }
  }

  async verify(jobId) {
    const job = await this.get(jobId);
    const errors = [];
    for (const stage of job.stages) {
      if (stage.parameters_sha256 !== canonicalJsonSha256(stage.parameters || {})) {
        errors.push({
          code: "job.parameters_hash",
          message: `Stage ${stage.id} parameters hash mismatch.`,
        });
      }
    }
    if (job.definition_sha256 !== computeJobDefinitionSha256({
      kind: job.kind,
      stages: job.stages,
      retryPolicy: job.retry_policy,
      metadata: job.metadata,
    })) {
      errors.push({ code: "job.definition_hash", message: "Job definition hash mismatch." });
    }
    let previous = null;
    let lines = [];
    try {
      const { bytes } = await readBoundedFile(
        join(this.jobDirectory(jobId), "events.jsonl"),
        { label: "Job audit log", maxBytes: 64 * MiB },
      );
      lines = bytes
        .toString("utf8")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean);
      if (lines.length > 5000) {
        errors.push({
          code: "job.audit_limit",
          message: "Job audit log exceeds the 5000-event verification limit.",
        });
        lines = lines.slice(0, 5000);
      }
    } catch (error) {
      errors.push({ code: "job.audit_missing", message: error.message });
    }
    for (const [index, line] of lines.entries()) {
      try {
        const event = JSON.parse(line);
        const actualHash = event.event_sha256;
        const candidate = { ...event };
        delete candidate.event_sha256;
        if (canonicalJsonSha256(candidate) !== actualHash) {
          errors.push({ code: "job.audit_hash", message: `Event ${index + 1} hash mismatch.` });
        }
        if (candidate.previous_event_sha256 !== previous) {
          errors.push({ code: "job.audit_chain", message: `Event ${index + 1} chain mismatch.` });
        }
        if (containsUnredactedSecret(event)) {
          errors.push({ code: "job.audit_secret", message: `Event ${index + 1} contains a secret.` });
        }
        previous = actualHash;
      } catch (error) {
        errors.push({ code: "job.audit_json", message: `Event ${index + 1}: ${error.message}` });
      }
    }
    if (job.audit_head_sha256 !== previous) {
      errors.push({ code: "job.audit_head", message: "Job audit head does not match the event chain." });
    }
    for (const stage of job.stages.filter((item) => item.checkpoint)) {
      try {
        const { bytes } = await readBoundedFile(
          resolveCheckpointPath(this.jobDirectory(jobId), stage),
          { label: `Checkpoint for ${stage.id}`, maxBytes: 4 * MiB },
        );
        if (sha256(bytes) !== stage.checkpoint.sha256) {
          errors.push({ code: "job.checkpoint_hash", message: `Stage ${stage.id} checkpoint hash mismatch.` });
        }
      } catch (error) {
        errors.push({ code: "job.checkpoint_missing", message: `Stage ${stage.id}: ${error.message}` });
      }
    }
    return {
      schema_version: "1.0",
      job_id: jobId,
      valid: errors.length === 0,
      errors,
      audit_events: lines.length,
      stages: job.stages.length,
    };
  }
}

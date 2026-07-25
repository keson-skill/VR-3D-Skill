#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
} from "../lib/cli.mjs";
import { JobStore } from "../runtime/job-runtime.mjs";
import { validateProductionJobSchema } from "../validation/json-schema.mjs";
import {
  buildProductionHandlers,
  validateProductionStages,
} from "./production-handlers.mjs";

function summarize(job) {
  return {
    job_id: job.job_id,
    kind: job.kind,
    state: job.state,
    revision: job.revision,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    current_stage: job.current_stage,
    stages: job.stages.map((stage) => ({
      id: stage.id,
      handler: stage.handler,
      status: stage.status,
      attempts: stage.attempts,
      duration_ms: stage.duration_ms,
      outputs: stage.outputs,
      error: stage.error,
    })),
    last_error: job.last_error,
    audit_head_sha256: job.audit_head_sha256,
    cancellation_pending: job.cancellation_pending === true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    action: { type: "string", default: "run" },
    store: { type: "string", default: "runs/runtime" },
    workspace: { type: "string", default: "runs" },
    definition: { type: "string" },
    "job-id": { type: "string" },
    "idempotency-key": { type: "string" },
    reason: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/orchestration/run-production-job.mjs --action run --definition job-definition.json [--idempotency-key request-0001] [--workspace runs]
  node scripts/orchestration/run-production-job.mjs --action status --job-id job-...
  node scripts/orchestration/run-production-job.mjs --action verify --job-id job-...
  node scripts/orchestration/run-production-job.mjs --action cancel --job-id job-... [--reason operator_cancelled]
  node scripts/orchestration/run-production-job.mjs --action list

Definitions may use only built-in handler IDs. There is no arbitrary shell-command handler, and every output must stay below --workspace.
`);
    return;
  }
  const store = new JobStore(options.store);
  if (options.action === "run") {
    if (!options.definition) throw new Error("--definition is required for action run.");
    const definition = await readJson(options.definition, "production job definition");
    const schema = validateProductionJobSchema(definition);
    if (!schema.valid) {
      const detail = schema.errors
        .slice(0, 20)
        .map((error) => `${error.path || "/"}: ${error.message}`)
        .join("; ");
      throw new Error(`Production job definition is invalid: ${detail}`);
    }
    const handlerContracts = validateProductionStages(definition.stages, {
      workspaceRoot: options.workspace,
    });
    if (!handlerContracts.valid) {
      const detail = handlerContracts.errors
        .slice(0, 20)
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ");
      throw new Error(`Production job handler parameters are invalid: ${detail}`);
    }
    const idempotencyKey = options["idempotency-key"] || definition.idempotency_key;
    if (!idempotencyKey) throw new Error("Provide --idempotency-key or definition.idempotency_key.");
    const created = await store.create({
      idempotencyKey,
      kind: definition.kind || "interior_pipeline",
      stages: definition.stages,
      jobId: definition.job_id,
      retryPolicy: definition.retry_policy || {},
      metadata: definition.metadata || {},
    });
    const result = await store.run(created.job.job_id, {
      handlers: buildProductionHandlers({ workspaceRoot: options.workspace }),
    });
    printJson({ reused_definition: created.reused, ...summarize(result.job) });
    if (result.job.state !== "succeeded") process.exitCode = 2;
    return;
  }
  if (options.action === "list") {
    printJson({ jobs: (await store.list()).map(summarize) });
    return;
  }
  if (!options["job-id"]) throw new Error(`--job-id is required for action ${options.action}.`);
  if (options.action === "status") {
    printJson(summarize(await store.get(options["job-id"])));
  } else if (options.action === "verify") {
    const report = await store.verify(options["job-id"]);
    printJson(report);
    if (!report.valid) process.exitCode = 2;
  } else if (options.action === "cancel") {
    printJson(summarize(await store.cancel(
      options["job-id"],
      options.reason || "cancelled_by_operator",
    )));
  } else {
    throw new Error("action must be run, status, verify, cancel, or list.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

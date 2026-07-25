#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";
import {
  computeJobDefinitionSha256,
  normalizeJobRetryPolicy,
} from "../runtime/job-runtime.mjs";
import {
  containsCredentialField,
  containsUnredactedSecret,
  redactValue,
} from "../runtime/redaction.mjs";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const STAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

function preparedJobMigration(document) {
  return {
    schema_version: "1.0",
    stage: document.status === "ready" ? "prepared" : document.status || "blocked",
    output_directory: document.outputDirectory || document.output_directory || null,
    source_manifest: document.sourceManifest || document.source_manifest || null,
    routes: document.routes || [],
    blockers: document.blockers || [],
    next_actions: document.nextActions || document.next_actions || [],
  };
}

function assetManifestMigration(document) {
  return {
    schema_version: "1.0",
    target: document.target || "web",
    assets: document.items || document.assets || [],
  };
}

function runtimeJobMigration(document) {
  if (!JOB_ID.test(document.job_id || "")) {
    throw new Error("Legacy runtime job has an invalid stable job ID.");
  }
  if (
    !Array.isArray(document.stages)
    || document.stages.length < 1
    || document.stages.length > 100
  ) {
    throw new Error("Legacy runtime job must contain 1 to 100 stages.");
  }
  const stages = (document.stages || []).map((stage, index) => {
    const id = stage.id || stage.name || `stage-${index + 1}`;
    const handler = stage.handler || id;
    const parameters = stage.parameters || {};
    if (!STAGE_ID.test(id) || !STAGE_ID.test(handler)) {
      throw new Error(`Legacy runtime stage ${index + 1} has an invalid ID or handler.`);
    }
    if (
      containsCredentialField(parameters)
      || containsUnredactedSecret(parameters)
    ) {
      throw new Error(`Legacy runtime stage ${id} contains credential-like parameters.`);
    }
    return {
      id,
      handler,
      parameters,
      parameters_sha256: canonicalJsonSha256(parameters),
      status: ["complete", "succeeded"].includes(stage.status)
        ? "succeeded"
        : "pending",
      attempts:
        Number.isSafeInteger(Number(stage.attempts))
        && Number(stage.attempts) >= 0
          ? Number(stage.attempts)
          : 0,
      started_at: stage.started_at || null,
      completed_at: stage.completed_at || null,
      duration_ms: stage.duration_ms || null,
      checkpoint: null,
      outputs: redactValue(stage.outputs || stage.result || null),
      error: redactValue(stage.error || null),
    };
  });
  const kind = document.kind || "interior_pipeline";
  if (!STAGE_ID.test(kind)) throw new Error("Legacy runtime job kind is invalid.");
  const retryPolicy = normalizeJobRetryPolicy(document.retry_policy || {});
  const metadata = {
    ...(document.metadata || {}),
    migrated_from_schema: document.schema_version || "legacy",
    migration_review_required: true,
  };
  if (
    containsCredentialField(metadata)
    || containsUnredactedSecret(metadata)
  ) {
    throw new Error("Legacy runtime job metadata contains credential-like data.");
  }
  const definitionSha256 = computeJobDefinitionSha256({
    kind,
    stages,
    retryPolicy,
    metadata,
  });
  return {
    schema_version: "1.0",
    job_id: document.job_id,
    kind,
    state: "blocked",
    revision:
      Number.isSafeInteger(Number(document.revision))
      && Number(document.revision) > 0
        ? Number(document.revision)
        : 1,
    created_at: document.created_at || new Date(0).toISOString(),
    updated_at: document.updated_at || document.created_at || new Date(0).toISOString(),
    started_at: document.started_at || null,
    completed_at: document.completed_at || null,
    idempotency_key_sha256:
      /^[a-f0-9]{64}$/u.test(
        document.idempotency_key_sha256 || document.idempotency_hash || "",
      )
        ? document.idempotency_key_sha256 || document.idempotency_hash
        : sha256(Buffer.from(`migrated:${document.job_id}`, "utf8")),
    definition_sha256: definitionSha256,
    retry_policy: retryPolicy,
    metadata,
    current_stage: null,
    stages,
    audit_head_sha256: null,
    last_error: {
      code: "migration_review_required",
      message: "Review migrated paths, approvals, and checkpoints before resuming.",
      retryable: false,
    },
  };
}

export function classifyMigrationDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return "unsupported";
  }
  if (
    document.kind === "spatial_approval"
    || (document.project && document.envelope)
  ) {
    return "protected_spatial";
  }
  if (document.job_id && Array.isArray(document.stages)) return "runtime_job";
  if (Array.isArray(document.items) || (Array.isArray(document.assets) && document.target)) {
    return "asset_manifest";
  }
  if (
    Object.hasOwn(document, "outputDirectory")
    || Object.hasOwn(document, "sourceManifest")
    || (Object.hasOwn(document, "stage") && Array.isArray(document.routes))
  ) {
    return "prepared_job";
  }
  return "unsupported";
}

export function migrateDocument(document) {
  const kind = classifyMigrationDocument(document);
  const fromVersion = document?.schema_version || document?.manifest_version || "legacy";
  if (kind === "protected_spatial") {
    throw new Error("Spatial JSON and approval documents require explicit schema-specific review and are never auto-migrated.");
  }
  if (kind === "unsupported") throw new Error("Document type is not supported by the migration registry.");
  if (fromVersion === "1.0") {
    return {
      kind,
      from_version: fromVersion,
      to_version: "1.0",
      changed: false,
      document: structuredClone(document),
    };
  }
  if (!["legacy", "0.1", "0.9"].includes(fromVersion)) {
    throw new Error(`No migration path from schema version ${fromVersion}.`);
  }
  let migrated;
  if (kind === "prepared_job") migrated = preparedJobMigration(document);
  else if (kind === "asset_manifest") migrated = assetManifestMigration(document);
  else migrated = runtimeJobMigration(document);
  return {
    kind,
    from_version: fromVersion,
    to_version: "1.0",
    changed: true,
    document: migrated,
  };
}

async function atomicWrite(filePath, document) {
  const temporary = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export async function migrateFile(
  inputFile,
  {
    outputFile = null,
    apply = false,
  } = {},
) {
  const input = resolve(inputFile);
  const { bytes: sourceBytes } = await readBoundedFile(input, {
    label: "Migration input",
    maxBytes: 4 * MiB,
  });
  let source;
  try {
    source = JSON.parse(sourceBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Migration input is invalid JSON: ${error.message}`);
  }
  const migration = migrateDocument(source);
  const target = outputFile ? resolve(outputFile) : input;
  let backup = null;
  if (apply && migration.changed) {
    const { bytes: currentBytes } = await readBoundedFile(input, {
      label: "Migration input",
      maxBytes: 4 * MiB,
    });
    if (sha256(currentBytes) !== sha256(sourceBytes)) {
      throw new Error("Migration input changed after the dry-run read.");
    }
    if (target === input) {
      backup = `${input}.backup-${migration.from_version.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
      await copyFile(input, backup, constants.COPYFILE_EXCL);
    }
    await atomicWrite(target, migration.document);
  }
  const report = {
    schema_version: "1.0",
    input: inputFile,
    output: apply ? (outputFile || inputFile) : null,
    backup,
    applied: apply && migration.changed,
    kind: migration.kind,
    from_version: migration.from_version,
    to_version: migration.to_version,
    changed: migration.changed,
    before_sha256: sha256(sourceBytes),
    after_sha256: canonicalJsonSha256(migration.document),
    review_required:
      migration.kind === "runtime_job" && migration.changed,
  };
  return { report, document: migration.document };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string" },
    report: { type: "string" },
    apply: { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/migrations/migrate-project.mjs --input legacy-job.json
  node scripts/migrations/migrate-project.mjs --input legacy-job.json --output migrated-job.json --apply --report migration-report.json

The default is a dry run. Spatial JSON and approval files are never auto-migrated.
`);
    return;
  }
  const result = await migrateFile(options.input, {
    outputFile: options.output,
    apply: options.apply,
  });
  if (options.report) await writeJson(options.report, result.report);
  printJson(result.report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

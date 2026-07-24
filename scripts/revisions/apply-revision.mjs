#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { validateRevision } from "../validation/validate-revision.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";
import { buildDependencyPlan } from "./build-dependency-plan.mjs";
import {
  durableCollectionPointer,
  findStableId,
  resolvePointer,
} from "./json-pointer.mjs";

export class RevisionApplicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RevisionApplicationError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function snapshot(value, exists = true) {
  return {
    exists,
    value: exists ? clone(value) : null,
    sha256: exists ? canonicalJsonSha256(value) : null,
  };
}

function sameValue(left, right) {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function containsStableId(value) {
  if (Array.isArray(value)) return value.some(containsStableId);
  if (value === null || typeof value !== "object") return false;
  if (typeof value.id === "string" && value.id.trim()) return true;
  return Object.values(value).some(containsStableId);
}

function joinInternalPointer(base, relative) {
  if (relative === "") return base;
  return `${base}${relative}`;
}

function insertionIndex(collection, insertBeforeId) {
  if (!insertBeforeId) return collection.length;
  const index = collection.findIndex((item) => item?.id === insertBeforeId);
  if (index === -1) {
    throw new RevisionApplicationError(
      "operation.insert_before_id",
      `Insertion anchor ${insertBeforeId} does not exist in the target collection.`,
    );
  }
  return index;
}

function assertNewStableObject(working, value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.id !== "string"
    || !value.id.trim()
  ) {
    throw new RevisionApplicationError(
      "operation.array_add",
      "Adding to an ID-keyed array requires an object with a stable id.",
    );
  }
  try {
    findStableId(working, value.id);
  } catch (error) {
    if (error.message.startsWith("Unknown stable ID")) return;
    throw error;
  }
  throw new RevisionApplicationError(
    "operation.duplicate_id",
    `Stable ID ${value.id} already exists.`,
  );
}

function applyAtPointer(working, operation, pointer, { target = null } = {}) {
  const container = target?.value ?? working;
  const localPointer = target ? operation.field_path : operation.path;
  const internalPointer = target
    ? joinInternalPointer(target.pointer, localPointer)
    : pointer;

  if (localPointer === "") {
    if (operation.op === "test") {
      if (!sameValue(container, operation.value)) {
        throw new RevisionApplicationError(
          "operation.test_failed",
          `Test failed for stable ID ${operation.target_id}.`,
        );
      }
      return {
        changed: false,
        pointer: internalPointer,
        before: snapshot(container),
        after: snapshot(container),
        inverse: null,
      };
    }
    if (operation.op !== "remove" || !target || !Array.isArray(target.parent)) {
      throw new RevisionApplicationError(
        "operation.target_root",
        "Whole-object operations require a stable-ID array member and remove or test.",
      );
    }
    const collectionPointer = durableCollectionPointer(target.pointer);
    const before = snapshot(target.value);
    const nextId = target.parent[target.key + 1]?.id || null;
    target.parent.splice(target.key, 1);
    return {
      changed: true,
      pointer: collectionPointer,
      before,
      after: snapshot(undefined, false),
      inverse: {
        op: "add",
        path: collectionPointer,
        value: before.value,
        ...(nextId ? { insert_before_id: nextId } : {}),
      },
    };
  }

  const resolution = resolvePointer(container, localPointer, {
    allowMissingFinal: operation.op === "add",
  });
  const before = snapshot(resolution.value, resolution.exists);

  if (operation.op === "test") {
    if (!resolution.exists || !sameValue(resolution.value, operation.value)) {
      throw new RevisionApplicationError(
        "operation.test_failed",
        `Test failed at ${internalPointer}.`,
      );
    }
    return {
      changed: false,
      pointer: internalPointer,
      before,
      after: before,
      inverse: null,
    };
  }

  if (
    ["replace", "remove"].includes(operation.op)
    && resolution.exists
    && containsStableId(resolution.value)
  ) {
    throw new RevisionApplicationError(
      "operation.stable_id_subtree",
      `Use a stable target ID instead of replacing or removing ID-bearing subtree ${internalPointer}.`,
    );
  }

  if (operation.op === "add" && resolution.exists && Array.isArray(resolution.value)) {
    assertNewStableObject(working, operation.value);
    const index = insertionIndex(resolution.value, operation.insert_before_id);
    resolution.value.splice(index, 0, clone(operation.value));
    return {
      changed: true,
      pointer: internalPointer,
      before,
      after: snapshot(operation.value),
      inverse: {
        op: "remove",
        target_id: operation.value.id,
        field_path: "",
      },
    };
  }

  if (operation.op === "add") {
    resolution.parent[resolution.key] = clone(operation.value);
    return {
      changed: true,
      pointer: internalPointer,
      before,
      after: snapshot(operation.value),
      inverse: resolution.exists
        ? {
            op: "replace",
            ...(target
              ? { target_id: operation.target_id, field_path: operation.field_path }
              : { path: operation.path }),
            value: before.value,
          }
        : {
            op: "remove",
            ...(target
              ? { target_id: operation.target_id, field_path: operation.field_path }
              : { path: operation.path }),
          },
    };
  }

  if (operation.op === "replace") {
    if (!resolution.exists) {
      throw new RevisionApplicationError(
        "operation.missing_target",
        `Cannot replace missing value at ${internalPointer}.`,
      );
    }
    resolution.parent[resolution.key] = clone(operation.value);
    return {
      changed: true,
      pointer: internalPointer,
      before,
      after: snapshot(operation.value),
      inverse: {
        op: "replace",
        ...(target
          ? { target_id: operation.target_id, field_path: operation.field_path }
          : { path: operation.path }),
        value: before.value,
      },
    };
  }

  if (operation.op === "remove") {
    if (!resolution.exists) {
      throw new RevisionApplicationError(
        "operation.missing_target",
        `Cannot remove missing value at ${internalPointer}.`,
      );
    }
    delete resolution.parent[resolution.key];
    return {
      changed: true,
      pointer: internalPointer,
      before,
      after: snapshot(undefined, false),
      inverse: {
        op: "add",
        ...(target
          ? { target_id: operation.target_id, field_path: operation.field_path }
          : { path: operation.path }),
        value: before.value,
      },
    };
  }

  throw new RevisionApplicationError(
    "operation.unsupported",
    `Unsupported operation ${operation.op}.`,
  );
}

function preservationSnapshots(document, revision) {
  return {
    ids: (revision.must_preserve_ids || []).map((id) => {
      const target = findStableId(document, id);
      return { id, sha256: canonicalJsonSha256(target.value) };
    }),
    paths: (revision.must_preserve_paths || []).map((pointer) => {
      const resolved = resolvePointer(document, pointer);
      return { pointer, sha256: canonicalJsonSha256(resolved.value) };
    }),
  };
}

function enforcePreservation(document, preserved) {
  for (const item of preserved.ids) {
    let target;
    try {
      target = findStableId(document, item.id);
    } catch {
      throw new RevisionApplicationError(
        "preservation.id_removed",
        `Preserved stable ID ${item.id} was removed.`,
      );
    }
    if (canonicalJsonSha256(target.value) !== item.sha256) {
      throw new RevisionApplicationError(
        "preservation.id_changed",
        `Preserved stable ID ${item.id} was changed.`,
      );
    }
  }
  for (const item of preserved.paths) {
    let resolved;
    try {
      resolved = resolvePointer(document, item.pointer);
    } catch {
      throw new RevisionApplicationError(
        "preservation.path_removed",
        `Preserved path ${item.pointer} was removed.`,
      );
    }
    if (canonicalJsonSha256(resolved.value) !== item.sha256) {
      throw new RevisionApplicationError(
        "preservation.path_changed",
        `Preserved path ${item.pointer} was changed.`,
      );
    }
  }
}

function inverseScope(operations) {
  return {
    target_ids: [...new Set(operations.map((operation) => operation.target_id).filter(Boolean))],
    paths: [...new Set(operations.map((operation) => operation.path).filter(Boolean))],
  };
}

function buildAudit({
  baseDocument,
  document,
  revision,
  diff,
  dependencyPlan,
  appliedAt,
  previousAuditSha256,
}) {
  const payload = {
    schema_version: "1.0",
    event_type: "revision_applied",
    event_id: `audit-${revision.revision_id}`,
    project_id: document.project.id,
    base_revision: revision.base_revision,
    revision_id: revision.revision_id,
    intent: revision.intent,
    provenance: revision.provenance,
    applied_at: appliedAt,
    base_document_sha256: canonicalJsonSha256(baseDocument),
    result_document_sha256: canonicalJsonSha256(document),
    revision_sha256: canonicalJsonSha256(revision),
    diff,
    dependency_plan: dependencyPlan,
    approval_transition: {
      from: baseDocument.validation?.status || null,
      to: document.validation?.status || null,
      requires_reapproval: true,
    },
    previous_audit_sha256: previousAuditSha256 || null,
  };
  return { ...payload, audit_sha256: canonicalJsonSha256(payload) };
}

export function applyRevision(
  baseDocument,
  revision,
  {
    appliedAt = new Date().toISOString(),
    previousAuditSha256 = null,
  } = {},
) {
  const revisionValidation = validateRevision(baseDocument, revision);
  if (!revisionValidation.valid) {
    throw new RevisionApplicationError(
      "revision.invalid",
      `Revision failed validation: ${revisionValidation.errors[0]?.message || "unknown error"}`,
      { validation: revisionValidation },
    );
  }

  const working = structuredClone(baseDocument);
  const preserved = preservationSnapshots(working, revision);
  const changes = [];
  const inverseOperations = [];

  for (let index = 0; index < revision.operations.length; index += 1) {
    const operation = revision.operations[index];
    try {
      const target = operation.target_id
        ? findStableId(working, operation.target_id)
        : null;
      const outcome = applyAtPointer(
        working,
        operation,
        operation.path,
        { target },
      );
      if (outcome.changed) {
        changes.push({
          operation_index: index,
          operation: clone(operation),
          resolved_pointer: outcome.pointer,
          before: outcome.before,
          after: outcome.after,
        });
        inverseOperations.unshift(outcome.inverse);
      }
    } catch (error) {
      if (error instanceof RevisionApplicationError) {
        error.details = { ...error.details, operation_index: index };
        throw error;
      }
      throw new RevisionApplicationError(
        "operation.apply_failed",
        error.message,
        { operation_index: index },
      );
    }
  }

  enforcePreservation(working, preserved);
  working.project.revision = revision.revision_id;
  working.validation = {
    ...(working.validation || {}),
    status: "pending",
    approved_scope: null,
    checks: [
      ...(Array.isArray(working.validation?.checks) ? working.validation.checks : []),
      {
        code: "revision.requires_reapproval",
        revision_id: revision.revision_id,
        previous_revision: revision.base_revision,
      },
    ],
  };

  const spatialValidation = validateSpatialJson(working);
  if (!spatialValidation.valid) {
    throw new RevisionApplicationError(
      "revision.spatial_invalid",
      `Revision produced invalid Spatial JSON: ${spatialValidation.errors[0]?.message || "unknown error"}`,
      { validation: spatialValidation },
    );
  }

  const dependencyPlan = buildDependencyPlan(
    changes.map((change) => change.resolved_pointer),
    revision.revalidate,
  );
  const inverseRevision = {
    revision_id: `undo-${revision.revision_id}`,
    base_revision: revision.revision_id,
    intent: `Undo revision ${revision.revision_id}: ${revision.intent}`,
    scope: inverseScope(inverseOperations),
    operations: inverseOperations,
    must_preserve_ids: clone(revision.must_preserve_ids || []),
    must_preserve_paths: clone(revision.must_preserve_paths || []),
    revalidate: dependencyPlan.revalidate,
    provenance: {
      actor_type: "system",
      actor_id: "revision-engine",
      created_at: appliedAt,
    },
    rollback_reference: revision.revision_id,
  };
  const audit = buildAudit({
    baseDocument,
    document: working,
    revision,
    diff: changes,
    dependencyPlan,
    appliedAt,
    previousAuditSha256,
  });

  return {
    schema_version: "1.0",
    document: working,
    revision,
    inverse_revision: inverseRevision,
    diff: changes,
    dependency_plan: dependencyPlan,
    spatial_validation: spatialValidation,
    requires_reapproval: true,
    audit,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    base: { type: "string", required: true },
    revision: { type: "string", required: true },
    output: { type: "string", required: true },
    diff: { type: "string" },
    inverse: { type: "string" },
    audit: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/revisions/apply-revision.mjs --base spatial.json --revision revision.json --output revised.json [--diff diff.json] [--inverse inverse.json] [--audit audit.json]\n");
    return;
  }
  const [baseDocument, revision] = await Promise.all([
    readJson(options.base, "base Spatial JSON"),
    readJson(options.revision, "revision"),
  ]);
  const result = applyRevision(baseDocument, revision);
  await writeJson(options.output, result.document);
  if (options.diff) await writeJson(options.diff, result.diff);
  if (options.inverse) await writeJson(options.inverse, result.inverse_revision);
  if (options.audit) await writeJson(options.audit, result.audit);
  printJson({
    outputFile: options.output,
    revision: result.document.project.revision,
    changes: result.diff.length,
    revalidate: result.dependency_plan.revalidate,
    regenerate: result.dependency_plan.regenerate,
    requiresReapproval: result.requires_reapproval,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}

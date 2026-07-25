#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import {
  isDurablePointer,
  pointerContains,
  resolvePointer,
} from "../revisions/json-pointer.mjs";
import { collectStableIds } from "./validate-spatial-json.mjs";

const ALLOWED_OPERATIONS = new Set(["add", "remove", "replace", "test"]);
const ACTOR_TYPES = new Set(["human", "model", "system"]);
const PROTECTED_PATHS = [
  "/schema_version",
  "/project/id",
  "/project/revision",
  "/validation",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathsOverlap(left, right) {
  return pointerContains(left, right) || pointerContains(right, left);
}

export function validateRevision(baseDocument, revision) {
  const errors = [];
  const warnings = [];
  const addError = (code, path, message) =>
    errors.push({ code, path, message });
  const addWarning = (code, path, message) =>
    warnings.push({ code, path, message });

  if (!isObject(baseDocument)) {
    addError("base.type", "", "Base Spatial JSON must be an object.");
    return { valid: false, errors, warnings };
  }
  if (!isObject(revision)) {
    addError("revision.type", "", "Revision must be an object.");
    return { valid: false, errors, warnings };
  }

  for (const field of ["revision_id", "base_revision", "intent"]) {
    if (typeof revision[field] !== "string" || !revision[field].trim()) {
      addError(
        `revision.${field}`,
        `/${field}`,
        `${field} must be a non-empty string.`,
      );
    }
  }
  if (revision.revision_id === revision.base_revision) {
    addError(
      "revision.id_reused",
      "/revision_id",
      "revision_id must differ from base_revision.",
    );
  }
  if (revision.base_revision !== baseDocument.project?.revision) {
    addError(
      "revision.stale_base",
      "/base_revision",
      `Expected base revision ${baseDocument.project?.revision || "(missing)"}.`,
    );
  }

  const stableIds = new Set(
    collectStableIds(baseDocument).map((entry) => entry.id),
  );
  const scopeIds = revision.scope?.target_ids;
  const scopePaths = revision.scope?.paths;
  if (!isObject(revision.scope)) {
    addError(
      "revision.scope",
      "/scope",
      "scope must explicitly list allowed target_ids and/or durable paths.",
    );
  } else {
    for (const [field, values] of [
      ["target_ids", scopeIds],
      ["paths", scopePaths],
    ]) {
      if (!Array.isArray(values)) {
        addError(
          `revision.scope.${field}`,
          `/scope/${field}`,
          `${field} must be an array.`,
        );
      }
    }
    if (
      Array.isArray(scopeIds)
      && Array.isArray(scopePaths)
      && scopeIds.length + scopePaths.length === 0
    ) {
      addError(
        "revision.scope.empty",
        "/scope",
        "Revision scope must allow at least one target ID or path.",
      );
    }
    for (const id of Array.isArray(scopeIds) ? scopeIds : []) {
      if (!stableIds.has(id)) {
        addError(
          "revision.scope.target_id",
          "/scope/target_ids",
          `Unknown scoped target ID ${id}.`,
        );
      }
    }
    for (const pointer of Array.isArray(scopePaths) ? scopePaths : []) {
      if (!isDurablePointer(pointer)) {
        addError(
          "revision.scope.path",
          "/scope/paths",
          `Invalid durable scope path ${pointer}.`,
        );
      } else if (PROTECTED_PATHS.some((protectedPath) => pathsOverlap(protectedPath, pointer))) {
        addError(
          "revision.scope.protected",
          "/scope/paths",
          `Scope path ${pointer} overlaps engine-controlled metadata.`,
        );
      }
    }
  }

  if (!isObject(revision.provenance)) {
    addError(
      "revision.provenance",
      "/provenance",
      "provenance must identify the human, model, or system actor.",
    );
  } else {
    if (!ACTOR_TYPES.has(revision.provenance.actor_type)) {
      addError(
        "revision.provenance.actor_type",
        "/provenance/actor_type",
        "actor_type must be human, model, or system.",
      );
    }
    if (
      typeof revision.provenance.actor_id !== "string"
      || !revision.provenance.actor_id.trim()
    ) {
      addError(
        "revision.provenance.actor_id",
        "/provenance/actor_id",
        "actor_id must be a non-empty string.",
      );
    }
    if (
      typeof revision.provenance.created_at !== "string"
      || !Number.isFinite(Date.parse(revision.provenance.created_at))
    ) {
      addError(
        "revision.provenance.created_at",
        "/provenance/created_at",
        "created_at must be an ISO-8601 timestamp.",
      );
    }
  }
  if (revision.rollback_reference !== revision.base_revision) {
    addError(
      "revision.rollback_reference",
      "/rollback_reference",
      "rollback_reference must identify the exact base revision.",
    );
  }

  if (!Array.isArray(revision.operations) || revision.operations.length === 0) {
    addError(
      "revision.operations",
      "/operations",
      "At least one revision operation is required.",
    );
  } else {
    revision.operations.forEach((operation, index) => {
      const path = `/operations/${index}`;
      if (!isObject(operation)) {
        addError("operation.type", path, "Operation must be an object.");
        return;
      }
      if (!ALLOWED_OPERATIONS.has(operation.op)) {
        addError(
          "operation.op",
          `${path}/op`,
          "op must be add, remove, replace, or test.",
        );
      }

      const usesPointer = operation.path !== undefined;
      const usesTarget = operation.target_id !== undefined;
      if (usesPointer === usesTarget) {
        addError(
          "operation.target",
          path,
          "Use either path or target_id with field_path, but not both.",
        );
      } else if (usesPointer && !isDurablePointer(operation.path)) {
        addError(
          "operation.path",
          `${path}/path`,
          "Durable paths must be RFC 6901 pointers without array indexes or wildcards.",
        );
      } else if (usesPointer) {
        if (PROTECTED_PATHS.some((protectedPath) => pathsOverlap(protectedPath, operation.path))) {
          addError(
            "operation.protected_path",
            `${path}/path`,
            `Operation path ${operation.path} overlaps engine-controlled metadata.`,
          );
        }
        if (
          Array.isArray(scopePaths)
          && !scopePaths.some((scopePath) => pointerContains(scopePath, operation.path))
        ) {
          addError(
            "operation.out_of_scope",
            `${path}/path`,
            `Operation path ${operation.path} is outside revision scope.`,
          );
        }
      } else if (usesTarget) {
        if (!stableIds.has(operation.target_id)) {
          addError(
            "operation.target_id",
            `${path}/target_id`,
            `Unknown target ID ${operation.target_id}.`,
          );
        }
        if (!isDurablePointer(operation.field_path, { allowRoot: true })) {
          addError(
            "operation.field_path",
            `${path}/field_path`,
            "field_path must be an RFC 6901 root or durable relative pointer.",
          );
        }
        if (
          Array.isArray(scopeIds)
          && !scopeIds.includes(operation.target_id)
        ) {
          addError(
            "operation.out_of_scope",
            `${path}/target_id`,
            `Target ${operation.target_id} is outside revision scope.`,
          );
        }
        if (
          operation.field_path === "/id"
          || (
            operation.target_id === baseDocument.project?.id
            && operation.field_path === "/revision"
          )
        ) {
          addError(
            "operation.stable_id",
            `${path}/field_path`,
            "Stable IDs cannot be changed by a revision.",
          );
        }
        if (
          operation.field_path === ""
          && !["remove", "test"].includes(operation.op)
        ) {
          addError(
            "operation.target_root",
            `${path}/field_path`,
            "A whole stable-ID object may only be tested or removed.",
          );
        }
      }

      if (
        ["add", "replace", "test"].includes(operation.op) &&
        !Object.hasOwn(operation, "value")
      ) {
        addError(
          "operation.value",
          `${path}/value`,
          `${operation.op} requires a value.`,
        );
      }
      if (operation.insert_before_id !== undefined) {
        if (operation.op !== "add" || !stableIds.has(operation.insert_before_id)) {
          addError(
            "operation.insert_before_id",
            `${path}/insert_before_id`,
            "insert_before_id is allowed only on add and must reference an existing stable ID.",
          );
        }
      }
    });
  }

  for (const [field, values] of [
    ["must_preserve_ids", revision.must_preserve_ids],
    ["must_preserve_paths", revision.must_preserve_paths],
  ]) {
    if (values !== undefined && !Array.isArray(values)) {
      addError(
        `revision.${field}`,
        `/${field}`,
        `${field} must be an array.`,
      );
    }
  }

  for (const id of revision.must_preserve_ids || []) {
    if (!stableIds.has(id)) {
      addError(
        "revision.preserve_id",
        "/must_preserve_ids",
        `Unknown preserved ID ${id}.`,
      );
    }
  }
  for (const pointer of revision.must_preserve_paths || []) {
    if (!isDurablePointer(pointer)) {
      addError(
        "revision.preserve_path",
        "/must_preserve_paths",
        `Invalid durable pointer ${pointer}.`,
      );
    } else {
      try {
        resolvePointer(baseDocument, pointer);
      } catch (error) {
        addError(
          "revision.preserve_path_missing",
          "/must_preserve_paths",
          error.message,
        );
      }
    }
  }
  if (!Array.isArray(revision.revalidate) || revision.revalidate.length === 0) {
    addError(
      "revision.revalidate",
      "/revalidate",
      "List the deterministic gates affected by this revision.",
    );
  }
  if (
    Array.isArray(revision.operations)
    && !revision.operations.some((operation) => operation?.op !== "test")
  ) {
    addError(
      "revision.no_change",
      "/operations",
      "A revision must contain at least one mutating operation.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      operations: Array.isArray(revision.operations)
        ? revision.operations.length
        : 0,
      preserved_ids: Array.isArray(revision.must_preserve_ids)
        ? revision.must_preserve_ids.length
        : 0,
      preserved_paths: Array.isArray(revision.must_preserve_paths)
        ? revision.must_preserve_paths.length
        : 0,
    },
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/validate-revision.mjs --base spatial.json --revision revision.json [--output revision-report.json]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    base: { type: "string", required: true },
    revision: { type: "string", required: true },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const [baseDocument, revision] = await Promise.all([
    readJson(options.base, "base Spatial JSON"),
    readJson(options.revision, "revision"),
  ]);
  const report = validateRevision(baseDocument, revision);
  if (options.output) {
    await writeJson(options.output, report);
    printJson({
      outputFile: options.output,
      valid: report.valid,
      errors: report.errors.length,
      warnings: report.warnings.length,
    });
  } else {
    printJson(report);
  }
  if (!report.valid) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

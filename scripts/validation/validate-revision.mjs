#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { collectStableIds } from "./validate-spatial-json.mjs";

const ALLOWED_OPERATIONS = new Set(["add", "remove", "replace", "test"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonPointer(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !/(^|[^~])~(?![01])/.test(value)
  );
}

function isDurablePointer(value) {
  return (
    isJsonPointer(value) &&
    !value.includes("*") &&
    !/(^|\/)\d+(?=\/|$)/.test(value)
  );
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
      } else if (usesTarget) {
        if (!stableIds.has(operation.target_id)) {
          addError(
            "operation.target_id",
            `${path}/target_id`,
            `Unknown target ID ${operation.target_id}.`,
          );
        }
        if (!isDurablePointer(operation.field_path)) {
          addError(
            "operation.field_path",
            `${path}/field_path`,
            "field_path must be a durable RFC 6901 pointer.",
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
    }
  }
  if (!Array.isArray(revision.revalidate) || revision.revalidate.length === 0) {
    addWarning(
      "revision.revalidate",
      "/revalidate",
      "List the deterministic gates affected by this revision.",
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

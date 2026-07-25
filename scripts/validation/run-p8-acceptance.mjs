#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  writeJson,
} from "../lib/cli.mjs";
import { applyRevision, RevisionApplicationError } from "../revisions/apply-revision.mjs";
import { validateRevision } from "./validate-revision.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p8-acceptance/fixtures.json", import.meta.url);

function verifyAudit(audit) {
  const { audit_sha256: recorded, ...payload } = audit;
  return recorded === canonicalJsonSha256(payload);
}

export async function runP8Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const url = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) {
    throw new Error("P8 acceptance requires at least 20 fixtures.");
  }
  const samples = suite.fixtures.map((fixture) => {
    try {
      const beforeColor = fixture.spatial.materials.finish_paint.base_color;
      const result = applyRevision(fixture.spatial, fixture.revision, {
        appliedAt: "2026-07-24T01:00:00.000Z",
      });
      const inverseValidation = validateRevision(result.document, result.inverse_revision);
      const undone = inverseValidation.valid
        ? applyRevision(result.document, result.inverse_revision, {
            appliedAt: "2026-07-24T02:00:00.000Z",
            previousAuditSha256: result.audit.audit_sha256,
          })
        : null;
      const valid =
        result.document.project.revision === fixture.revision.revision_id
        && result.document.validation.status === "pending"
        && result.document.validation.approved_scope === null
        && result.requires_reapproval
        && result.diff.length === 1
        && result.dependency_plan.regenerate.includes("scene_glb")
        && result.dependency_plan.regenerate.includes("web_viewer")
        && result.dependency_plan.regenerate.includes("blender_plan")
        && verifyAudit(result.audit)
        && inverseValidation.valid
        && undone?.document.materials.finish_paint.base_color === beforeColor
        && undone?.audit.previous_audit_sha256 === result.audit.audit_sha256;
      return {
        id: fixture.id,
        valid,
        revision: result.document.project.revision,
        diff_items: result.diff.length,
        regenerated: result.dependency_plan.regenerate,
        audit_sha256: result.audit.audit_sha256,
        error: null,
      };
    } catch (error) {
      return {
        id: fixture.id,
        valid: false,
        error: `${error.code || error.name}: ${error.message}`,
      };
    }
  });

  const first = suite.fixtures[0];
  const outOfScope = structuredClone(first.revision);
  outOfScope.operations[0].path = "/lights";
  const scopeBlocked = !validateRevision(first.spatial, outOfScope).valid;
  const preservationViolation = structuredClone(first.revision);
  preservationViolation.scope.paths.push("/envelope/ceiling_height");
  preservationViolation.operations[0] = {
    op: "replace",
    path: "/envelope/ceiling_height",
    value: first.spatial.envelope.ceiling_height + 0.1,
  };
  let preservationBlocked = false;
  try {
    applyRevision(first.spatial, preservationViolation);
  } catch (error) {
    preservationBlocked =
      error instanceof RevisionApplicationError
      && error.code === "preservation.path_changed";
  }

  const aggregate = {
    fixture_count: samples.length,
    application_errors: samples.filter((sample) => !sample.valid).length,
    scope_blocked: scopeBlocked,
    preservation_blocked: preservationBlocked,
  };
  const passed =
    aggregate.fixture_count >= 20
    && aggregate.application_errors === 0
    && aggregate.scope_blocked
    && aggregate.preservation_blocked;
  return {
    schema_version: "1.0",
    stage: "P8",
    passed,
    aggregate,
    samples,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p8-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/validation/run-p8-acceptance.mjs [--fixtures file] [--output file]\n");
    return;
  }
  const report = await runP8Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

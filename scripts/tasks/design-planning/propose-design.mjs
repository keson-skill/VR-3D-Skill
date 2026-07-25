#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  assertModelAvailable,
  generateSpatialJson,
} from "../../adapters/realmrouter-openai.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  readText,
  requireProviderApproval,
  sanitizeSpatialForProvider,
  writeJson,
} from "../../lib/cli.mjs";
import { checkStageReadiness } from "../../orchestration/check-stage-readiness.mjs";
import { validateRevision } from "../../validation/validate-revision.mjs";
import { evaluateDesignProposal } from "./evaluate-design-proposal.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/tasks/design-planning/propose-design.mjs --spatial-json approved-spatial.json --source-manifest source-manifest.json --spatial-validation spatial-validation.json --approval spatial-approval.json --approval-trust spatial-approval-trust.json --requirements requirements.md --output design-proposal.json [--metadata output-metadata.json] [--validation-report revision-validation.json] --allow-provider
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    "spatial-validation": { type: "string", required: true },
    approval: { type: "string", required: true },
    "approval-trust": { type: "string", required: true },
    requirements: { type: "string", required: true },
    output: { type: "string", required: true },
    metadata: { type: "string" },
    "validation-report": { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  requireProviderApproval(options);

  const [
    spatialJson,
    sourceManifest,
    spatialValidation,
    approval,
    approvalTrust,
    requirements,
  ] = await Promise.all([
    readJson(options["spatial-json"], "approved Spatial JSON"),
    readJson(options["source-manifest"], "source manifest"),
    readJson(options["spatial-validation"], "spatial validation report"),
    readJson(options.approval, "spatial approval"),
    readJson(options["approval-trust"], "spatial approval trust store"),
    readText(options.requirements, "design requirements"),
  ]);
  const readiness = checkStageReadiness("design", spatialJson, {
    sourceManifest,
    validationReport: spatialValidation,
    approval,
    approvalTrust,
  });
  if (!readiness.ready) {
    throw new Error(
      `Design planning blocked: ${readiness.blockers
        .slice(0, 3)
        .map((blocker) => `${blocker.path}: ${blocker.message}`)
        .join(" | ")}`,
    );
  }

  const providerSpatial = sanitizeSpatialForProvider(spatialJson);
  await assertModelAvailable({
    apiKey: process.env.REALMROUTER_SPATIAL_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model: process.env.REALMROUTER_SPATIAL_MODEL,
    routeLabel: "spatial",
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  const prompt = `Create editable interior-design alternatives for the approved spatial contract below.

User requirements:
${requirements.trim()}

Approved Spatial JSON:
${JSON.stringify(providerSpatial, null, 2)}

Return one JSON object with:
- base_revision;
- design_brief with budget, occupants, activities, must_keep_ids, minimum_clearance_meters;
- design_alternatives with explainable zoning, furniture footprints, clearances, materials, lighting, cost/risk notes, and scores;
- recommended_alternative_id;
- a proposed revision_patch with explicit scope.target_ids/scope.paths, stable target IDs, durable JSON Pointer paths, must-preserve rules, and deterministic gates to revalidate.

Do not change the measured envelope, structural edit policies, room topology, locked openings, or required circulation. This is a proposal only; do not mark it approved.`;

  const result = await generateSpatialJson({
    apiKey: process.env.REALMROUTER_SPATIAL_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model: process.env.REALMROUTER_SPATIAL_MODEL,
    reasoningEffort: process.env.REALMROUTER_SPATIAL_REASONING_EFFORT,
    prompt,
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
  });
  if (result.spatialJson?.revision_patch) {
    result.spatialJson.revision_patch.provenance = {
      actor_type: "model",
      actor_id: result.model,
      created_at: new Date().toISOString(),
      ...(result.requestId ? { request_id: result.requestId } : {}),
    };
    result.spatialJson.revision_patch.rollback_reference =
      spatialJson.project.revision;
  }
  await writeJson(options.output, result.spatialJson);

  const revisionValidation = result.spatialJson?.revision_patch
    ? validateRevision(spatialJson, result.spatialJson.revision_patch)
    : {
        valid: false,
        errors: [
          {
            code: "design.revision_patch_missing",
            path: "/revision_patch",
            message: "Design proposal must contain a revision_patch object.",
          },
        ],
        warnings: [],
      };
  const designValidation = evaluateDesignProposal(spatialJson, result.spatialJson);
  if (options["validation-report"]) {
    await writeJson(options["validation-report"], revisionValidation);
  }

  const metadata = {
    task: "design-planning",
    provider: "realmrouter",
    model: result.model,
    request_id: result.requestId,
    usage: result.usage,
    base_revision: spatialJson.project.revision,
    output_file: options.output,
    revision_validation: {
      valid: revisionValidation.valid,
      errors: revisionValidation.errors.length,
      warnings: revisionValidation.warnings.length,
    },
    design_validation: {
      valid: designValidation.valid,
      errors: designValidation.errors.length,
      warnings: designValidation.warnings.length,
    },
  };
  if (options.metadata) {
    await writeJson(options.metadata, metadata);
  }
  printJson(metadata);
  if (!revisionValidation.valid || !designValidation.valid) {
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

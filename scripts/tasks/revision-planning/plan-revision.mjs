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
import { collectStableIds } from "../../validation/validate-spatial-json.mjs";
import { validateRevision } from "../../validation/validate-revision.mjs";

export function buildRevisionPlanningPrompt(baseDocument, intent) {
  const stableTargets = collectStableIds(baseDocument).map(({ id, path }) => ({
    id,
    container: path.replace(/\/\d+\/id$/u, "").replace(/\/id$/u, ""),
  }));
  return `Translate the user's interior-design change into one constrained revision contract.

User request:
${intent.trim()}

Current revision: ${baseDocument.project.revision}
Stable targets:
${JSON.stringify(stableTargets, null, 2)}

Approved Spatial JSON with local source URIs removed:
${JSON.stringify(sanitizeSpatialForProvider(baseDocument), null, 2)}

Return one JSON object only with:
- revision_id: a new stable revision ID;
- base_revision: exactly "${baseDocument.project.revision}";
- intent: the user's request without expanding its scope;
- scope: { "target_ids": [...], "paths": [...] } listing every permitted edit target;
- operations: add/remove/replace/test operations using either a durable object path or target_id plus field_path;
- must_preserve_ids and must_preserve_paths for measured geometry, locked objects, and unrelated rooms;
- revalidate: every deterministic gate affected by the change.

Do not output provenance or rollback metadata; the trusted caller adds those. Never use array indexes, wildcards, or paths under /project, /schema_version, or /validation. Never mark the result approved. Do not infer a new dimension, move a measured wall, remove a required circulation path, or change an ID. If the request is ambiguous or unsafe, return { "blocked": true, "questions": [...] } instead of operations.`;
}

export async function planNaturalLanguageRevision(
  baseDocument,
  intent,
  {
    generate,
    actorId = "revision-model",
    createdAt = new Date().toISOString(),
  },
) {
  if (baseDocument.validation?.status !== "approved") {
    throw new Error("Natural-language revision planning requires an approved base Spatial JSON.");
  }
  if (typeof intent !== "string" || !intent.trim()) {
    throw new Error("Revision intent must be a non-empty string.");
  }
  const providerResult = await generate(buildRevisionPlanningPrompt(baseDocument, intent));
  const response = providerResult.spatialJson ?? providerResult;
  if (response?.blocked === true) {
    return {
      blocked: true,
      questions: Array.isArray(response.questions) ? response.questions : [],
      provider: {
        model: providerResult.model || actorId,
        request_id: providerResult.requestId || null,
      },
    };
  }
  const candidate = structuredClone(response.revision || response.revision_patch || response);
  candidate.provenance = {
    actor_type: "model",
    actor_id: providerResult.model || actorId,
    created_at: createdAt,
    ...(providerResult.requestId ? { request_id: providerResult.requestId } : {}),
  };
  candidate.rollback_reference = baseDocument.project.revision;
  const validation = validateRevision(baseDocument, candidate);
  return {
    blocked: !validation.valid,
    revision: candidate,
    validation,
    provider: {
      model: providerResult.model || actorId,
      request_id: providerResult.requestId || null,
      usage: providerResult.usage || null,
      attempts: providerResult.attempts || null,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    spatial: { type: "string", required: true },
    request: { type: "string", required: true },
    output: { type: "string", required: true },
    metadata: { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node --env-file=.env scripts/tasks/revision-planning/plan-revision.mjs --spatial approved.json --request change.txt --output revision.json [--metadata metadata.json] --allow-provider\n");
    return;
  }
  requireProviderApproval(options);
  const [baseDocument, intent] = await Promise.all([
    readJson(options.spatial, "approved Spatial JSON"),
    readText(options.request, "revision request"),
  ]);
  const apiKey = process.env.REALMROUTER_SPATIAL_API_KEY || "";
  const baseUrl = process.env.REALMROUTER_BASE_URL;
  const model = process.env.REALMROUTER_SPATIAL_MODEL || "gpt-5.5";
  await assertModelAvailable({
    apiKey,
    baseUrl,
    model,
    routeLabel: "revision planning",
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  const result = await planNaturalLanguageRevision(baseDocument, intent, {
    actorId: model,
    generate: (prompt) => generateSpatialJson({
      apiKey,
      baseUrl,
      model,
      reasoningEffort: process.env.REALMROUTER_SPATIAL_REASONING_EFFORT,
      prompt,
      timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
      maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
    }),
  });
  if (result.revision) await writeJson(options.output, result.revision);
  else await writeJson(options.output, result);
  if (options.metadata) {
    await writeJson(options.metadata, {
      task: "revision-planning",
      blocked: result.blocked,
      base_revision: baseDocument.project.revision,
      output_file: options.output,
      validation: result.validation || null,
      provider: result.provider,
    });
  }
  printJson({
    outputFile: options.output,
    blocked: result.blocked,
    valid: result.validation?.valid ?? false,
    errors: result.validation?.errors?.length ?? 0,
  });
  if (result.blocked) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  assertModelAvailable,
  generateSpatialJson,
} from "../../adapters/realmrouter-openai.mjs";
import {
  imageFileToDataUrl,
  parseArgs,
  printJson,
  readJson,
  readText,
  requireProviderApproval,
  sanitizeSourceManifestForProvider,
  sha256,
  writeJson,
} from "../../lib/cli.mjs";
import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/tasks/spatial-extraction/extract-spatial-json.mjs --prompt-file task.md --source-manifest source-manifest.json [--input-image plan.png] --output spatial-draft.json [--metadata output-metadata.json] [--validation-report validation.json] --allow-provider

--allow-provider confirms approval to send the listed prompt and images to RealmRouter.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "prompt-file": { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    "ocr-evidence": { type: "string" },
    "input-image": { type: "array" },
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

  const [task, sourceManifest, imageDataUrls, ocrEvidence] = await Promise.all([
    readText(options["prompt-file"], "spatial extraction task"),
    readJson(options["source-manifest"], "source manifest"),
    Promise.all(options["input-image"].map(imageFileToDataUrl)),
    options["ocr-evidence"]
      ? readJson(options["ocr-evidence"], "OCR evidence")
      : Promise.resolve(null),
  ]);
  if (!Array.isArray(sourceManifest.sources) || sourceManifest.sources.length === 0) {
    throw new Error("Source manifest must contain at least one source.");
  }

  const providerManifest = sanitizeSourceManifestForProvider(sourceManifest);
  await assertModelAvailable({
    apiKey: process.env.REALMROUTER_SPATIAL_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model: process.env.REALMROUTER_SPATIAL_MODEL,
    routeLabel: "spatial",
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  const prompt = `${task.trim()}

Source manifest:
${JSON.stringify(providerManifest, null, 2)}

Local OCR evidence (treat as evidence, not ground truth):
${JSON.stringify(ocrEvidence || { entries: [] }, null, 2)}

Return a draft Spatial JSON matching the contract. Separate measured, parsed, observed, and inferred facts. Keep unresolved dimension conflicts explicit.`;

  const result = await generateSpatialJson({
    apiKey: process.env.REALMROUTER_SPATIAL_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model: process.env.REALMROUTER_SPATIAL_MODEL,
    reasoningEffort: process.env.REALMROUTER_SPATIAL_REASONING_EFFORT,
    prompt,
    imageDataUrls,
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  await writeJson(options.output, result.spatialJson);

  const validation = validateSpatialJson(result.spatialJson);
  if (options["validation-report"]) {
    await writeJson(options["validation-report"], validation);
  }

  const metadata = {
    task: "spatial-extraction",
    provider: "realmrouter",
    model: result.model,
    request_id: result.requestId,
    usage: result.usage,
    provider_attempts: result.attempts,
    source_manifest_sha256: sha256(
      Buffer.from(JSON.stringify(sourceManifest), "utf8"),
    ),
    output_file: options.output,
    structural_validation: {
      valid: validation.valid,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
    },
  };
  if (options.metadata) {
    await writeJson(options.metadata, metadata);
  }
  printJson(metadata);
  if (!validation.valid) {
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

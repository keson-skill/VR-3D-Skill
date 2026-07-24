#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { generateImage } from "../../adapters/realmrouter-openai.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  readText,
  requireProviderApproval,
  sha256,
  writeBytes,
  writeJson,
} from "../../lib/cli.mjs";
import { checkStageReadiness } from "../../orchestration/check-stage-readiness.mjs";

function buildLockedVisualContext(spatialJson) {
  return {
    project: {
      id: spatialJson.project.id,
      revision: spatialJson.project.revision,
      units: spatialJson.project.units,
      up_axis: spatialJson.project.up_axis,
      forward_axis: spatialJson.project.forward_axis,
      origin: spatialJson.project.origin,
    },
    envelope: spatialJson.envelope,
    rooms: spatialJson.rooms,
    circulation: spatialJson.circulation,
    design_objects: spatialJson.design_objects,
    surfaces: spatialJson.surfaces,
    materials: spatialJson.materials,
    lights: spatialJson.lights,
    camera_intent: spatialJson.render_profiles?.preview?.camera_intent || null,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/tasks/visual-preview/generate-preview.mjs --spatial-json approved-spatial.json --prompt-file visual-direction.md --output preview.png --metadata preview.json [--size 1536x1024] [--quality medium] --allow-provider
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    "prompt-file": { type: "string", required: true },
    output: { type: "string", required: true },
    metadata: { type: "string", required: true },
    size: { type: "string" },
    quality: { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  requireProviderApproval(options);

  const [spatialJson, visualDirection] = await Promise.all([
    readJson(options["spatial-json"], "approved Spatial JSON"),
    readText(options["prompt-file"], "visual direction"),
  ]);
  const readiness = checkStageReadiness("preview", spatialJson);
  if (!readiness.ready) {
    throw new Error(
      `Visual preview blocked: ${readiness.blockers[0]?.message}`,
    );
  }

  const lockedContext = buildLockedVisualContext(spatialJson);
  const prompt = `${visualDirection.trim()}

Locked approved scene context:
${JSON.stringify(lockedContext, null, 2)}

Create a customer-facing concept preview. Preserve the declared walls, openings, furniture placement, circulation, materials, lighting, and camera intent. Do not invent or imply changed construction geometry.`;

  const result = await generateImage({
    apiKey: process.env.REALMROUTER_IMAGE_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model: process.env.REALMROUTER_IMAGE_MODEL,
    prompt,
    size: options.size || process.env.REALMROUTER_IMAGE_SIZE,
    quality: options.quality || process.env.REALMROUTER_IMAGE_QUALITY,
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  await writeBytes(options.output, result.bytes);

  const metadata = {
    task: "visual-preview",
    provider: "realmrouter",
    model: result.model,
    request_id: result.requestId,
    provider_attempts: result.attempts,
    design_revision_id: spatialJson.project.revision,
    prompt_sha256: sha256(Buffer.from(prompt, "utf8")),
    output_sha256: sha256(result.bytes),
    output_file: options.output,
    source_url_recorded: Boolean(result.sourceUrl),
    readiness_warnings: readiness.warnings,
  };
  await writeJson(options.metadata, metadata);
  printJson({ metadataFile: options.metadata, ...metadata });
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

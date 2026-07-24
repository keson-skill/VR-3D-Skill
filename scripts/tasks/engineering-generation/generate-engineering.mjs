#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  callKimiCode,
  composeEngineeringPrompt,
} from "../../adapters/kimi-code-engineer.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  readText,
  requireProviderApproval,
  sanitizeSpatialForProvider,
  writeJson,
  writeText,
} from "../../lib/cli.mjs";
import { checkStageReadiness } from "../../orchestration/check-stage-readiness.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/tasks/engineering-generation/generate-engineering.mjs --task task.md --spatial-json approved-spatial.json [--asset-manifest assets.json] --output result.md [--metadata output-metadata.json] --allow-provider
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    task: { type: "string", required: true },
    "spatial-json": { type: "string", required: true },
    "asset-manifest": { type: "string" },
    output: { type: "string", required: true },
    metadata: { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  requireProviderApproval(options);

  const [task, spatialJson, assetManifest] = await Promise.all([
    readText(options.task, "engineering task"),
    readJson(options["spatial-json"], "approved Spatial JSON"),
    options["asset-manifest"]
      ? readJson(options["asset-manifest"], "asset manifest")
      : Promise.resolve(null),
  ]);
  const readiness = checkStageReadiness("engineering", spatialJson, {
    assetManifest,
  });
  if (!readiness.ready) {
    throw new Error(
      `Engineering generation blocked: ${readiness.blockers[0]?.message}`,
    );
  }

  const prompt = composeEngineeringPrompt({
    task,
    spatialJson: sanitizeSpatialForProvider(spatialJson),
    assetManifest,
  });
  const result = await callKimiCode({
    apiKey: process.env.KIMI_CODE_API_KEY || "",
    baseUrl: process.env.KIMI_CODE_BASE_URL,
    model: process.env.KIMI_CODE_ENGINEERING_MODEL,
    reasoningEffort: process.env.KIMI_CODE_REASONING_EFFORT,
    system:
      "Act as the engineering-generation specialist for a VR interior-design pipeline. Consume only approved structured scene data and acceptance criteria. Preserve stable IDs, transforms, measured geometry, locked elements, and circulation. Generate small reviewable artifacts and tests. Never edit the repository directly or reinterpret design constraints.",
    prompt,
    timeoutMs: Number(process.env.KIMI_CODE_TIMEOUT_MS || 120000),
  });
  await writeText(options.output, `${result.text.trimEnd()}\n`);

  const metadata = {
    task: "engineering-generation",
    provider: "kimi-code",
    model: result.model,
    request_id: result.id,
    usage: result.usage,
    base_revision: spatialJson.project.revision,
    output_file: options.output,
    readiness_warnings: readiness.warnings,
  };
  if (options.metadata) {
    await writeJson(options.metadata, metadata);
  }
  printJson(metadata);
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

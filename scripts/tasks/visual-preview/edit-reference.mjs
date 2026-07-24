#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { assertModelAvailable, editImage } from "../../adapters/realmrouter-openai.mjs";
import { parseArgs, printJson, readText, requireProviderApproval, sha256, writeBytes, writeJson } from "../../lib/cli.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/tasks/visual-preview/edit-reference.mjs --input-image reference.png --prompt-file direction.md --design-revision-id rev-002 --output preview.png --metadata metadata.json --allow-provider [--mask-image mask.png]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "input-image": { type: "string", required: true },
    "mask-image": { type: "string" },
    "prompt-file": { type: "string", required: true },
    "design-revision-id": { type: "string", required: true },
    output: { type: "string", required: true },
    metadata: { type: "string", required: true },
    size: { type: "string" },
    quality: { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  requireProviderApproval(options);
  const prompt = await readText(options["prompt-file"], "image edit direction");
  const model = process.env.REALMROUTER_IMAGE_MODEL || "gpt-image-2";
  const timeoutMs = Number(process.env.REALMROUTER_TIMEOUT_MS || 120000);
  const maxRetries = Number(process.env.REALMROUTER_MAX_RETRIES || 3);
  await assertModelAvailable({
    apiKey: process.env.REALMROUTER_IMAGE_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model,
    routeLabel: "image",
    timeoutMs,
    maxRetries,
  });
  const result = await editImage({
    apiKey: process.env.REALMROUTER_IMAGE_API_KEY || "",
    baseUrl: process.env.REALMROUTER_BASE_URL,
    model,
    prompt,
    inputImage: options["input-image"],
    maskImage: options["mask-image"],
    size: options.size || process.env.REALMROUTER_IMAGE_SIZE || "1536x1024",
    quality: options.quality || process.env.REALMROUTER_IMAGE_QUALITY || "high",
    timeoutMs,
    maxRetries,
  });
  await writeBytes(options.output, result.bytes);
  await writeJson(options.metadata, {
    task: "visual-preview-edit",
    provider: "realmrouter",
    model: result.model,
    request_id: result.requestId,
    provider_attempts: result.attempts,
    design_revision_id: options["design-revision-id"],
    input_image_sha256: sha256(await readFile(options["input-image"])),
    prompt_sha256: sha256(Buffer.from(prompt, "utf8")),
    output_sha256: sha256(result.bytes),
    output_file: options.output,
  });
  printJson({ outputFile: options.output, metadataFile: options.metadata, model: result.model, requestId: result.requestId, attempts: result.attempts });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

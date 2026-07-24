#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { parseArgs, printJson } from "../lib/cli.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/processing/preprocess-plan-image.mjs --input plan.png --output normalized.png [--max-edge 4096] [--threshold]

Normalizes orientation and color space, constrains the longest edge, and emits
a real PNG on macOS, Windows, and Linux. Use --threshold only for clean line art;
retain the normalized color image when dimensions or annotations use color.
`);
}

export async function preprocessPlanImage(
  input,
  output,
  { maxEdge = 4096, threshold = false } = {},
) {
  if (!Number.isInteger(maxEdge) || maxEdge < 512 || maxEdge > 16384) {
    throw new Error("maxEdge must be an integer from 512 to 16384.");
  }
  await mkdir(dirname(output), { recursive: true });
  const source = sharp(input, {
    failOn: "error",
    limitInputPixels: 268402689,
  });
  const inputMetadata = await source.metadata();
  let pipeline = source
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb");
  if (threshold) {
    pipeline = pipeline.grayscale().threshold();
  }
  const outputInfo = await pipeline
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
  return {
    inputFile: input,
    outputFile: output,
    method: threshold ? "sharp-normalize-threshold" : "sharp-normalize",
    input: {
      format: inputMetadata.format,
      width: inputMetadata.width,
      height: inputMetadata.height,
      orientation: inputMetadata.orientation || null,
    },
    output: {
      format: outputInfo.format,
      width: outputInfo.width,
      height: outputInfo.height,
      bytes: outputInfo.size,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    "max-edge": { type: "string", default: "4096" },
    threshold: { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const maxEdge = Number(options["max-edge"]);
  printJson(await preprocessPlanImage(options.input, options.output, {
    maxEdge,
    threshold: options.threshold,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

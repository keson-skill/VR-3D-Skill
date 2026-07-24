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
  const orientation = inputMetadata.orientation || 1;
  const swapsAxes = [5, 6, 7, 8].includes(orientation);
  const orientedWidth = swapsAxes ? inputMetadata.height : inputMetadata.width;
  const orientedHeight = swapsAxes ? inputMetadata.width : inputMetadata.height;
  const scaleX = outputInfo.width / orientedWidth;
  const scaleY = outputInfo.height / orientedHeight;
  const orientationMatrix = (() => {
    switch (orientation) {
      case 2:
        return [-1, 0, inputMetadata.width, 0, 1, 0, 0, 0, 1];
      case 3:
        return [
          -1,
          0,
          inputMetadata.width,
          0,
          -1,
          inputMetadata.height,
          0,
          0,
          1,
        ];
      case 4:
        return [1, 0, 0, 0, -1, inputMetadata.height, 0, 0, 1];
      case 5:
        return [0, 1, 0, 1, 0, 0, 0, 0, 1];
      case 6:
        return [0, -1, inputMetadata.height, 1, 0, 0, 0, 0, 1];
      case 7:
        return [
          0,
          -1,
          inputMetadata.height,
          -1,
          0,
          inputMetadata.width,
          0,
          0,
          1,
        ];
      case 8:
        return [0, 1, 0, -1, 0, inputMetadata.width, 0, 0, 1];
      default:
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
  })();
  const originalToNormalized = [
    orientationMatrix[0] * scaleX,
    orientationMatrix[1] * scaleX,
    orientationMatrix[2] * scaleX,
    orientationMatrix[3] * scaleY,
    orientationMatrix[4] * scaleY,
    orientationMatrix[5] * scaleY,
    0,
    0,
    1,
  ];
  const [a, b, c, d, e, f] = originalToNormalized;
  const determinant = a * e - b * d;
  const normalizedToOriginal = [
    e / determinant,
    -b / determinant,
    (b * f - e * c) / determinant,
    -d / determinant,
    a / determinant,
    (d * c - a * f) / determinant,
    0,
    0,
    1,
  ];
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
    coordinate_transform: {
      source_space: "original-image-pixels",
      target_space: "normalized-image-pixels",
      original_to_normalized_matrix_3x3: originalToNormalized,
      normalized_to_original_matrix_3x3: normalizedToOriginal,
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

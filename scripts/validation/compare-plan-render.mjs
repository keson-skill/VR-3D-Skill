#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { parseArgs, printJson, writeJson } from "../lib/cli.mjs";

function darkMask(data, threshold = 210) {
  const result = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] < threshold ? 1 : 0;
  }
  return result;
}

function scoreShift(source, render, width, height, dx, dy) {
  let sourceDark = 0;
  let renderDark = 0;
  let intersection = 0;
  let union = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceValue = source[y * width + x];
      const renderX = x - dx;
      const renderY = y - dy;
      const renderValue =
        renderX >= 0 &&
        renderX < width &&
        renderY >= 0 &&
        renderY < height
          ? render[renderY * width + renderX]
          : 0;
      sourceDark += sourceValue;
      renderDark += renderValue;
      if (sourceValue && renderValue) intersection += 1;
      if (sourceValue || renderValue) union += 1;
    }
  }
  const precision = intersection / Math.max(1, renderDark);
  const recall = intersection / Math.max(1, sourceDark);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    dx,
    dy,
    precision,
    recall,
    f1,
    iou: intersection / Math.max(1, union),
  };
}

async function normalizedGray(path, width, height) {
  const result = await sharp(path)
    .rotate()
    .flatten({ background: "#ffffff" })
    .grayscale()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return result.data;
}

async function writeDiff(
  path,
  source,
  render,
  width,
  height,
  shift,
) {
  await mkdir(dirname(path), { recursive: true });
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const renderX = x - shift.dx;
      const renderY = y - shift.dy;
      const renderValue =
        renderX >= 0 &&
        renderX < width &&
        renderY >= 0 &&
        renderY < height
          ? render[renderY * width + renderX]
          : 0;
      const sourceValue = source[index];
      const offset = index * 4;
      if (sourceValue && renderValue) {
        rgba[offset] = 30;
        rgba[offset + 1] = 150;
        rgba[offset + 2] = 80;
      } else if (sourceValue) {
        rgba[offset] = 220;
        rgba[offset + 1] = 55;
        rgba[offset + 2] = 55;
      } else if (renderValue) {
        rgba[offset] = 40;
        rgba[offset + 1] = 100;
        rgba[offset + 2] = 230;
      } else {
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
      }
      rgba[offset + 3] = 255;
    }
  }
  await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(path);
}

export async function comparePlanRender(
  sourcePath,
  renderPath,
  {
    comparisonSize = 512,
    searchRadius = 8,
    minimumF1 = 0.72,
    minimumIou = 0.56,
    diffPath = null,
  } = {},
) {
  if (
    !Number.isInteger(comparisonSize) ||
    comparisonSize < 128 ||
    comparisonSize > 2048
  ) {
    throw new Error("comparisonSize must be an integer from 128 to 2048.");
  }
  const [sourceMetadata, renderMetadata, sourceData, renderData] =
    await Promise.all([
      sharp(sourcePath).metadata(),
      sharp(renderPath).metadata(),
      normalizedGray(sourcePath, comparisonSize, comparisonSize),
      normalizedGray(renderPath, comparisonSize, comparisonSize),
    ]);
  const source = darkMask(sourceData);
  const render = darkMask(renderData);
  let best = null;
  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      const score = scoreShift(
        source,
        render,
        comparisonSize,
        comparisonSize,
        dx,
        dy,
      );
      if (
        !best ||
        score.f1 > best.f1 ||
        (score.f1 === best.f1 && score.iou > best.iou)
      ) {
        best = score;
      }
    }
  }
  if (diffPath) {
    await writeDiff(
      diffPath,
      source,
      render,
      comparisonSize,
      comparisonSize,
      best,
    );
  }
  return {
    schema_version: "1.0",
    method: "binary-registration-v1",
    source_dimensions: [sourceMetadata.width, sourceMetadata.height],
    render_dimensions: [renderMetadata.width, renderMetadata.height],
    comparison_dimensions: [comparisonSize, comparisonSize],
    registration: {
      translation_pixels_at_comparison_size: [best.dx, best.dy],
      search_radius_pixels: searchRadius,
    },
    metrics: {
      precision: Number(best.precision.toFixed(6)),
      recall: Number(best.recall.toFixed(6)),
      f1: Number(best.f1.toFixed(6)),
      intersection_over_union: Number(best.iou.toFixed(6)),
    },
    thresholds: {
      minimum_f1: minimumF1,
      minimum_intersection_over_union: minimumIou,
    },
    passed: best.f1 >= minimumF1 && best.iou >= minimumIou,
    ...(diffPath ? { diff_image: diffPath } : {}),
    note:
      "Alignment is a deterministic visual signal and does not certify construction dimensions.",
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/compare-plan-render.mjs \\
    --source plan.png --render top-view.png --output alignment.json \\
    [--diff alignment-diff.png]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    source: { type: "string", required: true },
    render: { type: "string", required: true },
    output: { type: "string", required: true },
    diff: { type: "string" },
    "comparison-size": { type: "string", default: "512" },
    "search-radius": { type: "string", default: "8" },
    "minimum-f1": { type: "string", default: "0.72" },
    "minimum-iou": { type: "string", default: "0.56" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const report = await comparePlanRender(options.source, options.render, {
    comparisonSize: Number(options["comparison-size"]),
    searchRadius: Number(options["search-radius"]),
    minimumF1: Number(options["minimum-f1"]),
    minimumIou: Number(options["minimum-iou"]),
    diffPath: options.diff,
  });
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, ...report });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

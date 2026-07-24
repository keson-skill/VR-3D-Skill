#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { distance2d } from "../geometry/spatial-geometry.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";

function inverseAffine(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * e - b * d;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error("Spatial coordinate transform is not invertible.");
  }
  return [
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
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5],
  ];
}

function fitTransform(document, width, height, padding) {
  const points = (document.envelope?.walls || []).flatMap((wall) => [
    wall.start,
    wall.end,
  ]);
  if (points.length === 0) {
    throw new Error("Cannot render a top view without walls.");
  }
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const scale = Math.min(
    (width - 2 * padding) / Math.max(1e-6, maxX - minX),
    (height - 2 * padding) / Math.max(1e-6, maxY - minY),
  );
  return [
    scale,
    0,
    padding - minX * scale,
    0,
    scale,
    padding - minY * scale,
    0,
    0,
    1,
  ];
}

function interpolate(start, end, offset) {
  const length = distance2d(start, end);
  const ratio = length === 0 ? 0 : offset / length;
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

export async function renderSpatialTopView(
  document,
  output,
  { width = null, height = null, padding = 40 } = {},
) {
  const rasterAnalysis = document.extraction?.raster_analysis;
  const rasterTransform = document.extraction?.coordinate_transform?.matrix_3x3;
  const sourceAligned =
    rasterAnalysis &&
    Array.isArray(rasterTransform) &&
    rasterTransform.length === 9;
  const outputWidth = Number(
    width || (sourceAligned ? rasterAnalysis.width : 1024),
  );
  const outputHeight = Number(
    height || (sourceAligned ? rasterAnalysis.height : 1024),
  );
  if (
    !Number.isInteger(outputWidth) ||
    !Number.isInteger(outputHeight) ||
    outputWidth < 64 ||
    outputHeight < 64
  ) {
    throw new Error("Top-view width and height must be integers of at least 64.");
  }
  const meterToPixel = sourceAligned
    ? inverseAffine(rasterTransform)
    : fitTransform(document, outputWidth, outputHeight, Number(padding));
  const pixelsPerMeter = Math.hypot(meterToPixel[0], meterToPixel[3]);
  const wallSvg = [];
  for (const wall of document.envelope?.walls || []) {
    const start = transformPoint(meterToPixel, wall.start);
    const end = transformPoint(meterToPixel, wall.end);
    const strokeWidth = Math.max(1, wall.thickness * pixelsPerMeter);
    wallSvg.push(
      `<line x1="${start[0]}" y1="${start[1]}" x2="${end[0]}" y2="${end[1]}" stroke="#111111" stroke-width="${strokeWidth}" stroke-linecap="butt"/>`,
    );
  }
  const wallMap = new Map(
    (document.envelope?.walls || []).map((wall) => [wall.id, wall]),
  );
  const openingSvg = [];
  for (const opening of document.envelope?.openings || []) {
    const wall = wallMap.get(opening.host_wall_id);
    if (!wall) continue;
    const startMeters = interpolate(wall.start, wall.end, opening.offset);
    const endMeters = interpolate(
      wall.start,
      wall.end,
      opening.offset + opening.width,
    );
    const start = transformPoint(meterToPixel, startMeters);
    const end = transformPoint(meterToPixel, endMeters);
    const strokeWidth = Math.max(3, wall.thickness * pixelsPerMeter + 2);
    openingSvg.push(
      `<line x1="${start[0]}" y1="${start[1]}" x2="${end[0]}" y2="${end[1]}" stroke="#ffffff" stroke-width="${strokeWidth}" stroke-linecap="butt"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">
<rect width="100%" height="100%" fill="#ffffff"/>
${wallSvg.join("\n")}
${openingSvg.join("\n")}
</svg>`;
  await mkdir(dirname(output), { recursive: true });
  const info = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
  return {
    schema_version: "1.0",
    output,
    width: info.width,
    height: info.height,
    source_aligned: Boolean(sourceAligned),
    meter_to_pixel_matrix_3x3: meterToPixel,
    walls: wallSvg.length,
    openings: openingSvg.length,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/render-spatial-top-view.mjs \\
    --spatial-json spatial.json --output top-view.png \\
    [--metadata top-view.json] [--width 1024] [--height 1024]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    output: { type: "string", required: true },
    metadata: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    padding: { type: "string", default: "40" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const document = await readJson(options["spatial-json"], "Spatial JSON");
  const report = await renderSpatialTopView(document, options.output, {
    width: options.width ? Number(options.width) : null,
    height: options.height ? Number(options.height) : null,
    padding: Number(options.padding),
  });
  if (options.metadata) await writeJson(options.metadata, report);
  printJson(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

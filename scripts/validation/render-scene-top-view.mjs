#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { parseArgs, printJson, readJson, writeJson } from "../lib/cli.mjs";

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
  if (points.length === 0) throw new Error("Cannot render a top view without walls.");
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const scale = Math.min(
    (width - 2 * padding) / Math.max(1e-6, maxX - minX),
    (height - 2 * padding) / Math.max(1e-6, maxZ - minZ),
  );
  return [
    scale,
    0,
    padding - minX * scale,
    0,
    scale,
    padding - minZ * scale,
    0,
    0,
    1,
  ];
}

function rotatePoint([x, z], radians) {
  return [
    x * Math.cos(radians) + z * Math.sin(radians),
    -x * Math.sin(radians) + z * Math.cos(radians),
  ];
}

function boxFootprint(primitive) {
  const [width, , depth] = primitive.scale;
  const [x, , z] = primitive.translation;
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map((local) => {
    const rotated = rotatePoint(local, primitive.rotation_y_radians || 0);
    return [x + rotated[0], z + rotated[1]];
  });
}

function primitiveFootprint(primitive) {
  if (primitive.shape === "extruded_polygon") return primitive.footprint;
  return boxFootprint(primitive);
}

export async function renderSceneTopView(
  document,
  output,
  { primitives = null, width = null, height = null, padding = 40 } = {},
) {
  const compiled = primitives || compileScenePrimitives(document);
  const rasterAnalysis = document.extraction?.raster_analysis;
  const transform = document.extraction?.coordinate_transform?.matrix_3x3;
  const sourceAligned =
    rasterAnalysis && Array.isArray(transform) && transform.length === 9;
  const outputWidth = Number(width || (sourceAligned ? rasterAnalysis.width : 1024));
  const outputHeight = Number(height || (sourceAligned ? rasterAnalysis.height : 1024));
  if (
    !Number.isInteger(outputWidth) ||
    !Number.isInteger(outputHeight) ||
    outputWidth < 64 ||
    outputHeight < 64
  ) {
    throw new Error("Top-view width and height must be integers of at least 64.");
  }
  const meterToPixel = sourceAligned
    ? inverseAffine(transform)
    : fitTransform(document, outputWidth, outputHeight, Number(padding));
  const walls = compiled.filter(
    (primitive) =>
      (primitive.shape === "box" || primitive.shape === "extruded_polygon") &&
      primitive.category === "shell" &&
      primitive.kind === "wall",
  );
  const wallSvg = walls.map((primitive) => {
    const points = primitiveFootprint(primitive)
      .map((point) => transformPoint(meterToPixel, point).join(","))
      .join(" ");
    return `<polygon points="${points}" fill="#111111"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">
<rect width="100%" height="100%" fill="#ffffff"/>
${wallSvg.join("\n")}
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
    compiled_wall_primitives: walls.length,
    compiled_primitives: compiled.length,
  };
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
  if (options.help) {
    process.stdout.write(`Usage:\n  node scripts/validation/render-scene-top-view.mjs --spatial-json spatial.json --output compiled-top-view.png [--metadata report.json]\n`);
    return;
  }
  const document = await readJson(options["spatial-json"], "Spatial JSON");
  const report = await renderSceneTopView(document, options.output, {
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

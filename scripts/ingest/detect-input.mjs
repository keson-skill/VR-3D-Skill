#!/usr/bin/env node

import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson } from "../lib/cli.mjs";

const ROUTES = new Map([
  [".dxf", { kind: "cad_vector", route: "dxf" }],
  [".dwg", { kind: "cad_binary", route: "convert_dwg_to_dxf" }],
  [".pdf", { kind: "document", route: "inspect_pdf" }],
  [".png", { kind: "raster_plan", route: "image" }],
  [".jpg", { kind: "raster_plan", route: "image" }],
  [".jpeg", { kind: "raster_plan", route: "image" }],
  [".webp", { kind: "raster_plan", route: "image" }],
  [".json", { kind: "structured_data", route: "spatial_json" }],
  [".glb", { kind: "scene_asset", route: "existing_scene" }],
  [".gltf", { kind: "scene_asset", route: "existing_scene" }],
  [".ifc", { kind: "bim", route: "convert_ifc" }],
]);

export function detectInput(filePath) {
  const extension = extname(filePath).toLowerCase();
  const matched = ROUTES.get(extension);
  if (!matched) {
    return {
      path: filePath,
      extension: extension || null,
      kind: "unknown",
      route: "manual_review",
      supported_now: false,
    };
  }
  return {
    path: filePath,
    extension,
    ...matched,
    supported_now: ["dxf", "image", "spatial_json", "existing_scene"].includes(
      matched.route,
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "array", required: true },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ingest/detect-input.mjs --input plan.dxf [--input room.png]\n",
    );
    return;
  }
  printJson({ inputs: options.input.map(detectInput) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

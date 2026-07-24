#!/usr/bin/env node

import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson } from "../lib/cli.mjs";

const ROUTES = new Map([
  [".dxf", { kind: "cad_vector", route: "dxf", supported_now: true }],
  [".dwg", { kind: "cad_binary", route: "convert_dwg_to_dxf", supported_now: true, requirements: ["approved_local_dwg_converter"] }],
  [".pdf", { kind: "document", route: "inspect_pdf", supported_now: true, requirements: ["poppler"] }],
  [".png", { kind: "raster_plan", route: "image", supported_now: true }],
  [".jpg", { kind: "raster_plan", route: "image", supported_now: true }],
  [".jpeg", { kind: "raster_plan", route: "image", supported_now: true }],
  [".webp", { kind: "raster_plan", route: "image", supported_now: true }],
  [".tif", { kind: "raster_plan", route: "image", supported_now: true }],
  [".tiff", { kind: "raster_plan", route: "image", supported_now: true }],
  [".avif", { kind: "raster_plan", route: "image", supported_now: true }],
  [".mp4", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".mov", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".m4v", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".webm", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".mkv", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".avi", { kind: "visual_video", route: "visual_video", supported_now: true, requirements: ["ffmpeg", "ffprobe"] }],
  [".ply", { kind: "point_cloud", route: "point_cloud", supported_now: true }],
  [".pcd", { kind: "point_cloud", route: "point_cloud", supported_now: true }],
  [".xyz", { kind: "point_cloud", route: "point_cloud", supported_now: true }],
  [".pts", { kind: "point_cloud", route: "point_cloud", supported_now: true }],
  [".las", { kind: "point_cloud_binary", route: "convert_point_cloud", supported_now: true, requirements: ["pdal"] }],
  [".laz", { kind: "point_cloud_binary", route: "convert_point_cloud", supported_now: true, requirements: ["pdal"] }],
  [".e57", { kind: "point_cloud_binary", route: "convert_point_cloud", supported_now: true, requirements: ["pdal"] }],
  [".json", { kind: "structured_data", route: "spatial_json", supported_now: true }],
  [".glb", { kind: "scene_asset", route: "existing_scene", supported_now: true }],
  [".gltf", { kind: "scene_asset", route: "existing_scene", supported_now: true }],
  [".obj", { kind: "scene_asset", route: "existing_scene", supported_now: true }],
  [".fbx", { kind: "scene_asset", route: "existing_scene", supported_now: true, requirements: ["approved_local_scene_converter"] }],
  [".ifc", { kind: "bim", route: "ifc", supported_now: true }],
  [".csv", { kind: "product_catalog", route: "catalog_table", supported_now: true }],
  [".tsv", { kind: "product_catalog", route: "catalog_table", supported_now: true }],
  [".xlsx", { kind: "product_catalog", route: "catalog_table", supported_now: true, requirements: ["libreoffice"] }],
]);

const IMAGE_ROLES = new Map([
  ["floor_plan", { kind: "raster_plan", route: "image" }],
  ["interior_photo", { kind: "interior_photo", route: "visual_image" }],
  ["multiview", { kind: "interior_multiview", route: "visual_image" }],
  ["panorama", { kind: "equirectangular_panorama", route: "visual_image" }],
  ["material_reference", { kind: "material_reference", route: "visual_image" }],
  ["depth", { kind: "depth_image", route: "depth_image" }],
]);

export function detectInput(filePath, { role = null } = {}) {
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
  const roleRoute = matched.route === "image" && role
    ? IMAGE_ROLES.get(role)
    : null;
  if (matched.route === "image" && role && !roleRoute) {
    return {
      path: filePath,
      extension,
      kind: "unknown_image_role",
      route: "manual_review",
      role,
      supported_now: false,
      requirements: [],
    };
  }
  return {
    path: filePath,
    extension,
    ...matched,
    ...(roleRoute || {}),
    role: role || (matched.route === "image" ? "floor_plan" : null),
    requirements: matched.requirements || [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "array", required: true },
    role: { type: "array" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ingest/detect-input.mjs --input plan.dxf [--input room.png]\n",
    );
    return;
  }
  if (options.role.length && options.role.length !== options.input.length) {
    throw new Error("When --role is used, provide one role for every input.");
  }
  printJson({
    inputs: options.input.map((input, index) =>
      detectInput(input, { role: options.role[index] || null })),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

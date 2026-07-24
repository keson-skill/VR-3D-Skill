#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../../lib/cli.mjs";
import { checkStageReadiness } from "../../orchestration/check-stage-readiness.mjs";

export function createAssetBrief(spatialJson, objectId, options = {}) {
  const designObject = spatialJson.design_objects?.find(
    (item) => item.id === objectId,
  );
  if (!designObject) {
    throw new Error(`Unknown design object ID: ${objectId}`);
  }
  const existingAsset = spatialJson.assets?.find(
    (item) => item.id === designObject.asset_id,
  );

  return {
    brief_version: "1.0",
    project_id: spatialJson.project.id,
    design_revision_id: spatialJson.project.revision,
    design_object_id: designObject.id,
    kind: designObject.kind,
    target_dimensions_meters: designObject.dimensions,
    style:
      options.style ||
      spatialJson.requirements?.design_intent?.style ||
      "match approved design",
    materials: options.materials || existingAsset?.material_slots || [],
    reference_asset_id: existingAsset?.id || null,
    views: options.views || ["front", "side", "back", "three-quarter"],
    polygon_budget: options.polygonBudget || 50000,
    target_format: "glb",
    normalization: {
      units: "meters",
      pivot: "bottom_center",
      forward_axis: "-Z",
      generate_collision_proxy: true,
    },
    forbidden_scope: [
      "walls",
      "openings",
      "room topology",
      "circulation planning",
      "whole-room redesign",
    ],
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/tasks/asset-generation/create-asset-brief.mjs --spatial-json approved-spatial.json --object-id furniture-sofa-01 --output sofa-brief.json [--style "warm cream"] [--polygon-budget 50000]

This command prepares a validated provider-neutral brief. It does not upload data or submit a Hunyuan3D job.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    "object-id": { type: "string", required: true },
    output: { type: "string", required: true },
    style: { type: "string" },
    "polygon-budget": { type: "string", default: "50000" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const spatialJson = await readJson(
    options["spatial-json"],
    "approved Spatial JSON",
  );
  const readiness = checkStageReadiness("assets", spatialJson);
  if (!readiness.ready) {
    throw new Error(
      `Asset brief blocked: ${readiness.blockers[0]?.message}`,
    );
  }
  const polygonBudget = Number(options["polygon-budget"]);
  if (!Number.isInteger(polygonBudget) || polygonBudget <= 0) {
    throw new Error("--polygon-budget must be a positive integer.");
  }

  const brief = createAssetBrief(spatialJson, options["object-id"], {
    style: options.style,
    polygonBudget,
  });
  await writeJson(options.output, brief);
  printJson({
    outputFile: options.output,
    designObjectId: brief.design_object_id,
    targetDimensionsMeters: brief.target_dimensions_meters,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

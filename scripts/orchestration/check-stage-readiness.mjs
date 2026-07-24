#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

const STAGES = new Set([
  "design",
  "preview",
  "assets",
  "engineering",
  "runtime",
]);

export function checkStageReadiness(
  stage,
  spatialJson,
  { assetManifest = null } = {},
) {
  if (!STAGES.has(stage)) {
    throw new Error(`Unknown stage ${stage}.`);
  }
  const spatial = validateSpatialJson(spatialJson, {
    requireApproved: true,
  });
  const blockers = spatial.errors.map((error) => ({
    source: "spatial-validation",
    ...error,
  }));
  const warnings = spatial.warnings.map((warning) => ({
    source: "spatial-validation",
    ...warning,
  }));

  if (
    ["preview", "assets", "engineering", "runtime"].includes(stage) &&
    (!Array.isArray(spatialJson.design_objects) ||
      spatialJson.design_objects.length === 0)
  ) {
    blockers.push({
      source: "stage-readiness",
      code: "design_objects.missing",
      path: "/design_objects",
      message: `${stage} requires at least one approved design object.`,
    });
  }

  if (stage === "preview") {
    if (!spatialJson.materials || Object.keys(spatialJson.materials).length === 0) {
      blockers.push({
        source: "stage-readiness",
        code: "materials.missing",
        path: "/materials",
        message: "Visual preview requires approved materials.",
      });
    }
    if (!Array.isArray(spatialJson.lights) || spatialJson.lights.length === 0) {
      warnings.push({
        source: "stage-readiness",
        code: "lights.missing",
        path: "/lights",
        message: "No approved lighting intent is available.",
      });
    }
  }

  if (stage === "engineering") {
    if (!assetManifest) {
      warnings.push({
        source: "stage-readiness",
        code: "asset_manifest.missing",
        path: "",
        message:
          "No asset manifest was supplied; engineering must use dimensionally correct proxies.",
      });
    } else if (!Array.isArray(assetManifest.assets)) {
      blockers.push({
        source: "stage-readiness",
        code: "asset_manifest.invalid",
        path: "/assets",
        message: "Asset manifest must contain an assets array.",
      });
    }
  }

  if (stage === "runtime" && !spatialJson.xr) {
    blockers.push({
      source: "stage-readiness",
      code: "xr.missing",
      path: "/xr",
      message: "Runtime verification requires an XR configuration.",
    });
  }

  return {
    stage,
    ready: blockers.length === 0,
    blockers,
    warnings,
    spatial_summary: spatial.summary,
    base_revision: spatialJson.project?.revision || null,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/orchestration/check-stage-readiness.mjs --stage preview --spatial-json approved-spatial.json [--asset-manifest assets.json] [--output readiness.json]

This deterministic gate never calls an external provider.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    stage: { type: "string", required: true },
    "spatial-json": { type: "string", required: true },
    "asset-manifest": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  if (!STAGES.has(options.stage)) {
    throw new Error(`--stage must be one of: ${[...STAGES].join(", ")}.`);
  }

  const [spatialJson, assetManifest] = await Promise.all([
    readJson(options["spatial-json"], "approved Spatial JSON"),
    options["asset-manifest"]
      ? readJson(options["asset-manifest"], "asset manifest")
      : Promise.resolve(null),
  ]);
  const report = checkStageReadiness(options.stage, spatialJson, {
    assetManifest,
  });
  if (options.output) {
    await writeJson(options.output, report);
    printJson({
      outputFile: options.output,
      stage: report.stage,
      ready: report.ready,
      blockers: report.blockers.length,
      warnings: report.warnings.length,
    });
  } else {
    printJson(report);
  }
  if (!report.ready) {
    process.exitCode = 1;
  }
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

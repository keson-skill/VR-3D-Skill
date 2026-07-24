#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";

function validateAsset(asset, path) {
  const errors = [];
  const requiredStrings = [
    "id",
    "uri",
    "format",
    "source",
    "license",
    "pivot",
    "forward_axis",
  ];
  for (const field of requiredStrings) {
    if (typeof asset?.[field] !== "string" || !asset[field].trim()) {
      errors.push({
        path: `${path}/${field}`,
        message: `${field} must be a non-empty string.`,
      });
    }
  }
  if (
    !Array.isArray(asset?.dimensions) ||
    asset.dimensions.length !== 3 ||
    asset.dimensions.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    errors.push({
      path: `${path}/dimensions`,
      message: "dimensions must contain three positive numbers in meters.",
    });
  }
  if (typeof asset?.optimized !== "boolean") {
    errors.push({
      path: `${path}/optimized`,
      message: "optimized must be a boolean.",
    });
  }
  return errors;
}

export function buildAssetManifest(entries, { target = "web" } = {}) {
  const assets = entries.flatMap((entry) =>
    Array.isArray(entry?.assets) ? entry.assets : [entry],
  );
  const errors = [];
  const warnings = [];
  const seen = new Set();

  assets.forEach((asset, index) => {
    const path = `/assets/${index}`;
    errors.push(...validateAsset(asset, path));
    if (seen.has(asset?.id)) {
      errors.push({ path: `${path}/id`, message: `Duplicate asset ID ${asset.id}.` });
    }
    seen.add(asset?.id);
    if (target === "web" && asset?.format?.toLowerCase() !== "glb") {
      errors.push({
        path: `${path}/format`,
        message: "Web targets require normalized GLB assets.",
      });
    }
    if (asset?.license === "verify_before_distribution") {
      warnings.push({
        path: `${path}/license`,
        message: "Verify the asset license before distribution.",
      });
    }
  });

  return {
    manifest: {
      manifest_version: "1.0",
      target,
      assets,
    },
    report: {
      valid: errors.length === 0,
      errors,
      warnings,
      asset_count: assets.length,
    },
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/processing/build-asset-manifest.mjs --entry asset-1.json [--entry asset-2.json] --output asset-manifest.json [--report asset-report.json] [--target web|native]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    entry: { type: "array", required: true },
    output: { type: "string", required: true },
    report: { type: "string" },
    target: { type: "string", default: "web" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  if (!["web", "native"].includes(options.target)) {
    throw new Error("--target must be web or native.");
  }

  const entries = await Promise.all(
    options.entry.map((filePath) => readJson(filePath, "asset entry")),
  );
  const result = buildAssetManifest(entries, { target: options.target });
  if (result.report.valid) {
    await writeJson(options.output, result.manifest);
  }
  if (options.report) {
    await writeJson(options.report, result.report);
  }
  printJson({
    outputFile: result.report.valid ? options.output : null,
    reportFile: options.report || null,
    ...result.report,
  });
  if (!result.report.valid) {
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

#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSourceManifest } from "../ingest/build-source-manifest.mjs";
import { detectInput } from "../ingest/detect-input.mjs";
import { extractDxfEvidence } from "../ingest/extract-dxf-evidence.mjs";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { preprocessPlanImage } from "../processing/preprocess-plan-image.mjs";

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function prepareInteriorJob(
  inputs,
  { outputDirectory, maxEdge = 4096 } = {},
) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("At least one input is required.");
  }
  const inputDirectory = join(outputDirectory, "inputs");
  const evidenceDirectory = join(outputDirectory, "evidence");
  await mkdir(inputDirectory, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  const sourceManifest = await buildSourceManifest(inputs);
  const routes = [];
  const blockers = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const source = inputs[index];
    const route = detectInput(source);
    const storedName = `${String(index + 1).padStart(2, "0")}-${safeName(basename(source))}`;
    const storedPath = join(inputDirectory, storedName);
    await copyFile(source, storedPath);
    const entry = {
      ...route,
      original_sha256: sourceManifest.sources[index].sha256,
      stored_path: storedPath,
      evidence: [],
    };
    if (route.route === "image") {
      const normalizedPath = join(
        evidenceDirectory,
        `${storedName.slice(0, -extname(storedName).length)}-normalized.png`,
      );
      const preprocessing = await preprocessPlanImage(
        storedPath,
        normalizedPath,
        { maxEdge },
      );
      const metadataPath = join(
        evidenceDirectory,
        `${storedName.slice(0, -extname(storedName).length)}-preprocess.json`,
      );
      await writeJson(metadataPath, preprocessing);
      entry.evidence.push({
        type: "normalized_raster",
        path: normalizedPath,
        sha256: sha256(await readFile(normalizedPath)),
        preprocessing_metadata: metadataPath,
        coordinate_transform: preprocessing.coordinate_transform,
      });
    } else if (route.route === "dxf") {
      const bytes = await readFile(storedPath);
      const evidence = extractDxfEvidence(bytes.toString("utf8"), {
        path: storedPath,
        sha256: sha256(bytes),
      });
      const evidencePath = join(evidenceDirectory, `${storedName}.json`);
      await writeJson(evidencePath, evidence);
      entry.evidence.push({
        type: "dxf_vector",
        path: evidencePath,
        drawing_units: evidence.coordinate_system.drawing_units,
        requires_scale_confirmation:
          evidence.coordinate_system.requires_scale_confirmation,
      });
    } else if (!route.supported_now) {
      blockers.push({
        input: source,
        route: route.route,
        message:
          route.route === "convert_dwg_to_dxf"
            ? "Convert DWG locally to DXF before spatial extraction."
            : route.route === "inspect_pdf"
              ? "Inspect whether the PDF is vector or raster, then export DXF or a lossless plan image."
              : `Input requires manual conversion or review: ${route.route}.`,
      });
    }
    routes.push(entry);
  }

  const preparedManifest = {
    ...sourceManifest,
    prepared_sources: routes,
  };
  const manifestPath = join(outputDirectory, "source-manifest.json");
  await writeJson(manifestPath, preparedManifest);
  const job = {
    schema_version: "1.0",
    stage: blockers.length > 0 ? "blocked" : "prepared",
    output_directory: outputDirectory,
    source_manifest: manifestPath,
    routes,
    blockers,
    next_actions: [
      ...(routes.some((route) => route.route === "image")
        ? [
            "Run local OCR on normalized raster evidence when Tesseract is available.",
            "Confirm at least one trustworthy scale anchor for raster-only plans.",
          ]
        : []),
      ...(routes.some(
        (route) =>
          route.route === "dxf" &&
          route.evidence.some((item) => item.requires_scale_confirmation),
      )
        ? ["Confirm the DXF drawing unit before converting coordinates to meters."]
        : []),
      "Generate draft Spatial JSON from the prepared evidence.",
      "Resolve validation blockers and explicitly approve visualization scope.",
      "Run build-viewable-scene.mjs to create GLB and the Web viewer.",
    ],
  };
  await writeJson(join(outputDirectory, "job.json"), job);
  return job;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "array", required: true },
    output: { type: "string", required: true },
    "max-edge": { type: "string", default: "4096" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/orchestration/prepare-interior-job.mjs \\
    --input plan.png [--input plan.dxf] \\
    --output runs/job-001
`);
    return;
  }
  const result = await prepareInteriorJob(options.input, {
    outputDirectory: options.output,
    maxEdge: Number(options["max-edge"]),
  });
  printJson({
    stage: result.stage,
    outputDirectory: result.output_directory,
    routes: result.routes.map((route) => ({
      path: route.path,
      route: route.route,
      evidence: route.evidence.length,
    })),
    blockers: result.blockers,
    nextActions: result.next_actions,
  });
  if (result.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

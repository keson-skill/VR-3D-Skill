#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSourceManifest } from "../ingest/build-source-manifest.mjs";
import { convertDwgToDxf } from "../ingest/convert-dwg-to-dxf.mjs";
import { detectInput } from "../ingest/detect-input.mjs";
import { extractDxfEvidence } from "../ingest/extract-dxf-evidence.mjs";
import {
  convertPointCloudToAscii,
  extractDepthEvidence,
  extractPointCloudEvidence,
} from "../ingest/extract-point-cloud-evidence.mjs";
import { extractIfcEvidence } from "../ingest/extract-ifc-evidence.mjs";
import { importProductCatalog } from "../ingest/import-product-catalog.mjs";
import {
  buildSceneImportContract,
  convertSceneToGlb,
  inspectExistingScene,
} from "../ingest/inspect-existing-scene.mjs";
import { inspectPdf } from "../ingest/inspect-pdf.mjs";
import {
  buildVisualReconstructionEvidence,
  inspectImageMedia,
  inspectVideoMedia,
} from "../ingest/inspect-visual-media.mjs";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { preprocessPlanImage } from "../processing/preprocess-plan-image.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function prepareInteriorJob(
  inputs,
  {
    outputDirectory,
    maxEdge = 4096,
    roles = [],
    dwgConverter = null,
    cameraRegistration = null,
    scaleAnchor = null,
    pointCloud = {},
    depthIntrinsics = null,
    sceneImport = {},
  } = {},
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
  const visualViews = [];
  const visualVideos = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const source = inputs[index];
    const route = detectInput(source, { role: roles[index] || null });
    const storedName = `${String(index + 1).padStart(2, "0")}-${safeName(basename(source))}`;
    const storedPath = join(inputDirectory, storedName);
    await copyFile(source, storedPath);
    const entry = {
      ...route,
      original_sha256: sourceManifest.sources[index].sha256,
      stored_path: storedPath,
      evidence: [],
    };
    try {
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
      } else if (route.route === "convert_dwg_to_dxf") {
        if (!dwgConverter) {
          throw new Error("Configure and explicitly approve a local DWG converter.");
        }
        const dxfPath = join(evidenceDirectory, `${storedName}.dxf`);
        const conversion = await convertDwgToDxf(storedPath, dxfPath, dwgConverter);
        const evidencePath = join(evidenceDirectory, `${storedName}-dwg-conversion.json`);
        await writeJson(evidencePath, conversion);
        entry.evidence.push({
          type: "dwg_converted_dxf",
          path: evidencePath,
          dxf_path: dxfPath,
          sha256: conversion.output.sha256,
          converter_version: conversion.converter.version,
        });
      } else if (route.route === "inspect_pdf") {
        const pdfDirectory = join(evidenceDirectory, `${storedName}-pdf`);
        const evidence = await inspectPdf(storedPath, pdfDirectory);
        const evidencePath = join(evidenceDirectory, `${storedName}-pdf.json`);
        await writeJson(evidencePath, evidence);
        entry.evidence.push({
          type: evidence.document_kind,
          path: evidencePath,
          pages: evidence.page_count,
        });
        blockers.push(...evidence.blockers.map((blocker) => ({
          input: source,
          route: route.route,
          message: `PDF page ${blocker.page}: ${blocker.message}`,
        })));
      } else if (route.route === "ifc") {
        const bytes = await readFile(storedPath);
        const evidence = extractIfcEvidence(bytes.toString("utf8"), {
          path: storedPath,
          fileSha256: sha256(bytes),
        });
        const evidencePath = join(evidenceDirectory, `${storedName}-ifc.json`);
        await writeJson(evidencePath, evidence);
        entry.evidence.push({
          type: "ifc_semantics",
          path: evidencePath,
          schema: evidence.header_schema,
          entities: evidence.entities.total,
          wall_axes: evidence.wall_axes.length,
        });
        blockers.push(...evidence.blockers.map((message) => ({
          input: source,
          route: route.route,
          message,
        })));
      } else if (["point_cloud", "convert_point_cloud"].includes(route.route)) {
        let evidence;
        if (route.route === "convert_point_cloud" && pointCloud.converter) {
          const convertedPath = join(evidenceDirectory, `${storedName}.ply`);
          const conversion = await convertPointCloudToAscii(
            storedPath,
            convertedPath,
            {
              ...pointCloud.converter,
              extractionOptions: pointCloud,
            },
          );
          evidence = {
            ...conversion.evidence,
            conversion: {
              source: conversion.source,
              output: conversion.output,
              converter: conversion.converter,
            },
          };
        } else {
          evidence = await extractPointCloudEvidence(storedPath, pointCloud);
        }
        const evidencePath = join(evidenceDirectory, `${storedName}-point-cloud.json`);
        await writeJson(evidencePath, evidence);
        entry.evidence.push({
          type: "point_cloud",
          path: evidencePath,
          source_points: evidence.source_points || 0,
          recommended_scope: evidence.quality.recommended_scope,
        });
        blockers.push(...evidence.quality.blockers.map((message) => ({
          input: source,
          route: route.route,
          message,
        })));
      } else if (route.route === "depth_image") {
        if (!depthIntrinsics) throw new Error("Depth image requires a camera-intrinsics sidecar.");
        const evidence = await extractDepthEvidence(
          storedPath,
          depthIntrinsics,
          pointCloud,
        );
        const evidencePath = join(evidenceDirectory, `${storedName}-depth.json`);
        await writeJson(evidencePath, evidence);
        entry.evidence.push({
          type: "depth_point_cloud",
          path: evidencePath,
          source_points: evidence.source_points,
          recommended_scope: evidence.quality.recommended_scope,
        });
        blockers.push(...evidence.quality.blockers.map((message) => ({
          input: source,
          route: route.route,
          message,
        })));
      } else if (route.route === "existing_scene") {
        let inspection;
        if (route.extension === ".fbx" && sceneImport.converter) {
          const convertedPath = join(evidenceDirectory, `${storedName}.glb`);
          const conversion = await convertSceneToGlb(
            storedPath,
            convertedPath,
            sceneImport.converter,
          );
          inspection = await inspectExistingScene(convertedPath);
          inspection.conversion = {
            source: conversion.source,
            output: {
              path: conversion.output,
              sha256: conversion.sha256,
              bytes: conversion.bytes,
            },
            converter: conversion.converter,
          };
        } else {
          inspection = await inspectExistingScene(storedPath, {
            unitScale: sceneImport.unitScale ?? null,
            upAxis: sceneImport.upAxis || null,
            forwardAxis: sceneImport.forwardAxis || null,
            handedness: sceneImport.handedness || null,
          });
        }
        const contract = buildSceneImportContract(inspection, {
          mode: sceneImport.mode || "spatial_reference",
          assetId: sceneImport.assetId || null,
          license: sceneImport.license || null,
          pivot: sceneImport.pivot || null,
          collisionProxy: sceneImport.collisionProxy === true,
        });
        const evidencePath = join(evidenceDirectory, `${storedName}-scene.json`);
        await writeJson(evidencePath, contract);
        entry.evidence.push({
          type: "existing_3d",
          path: evidencePath,
          mode: contract.mode,
          semantic_coverage: inspection.semantic_coverage || 0,
        });
        blockers.push(...contract.blockers.map((message) => ({
          input: source,
          route: route.route,
          message,
        })));
      } else if (route.route === "catalog_table") {
        const imported = await importProductCatalog(storedPath);
        const catalogPath = join(evidenceDirectory, `${storedName}-catalog.json`);
        const reportPath = join(evidenceDirectory, `${storedName}-catalog-validation.json`);
        await writeJson(catalogPath, imported.catalog);
        await writeJson(reportPath, imported.report);
        entry.evidence.push({
          type: "product_catalog",
          path: catalogPath,
          validation: reportPath,
          assets: imported.catalog.assets.length,
          source_sha256: imported.source.sha256,
        });
        blockers.push(...imported.report.errors.map((error) => ({
          input: source,
          route: route.route,
          message: `${error.path}: ${error.message}`,
        })));
      } else if (route.route === "visual_image") {
        const view = await inspectImageMedia(storedPath, route.role);
        if (route.role !== "material_reference") visualViews.push(view);
        entry.evidence.push({
          type: view.media_type,
          view_id: view.id,
          sha256: view.sha256,
          role: view.role,
        });
      } else if (route.route === "spatial_json") {
        const spatial = JSON.parse(await readFile(storedPath, "utf8"));
        const validation = validateSpatialJson(spatial);
        const validationPath = join(evidenceDirectory, `${storedName}-spatial-validation.json`);
        await writeJson(validationPath, validation);
        entry.evidence.push({
          type: "spatial_json",
          path: storedPath,
          validation: validationPath,
          valid: validation.valid,
          validation_status: spatial.validation?.status || null,
        });
        blockers.push(...validation.errors.map((error) => ({
          input: source,
          route: route.route,
          message: `${error.path || "/"}: ${error.message}`,
        })));
      } else if (route.route === "visual_video") {
        const video = await inspectVideoMedia(
          storedPath,
          join(evidenceDirectory, `${storedName}-frames`),
        );
        visualVideos.push(video);
        visualViews.push(...video.extracted_frames);
        entry.evidence.push({
          type: "video_keyframes",
          video_id: video.id,
          frames: video.extracted_frames.length,
        });
        blockers.push(...video.blockers.map((message) => ({
          input: source,
          route: route.route,
          message,
        })));
      } else if (!route.supported_now) {
        throw new Error(`Input requires manual conversion or review: ${route.route}.`);
      }
    } catch (error) {
      blockers.push({
        input: source,
        route: route.route,
        message: error.message,
      });
    }
    routes.push(entry);
  }

  if (visualViews.length > 0) {
    const visualEvidence = buildVisualReconstructionEvidence(visualViews, {
      registration: cameraRegistration,
      scaleAnchor,
    });
    visualEvidence.videos = visualVideos;
    const visualEvidencePath = join(evidenceDirectory, "visual-reconstruction.json");
    await writeJson(visualEvidencePath, visualEvidence);
    blockers.push(...visualEvidence.blockers.map((blocker) => ({
      input: blocker.view_id || "visual-group",
      route: "visual_reconstruction",
      message: blocker.message,
    })));
    for (const route of routes.filter((candidate) =>
      ["visual_image", "visual_video"].includes(candidate.route))) {
      route.evidence.push({
        type: "visual_reconstruction_contract",
        path: visualEvidencePath,
        recommended_scope: visualEvidence.recommended_scope,
      });
    }
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
      ...(routes.some((route) => ["visual_image", "visual_video"].includes(route.route))
        ? ["Validate camera registration and a metric scale anchor; treat missing geometry as explicit inference."]
        : []),
      ...(routes.some((route) => route.route === "ifc")
        ? ["Review IFC semantic mapping, wall-axis topology, storey selection, and unresolved opening hosts."]
        : []),
      ...(routes.some((route) => ["point_cloud", "convert_point_cloud", "depth_image"].includes(route.route))
        ? ["Review metric scale, up axis, filtering, detected planes, and point-density quality."]
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
    role: { type: "array" },
    registration: { type: "string" },
    "scale-anchor": { type: "string" },
    "depth-intrinsics": { type: "string" },
    "point-unit-scale": { type: "string", default: "1" },
    "point-up-axis": { type: "string", default: "Y" },
    "point-scale-confirmed": { type: "boolean" },
    "point-converter": { type: "string", default: "pdal" },
    "allow-point-converter": { type: "boolean" },
    "scene-mode": { type: "string", default: "spatial_reference" },
    "scene-unit-scale": { type: "string" },
    "scene-up-axis": { type: "string" },
    "scene-forward-axis": { type: "string" },
    "scene-handedness": { type: "string" },
    "scene-asset-id": { type: "string" },
    "scene-license": { type: "string" },
    "scene-pivot": { type: "string" },
    "scene-collision-proxy": { type: "boolean" },
    "scene-converter": { type: "string" },
    "scene-converter-arg": { type: "array" },
    "allow-scene-converter": { type: "boolean" },
    "dwg-converter": { type: "string" },
    "dwg-arg": { type: "array" },
    "allow-dwg-converter": { type: "boolean" },
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
  if (options.role.length && options.role.length !== options.input.length) {
    throw new Error("When --role is used, provide one role for every input.");
  }
  const [cameraRegistration, scaleAnchor, depthIntrinsics] = await Promise.all([
    options.registration ? JSON.parse(await readFile(options.registration, "utf8")) : null,
    options["scale-anchor"] ? JSON.parse(await readFile(options["scale-anchor"], "utf8")) : null,
    options["depth-intrinsics"] ? JSON.parse(await readFile(options["depth-intrinsics"], "utf8")) : null,
  ]);
  const result = await prepareInteriorJob(options.input, {
    outputDirectory: options.output,
    maxEdge: Number(options["max-edge"]),
    roles: options.role,
    cameraRegistration,
    scaleAnchor,
    depthIntrinsics,
    pointCloud: {
      unitScale: Number(options["point-unit-scale"]),
      upAxis: options["point-up-axis"].toUpperCase(),
      scaleConfirmed: options["point-scale-confirmed"],
      converter: options["allow-point-converter"]
        ? {
            command: options["point-converter"],
            converterApproved: true,
          }
        : null,
    },
    sceneImport: {
      mode: options["scene-mode"],
      unitScale: options["scene-unit-scale"] ? Number(options["scene-unit-scale"]) : null,
      upAxis: options["scene-up-axis"]?.toUpperCase() || null,
      forwardAxis: options["scene-forward-axis"]?.toUpperCase() || null,
      handedness: options["scene-handedness"]?.toLowerCase() || null,
      assetId: options["scene-asset-id"],
      license: options["scene-license"],
      pivot: options["scene-pivot"],
      collisionProxy: options["scene-collision-proxy"],
      converter: options["scene-converter"]
        ? {
            command: options["scene-converter"],
            argumentsTemplate: options["scene-converter-arg"],
            converterApproved: options["allow-scene-converter"],
          }
        : null,
    },
    dwgConverter: options["dwg-converter"]
      ? {
          command: options["dwg-converter"],
          argumentsTemplate: options["dwg-arg"],
          converterApproved: options["allow-dwg-converter"],
        }
      : null,
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

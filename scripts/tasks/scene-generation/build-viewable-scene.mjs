#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWebViewer } from "../../builders/build-web-viewer.mjs";
import { writeGlb } from "../../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../../geometry/spatial-geometry.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../../lib/cli.mjs";
import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";
import { validateGlbBytes } from "../../validation/validate-glb.mjs";

const MODES = new Map([
  ["shell", "毛坯房"],
  ["hard-furnishing", "硬装房"],
  ["furnished", "精装房"],
]);

function sceneBounds(document) {
  const points = (document.envelope?.walls || []).flatMap((wall) => [
    wall.start,
    wall.end,
  ]);
  if (points.length === 0) return { min: [-2, -2], max: [2, 2] };
  return {
    min: [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
    ],
    max: [
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ],
  };
}

export async function buildViewableScene(
  spatialJson,
  {
    outputDirectory,
    mode = "furnished",
    sourcePath = null,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust = null,
    allowTestApproval = false,
  },
) {
  if (!MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...MODES.keys()].join(", ")}.`);
  }
  const validation = validateSpatialJson(spatialJson, {
    requireApproved: true,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
    allowTestApproval,
  });
  if (!validation.valid) {
    throw new Error(
      `Approved Spatial JSON is invalid: ${validation.errors
        .map((error) => `${error.code} ${error.path}`)
        .join("; ")}`,
    );
  }
  await mkdir(outputDirectory, { recursive: true });
  const sceneFile = join(outputDirectory, "scene.glb");
  let primitives = compileScenePrimitives(spatialJson);
  if (mode === "shell") {
    primitives = primitives.filter((item) => item.category !== "furniture");
  } else if (mode === "hard-furnishing") {
    primitives = primitives.filter(
      (item) => item.category !== "furniture" || item.fixed,
    );
  }
  await writeGlb(sceneFile, spatialJson, primitives);
  const sceneBytes = await readFile(sceneFile);
  const glbValidation = validateGlbBytes(sceneBytes, {
    expectedProject: spatialJson.project,
  });
  if (!glbValidation.valid) {
    throw new Error(
      `Generated GLB failed structural validation: ${glbValidation.errors
        .map((error) => `${error.code} ${error.path || ""}`)
        .join("; ")}`,
    );
  }
  const manifest = {
    schema_version: "1.0",
    project: {
      id: spatialJson.project.id,
      name: spatialJson.project.name || spatialJson.project.id,
      revision: spatialJson.project.revision,
    },
    mode,
    mode_label: MODES.get(mode),
    approval_scope: spatialJson.validation.approved_scope,
    spatial_approval: {
      id: approval.approval_id,
      approver: approval.decision.approver,
      approved_at: approval.decision.approved_at,
      scope: approval.decision.scope,
      spatial_sha256: approval.bindings.spatial_json.sha256,
      signature_key_id: approval.signature.key_id,
    },
    scene: "./scene.glb",
    scene_sha256: sha256(sceneBytes),
    bounds: sceneBounds(spatialJson),
    xr: spatialJson.xr || null,
    counts: {
      primitives: primitives.length,
      rooms: spatialJson.rooms.length,
      structural_elements: (spatialJson.envelope?.architectural_elements || [])
        .length,
      design_objects: primitives.filter((item) => item.category === "furniture")
        .length,
    },
    glb_validation: glbValidation.summary,
    limitations: [
      ...(spatialJson.validation.approved_scope === "visualization_only"
        ? ["Not approved for construction, procurement, or exact layout."]
        : []),
      "Generated furniture without a resolved asset is represented by a dimensionally sized proxy.",
      "Browser first-person mode is a preview and does not certify collision or accessibility.",
    ],
  };
  await buildWebViewer(outputDirectory, manifest);
  await writeJson(
    join(outputDirectory, "approval-verification-report.json"),
    validation,
  );
  await writeJson(join(outputDirectory, "glb-validation-report.json"), glbValidation);
  await writeJson(join(outputDirectory, "validation-report.json"), validation);
  await writeJson(join(outputDirectory, "source-manifest.json"), sourceManifest);
  await writeJson(
    join(outputDirectory, "spatial-validation.json"),
    validationReport,
  );
  await writeJson(join(outputDirectory, "spatial-approval.json"), approval);
  if (approvalTrust) {
    await writeJson(
      join(outputDirectory, "spatial-approval-trust.json"),
      approvalTrust,
    );
  }
  if (sourcePath) {
    await copyFile(sourcePath, join(outputDirectory, "spatial.json"));
  } else {
    await writeJson(join(outputDirectory, "spatial.json"), spatialJson);
  }
  return {
    outputDirectory,
    sceneFile,
    viewer: join(outputDirectory, "index.html"),
    manifest,
    validation,
    glbValidation,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/tasks/scene-generation/build-viewable-scene.mjs \\
    --spatial-json approved-spatial.json \\
    --source-manifest source-manifest.json \\
    --validation-report spatial-validation.json \\
    --approval spatial-approval.json \\
    --approval-trust spatial-approval-trust.json \\
    --output runs/project-001 \\
    [--mode shell|hard-furnishing|furnished]

Serve the output over HTTP; opening index.html directly cannot fetch the GLB.
Example: npx http-server runs/project-001
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    "validation-report": { type: "string", required: true },
    approval: { type: "string", required: true },
    "approval-trust": { type: "string", required: true },
    output: { type: "string", required: true },
    mode: { type: "string", default: "furnished" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const [
    spatialJson,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
  ] =
    await Promise.all([
      readJson(options["spatial-json"], "approved Spatial JSON"),
      readJson(options["source-manifest"], "source manifest"),
      readJson(options["validation-report"], "validation report"),
      readJson(options.approval, "spatial approval"),
      readJson(options["approval-trust"], "spatial approval trust store"),
    ]);
  const result = await buildViewableScene(spatialJson, {
    outputDirectory: options.output,
    mode: options.mode,
    sourcePath: options["spatial-json"],
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
  });
  printJson({
    outputDirectory: result.outputDirectory,
    sceneFile: result.sceneFile,
    viewer: result.viewer,
    approvalScope: result.manifest.approval_scope,
    counts: result.manifest.counts,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

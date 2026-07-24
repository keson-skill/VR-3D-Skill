#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  assertModelAvailable,
  generateSpatialJson,
} from "../../adapters/realmrouter-openai.mjs";
import {
  imageFileToDataUrl,
  parseArgs,
  printJson,
  readJson,
  requireProviderApproval,
  sha256,
  writeJson,
} from "../../lib/cli.mjs";
import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";

function finiteArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

export function validateVisualReconstructionResult(result, evidence) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  const evidenceViews = Array.isArray(evidence?.views) ? evidence.views : [];
  const viewIds = new Set(evidenceViews.map((view) => view.id));
  if (!Array.isArray(result?.camera_estimates) || result.camera_estimates.length !== evidenceViews.length) {
    add("visual.cameras", "/camera_estimates", "Return exactly one camera estimate per input view.");
  } else {
    const cameraViewIds = new Set();
    for (const [index, camera] of result.camera_estimates.entries()) {
      if (!viewIds.has(camera.view_id)) add("visual.camera_view", `/camera_estimates/${index}/view_id`, "Camera references an unknown view.");
      if (cameraViewIds.has(camera.view_id)) add("visual.camera_duplicate", `/camera_estimates/${index}/view_id`, "Camera estimate view IDs must be unique.");
      cameraViewIds.add(camera.view_id);
      if (camera.projection === "perspective") {
        if (
          !camera.intrinsics
          || !["fx", "fy", "cx", "cy"].every((key) => Number.isFinite(camera.intrinsics[key]))
        ) {
          add("visual.intrinsics", `/camera_estimates/${index}/intrinsics`, "Perspective camera requires finite intrinsics.");
        }
      } else if (camera.projection !== "equirectangular") {
        add("visual.projection", `/camera_estimates/${index}/projection`, "Projection must be perspective or equirectangular.");
      }
      if (camera.camera_to_world && !finiteArray(camera.camera_to_world, 16)) {
        add("visual.camera_transform", `/camera_estimates/${index}/camera_to_world`, "Camera transform must contain 16 finite values.");
      }
      if (!Number.isFinite(camera.confidence) || camera.confidence < 0 || camera.confidence > 1) {
        add("visual.camera_confidence", `/camera_estimates/${index}/confidence`, "Camera confidence must be from 0 to 1.");
      }
    }
  }
  for (const [field, allowedKinds] of [
    ["visible_surfaces", new Set(["wall", "floor", "ceiling", "door", "window", "fixed_fixture"])],
    ["fixed_objects", null],
  ]) {
    if (!Array.isArray(result?.[field])) {
      add(`visual.${field}`, `/${field}`, `${field} must be an array.`);
      continue;
    }
    result[field].forEach((item, index) => {
      if (typeof item.id !== "string" || !item.id.trim()) add("visual.stable_id", `/${field}/${index}/id`, "Evidence item requires a stable ID.");
      if (!Array.isArray(item.view_ids) || item.view_ids.length === 0 || item.view_ids.some((id) => !viewIds.has(id))) {
        add("visual.view_ids", `/${field}/${index}/view_ids`, "Evidence item must reference known views.");
      }
      if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        add("visual.confidence", `/${field}/${index}/confidence`, "Confidence must be from 0 to 1.");
      }
      if (allowedKinds && !allowedKinds.has(item.kind)) {
        add("visual.surface_kind", `/${field}/${index}/kind`, "Visible surface kind is unsupported.");
      }
    });
  }
  if (!Array.isArray(result?.inferred_geometry)) {
    add("visual.inferred_geometry", "/inferred_geometry", "Explicitly list inferred or occluded geometry.");
  } else {
    result.inferred_geometry.forEach((item, index) => {
      if (typeof item.id !== "string" || !item.id.trim()) {
        add("visual.inference_id", `/inferred_geometry/${index}/id`, "Inferred geometry requires a stable ID.");
      }
      if (typeof item.reason !== "string" || !item.reason.trim()) {
        add("visual.inference_reason", `/inferred_geometry/${index}/reason`, "Inferred geometry requires an explicit reason.");
      }
      if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        add("visual.inference_confidence", `/inferred_geometry/${index}/confidence`, "Inference confidence must be from 0 to 1.");
      }
    });
  }
  const spatialValidation = validateSpatialJson(result?.spatial_json);
  errors.push(...spatialValidation.errors.map((error) => ({
    ...error,
    path: `/spatial_json${error.path || ""}`,
  })));
  if (result?.spatial_json?.extraction?.source_kind !== "visual") {
    add("visual.source_kind", "/spatial_json/extraction/source_kind", "Visual reconstruction must declare source_kind visual.");
  }
  if (
    result?.spatial_json?.validation?.status !== "pending"
    || result?.spatial_json?.validation?.approved_scope !== null
  ) {
    add("visual.approval", "/spatial_json/validation", "Model output must remain pending and unapproved.");
  }
  if (result?.spatial_json?.extraction?.recommended_scope !== "visualization_only") {
    add("visual.scope", "/spatial_json/extraction/recommended_scope", "Visual reconstruction is limited to visualization_only.");
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: [
      {
        code: "visual.not_construction_ready",
        path: "/spatial_json",
        message: "Camera and image evidence never prove hidden construction geometry.",
      },
    ],
    spatial_validation: spatialValidation,
  };
}

export function buildVisualReconstructionPrompt(evidence, projectId) {
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "uri" && key !== "path" && key !== "stored_path" && !key.endsWith("_path"))
        .map(([key, child]) => [key, sanitize(child)]),
    );
  };
  const sanitized = sanitize(evidence);
  return `Reconstruct a visualization-only interior Spatial JSON draft from the approved visual evidence.

Project ID: ${projectId}
Evidence contract:
${JSON.stringify(sanitized, null, 2)}

Return one JSON object with:
- camera_estimates: one per view, with projection, intrinsics when perspective, optional camera_to_world, and confidence;
- visible_surfaces: stable ID, kind, supporting view_ids, confidence, and observed geometry;
- fixed_objects: stable ID, kind, supporting view_ids, confidence, and observed bounds;
- inferred_geometry: every occluded or guessed surface, its reason, and confidence;
- spatial_json: schema 1.0, meters/Y-up/right-handed, source_kind "visual", source-bound observed/inferred provenance, explicit assumptions/questions, recommended_scope "visualization_only", validation.status "pending", and approved_scope null.

Use the supplied metric scale and validated registration when available. Do not invent construction dimensions, hidden openings, structural roles, or human approval. Preserve uncertainty explicitly.`;
}

export async function extractVisualSpatial(
  evidence,
  imagePaths,
  projectId,
  {
    generate,
  },
) {
  const blockers = Array.isArray(evidence?.blockers) ? evidence.blockers : [];
  if (blockers.length > 0) {
    const first = blockers[0];
    const message = typeof first === "string" ? first : first?.message || JSON.stringify(first);
    throw new Error(`Visual reconstruction evidence is blocked: ${message}.`);
  }
  if (!Array.isArray(evidence?.views) || imagePaths.length !== evidence.views.length) {
    throw new Error("Provide exactly one image path for every visual evidence view.");
  }
  const imageBytes = await Promise.all(imagePaths.map((imagePath) => readFile(imagePath)));
  for (let index = 0; index < imageBytes.length; index += 1) {
    if (sha256(imageBytes[index]) !== evidence.views[index].sha256) {
      throw new Error(`Image ${index + 1} does not match visual evidence SHA-256.`);
    }
  }
  const imageDataUrls = await Promise.all(imagePaths.map(imageFileToDataUrl));
  const providerResult = await generate(
    buildVisualReconstructionPrompt(evidence, projectId),
    imageDataUrls,
  );
  const result = providerResult.spatialJson ?? providerResult;
  return {
    result,
    validation: validateVisualReconstructionResult(result, evidence),
    provider: {
      model: providerResult.model || null,
      request_id: providerResult.requestId || null,
      usage: providerResult.usage || null,
      attempts: providerResult.attempts || null,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    evidence: { type: "string", required: true },
    image: { type: "array", required: true },
    "project-id": { type: "string", required: true },
    output: { type: "string", required: true },
    validation: { type: "string" },
    metadata: { type: "string" },
    "allow-provider": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node --env-file=.env scripts/tasks/visual-reconstruction/extract-visual-spatial.mjs --evidence visual-evidence.json --image room-a.jpg [--image room-b.jpg] --project-id project-001 --output visual-spatial-result.json --allow-provider\n");
    return;
  }
  requireProviderApproval(options);
  const evidence = await readJson(options.evidence, "visual reconstruction evidence");
  const apiKey = process.env.REALMROUTER_SPATIAL_API_KEY || "";
  const baseUrl = process.env.REALMROUTER_BASE_URL;
  const model = process.env.REALMROUTER_SPATIAL_MODEL || "gpt-5.5";
  await assertModelAvailable({
    apiKey,
    baseUrl,
    model,
    routeLabel: "visual reconstruction",
    timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
    maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
  });
  const result = await extractVisualSpatial(
    evidence,
    options.image,
    options["project-id"],
    {
      generate: (prompt, imageDataUrls) => generateSpatialJson({
        apiKey,
        baseUrl,
        model,
        reasoningEffort: process.env.REALMROUTER_SPATIAL_REASONING_EFFORT,
        prompt,
        imageDataUrls,
        timeoutMs: Number(process.env.REALMROUTER_TIMEOUT_MS || 120000),
        maxRetries: Number(process.env.REALMROUTER_MAX_RETRIES || 3),
      }),
    },
  );
  await writeJson(options.output, result.result);
  if (options.validation) await writeJson(options.validation, result.validation);
  if (options.metadata) await writeJson(options.metadata, result.provider);
  printJson({
    outputFile: options.output,
    valid: result.validation.valid,
    errors: result.validation.errors.length,
    model: result.provider.model,
    requestId: result.provider.request_id,
  });
  if (!result.validation.valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import {
  lstat,
  readdir,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";
import { parseGlb, validateGlbBytes } from "../validation/validate-glb.mjs";

async function directoryBytes(directory) {
  const rootMetadata = await lstat(directory);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Viewer root must be a regular non-symlink directory.");
  }
  const pending = [directory];
  let total = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > 10000) {
        throw new Error("Viewer directory exceeds the 10000-entry audit limit.");
      }
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Viewer directory contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) total += metadata.size;
      if (total > 2 * 1024 * MiB) {
        throw new Error("Viewer directory exceeds the 2 GiB audit limit.");
      }
    }
  }
  return total;
}

function gltfMetrics(gltf) {
  const accessors = gltf.accessors || [];
  const bufferViews = gltf.bufferViews || [];
  const primitives = (gltf.meshes || []).flatMap((mesh) => mesh.primitives || []);
  const textureViews = new Set(
    (gltf.images || [])
      .map((image) => image.bufferView)
      .filter(Number.isInteger),
  );
  return {
    draw_calls: primitives.length,
    texture_bytes: [...textureViews]
      .reduce((total, index) => total + (bufferViews[index]?.byteLength || 0), 0),
    materials: gltf.materials?.length || 0,
    lights: gltf.extensions?.KHR_lights_punctual?.lights?.length || 0,
    indexed_primitives: primitives.filter((primitive) =>
      Number.isInteger(primitive.indices) && accessors[primitive.indices]).length,
  };
}

function compareBudget(metrics, budget) {
  const checks = [
    ["glb_bytes", "max_glb_bytes"],
    ["delivery_bytes", "max_delivery_bytes"],
    ["triangles", "max_triangles"],
    ["draw_calls", "max_draw_calls"],
    ["texture_bytes", "max_texture_bytes"],
    ["materials", "max_materials"],
    ["lights", "max_lights"],
  ].map(([metric, limit]) => ({
    metric,
    actual: metrics[metric],
    limit: budget[limit],
    passed: Number.isFinite(metrics[metric])
      && Number.isFinite(budget[limit])
      && metrics[metric] <= budget[limit],
  }));
  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export async function auditScenePerformance(
  sceneFile,
  viewerDirectory,
  budgets,
  profile,
) {
  const budget = budgets?.profiles?.[profile];
  if (!budget) throw new Error(`Unknown performance profile ${profile}.`);
  const { bytes } = await readBoundedFile(sceneFile, {
    label: "Performance scene",
    maxBytes: 512 * MiB,
  });
  const structural = validateGlbBytes(bytes);
  const parsed = parseGlb(bytes);
  if (!parsed.gltf) {
    throw new Error(`Cannot audit invalid GLB: ${parsed.errors[0]?.message || "missing glTF"}.`);
  }
  const metrics = {
    glb_bytes: bytes.length,
    delivery_bytes: viewerDirectory
      ? await directoryBytes(viewerDirectory)
      : bytes.length,
    triangles: structural.summary.triangles,
    ...gltfMetrics(parsed.gltf),
  };
  const budgetResult = compareBudget(metrics, budget);
  const report = {
    schema_version: "1.0",
    profile,
    passed: structural.valid && budgetResult.passed,
    scene: {
      sha256: sha256(bytes),
      extension: extname(sceneFile).toLowerCase(),
    },
    metrics,
    budget,
    checks: budgetResult.checks,
    structural_validation: {
      valid: structural.valid,
      errors: structural.errors,
    },
    limitations: [
      "Static GLB metrics do not measure browser, mobile GPU, headset, network, or Blender frame time.",
      "Use a real performance qualification record for each target device and software stack.",
    ],
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    scene: { type: "string", required: true },
    viewer: { type: "string" },
    budgets: { type: "string", default: "config/performance-budgets.json" },
    profile: { type: "string", default: "web_desktop" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/performance/audit-scene.mjs --scene scene.glb [--viewer viewer] --profile web_desktop [--output report.json]\n");
    return;
  }
  const budgets = await readJson(
    options.budgets,
    "performance budgets",
    { maxBytes: MiB },
  );
  const report = await auditScenePerformance(
    options.scene,
    options.viewer || null,
    budgets,
    options.profile,
  );
  if (options.output) await writeJson(options.output, report);
  printJson({
    outputFile: options.output || null,
    profile: report.profile,
    passed: report.passed,
    metrics: report.metrics,
  });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

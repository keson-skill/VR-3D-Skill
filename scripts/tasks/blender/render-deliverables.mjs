#!/usr/bin/env node

import {
  copyFile,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBlenderRenderPlan } from "./build-render-plan.mjs";
import {
  GiB,
  hashBoundedFile,
} from "../../ingest/file-safety.mjs";
import { runTool } from "../../ingest/tool-runner.mjs";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../../lib/cli.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.message.includes("ENOENT")) return null;
    throw error;
  }
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}

async function ensureSafeDirectory(root, relativeDirectory) {
  const target = resolve(root, relativeDirectory);
  if (target !== root && !contained(root, target)) {
    throw new Error(`Render directory escapes the output root: ${relativeDirectory}`);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Render directory must not be a symbolic link: ${relativeDirectory}`);
  }
  const canonical = await realpath(target);
  if (canonical !== root && !contained(root, canonical)) {
    throw new Error(`Render directory resolves outside the output root: ${relativeDirectory}`);
  }
  return canonical;
}

async function ensureSafeDestination(root, relativeFile) {
  if (
    typeof relativeFile !== "string"
    || !relativeFile
    || isAbsolute(relativeFile)
  ) {
    throw new Error("Render artifact path must be relative.");
  }
  const target = resolve(root, relativeFile);
  if (!contained(root, target)) {
    throw new Error(`Render artifact escapes the output root: ${relativeFile}`);
  }
  await ensureSafeDirectory(root, relative(root, dirname(target)));
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Render artifact must be a regular non-symlink file: ${relativeFile}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}

async function hashArtifact(root, relativeFile, kind) {
  const target = await ensureSafeDestination(root, relativeFile);
  const { metadata, sha256 } = await hashBoundedFile(target, {
    label: `Blender ${kind} artifact`,
    maxBytes: 2 * GiB,
  });
  return {
    kind,
    file: `./${relativeFile}`,
    bytes: metadata.size,
    sha256,
  };
}

export async function renderDeliverables(
  spatialJson,
  {
    sceneFile,
    outputDirectory,
    blender = "blender",
    walkthrough = false,
    force = false,
    renderTimeoutMs = 2 * 60 * 60 * 1000,
    run = runTool,
  },
) {
  if (
    !Number.isInteger(renderTimeoutMs)
    || renderTimeoutMs < 1000
    || renderTimeoutMs > 24 * 60 * 60 * 1000
  ) {
    throw new Error("renderTimeoutMs must be from 1 second to 24 hours.");
  }
  const requestedOutput = resolve(outputDirectory);
  const absoluteScene = resolve(sceneFile);
  await mkdir(requestedOutput, { recursive: true, mode: 0o700 });
  const outputMetadata = await lstat(requestedOutput);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("Blender output must be a regular non-symlink directory.");
  }
  const absoluteOutput = await realpath(requestedOutput);
  const sceneEvidence = await hashBoundedFile(absoluteScene, {
    label: "Blender source scene",
    maxBytes: 2 * GiB,
  });
  const unboundPlan = buildBlenderRenderPlan(spatialJson, {
    scene: absoluteScene,
    outputDirectory: absoluteOutput,
    walkthrough,
  });
  const { plan_sha256: _unboundHash, ...planBody } = unboundPlan;
  const boundPlanBody = {
    ...planBody,
    source_scene_sha256: sceneEvidence.sha256,
  };
  const plan = {
    ...boundPlanBody,
    plan_sha256: canonicalJsonSha256(boundPlanBody),
  };
  const planFile = await ensureSafeDestination(absoluteOutput, "render-plan.json");
  await writeJson(planFile, plan);
  await ensureSafeDirectory(absoluteOutput, "panorama");
  await ensureSafeDirectory(absoluteOutput, "vendor");
  for (const file of ["index.html", "styles.css", "app.js"]) {
    const destination = await ensureSafeDestination(absoluteOutput, join("panorama", file));
    await copyFile(join(ROOT, "assets", "panorama-player", file), destination);
  }
  const threeDestination = await ensureSafeDestination(
    absoluteOutput,
    join("vendor", "three.module.js"),
  );
  await copyFile(
    join(ROOT, "node_modules", "three", "build", "three.module.js"),
    threeDestination,
  );

  const manifestFile = await ensureSafeDestination(absoluteOutput, "render-manifest.json");
  const checkpointFile = await ensureSafeDestination(absoluteOutput, plan.checkpoint_file);
  const artifactSpecs = [
    ...plan.stills.map((item) => [item.file, "still"]),
    [plan.panorama.file, "panorama"],
    [plan.blend_file, "blend"],
    ...(plan.optional_walkthrough.enabled
      ? [[plan.optional_walkthrough.file, "walkthrough"]]
      : []),
  ];
  const priorCheckpoint = await readJsonIfPresent(checkpointFile);
  const priorManifest = await readJsonIfPresent(manifestFile);
  if (
    !force
    && priorCheckpoint?.state === "completed"
    && priorCheckpoint?.detail?.plan_sha256 === plan.plan_sha256
    && priorManifest?.plan_sha256 === plan.plan_sha256
  ) {
    try {
      const verifiedArtifacts = await Promise.all(
        artifactSpecs.map(([file, kind]) => hashArtifact(absoluteOutput, file, kind)),
      );
      if (
        JSON.stringify(verifiedArtifacts)
        === JSON.stringify(priorManifest.artifacts)
      ) {
        return { plan, manifest: priorManifest, resumed: true };
      }
    } catch {
      // Missing, unsafe, or changed artifacts force a fresh bounded render.
    }
  }
  await Promise.all(
    artifactSpecs.map(([file]) => ensureSafeDestination(absoluteOutput, file)),
  );

  let versionResult;
  try {
    versionResult = await run(blender, ["--version"], {
      timeoutMs: 10000,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT") error.code = "BLENDER_UNAVAILABLE";
    throw error;
  }
  const blenderVersion = versionResult.stdout.split(/\r?\n/u).find((line) => line.trim())?.trim();
  if (!blenderVersion) throw new Error("Blender did not report a version.");
  try {
    await run(
      blender,
      [
        "--background",
        "--python",
        join(ROOT, "scripts", "blender", "render_scene.py"),
        "--",
        planFile,
      ],
      {
        timeoutMs: renderTimeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (error.code === "ENOENT") error.code = "BLENDER_UNAVAILABLE";
    throw error;
  }
  const checkpoint = await readJson(checkpointFile, "Blender checkpoint");
  if (
    checkpoint.state !== "completed"
    || checkpoint.detail?.plan_sha256 !== plan.plan_sha256
  ) {
    throw new Error(
      `Blender render did not complete the current plan: ${checkpoint.state}.`,
    );
  }

  const artifacts = await Promise.all(
    artifactSpecs.map(([file, kind]) => hashArtifact(absoluteOutput, file, kind)),
  );
  const manifest = {
    schema_version: "1.0",
    project_id: spatialJson.project.id,
    revision: spatialJson.project.revision,
    blender_version: blenderVersion,
    plan_sha256: plan.plan_sha256,
    source_scene_sha256: plan.source_scene_sha256,
    panorama_player: "./panorama/index.html",
    panorama: "./panorama/panorama-360.png",
    blend_file: `./${plan.blend_file}`,
    stills: plan.stills.map((item) => `./${item.file}`),
    walkthrough: plan.optional_walkthrough.enabled
      ? `./${plan.optional_walkthrough.file}`
      : null,
    artifacts,
  };
  await writeJson(manifestFile, manifest);
  return { plan, manifest, resumed: false };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    spatial: { type: "string", required: true },
    scene: { type: "string", required: true },
    output: { type: "string", required: true },
    blender: { type: "string", default: "blender" },
    walkthrough: { type: "boolean" },
    force: { type: "boolean" },
    "timeout-ms": { type: "string", default: String(2 * 60 * 60 * 1000) },
    help: { type: "boolean" },
  });
  if (options.help) return process.stdout.write("Usage:\n  node scripts/tasks/blender/render-deliverables.mjs --spatial spatial.json --scene scene.glb --output render [--walkthrough] [--force] [--timeout-ms 7200000]\n");
  const result = await renderDeliverables(await readJson(options.spatial), {
    sceneFile: options.scene,
    outputDirectory: options.output,
    blender: options.blender,
    walkthrough: options.walkthrough,
    force: options.force,
    renderTimeoutMs: Number(options["timeout-ms"]),
  });
  printJson({
    outputDirectory: options.output,
    planSha256: result.plan.plan_sha256,
    resumed: result.resumed,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBlenderRenderPlan } from "./build-render-plan.mjs";
import { parseArgs, printJson, readJson, sha256, writeJson } from "../../lib/cli.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)));
  });
}

function capture(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.message.includes("ENOENT")) return null;
    throw error;
  }
}

async function hashArtifact(root, relativeFile, kind) {
  const bytes = await readFile(join(root, relativeFile));
  return {
    kind,
    file: `./${relativeFile}`,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
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
  },
) {
  const absoluteOutput = resolve(outputDirectory);
  const absoluteScene = resolve(sceneFile);
  await mkdir(absoluteOutput, { recursive: true });
  const plan = buildBlenderRenderPlan(spatialJson, {
    scene: absoluteScene,
    outputDirectory: absoluteOutput,
    walkthrough,
  });
  const planFile = join(absoluteOutput, "render-plan.json");
  await writeJson(planFile, plan);
  await mkdir(join(absoluteOutput, "panorama"), { recursive: true });
  await mkdir(join(absoluteOutput, "vendor"), { recursive: true });
  for (const file of ["index.html", "styles.css", "app.js"]) {
    await copyFile(join(ROOT, "assets", "panorama-player", file), join(absoluteOutput, "panorama", file));
  }
  await copyFile(join(ROOT, "node_modules", "three", "build", "three.module.js"), join(absoluteOutput, "vendor", "three.module.js"));

  const manifestFile = join(absoluteOutput, "render-manifest.json");
  const checkpointFile = join(absoluteOutput, plan.checkpoint_file);
  const priorCheckpoint = await readJsonIfPresent(checkpointFile);
  const priorManifest = await readJsonIfPresent(manifestFile);
  if (
    !force
    && priorCheckpoint?.state === "completed"
    && priorCheckpoint?.detail?.plan_sha256 === plan.plan_sha256
    && priorManifest?.plan_sha256 === plan.plan_sha256
  ) {
    return { plan, manifest: priorManifest, resumed: true };
  }

  const versionResult = await capture(blender, ["--version"]);
  const blenderVersion = versionResult.stdout.split(/\r?\n/u).find((line) => line.trim())?.trim();
  if (!blenderVersion) throw new Error("Blender did not report a version.");
  await run(blender, ["--background", "--python", join(ROOT, "scripts", "blender", "render_scene.py"), "--", planFile]);
  const checkpoint = await readJson(checkpointFile, "Blender checkpoint");
  if (checkpoint.state !== "completed") throw new Error(`Blender render did not complete: ${checkpoint.state}.`);

  const artifactSpecs = [
    ...plan.stills.map((item) => [item.file, "still"]),
    [plan.panorama.file, "panorama"],
    [plan.blend_file, "blend"],
    ...(plan.optional_walkthrough.enabled
      ? [[plan.optional_walkthrough.file, "walkthrough"]]
      : []),
  ];
  const artifacts = await Promise.all(
    artifactSpecs.map(([file, kind]) => hashArtifact(absoluteOutput, file, kind)),
  );
  const manifest = {
    schema_version: "1.0",
    project_id: spatialJson.project.id,
    revision: spatialJson.project.revision,
    blender_version: blenderVersion,
    plan_sha256: plan.plan_sha256,
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
    help: { type: "boolean" },
  });
  if (options.help) return process.stdout.write("Usage:\n  node scripts/tasks/blender/render-deliverables.mjs --spatial spatial.json --scene scene.glb --output render [--walkthrough] [--force]\n");
  const result = await renderDeliverables(await readJson(options.spatial), {
    sceneFile: options.scene,
    outputDirectory: options.output,
    blender: options.blender,
    walkthrough: options.walkthrough,
    force: options.force,
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

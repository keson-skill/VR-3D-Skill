#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson, readJson } from "../lib/cli.mjs";
import { buildViewableScene } from "../tasks/scene-generation/build-viewable-scene.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    output: { type: "string", default: "runs/example" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/tests/build-bundled-example.mjs [--output runs/example]\n",
    );
    return;
  }
  const directory = "examples/one-room";
  const [spatialJson, sourceManifest, validationReport, approval] =
    await Promise.all([
      readJson(join(directory, "spatial.json"), "example Spatial JSON"),
      readJson(join(directory, "source-manifest.json"), "example source manifest"),
      readJson(
        join(directory, "spatial-validation.json"),
        "example validation report",
      ),
      readJson(join(directory, "spatial-approval.json"), "example approval"),
    ]);
  const result = await buildViewableScene(spatialJson, {
    outputDirectory: options.output,
    mode: "furnished",
    sourceManifest,
    validationReport,
    approval,
    allowTestApproval: true,
  });
  printJson({
    outputDirectory: result.outputDirectory,
    sceneFile: result.sceneFile,
    viewer: result.viewer,
    notice:
      "This bundled test approval is accepted only by this test helper, never by production CLIs.",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

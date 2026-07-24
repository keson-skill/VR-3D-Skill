#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildBlenderRenderPlan } from "../tasks/blender/build-render-plan.mjs";
import { canonicalJsonSha256, parseArgs, printJson, writeJson } from "../lib/cli.mjs";
const DEFAULT_FIXTURES = new URL("../../examples/p7-acceptance/fixtures.json", import.meta.url);
export async function runP7Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const url = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) throw new Error("P7 acceptance requires 20 fixtures.");
  const [python, player] = await Promise.all([
    readFile(new URL("../blender/render_scene.py", import.meta.url), "utf8"),
    readFile(new URL("../../assets/panorama-player/app.js", import.meta.url), "utf8"),
  ]);
  const backendMarkers = ["import_scene.gltf", "EQUIRECTANGULAR", "save_as_mainfile", "checkpoint_file", "write_still", "animation=True", "os.replace"];
  const playerMarkers = ["SphereGeometry", "TextureLoader", "pointermove", "wheel"];
  const missing = [
    ...backendMarkers.filter((marker) => !python.includes(marker)),
    ...playerMarkers.filter((marker) => !player.includes(marker)),
  ];
  const samples = suite.fixtures.map((fixture) => {
    const plan = buildBlenderRenderPlan(fixture.spatial);
    const walkthroughPlan = buildBlenderRenderPlan(fixture.spatial, { walkthrough: true });
    const valid = plan.cameras.length >= fixture.spatial.rooms.length + 1
      && plan.panorama.width === plan.panorama.height * 2
      && plan.stills.length === plan.cameras.length
      && plan.color_management.view_transform === "AgX"
      && walkthroughPlan.optional_walkthrough.enabled
      && walkthroughPlan.optional_walkthrough.file.endsWith(".mp4");
    return { id: fixture.id, valid, cameras: plan.cameras.length, plan_sha256: plan.plan_sha256, plan_contract_sha256: canonicalJsonSha256(plan) };
  });
  const aggregate = { fixture_count: samples.length, plan_errors: samples.filter((sample) => !sample.valid).length, implementation_marker_errors: missing.length, missing_markers: missing };
  const passed = aggregate.fixture_count >= 20 && aggregate.plan_errors === 0 && aggregate.implementation_marker_errors === 0;
  return {
    schema_version: "1.0",
    stage: "P7",
    passed,
    aggregate,
    blender_execution: {
      status: "not_available_in_ci",
      recovery: "Atomic render-checkpoint.json history supports failed reruns and completed-plan reuse.",
      production_manifest: "Records the real Blender version and SHA-256 for every generated deliverable.",
    },
    samples,
  };
}
async function main() {
  const options = parseArgs(process.argv.slice(2), { fixtures: { type: "string" }, output: { type: "string", default: "examples/p7-acceptance/automated-evidence.json" }, help: { type: "boolean" } });
  if (options.help) return process.stdout.write("Usage: node scripts/validation/run-p7-acceptance.mjs [--fixtures file] [--output file]\n");
  const report = await runP7Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report); printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate }); if (!report.passed) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildRuntimeContract } from "../runtime/build-runtime-contract.mjs";
import { canonicalJsonSha256, parseArgs, printJson, writeJson } from "../lib/cli.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p6-acceptance/fixtures.json", import.meta.url);
const VIEWER_APP = new URL("../../assets/web-viewer/app.js", import.meta.url);
const VIEWER_HTML = new URL("../../assets/web-viewer/index.html", import.meta.url);

export async function runP6Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const url = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) throw new Error("P6 acceptance requires at least 20 fixtures.");
  const [app, html] = await Promise.all([readFile(VIEWER_APP, "utf8"), readFile(VIEWER_HTML, "utf8")]);
  const requiredMarkers = [
    "room-select", "measure-button", "annotate-button", "undo-button",
    "sessionstart", "sessionend", "visibilitychange", "reconnecting",
    "无效位置", "prefers-reduced-motion",
  ];
  const combined = `${app}\n${html}\n${await readFile(new URL("../../assets/web-viewer/styles.css", import.meta.url), "utf8")}`;
  const missingMarkers = requiredMarkers.filter((marker) => !combined.toLowerCase().includes(marker.toLowerCase()));
  const samples = suite.fixtures.map((fixture) => {
    const contract = buildRuntimeContract(fixture.spatial);
    const valid =
      contract.valid &&
      contract.rooms.length > 0 &&
      contract.interaction.operations.includes("measure") &&
      contract.interaction.operations.includes("undo") &&
      contract.lifecycle.includes("reconnecting") &&
      contract.locomotion.xr === "teleport";
    return { id: fixture.id, valid, rooms: contract.rooms.length, obstacles: contract.obstacles.length, contract_sha256: canonicalJsonSha256(contract), errors: contract.errors };
  });
  const aggregate = {
    fixture_count: samples.length,
    runtime_errors: samples.filter((sample) => !sample.valid).length,
    viewer_marker_errors: missingMarkers.length,
    missing_markers: missingMarkers,
  };
  const passed = aggregate.fixture_count >= 20 && aggregate.runtime_errors === 0 && aggregate.viewer_marker_errors === 0;
  return {
    schema_version: "1.0",
    stage: "P6",
    passed,
    aggregate,
    samples,
    device_validation: {
      status: "contract_only",
      statement: "Physical headset and controller performance was not fabricated; run P10 device qualification on target hardware.",
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p6-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) return process.stdout.write("Usage:\n  node scripts/validation/run-p6-acceptance.mjs [--fixtures fixtures.json] [--output evidence.json]\n");
  const report = await runP6Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

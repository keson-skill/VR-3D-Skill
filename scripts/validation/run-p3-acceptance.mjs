#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGlb } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { canonicalJsonSha256, parseArgs, printJson, sha256, writeJson } from "../lib/cli.mjs";
import { comparePlanRender } from "./compare-plan-render.mjs";
import { renderSceneTopView } from "./render-scene-top-view.mjs";
import { renderSpatialTopView } from "./render-spatial-top-view.mjs";
import { validateGlbBytes } from "./validate-glb.mjs";
import { validateSpatialJson } from "./validate-spatial-json.mjs";

const DEFAULT_FIXTURES = new URL(
  "../../examples/p3-acceptance/fixtures.json",
  import.meta.url,
);

export async function runP3Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const fixturePath = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) {
    throw new Error("P3 acceptance requires at least 20 fixed geometry fixtures.");
  }
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p3-acceptance-"));
  try {
    const samples = [];
    for (const fixture of suite.fixtures) {
      const spatialValidation = validateSpatialJson(fixture.spatial);
      const primitives = spatialValidation.valid
        ? compileScenePrimitives(fixture.spatial)
        : [];
      const glb = spatialValidation.valid
        ? buildGlb(fixture.spatial, primitives)
        : Buffer.alloc(0);
      const glbValidation = spatialValidation.valid
        ? validateGlbBytes(glb, { expectedProject: fixture.spatial.project })
        : { valid: false, errors: [{ code: "p3.spatial_invalid" }], summary: {} };
      const sourceView = join(directory, `${fixture.id}-source.png`);
      const sceneView = join(directory, `${fixture.id}-scene.png`);
      let alignment = null;
      if (spatialValidation.valid && glbValidation.valid) {
        await renderSpatialTopView(fixture.spatial, sourceView, {
          width: 512,
          height: 512,
        });
        await renderSceneTopView(fixture.spatial, sceneView, {
          primitives,
          width: 512,
          height: 512,
        });
        alignment = await comparePlanRender(sourceView, sceneView, {
          comparisonSize: 512,
          searchRadius: 2,
          minimumF1: 0.84,
          minimumIou: 0.72,
        });
      }
      const expected = fixture.expected || {};
      const expectedCounts =
        primitives.filter((item) => item.kind === "ceiling").length === expected.rooms &&
        fixture.spatial.envelope.walls.length === expected.walls &&
        fixture.spatial.envelope.openings.length === expected.openings &&
        (fixture.spatial.envelope.architectural_elements?.length || 0) ===
          expected.structural_elements;
      samples.push({
        id: fixture.id,
        spatial_valid: spatialValidation.valid,
        glb_valid: glbValidation.valid,
        expected_counts_valid: expectedCounts,
        scene_sha256: sha256(glb),
        primitives_sha256: canonicalJsonSha256(primitives),
        primitive_count: primitives.length,
        glb: glbValidation.summary,
        ...(alignment ? { alignment } : {}),
      });
    }
    const aggregate = {
      fixture_count: samples.length,
      spatial_errors: samples.filter((sample) => !sample.spatial_valid).length,
      glb_errors: samples.filter((sample) => !sample.glb_valid).length,
      count_errors: samples.filter((sample) => !sample.expected_counts_valid).length,
      minimum_alignment_f1: Math.min(
        ...samples.map((sample) => sample.alignment?.metrics?.f1 ?? 0),
      ),
      minimum_alignment_iou: Math.min(
        ...samples.map((sample) => sample.alignment?.metrics?.intersection_over_union ?? 0),
      ),
    };
    const passed =
      aggregate.fixture_count >= 20 &&
      aggregate.spatial_errors === 0 &&
      aggregate.glb_errors === 0 &&
      aggregate.count_errors === 0 &&
      aggregate.minimum_alignment_f1 >= 0.84 &&
      aggregate.minimum_alignment_iou >= 0.72;
    return {
      schema_version: "1.0",
      stage: "P3",
      fixture_set: "examples/p3-acceptance/fixtures.json",
      passed,
      aggregate,
      samples,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p3-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:\n  node scripts/validation/run-p3-acceptance.mjs [--fixtures examples/p3-acceptance/fixtures.json] [--output examples/p3-acceptance/automated-evidence.json]\n`);
    return;
  }
  const report = await runP3Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

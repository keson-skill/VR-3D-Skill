#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildGlb, prepareTextureAssets } from "../builders/glb-writer.mjs";
import { buildBlenderImportContract } from "../tasks/blender/build-blender-import-contract.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { canonicalJsonSha256, parseArgs, printJson, sha256, writeJson } from "../lib/cli.mjs";
import { validateGlbBytes } from "./validate-glb.mjs";
import { validateSpatialJson } from "./validate-spatial-json.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p4-acceptance/fixtures.json", import.meta.url);

export async function runP4Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const fixturePath = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) {
    throw new Error("P4 acceptance requires at least 20 fixed hard-finish/material fixtures.");
  }
  const samples = [];
  for (const fixture of suite.fixtures) {
    const spatialValidation = validateSpatialJson(fixture.spatial);
    const primitives = spatialValidation.valid ? compileScenePrimitives(fixture.spatial) : [];
    const textureBuild = spatialValidation.valid
      ? await prepareTextureAssets(fixture.spatial, {
          materialIds: [...new Set(primitives.map((item) => item.material_id))],
          quality: fixture.spatial.render_profiles?.quality || "standard",
        })
      : { assets: [], report: [] };
    const glb = spatialValidation.valid
      ? buildGlb(fixture.spatial, primitives, {
          textureAssets: textureBuild.assets,
          quality: fixture.spatial.render_profiles?.quality || "standard",
        })
      : Buffer.alloc(0);
    const glbValidation = spatialValidation.valid
      ? validateGlbBytes(glb, { expectedProject: fixture.spatial.project })
      : { valid: false, errors: [{ code: "p4.spatial_invalid" }], summary: {} };
    const contract = glbValidation.valid
      ? buildBlenderImportContract(fixture.spatial, glb)
      : null;
    const expected = fixture.expected;
    const hardFinishes = primitives.filter((item) => item.category === "hard_finish").length;
    const fallbackTextures = textureBuild.report.filter((item) => item.status === "fallback").length;
    const embeddedBySlot = new Map();
    for (const asset of textureBuild.report) {
      if (!embeddedBySlot.has(asset.resolved_material_id)) {
        embeddedBySlot.set(asset.resolved_material_id, new Map());
      }
      embeddedBySlot.get(asset.resolved_material_id).set(asset.slot, asset.packaged_bytes);
    }
    const textureBytesByMaterial = new Map();
    for (const [materialId, slots] of embeddedBySlot) {
      textureBytesByMaterial.set(
        materialId,
        [...slots.values()].reduce((total, bytes) => total + bytes, 0),
      );
    }
    const textureBudgetValid = [...textureBytesByMaterial].every(([materialId, bytes]) => {
      const budget = fixture.spatial.materials?.[materialId]?.texture_budget_bytes;
      return !Number.isInteger(budget) || bytes <= budget;
    });
    const materialBindingValid = contract?.materials.some(
      (material) => material.source_material_id === "wall_default" && material.resolved_material_id === "finish_paint",
    );
    const expectedCountsValid =
      fixture.spatial.rooms.length === expected.rooms &&
      glbValidation.summary.lights === expected.lights &&
      glbValidation.summary.images === expected.embedded_images &&
      hardFinishes === expected.hard_finishes &&
      fallbackTextures === expected.fallback_textures;
    samples.push({
      id: fixture.id,
      spatial_valid: spatialValidation.valid,
      glb_valid: glbValidation.valid,
      blender_contract_valid: Boolean(contract && materialBindingValid && contract.lights.length === expected.lights),
      texture_budget_valid: textureBudgetValid,
      expected_counts_valid: expectedCountsValid,
      scene_sha256: sha256(glb),
      primitives_sha256: canonicalJsonSha256(primitives),
      glb: glbValidation.summary,
      hard_finish_primitives: hardFinishes,
      texture_assets: {
        packed: textureBuild.report.filter((item) => item.status === "packed").length,
        fallback: fallbackTextures,
      },
    });
  }
  const aggregate = {
    fixture_count: samples.length,
    spatial_errors: samples.filter((sample) => !sample.spatial_valid).length,
    glb_errors: samples.filter((sample) => !sample.glb_valid).length,
    blender_contract_errors: samples.filter((sample) => !sample.blender_contract_valid).length,
    texture_budget_errors: samples.filter((sample) => !sample.texture_budget_valid).length,
    count_errors: samples.filter((sample) => !sample.expected_counts_valid).length,
    embedded_images: samples.reduce((total, sample) => total + (sample.glb.images || 0), 0),
    fallback_textures: samples.reduce((total, sample) => total + sample.texture_assets.fallback, 0),
  };
  const passed =
    aggregate.fixture_count >= 20 &&
    aggregate.spatial_errors === 0 &&
    aggregate.glb_errors === 0 &&
    aggregate.blender_contract_errors === 0 &&
    aggregate.texture_budget_errors === 0 &&
    aggregate.count_errors === 0 &&
    aggregate.embedded_images >= aggregate.fixture_count &&
    aggregate.fallback_textures >= aggregate.fixture_count;
  return {
    schema_version: "1.0",
    stage: "P4",
    fixture_set: "examples/p4-acceptance/fixtures.json",
    passed,
    aggregate,
    samples,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p4-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/validation/run-p4-acceptance.mjs [--fixtures examples/p4-acceptance/fixtures.json] [--output examples/p4-acceptance/automated-evidence.json]\n");
    return;
  }
  const report = await runP4Acceptance(options.fixtures || DEFAULT_FIXTURES);
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

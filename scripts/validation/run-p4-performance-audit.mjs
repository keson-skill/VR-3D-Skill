#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildGlb, prepareTextureAssets } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { parseArgs, printJson, writeJson } from "../lib/cli.mjs";
import { parseGlb, validateGlbBytes } from "./validate-glb.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p4-acceptance/fixtures.json", import.meta.url);
const LIMITS = {
  draft: { max_glb_bytes: 2 * 1024 * 1024, max_texture_bytes: 512 * 1024 },
  standard: { max_glb_bytes: 8 * 1024 * 1024, max_texture_bytes: 2 * 1024 * 1024 },
  presentation: { max_glb_bytes: 24 * 1024 * 1024, max_texture_bytes: 8 * 1024 * 1024 },
};

export async function runP4PerformanceAudit(fixturesFile = DEFAULT_FIXTURES) {
  const fixturePath = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(fixturePath, "utf8"));
  const profiles = ["draft", "standard", "presentation"];
  const samples = [];
  for (const fixture of suite.fixtures) {
    const primitives = compileScenePrimitives(fixture.spatial);
    const materialIds = [...new Set(primitives.map((item) => item.material_id))];
    for (const quality of profiles) {
      const textures = await prepareTextureAssets(fixture.spatial, { materialIds, quality });
      const glb = buildGlb(fixture.spatial, primitives, { textureAssets: textures.assets, quality });
      const validation = validateGlbBytes(glb, { expectedProject: fixture.spatial.project });
      const uniqueTextures = new Map();
      for (const asset of textures.report) {
        uniqueTextures.set(`${asset.resolved_material_id}\u0000${asset.slot}\u0000${asset.packaged_sha256}`, asset.packaged_bytes);
      }
      const textureBytes = [...uniqueTextures.values()].reduce((total, bytes) => total + bytes, 0);
      const limits = LIMITS[quality];
      const gltf = parseGlb(glb).gltf;
      samples.push({
        id: fixture.id,
        quality,
        glb_bytes: glb.length,
        texture_bytes: textureBytes,
        material_count: gltf?.materials?.length || 0,
        embedded_images: validation.summary.images,
        material_slots_valid: validation.valid,
        within_budget: glb.length <= limits.max_glb_bytes && textureBytes <= limits.max_texture_bytes,
      });
    }
  }
  const aggregate = {
    fixture_count: suite.fixtures.length,
    profiles,
    sample_count: samples.length,
    budget_errors: samples.filter((sample) => !sample.within_budget).length,
    material_slot_errors: samples.filter((sample) => !sample.material_slots_valid).length,
    maximum_glb_bytes: Math.max(...samples.map((sample) => sample.glb_bytes)),
    maximum_texture_bytes: Math.max(...samples.map((sample) => sample.texture_bytes)),
  };
  return { schema_version: "1.0", stage: "P4", limits: LIMITS, passed: aggregate.budget_errors === 0 && aggregate.material_slot_errors === 0, aggregate, samples };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p4-acceptance/performance-audit.json" },
    help: { type: "boolean" },
  });
  if (options.help) return process.stdout.write("Usage:\n  node scripts/validation/run-p4-performance-audit.mjs [--fixtures fixtures.json] [--output audit.json]\n");
  const report = await runP4PerformanceAudit(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

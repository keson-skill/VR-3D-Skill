#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveAssets } from "../tasks/asset-generation/resolve-assets.mjs";
import { evaluateDesignProposal } from "../tasks/design-planning/evaluate-design-proposal.mjs";
import { canonicalJsonSha256, parseArgs, printJson, writeJson } from "../lib/cli.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p5-acceptance/fixtures.json", import.meta.url);

export async function runP5Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const url = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 20) throw new Error("P5 acceptance requires at least 20 fixtures.");
  const samples = suite.fixtures.map((fixture) => {
    const design = evaluateDesignProposal(fixture.spatial, fixture.proposal);
    const selected = fixture.proposal.design_alternatives.find((item) => item.id === fixture.proposal.recommended_alternative_id);
    const assets = resolveAssets(selected?.design_objects, fixture.catalog);
    return {
      id: fixture.id,
      design_valid: design.valid,
      asset_resolution_valid: assets.valid,
      alternatives: design.alternatives.length,
      real_assets: assets.summary.real_assets,
      proxies: assets.summary.proxies,
      proposal_sha256: canonicalJsonSha256(fixture.proposal),
      errors: [...design.errors, ...assets.errors],
    };
  });
  const aggregate = {
    fixture_count: samples.length,
    design_errors: samples.filter((sample) => !sample.design_valid).length,
    asset_errors: samples.filter((sample) => !sample.asset_resolution_valid).length,
    comparison_errors: samples.filter((sample) => sample.alternatives < 2).length,
    unresolved_selected_assets: samples.filter((sample) => sample.real_assets < 1).length,
  };
  const passed = aggregate.fixture_count >= 20 && Object.entries(aggregate).filter(([key]) => key !== "fixture_count").every(([, value]) => value === 0);
  return { schema_version: "1.0", stage: "P5", passed, aggregate, samples };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p5-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) return process.stdout.write("Usage:\n  node scripts/validation/run-p5-acceptance.mjs [--fixtures fixtures.json] [--output evidence.json]\n");
  const report = await runP5Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

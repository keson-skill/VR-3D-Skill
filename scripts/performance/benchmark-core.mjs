#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { cpus, platform, release, totalmem } from "node:os";
import { pathToFileURL } from "node:url";
import { buildGlb } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

export async function benchmarkCore(
  fixtureFile = new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url),
  {
    iterations = 3,
    maxMedianMs = 250,
    maxP95Ms = 1000,
    maxMemoryGrowthBytes = 128 * 1024 * 1024,
  } = {},
) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new Error("Core benchmark iterations must be an integer from 1 to 20.");
  }
  for (const [name, value] of Object.entries({
    maxMedianMs,
    maxP95Ms,
    maxMemoryGrowthBytes,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite number.`);
    }
  }
  const suite = await readJson(
    fixtureFile,
    "core benchmark fixtures",
    { maxBytes: 32 * 1024 * 1024 },
  );
  const fixtures = suite.fixtures.slice(0, 20);
  if (fixtures.length < 10) throw new Error("Core benchmark requires at least ten fixtures.");
  const samples = [];
  const startMemory = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const fixture of fixtures) {
      const started = performance.now();
      const validation = validateSpatialJson(fixture.spatial);
      if (!validation.valid) throw new Error(`Benchmark fixture ${fixture.id} is invalid.`);
      const glb = buildGlb(
        fixture.spatial,
        compileScenePrimitives(fixture.spatial),
      );
      samples.push({
        fixture_id: fixture.id,
        iteration: iteration + 1,
        duration_ms: performance.now() - started,
        glb_bytes: glb.length,
        glb_sha256: sha256(glb),
      });
    }
  }
  const durations = samples.map((sample) => sample.duration_ms);
  const memoryGrowth = Math.max(0, process.memoryUsage().heapUsed - startMemory);
  const deterministic = fixtures.every((fixture) => {
    const hashes = new Set(
      samples
        .filter((sample) => sample.fixture_id === fixture.id)
        .map((sample) => sample.glb_sha256),
    );
    return hashes.size === 1;
  });
  const aggregate = {
    fixtures: fixtures.length,
    iterations,
    samples: samples.length,
    median_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    maximum_ms: Math.max(...durations),
    memory_growth_bytes: memoryGrowth,
    deterministic,
  };
  const limits = {
    max_median_ms: maxMedianMs,
    max_p95_ms: maxP95Ms,
    max_memory_growth_bytes: maxMemoryGrowthBytes,
  };
  const passed =
    aggregate.median_ms <= limits.max_median_ms
    && aggregate.p95_ms <= limits.max_p95_ms
    && aggregate.memory_growth_bytes <= limits.max_memory_growth_bytes
    && deterministic;
  const report = {
    schema_version: "1.0",
    benchmark: "core_spatial_compile",
    evidence_kind: "ci_core_benchmark",
    passed,
    host: {
      platform: platform(),
      release: release(),
      node: process.versions.node,
      cpu: cpus()[0]?.model || "unknown",
      logical_cpus: cpus().length,
      total_memory_bytes: totalmem(),
    },
    limits,
    aggregate,
    samples,
    explicit_non_claim:
      "This CI/core benchmark does not qualify browser FPS, mobile GPU, physical XR, or Blender rendering.",
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    iterations: { type: "string", default: "3" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/performance/benchmark-core.mjs [--iterations 3] [--output core-benchmark.json]\n");
    return;
  }
  const report = await benchmarkCore(
    options.fixtures || new URL("../../examples/p3-acceptance/fixtures.json", import.meta.url),
    { iterations: Number(options.iterations) },
  );
  if (options.output) await writeJson(options.output, report);
  printJson({
    outputFile: options.output || null,
    passed: report.passed,
    aggregate: report.aggregate,
    reportSha256: report.report_sha256,
  });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

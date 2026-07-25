#!/usr/bin/env node

import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractDxfEvidence } from "../ingest/extract-dxf-evidence.mjs";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { convertDxfEvidenceToSpatial } from "../spatial/dxf-to-spatial.mjs";
import { convertRasterToSpatial } from "../spatial/raster-to-spatial.mjs";
import { comparePlanRender } from "./compare-plan-render.mjs";
import { renderSpatialTopView } from "./render-spatial-top-view.mjs";
import { validateSpatialJson } from "./validate-spatial-json.mjs";

const DEFAULT_FIXTURE_ROOT = fileURLToPath(
  new URL("../../examples/p2-acceptance/", import.meta.url),
);

function bounds(document) {
  const points = document.envelope.walls.flatMap((wall) => [
    wall.start,
    wall.end,
  ]);
  return {
    min: [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
    ],
    max: [
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ],
  };
}

function nearestDistance(point, candidates) {
  return Math.min(
    ...candidates.map((candidate) =>
      Math.hypot(candidate[0] - point[0], candidate[1] - point[1]),
    ),
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runDxfFixture(root, fixture) {
  const dxfPath = join(root, fixture.dxf);
  const [bytes, sourceManifest] = await Promise.all([
    readFile(dxfPath),
    readJson(join(root, fixture.source_manifest), "fixture source manifest"),
  ]);
  const evidence = extractDxfEvidence(bytes.toString("utf8"), {
    path: fixture.dxf,
    sha256: sha256(bytes),
  });
  const spatial = convertDxfEvidenceToSpatial(evidence, {
    sourceManifest,
    projectId: fixture.id,
  });
  const validation = validateSpatialJson(spatial);
  const expected = fixture.expected;
  const expectedCorners = [
    [0, 0],
    [expected.width_meters, 0],
    [expected.width_meters, expected.height_meters],
    [0, expected.height_meters],
  ];
  const actualEndpoints = spatial.envelope.walls.flatMap((wall) => [
    wall.start,
    wall.end,
  ]);
  const endpointErrors = expectedCorners.map((point) =>
    nearestDistance(point, actualEndpoints),
  );
  const openingWidthError = Math.abs(
    (spatial.envelope.openings[0]?.width ?? Infinity) -
      expected.opening_width_meters,
  );
  const maxEndpointError = Math.max(...endpointErrors);
  const passed =
    validation.valid &&
    spatial.rooms.length === expected.room_count &&
    maxEndpointError <= expected.endpoint_tolerance_meters &&
    openingWidthError <= expected.endpoint_tolerance_meters;
  return {
    id: fixture.id,
    input_kind: "dxf",
    passed,
    schema_valid: validation.schema_valid,
    geometry_errors: validation.errors.length,
    counts: {
      walls: spatial.envelope.walls.length,
      openings: spatial.envelope.openings.length,
      rooms: spatial.rooms.length,
    },
    metrics: {
      max_endpoint_error_meters: Number(maxEndpointError.toFixed(9)),
      opening_width_error_meters: Number(openingWidthError.toFixed(9)),
      tolerance_meters: expected.endpoint_tolerance_meters,
    },
  };
}

async function runRasterFixture(root, fixture, workingDirectory) {
  const imagePath = join(root, fixture.image);
  const [sourceManifest, scaleAnchor, correction] = await Promise.all([
    readJson(join(root, fixture.source_manifest), "fixture source manifest"),
    fixture.scale_anchor
      ? readJson(join(root, fixture.scale_anchor), "fixture scale anchor")
      : Promise.resolve(null),
    fixture.correction
      ? readJson(join(root, fixture.correction), "fixture correction")
      : Promise.resolve(null),
  ]);
  const automatic = await convertRasterToSpatial(imagePath, {
    sourceManifest,
    scaleAnchor,
    estimatedMetersPerPixel: fixture.estimated_meters_per_pixel,
    projectId: fixture.id,
  });
  const spatial = correction
    ? await convertRasterToSpatial(imagePath, {
        sourceManifest,
        scaleAnchor,
        correction,
        estimatedMetersPerPixel: fixture.estimated_meters_per_pixel,
        projectId: fixture.id,
      })
    : automatic;
  const validation = validateSpatialJson(spatial);
  const actualBounds = bounds(spatial);
  const width = actualBounds.max[0] - actualBounds.min[0];
  const height = actualBounds.max[1] - actualBounds.min[1];
  const expected = fixture.expected;
  const absoluteErrors = [
    Math.abs(width - expected.width_meters),
    Math.abs(height - expected.height_meters),
  ];
  const relativeErrors = [
    absoluteErrors[0] / expected.width_meters,
    absoluteErrors[1] / expected.height_meters,
  ];
  const topView = join(workingDirectory, `${fixture.id}-top-view.png`);
  await renderSpatialTopView(spatial, topView);
  const alignment = await comparePlanRender(imagePath, topView);
  const estimatedScopeCorrect =
    expected.trusted_scale ||
    spatial.extraction.recommended_scope === "visualization_only";
  const openingCountCorrect =
    (expected.automatic_opening_check === false ||
      automatic.envelope.openings.length === expected.opening_count) &&
    spatial.envelope.openings.length === expected.opening_count;
  const passed =
    validation.valid &&
    median(relativeErrors) <= 0.02 &&
    Math.max(...absoluteErrors) <= 0.05 &&
    alignment.passed &&
    estimatedScopeCorrect &&
    openingCountCorrect;
  return {
    id: fixture.id,
    input_kind: "raster",
    passed,
    schema_valid: validation.schema_valid,
    geometry_errors: validation.errors.length,
    counts: {
      walls: spatial.envelope.walls.length,
      automatic_openings: automatic.envelope.openings.length,
      final_openings: spatial.envelope.openings.length,
      rooms: spatial.rooms.length,
    },
    scale: {
      status: spatial.extraction.scale.status,
      recommended_scope: spatial.extraction.recommended_scope,
    },
    correction_applied: Boolean(correction),
    metrics: {
      median_relative_wall_error: Number(
        median(relativeErrors).toFixed(9),
      ),
      max_absolute_wall_error_meters: Number(
        Math.max(...absoluteErrors).toFixed(9),
      ),
      alignment_f1: alignment.metrics.f1,
      alignment_iou: alignment.metrics.intersection_over_union,
    },
  };
}

export async function runP2Acceptance(
  fixtureRoot = DEFAULT_FIXTURE_ROOT,
) {
  const root = resolve(fixtureRoot);
  const [dxfIndex, rasterIndex] = await Promise.all([
    readJson(join(root, "dxf-index.json"), "DXF fixture index"),
    readJson(join(root, "raster-index.json"), "raster fixture index"),
  ]);
  const workingDirectory = await mkdtemp(join(tmpdir(), "vr-3d-p2-"));
  try {
    const dxf = [];
    for (const fixture of dxfIndex.fixtures) {
      dxf.push(await runDxfFixture(root, fixture));
    }
    const raster = [];
    for (const fixture of rasterIndex.fixtures) {
      raster.push(await runRasterFixture(root, fixture, workingDirectory));
    }
    const samples = [...dxf, ...raster];
    const dxfMaxEndpointError = Math.max(
      ...dxf.map((sample) => sample.metrics.max_endpoint_error_meters),
    );
    const rasterMedianRelativeError = median(
      raster.map((sample) => sample.metrics.median_relative_wall_error),
    );
    const rasterMaxAbsoluteError = Math.max(
      ...raster.map(
        (sample) => sample.metrics.max_absolute_wall_error_meters,
      ),
    );
    const schemaAndGeometryErrors = samples.reduce(
      (sum, sample) =>
        sum + sample.geometry_errors + (sample.schema_valid ? 0 : 1),
      0,
    );
    return {
      schema_version: "1.0",
      stage: "P2",
      fixture_set: "examples/p2-acceptance",
      fixture_counts: {
        raster: raster.length,
        dxf: dxf.length,
        total: samples.length,
      },
      thresholds: {
        schema_and_geometry_errors: 0,
        dxf_max_endpoint_error_meters: 0.001,
        raster_median_relative_wall_error: 0.02,
        raster_max_absolute_wall_error_meters: 0.05,
      },
      aggregate: {
        schema_and_geometry_errors: schemaAndGeometryErrors,
        dxf_max_endpoint_error_meters: dxfMaxEndpointError,
        raster_median_relative_wall_error: rasterMedianRelativeError,
        raster_max_absolute_wall_error_meters: rasterMaxAbsoluteError,
        minimum_alignment_f1: Math.min(
          ...raster.map((sample) => sample.metrics.alignment_f1),
        ),
        minimum_alignment_iou: Math.min(
          ...raster.map((sample) => sample.metrics.alignment_iou),
        ),
      },
      passed:
        samples.length >= 10 &&
        dxf.length >= 5 &&
        raster.length >= 5 &&
        samples.every((sample) => sample.passed) &&
        schemaAndGeometryErrors === 0 &&
        dxfMaxEndpointError <= 0.001 &&
        rasterMedianRelativeError <= 0.02 &&
        rasterMaxAbsoluteError <= 0.05,
      samples,
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/run-p2-acceptance.mjs \\
    [--fixtures examples/p2-acceptance] \\
    --output examples/p2-acceptance/automated-evidence.json
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string", default: DEFAULT_FIXTURE_ROOT },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const report = await runP2Acceptance(options.fixtures);
  await writeJson(options.output, report);
  printJson({
    outputFile: options.output,
    passed: report.passed,
    fixtureCounts: report.fixture_counts,
    aggregate: report.aggregate,
  });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

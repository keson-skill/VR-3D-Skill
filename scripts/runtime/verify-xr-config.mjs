#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point[0] - (start[0] + projection * dx),
    point[1] - (start[1] + projection * dz),
  );
}

export function verifyXrConfig(
  spatialJson,
  {
    approval = null,
    approvalTrust = null,
    sourceManifest = null,
    validationReport = null,
    allowTestApproval = false,
  } = {},
) {
  const spatial = validateSpatialJson(spatialJson, {
    requireApproved: true,
    approval,
    approvalTrust,
    sourceManifest,
    validationReport,
    allowTestApproval,
  });
  const errors = spatial.errors.map((error) => ({
    source: "spatial-validation",
    ...error,
  }));
  const warnings = spatial.warnings.map((warning) => ({
    source: "spatial-validation",
    ...warning,
  }));
  const xr = spatialJson.xr;

  if (spatialJson.validation?.approved_scope !== "construction_ready") {
    warnings.push({
      code: "validation.visualization_only",
      path: "/validation/approved_scope",
      message:
        "This scene is approved for visualization only; do not treat its layout as construction-ready without independent source alignment.",
    });
  }

  if (!xr) {
    errors.push({
      code: "xr.required",
      path: "/xr",
      message: "XR configuration is required.",
    });
    return { valid: false, errors, warnings };
  }

  const spawn = xr.spawn;
  if (Array.isArray(spawn) && spawn.length === 3 && spawn.every(Number.isFinite)) {
    const floorElevation = spatialJson.envelope?.floor_elevation ?? 0;
    if (Math.abs(spawn[1] - floorElevation) > 0.05) {
      warnings.push({
        code: "xr.spawn_height",
        path: "/xr/spawn/1",
        message:
          "XR origin height differs from the floor elevation; confirm whether the runtime uses floor-level or eye-level origin.",
      });
    }

    const spawn2d = [spawn[0], spawn[2]];
    for (const [index, wall] of (spatialJson.envelope?.walls || []).entries()) {
      if (
        Array.isArray(wall.start) &&
        Array.isArray(wall.end) &&
        Number.isFinite(wall.thickness) &&
        pointToSegmentDistance(spawn2d, wall.start, wall.end) <=
          wall.thickness / 2
      ) {
        errors.push({
          code: "xr.spawn_inside_wall",
          path: "/xr/spawn",
          message: `XR spawn intersects wall ${wall.id || index}.`,
        });
      }
    }

    for (const [index, object] of (spatialJson.design_objects || []).entries()) {
      const position = object.transform?.position;
      const dimensions = object.dimensions;
      if (
        Array.isArray(position) &&
        Array.isArray(dimensions) &&
        position.length === 3 &&
        dimensions.length === 3
      ) {
        const inside =
          Math.abs(spawn[0] - position[0]) <= dimensions[0] / 2 &&
          Math.abs(spawn[2] - position[2]) <= dimensions[2] / 2;
        if (inside) {
          errors.push({
            code: "xr.spawn_inside_object",
            path: "/xr/spawn",
            message: `XR spawn intersects design object ${object.id || index}.`,
          });
        }
      }
    }
  }

  if (xr.navigation !== "teleport") {
    warnings.push({
      code: "xr.comfort_navigation",
      path: "/xr/navigation",
      message: "Teleport should be the default artificial locomotion mode.",
    });
  }
  if (
    !Number.isFinite(xr.snap_turn_degrees) ||
    xr.snap_turn_degrees <= 0 ||
    xr.snap_turn_degrees > 90
  ) {
    errors.push({
      code: "xr.snap_turn",
      path: "/xr/snap_turn_degrees",
      message: "snap_turn_degrees must be greater than 0 and at most 90.",
    });
  }
  if (!spatialJson.render_profiles?.webxr) {
    warnings.push({
      code: "render_profile.webxr",
      path: "/render_profiles/webxr",
      message: "Define a WebXR render profile and quality tier.",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checked: [
      "approved spatial contract",
      "spawn height",
      "wall intersection",
      "axis-aligned object intersection",
      "navigation comfort defaults",
      "WebXR render profile",
    ],
    limitations: [
      "Room containment requires explicit room polygons or navmesh data.",
      "Rotated object bounds, reach, teleport navmesh, device lifecycle, and frame time require runtime testing.",
    ],
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/runtime/verify-xr-config.mjs \\
    --spatial-json approved-spatial.json \\
    --source-manifest source-manifest.json \\
    --validation-report spatial-validation.json \\
    --approval spatial-approval.json \\
    --approval-trust spatial-approval-trust.json \\
    [--output xr-report.json]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "spatial-json": { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    "validation-report": { type: "string", required: true },
    approval: { type: "string", required: true },
    "approval-trust": { type: "string", required: true },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const [
    spatialJson,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
  ] =
    await Promise.all([
      readJson(options["spatial-json"], "approved Spatial JSON"),
      readJson(options["source-manifest"], "source manifest"),
      readJson(options["validation-report"], "validation report"),
      readJson(options.approval, "spatial approval"),
      readJson(options["approval-trust"], "spatial approval trust store"),
    ]);
  const report = verifyXrConfig(spatialJson, {
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
  });
  if (options.output) {
    await writeJson(options.output, report);
    printJson({
      outputFile: options.output,
      valid: report.valid,
      errors: report.errors.length,
      warnings: report.warnings.length,
    });
  } else {
    printJson(report);
  }
  if (!report.valid) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

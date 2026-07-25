#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { distance2d, polygonSignedArea } from "../geometry/spatial-geometry.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

function stableSlug(value, fallback) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}._:-]+/gu, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+$/g, "");
  return slug || fallback;
}

function otsuThreshold(histogram, total) {
  let weightedTotal = 0;
  for (let index = 0; index < 256; index += 1) {
    weightedTotal += index * histogram[index];
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 180;
  for (let index = 0; index < 256; index += 1) {
    backgroundWeight += histogram[index];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += index * histogram[index];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean =
      (weightedTotal - backgroundSum) / foregroundWeight;
    const variance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return Math.min(220, Math.max(40, threshold));
}

function clusters(values) {
  const result = [];
  for (const value of values) {
    const current = result[result.length - 1];
    if (!current || value > current[current.length - 1] + 1) {
      result.push([value]);
    } else {
      current.push(value);
    }
  }
  return result.map((items) => ({
    start: items[0],
    end: items[items.length - 1],
    center: (items[0] + items[items.length - 1]) / 2,
    thickness: items.length,
  }));
}

function findRuns(mask, start, end, predicate) {
  const result = [];
  let runStart = null;
  for (let index = start; index <= end + 1; index += 1) {
    const active = index <= end && predicate(mask[index], index);
    if (active && runStart === null) runStart = index;
    if (!active && runStart !== null) {
      result.push([runStart, index - 1]);
      runStart = null;
    }
  }
  return result;
}

function lineOccupancy(mask, width, height, axis, band) {
  const length = axis === "horizontal" ? width : height;
  const result = new Float64Array(length);
  for (let major = 0; major < length; major += 1) {
    let dark = 0;
    let total = 0;
    for (
      let minor = Math.floor(band.start);
      minor <= Math.ceil(band.end);
      minor += 1
    ) {
      if (minor < 0 || minor >= (axis === "horizontal" ? height : width)) {
        continue;
      }
      const x = axis === "horizontal" ? major : minor;
      const y = axis === "horizontal" ? minor : major;
      total += 1;
      if (mask[y * width + x]) dark += 1;
    }
    result[major] = total === 0 ? 0 : dark / total;
  }
  return result;
}

function detectOrthogonalShell(mask, width, height) {
  const rowCounts = new Uint32Array(height);
  const columnCounts = new Uint32Array(width);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      rowCounts[y] += 1;
      columnCounts[x] += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error("Raster contains no detectable dark plan geometry.");
  }
  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const horizontal = clusters(
    [...rowCounts.keys()].filter((y) => rowCounts[y] >= spanX * 0.45),
  );
  const vertical = clusters(
    [...columnCounts.keys()].filter((x) => columnCounts[x] >= spanY * 0.45),
  );
  if (horizontal.length < 2 || vertical.length < 2) {
    throw new Error(
      "Could not detect two horizontal and two vertical outer wall bands.",
    );
  }
  const top = horizontal[0];
  const bottom = horizontal[horizontal.length - 1];
  const left = vertical[0];
  const right = vertical[vertical.length - 1];
  return {
    boundary: [
      [left.center, top.center],
      [right.center, top.center],
      [right.center, bottom.center],
      [left.center, bottom.center],
    ],
    bands: { top, right, bottom, left },
    candidate_counts: {
      horizontal: horizontal.length,
      vertical: vertical.length,
    },
    wall_thickness_pixels:
      (top.thickness + right.thickness + bottom.thickness + left.thickness) /
      4,
  };
}

function detectOpeningGaps(mask, width, height, shell) {
  const margin = Math.max(3, Math.ceil(shell.wall_thickness_pixels));
  const minimumGap = Math.max(6, Math.ceil(shell.wall_thickness_pixels * 1.5));
  const specs = [
    {
      wall_index: 0,
      axis: "horizontal",
      band: shell.bands.top,
      start: Math.ceil(shell.boundary[0][0] + margin),
      end: Math.floor(shell.boundary[1][0] - margin),
      reverse: false,
    },
    {
      wall_index: 1,
      axis: "vertical",
      band: shell.bands.right,
      start: Math.ceil(shell.boundary[1][1] + margin),
      end: Math.floor(shell.boundary[2][1] - margin),
      reverse: false,
    },
    {
      wall_index: 2,
      axis: "horizontal",
      band: shell.bands.bottom,
      start: Math.ceil(shell.boundary[3][0] + margin),
      end: Math.floor(shell.boundary[2][0] - margin),
      reverse: true,
    },
    {
      wall_index: 3,
      axis: "vertical",
      band: shell.bands.left,
      start: Math.ceil(shell.boundary[0][1] + margin),
      end: Math.floor(shell.boundary[3][1] - margin),
      reverse: true,
    },
  ];
  const gaps = [];
  for (const spec of specs) {
    const occupancy = lineOccupancy(
      mask,
      width,
      height,
      spec.axis,
      spec.band,
    );
    for (const [start, end] of findRuns(
      occupancy,
      spec.start,
      spec.end,
      (value) => value < 0.2,
    )) {
      if (end - start + 1 < minimumGap) continue;
      gaps.push({
        wall_index: spec.wall_index,
        start_pixel: start,
        end_pixel: end + 1,
        reverse: spec.reverse,
        kind: "open_passage",
      });
    }
  }
  return gaps;
}

function sourceForRaster(sourceManifest) {
  const source = sourceManifest?.sources?.[0];
  if (!source) {
    throw new Error("Raster conversion requires a source manifest with a source.");
  }
  return {
    id: stableSlug(source.id, "source-raster"),
    type: "raster_floor_plan",
    uri: source.uri || "local://raster",
    ...(source.revision ? { revision: source.revision } : {}),
    ...(source.sha256 ? { sha256: source.sha256 } : {}),
    contains_personal_data:
      typeof source.contains_personal_data === "boolean"
        ? source.contains_personal_data
        : false,
  };
}

function metersPerPixel(scaleAnchor, estimatedMetersPerPixel) {
  if (scaleAnchor) {
    const pixelDistance = distance2d(
      scaleAnchor.pixel_start,
      scaleAnchor.pixel_end,
    );
    if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) {
      throw new Error("Scale anchor pixel points must be different.");
    }
    if (
      !Number.isFinite(scaleAnchor.distance_meters) ||
      scaleAnchor.distance_meters <= 0
    ) {
      throw new Error("Scale anchor distance_meters must be positive.");
    }
    return {
      value: scaleAnchor.distance_meters / pixelDistance,
      status: "trusted",
    };
  }
  if (
    !Number.isFinite(estimatedMetersPerPixel) ||
    estimatedMetersPerPixel <= 0
  ) {
    throw new Error("estimatedMetersPerPixel must be positive.");
  }
  return { value: estimatedMetersPerPixel, status: "estimated" };
}

function gapToOpening(gap, boundaryPixels, metersPerPixelValue, index) {
  const wallStart = boundaryPixels[gap.wall_index];
  const wallEnd = boundaryPixels[(gap.wall_index + 1) % boundaryPixels.length];
  const horizontal = Math.abs(wallEnd[0] - wallStart[0]) >=
    Math.abs(wallEnd[1] - wallStart[1]);
  const axisStart = horizontal ? wallStart[0] : wallStart[1];
  const axisEnd = horizontal ? wallEnd[0] : wallEnd[1];
  const increasing = axisEnd >= axisStart;
  const low = Math.min(gap.start_pixel, gap.end_pixel);
  const high = Math.max(gap.start_pixel, gap.end_pixel);
  const widthPixels = high - low;
  const offsetPixels = increasing
    ? low - axisStart
    : axisStart - high;
  const kind = gap.kind || "open_passage";
  const isWindow = kind.includes("window");
  return {
    id: `opening-${String(index + 1).padStart(3, "0")}`,
    kind,
    host_wall_id: `wall-${String(gap.wall_index + 1).padStart(3, "0")}`,
    offset: Number((Math.max(0, offsetPixels) * metersPerPixelValue).toFixed(6)),
    width: Number((widthPixels * metersPerPixelValue).toFixed(6)),
    height: Number(gap.height_meters || (isWindow ? 1.2 : 2.1)),
    sill_height: Number(
      Number.isFinite(gap.sill_meters) ? gap.sill_meters : isWindow ? 0.9 : 0,
    ),
  };
}

export async function convertRasterToSpatial(
  imagePath,
  {
    sourceManifest,
    preprocessing = null,
    correction = null,
    scaleAnchor = null,
    estimatedMetersPerPixel = 0.01,
    projectId = "raster-interior",
    revision = "rev-001",
    wallHeightMeters = 2.8,
    wallThicknessMeters = null,
  } = {},
) {
  const { data, info } = await sharp(imagePath)
    .rotate()
    .flatten({ background: "#ffffff" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value] += 1;
  const threshold = otsuThreshold(histogram, data.length);
  const mask = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    mask[index] = data[index] <= threshold ? 1 : 0;
  }
  let detected;
  let automaticDetectionError = null;
  try {
    detected = detectOrthogonalShell(mask, info.width, info.height);
  } catch (error) {
    if (!correction?.outer_boundary_pixels) throw error;
    automaticDetectionError = error.message;
    detected = {
      boundary: correction.outer_boundary_pixels,
      bands: null,
      candidate_counts: { horizontal: 0, vertical: 0 },
      wall_thickness_pixels: Number(
        correction.wall_thickness_pixels || 10,
      ),
    };
  }
  const boundaryPixels =
    correction?.outer_boundary_pixels || detected.boundary;
  if (
    !Array.isArray(boundaryPixels) ||
    boundaryPixels.length < 3 ||
    boundaryPixels.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every(Number.isFinite),
    )
  ) {
    throw new Error("Correction outer_boundary_pixels must be a polygon.");
  }
  const anchor = correction?.scale_anchor || scaleAnchor;
  const scale = metersPerPixel(anchor, estimatedMetersPerPixel);
  const originPixel = boundaryPixels[0];
  const toMeters = (point) => [
    Number(((point[0] - originPixel[0]) * scale.value).toFixed(6)),
    Number(((point[1] - originPixel[1]) * scale.value).toFixed(6)),
  ];
  const meterBoundary = boundaryPixels.map(toMeters);
  const source = sourceForRaster(sourceManifest);
  const constructionReadyEligible =
    scale.status === "trusted" &&
    correction?.independent_dimension_verification === true;
  const correctionUsed = Boolean(correction?.outer_boundary_pixels);
  const topologyAmbiguous =
    !correctionUsed &&
    (detected.candidate_counts.horizontal > 2 ||
      detected.candidate_counts.vertical > 2);
  const topologyConfidence = correctionUsed
    ? 1
    : topologyAmbiguous
      ? 0.75
      : 0.95;
  const unresolved = topologyAmbiguous
    ? [
        {
          code: "raster.multiple_wall_bands",
          message:
            "Multiple long wall bands were detected. Confirm room topology in the correction overlay.",
          source_ids: [source.id],
        },
      ]
    : [];
  const thickness =
    wallThicknessMeters ||
    Number((detected.wall_thickness_pixels * scale.value).toFixed(6));
  const walls = meterBoundary.map((start, index) => ({
    id: `wall-${String(index + 1).padStart(3, "0")}`,
    start,
    end: meterBoundary[(index + 1) % meterBoundary.length],
    thickness: Math.max(0.05, thickness),
    height: wallHeightMeters,
    structural_role: "unknown",
    edit_policy: "review_required",
    provenance: {
      source_id: source.id,
      source_entity_ids: [`raster-boundary:${index}`],
      method: correctionUsed ? "user_edited" : "observed",
      confidence: topologyConfidence,
      tolerance_meters: scale.status === "trusted" ? 0.05 : scale.value * 5,
    },
  }));
  const gapSpecs =
    correction?.openings ||
    (detected.bands
      ? detectOpeningGaps(mask, info.width, info.height, detected)
      : []);
  const openings = gapSpecs
    .map((gap, index) =>
      gapToOpening(gap, boundaryPixels, scale.value, index),
    )
    .filter((opening) => opening.width > 0)
    .map((opening, index) => ({
      ...opening,
      provenance: {
        source_id: source.id,
        source_entity_ids: [`raster-gap:${index}`],
        method: correction?.openings ? "user_edited" : "observed",
        confidence: correction?.openings ? 1 : 0.9,
        tolerance_meters: scale.status === "trusted" ? 0.05 : scale.value * 5,
      },
    }));
  const area = Math.abs(polygonSignedArea(meterBoundary));
  return {
    schema_version: "1.0",
    project: {
      id: stableSlug(projectId, "raster-interior"),
      name: projectId,
      revision,
      units: "meters",
      up_axis: "Y",
      forward_axis: "-Z",
      handedness: "right",
      origin: [0, 0, 0],
    },
    sources: [source],
    extraction: {
      source_kind: "raster",
      method: correctionUsed
        ? "manual-overlay-correction-v1"
        : "deterministic-orthogonal-raster-v1",
      scale: {
        status: scale.status,
        meters_per_source_unit: scale.value,
        ...(anchor ? { anchor } : {}),
      },
      topology_confidence: topologyConfidence,
      coordinate_transform: {
        source_space: "normalized-image-pixels",
        target_space: "spatial-meters-xz",
        matrix_3x3: [
          scale.value,
          0,
          -originPixel[0] * scale.value,
          0,
          scale.value,
          -originPixel[1] * scale.value,
          0,
          0,
          1,
        ],
        ...(preprocessing?.coordinate_transform
          ? { preprocessing: preprocessing.coordinate_transform }
          : {}),
      },
      source_conflicts: [],
      raster_analysis: {
        width: info.width,
        height: info.height,
        threshold,
        wall_thickness_pixels: detected.wall_thickness_pixels,
        candidate_counts: detected.candidate_counts,
        ...(automaticDetectionError
          ? { automatic_detection_error: automaticDetectionError }
          : {}),
      },
      recommended_scope:
        constructionReadyEligible
          ? "construction_ready"
          : "visualization_only",
      construction_ready_eligible: constructionReadyEligible,
    },
    requirements: {
      design_intent: {},
      constraints: [],
    },
    envelope: {
      floor_elevation: 0,
      ceiling_height: wallHeightMeters,
      walls,
      openings,
    },
    rooms: [
      {
        id: "room-001",
        name: correction?.room_name || "Room 1",
        type: correction?.room_type || "unspecified",
        boundary_wall_ids: walls.map((wall) => wall.id),
        area: Number(area.toFixed(6)),
        provenance: {
          source_id: source.id,
          source_entity_ids: ["raster-room:0"],
          method: correctionUsed ? "user_edited" : "observed",
          confidence: topologyConfidence,
          tolerance_meters: scale.status === "trusted" ? 0.05 : scale.value * 5,
        },
      },
    ],
    design_objects: [],
    assets: [],
    materials: {},
    assumptions: [
      "The deterministic raster extractor supports orthogonal closed outer shells.",
      ...(scale.status === "estimated"
        ? [
            "No trusted scale anchor was provided; dimensions are estimated and approval is limited to visualization_only.",
          ]
        : []),
      "Structural roles remain unknown until reviewed by a qualified person.",
    ],
    unresolved_questions: unresolved,
    validation: {
      status: unresolved.length > 0 ? "blocked" : "pending",
      approved_scope: null,
      checks: [],
    },
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/spatial/raster-to-spatial.mjs \\
    --input normalized-plan.png \\
    --source-manifest source-manifest.json \\
    [--preprocess-metadata preprocess.json] \\
    [--scale-anchor scale-anchor.json] \\
    [--correction correction.json] \\
    --project-id project-001 --output spatial-draft.json \\
    [--validation-report spatial-validation.json]

Without a trusted scale anchor, the result is automatically limited to
visualization_only. Ambiguous topology is blocked until corrected.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    "preprocess-metadata": { type: "string" },
    "scale-anchor": { type: "string" },
    correction: { type: "string" },
    "estimated-meters-per-pixel": { type: "string", default: "0.01" },
    "project-id": { type: "string", required: true },
    revision: { type: "string", default: "rev-001" },
    output: { type: "string", required: true },
    "validation-report": { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const [sourceManifest, preprocessing, scaleAnchor, correction] =
    await Promise.all([
      readJson(options["source-manifest"], "source manifest"),
      options["preprocess-metadata"]
        ? readJson(options["preprocess-metadata"], "preprocessing metadata")
        : Promise.resolve(null),
      options["scale-anchor"]
        ? readJson(options["scale-anchor"], "scale anchor")
        : Promise.resolve(null),
      options.correction
        ? readJson(options.correction, "raster correction")
        : Promise.resolve(null),
    ]);
  const spatial = await convertRasterToSpatial(options.input, {
    sourceManifest,
    preprocessing,
    scaleAnchor,
    correction,
    estimatedMetersPerPixel: Number(
      options["estimated-meters-per-pixel"],
    ),
    projectId: options["project-id"],
    revision: options.revision,
  });
  const validation = validateSpatialJson(spatial);
  await writeJson(options.output, spatial);
  if (options["validation-report"]) {
    await writeJson(options["validation-report"], validation);
  }
  printJson({
    outputFile: options.output,
    valid: validation.valid,
    schemaValid: validation.schema_valid,
    errors: validation.errors.length,
    unresolvedQuestions: spatial.unresolved_questions.length,
    walls: spatial.envelope.walls.length,
    openings: spatial.envelope.openings.length,
    rooms: spatial.rooms.length,
    scale: spatial.extraction.scale,
    recommendedScope: spatial.extraction.recommended_scope,
  });
  if (!validation.valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

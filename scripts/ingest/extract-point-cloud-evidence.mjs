#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import {
  GiB,
  MiB,
  hashBoundedFile,
  readBoundedFile,
} from "./file-safety.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

function finitePoint(tokens) {
  const point = tokens.slice(0, 3).map(Number);
  return point.length === 3 && point.every(Number.isFinite) ? point : null;
}

function parsePly(text, maxPoints) {
  const end = text.indexOf("end_header");
  if (end < 0) throw new Error("PLY header is incomplete.");
  const header = text.slice(0, end);
  if (!/format\s+ascii\s+1\.0/iu.test(header)) {
    throw new Error("Only ASCII PLY is supported without an external point-cloud converter.");
  }
  const count = Number(/element\s+vertex\s+(\d+)/iu.exec(header)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error("PLY vertex count is missing.");
  if (count > maxPoints) throw new Error(`PLY declares ${count} points, above the ${maxPoints}-point limit.`);
  const body = text.slice(end + "end_header".length).trim().split(/\r?\n/u);
  return body.slice(0, count).map((line) => finitePoint(line.trim().split(/\s+/u))).filter(Boolean);
}

function parsePcd(text, maxPoints) {
  const marker = /^DATA\s+ascii\s*$/imu.exec(text);
  if (!marker) throw new Error("Only ASCII PCD is supported without an external point-cloud converter.");
  const header = text.slice(0, marker.index);
  const fields = /^FIELDS\s+(.+)$/imu.exec(header)?.[1]?.trim().split(/\s+/u) || [];
  const declaredPoints = Number(/^POINTS\s+(\d+)\s*$/imu.exec(header)?.[1]);
  if (Number.isInteger(declaredPoints) && declaredPoints > maxPoints) {
    throw new Error(`PCD declares ${declaredPoints} points, above the ${maxPoints}-point limit.`);
  }
  const indices = ["x", "y", "z"].map((field) => fields.indexOf(field));
  if (indices.some((index) => index < 0)) throw new Error("PCD must contain x, y, and z fields.");
  const body = text.slice(marker.index + marker[0].length).trim().split(/\r?\n/u);
  return body.map((line) => {
    const tokens = line.trim().split(/\s+/u);
    return finitePoint(indices.map((index) => tokens[index]));
  }).filter(Boolean);
}

function parseXyzOrPts(text, format) {
  const lines = text.trim().split(/\r?\n/u);
  const start = format === "pts" && /^\d+$/u.test(lines[0]?.trim()) ? 1 : 0;
  return lines.slice(start).map((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return null;
    return finitePoint(clean.replaceAll(",", " ").split(/\s+/u));
  }).filter(Boolean);
}

export function parseAsciiPointCloud(
  text,
  format,
  {
    maxPoints = 2_000_000,
  } = {},
) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Point-cloud input is empty.");
  let points;
  if (format === "ply") points = parsePly(text, maxPoints);
  else if (format === "pcd") points = parsePcd(text, maxPoints);
  else if (["xyz", "pts"].includes(format)) points = parseXyzOrPts(text, format);
  else throw new Error(`Unsupported ASCII point-cloud format ${format}.`);
  if (points.length > maxPoints) {
    throw new Error(`Point cloud contains ${points.length} points, above the ${maxPoints}-point limit.`);
  }
  return points;
}

function normalizeAxis(point, upAxis) {
  if (upAxis === "Y") return point;
  if (upAxis === "Z") return [point[0], point[2], -point[1]];
  if (upAxis === "X") return [-point[1], point[0], point[2]];
  throw new Error("upAxis must be X, Y, or Z.");
}

function downsample(points, voxelSize) {
  if (!(voxelSize > 0)) return points;
  const voxels = new Map();
  for (const point of points) {
    const key = point.map((value) => Math.floor(value / voxelSize)).join(":");
    if (!voxels.has(key)) voxels.set(key, point);
  }
  return [...voxels.values()];
}

function boundsFor(points) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], point[axis]);
      maximum[axis] = Math.max(maximum[axis], point[axis]);
    }
  }
  return {
    min: minimum,
    max: maximum,
    size: maximum.map((value, axis) => value - minimum[axis]),
  };
}

function extractAxisAlignedPlanes(points, bounds, tolerance) {
  const planes = [];
  const names = ["x", "y", "z"];
  for (let axis = 0; axis < 3; axis += 1) {
    const bins = new Map();
    for (const point of points) {
      const key = Math.round(point[axis] / tolerance);
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    const candidates = [...bins.entries()]
      .filter(([, count]) => count >= Math.max(10, points.length * 0.02))
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6);
    for (const [key, count] of candidates) {
      const offset = key * tolerance;
      const nearMin = Math.abs(offset - bounds.min[axis]) <= tolerance * 2;
      const nearMax = Math.abs(offset - bounds.max[axis]) <= tolerance * 2;
      let kind = "interior_plane";
      if (axis === 1 && nearMin) kind = "floor";
      else if (axis === 1 && nearMax) kind = "ceiling";
      else if (axis !== 1 && (nearMin || nearMax)) kind = "wall";
      planes.push({
        id: `plane-${names[axis]}-${String(key).replace("-", "n")}`,
        axis: names[axis],
        offset,
        kind,
        support_points: count,
        support_ratio: count / points.length,
      });
    }
  }
  return planes;
}

export function detectOpeningCandidates(
  points,
  bounds,
  {
    planeTolerance = 0.05,
    cellSize = 0.1,
  } = {},
) {
  const definitions = [
    { id: "wall-x-min", planeAxis: 0, plane: bounds.min[0], horizontalAxis: 2, start: bounds.min[2], end: bounds.max[2] },
    { id: "wall-x-max", planeAxis: 0, plane: bounds.max[0], horizontalAxis: 2, start: bounds.min[2], end: bounds.max[2] },
    { id: "wall-z-min", planeAxis: 2, plane: bounds.min[2], horizontalAxis: 0, start: bounds.min[0], end: bounds.max[0] },
    { id: "wall-z-max", planeAxis: 2, plane: bounds.max[2], horizontalAxis: 0, start: bounds.min[0], end: bounds.max[0] },
  ];
  const candidates = [];
  for (const definition of definitions) {
    const columns = Math.max(1, Math.ceil((definition.end - definition.start) / cellSize));
    const support = Array(columns).fill(0);
    for (const point of points) {
      if (Math.abs(point[definition.planeAxis] - definition.plane) > planeTolerance * 2) continue;
      if (point[1] < bounds.min[1] + cellSize || point[1] > Math.min(bounds.min[1] + 2.2, bounds.max[1] - cellSize)) continue;
      const column = Math.floor((point[definition.horizontalAxis] - definition.start) / cellSize);
      if (column >= 0 && column < columns) support[column] += 1;
    }
    const maximumSupport = Math.max(...support);
    if (maximumSupport < 3) continue;
    const lowSupport = support.map((count) => count <= maximumSupport * 0.15);
    let runStart = null;
    for (let column = 0; column <= columns; column += 1) {
      if (column < columns && lowSupport[column]) {
        if (runStart === null) runStart = column;
        continue;
      }
      if (runStart === null) continue;
      const runEnd = column;
      const width = (runEnd - runStart) * cellSize;
      const interior = runStart > 0 && runEnd < columns;
      if (interior && width >= 0.6 && width <= 2.5) {
        const leftSupport = support[Math.max(0, runStart - 1)];
        const rightSupport = support[Math.min(columns - 1, runEnd)];
        candidates.push({
          id: `opening-candidate-${definition.id}-${runStart}`,
          host_wall_candidate_id: definition.id,
          offset_range_meters: [
            runStart * cellSize,
            Math.min(definition.end - definition.start, runEnd * cellSize),
          ],
          width_meters: width,
          sill_height_meters: null,
          height_meters: null,
          confidence: Math.min(0.95, (leftSupport + rightSupport) / (2 * maximumSupport)),
          status: "review_required",
          evidence: "low point support bounded by observed wall samples",
        });
      }
      runStart = null;
    }
  }
  return candidates;
}

export function analyzePointCloud(
  points,
  {
    unitScale = 1,
    upAxis = "Y",
    voxelSize = 0.03,
    planeTolerance = 0.05,
    scaleConfirmed = false,
    maxPoints = 2_000_000,
  } = {},
) {
  if (!Array.isArray(points) || points.length < 4) {
    throw new Error("Point cloud requires at least four finite points.");
  }
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new Error("unitScale must be positive.");
  if (!Number.isInteger(maxPoints) || maxPoints < 4) throw new Error("maxPoints must be an integer of at least four.");
  if (points.length > maxPoints) throw new Error(`Point cloud exceeds the ${maxPoints}-point analysis limit.`);
  const normalized = points.map((point) =>
    normalizeAxis(point, upAxis).map((value) => value * unitScale));
  const sampled = downsample(normalized, voxelSize);
  if (sampled.length < 4) throw new Error("Voxel filtering removed too many points.");
  const bounds = boundsFor(sampled);
  const planes = extractAxisAlignedPlanes(sampled, bounds, planeTolerance);
  const openingCandidates = detectOpeningCandidates(sampled, bounds, {
    planeTolerance,
    cellSize: Math.max(voxelSize, 0.1),
  });
  const wallPlanes = planes.filter((plane) => plane.kind === "wall");
  const floorPlanes = planes.filter((plane) => plane.kind === "floor");
  const blockers = [];
  if (!scaleConfirmed) blockers.push("Metric scale has not been independently confirmed.");
  if (points.length < 5000) blockers.push("Fewer than 5,000 source points; construction geometry is not qualified.");
  if (floorPlanes.length === 0) blockers.push("No supported floor plane was detected for the declared up axis.");
  if (wallPlanes.length < 2) blockers.push("Fewer than two supported boundary wall planes were detected.");
  if (bounds.size.some((size) => !Number.isFinite(size) || size <= 0)) blockers.push("Point-cloud bounds are degenerate.");
  const geometryQualityPassed = blockers.length === 0;
  return {
    source_points: points.length,
    filtered_points: sampled.length,
    unit_scale_to_meters: unitScale,
    source_up_axis: upAxis,
    target_axes: { units: "meters", up_axis: "Y", forward_axis: "-Z", handedness: "right" },
    voxel_size_meters: voxelSize,
    bounds,
    planes,
    opening_candidates: openingCandidates,
    sample_points: sampled.slice(0, 32),
    quality: {
      metric_scale_confirmed: scaleConfirmed,
      geometry_quality_passed: geometryQualityPassed,
      construction_ready: false,
      recommended_scope: "visualization_only",
      limitation: "Point density and axis-aligned plane checks do not prove hidden construction geometry, structural role, or code compliance.",
      blockers,
    },
  };
}

export function pointCloudEvidenceToSpatial(
  evidence,
  {
    projectId,
    sourceUri = "local://point-cloud",
    revision = "rev-001",
    defaultWallThickness = 0.2,
  },
) {
  const bounds = evidence.bounds;
  if (
    !bounds
    || !Array.isArray(bounds.min)
    || !Array.isArray(bounds.max)
    || bounds.size?.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("Point-cloud evidence has no usable three-dimensional bounds.");
  }
  const sourceId = "source-point-cloud";
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const height = maxY - minY;
  const wallSpecs = [
    ["wall-x-min", [minX, minZ], [minX, maxZ]],
    ["wall-z-max", [minX, maxZ], [maxX, maxZ]],
    ["wall-x-max", [maxX, maxZ], [maxX, minZ]],
    ["wall-z-min", [maxX, minZ], [minX, minZ]],
  ];
  const walls = wallSpecs.map(([id, start, end]) => ({
    id,
    start,
    end,
    thickness: defaultWallThickness,
    height,
    structural_role: "unknown",
    edit_policy: "review_required",
    provenance: {
      source_id: sourceId,
      method: "parsed",
      confidence: evidence.quality.geometry_quality_passed ? 0.9 : 0.65,
    },
  }));
  return {
    schema_version: "1.0",
    project: {
      id: projectId,
      revision,
      units: "meters",
      up_axis: "Y",
      forward_axis: "-Z",
      handedness: "right",
      origin: [0, 0, 0],
    },
    sources: [{
      id: sourceId,
      type: "point_cloud",
      uri: sourceUri,
      ...(evidence.source?.sha256 ? { sha256: evidence.source.sha256 } : {}),
      contains_personal_data: true,
    }],
    extraction: {
      source_kind: "point_cloud",
      method: "axis_aligned_boundary_plane_draft",
      scale: {
        status: evidence.quality.metric_scale_confirmed ? "trusted" : "estimated",
        meters_per_source_unit: evidence.unit_scale_to_meters,
      },
      topology_confidence: evidence.quality.geometry_quality_passed ? 0.9 : 0.65,
      coordinate_transform: {
        source_space: `${evidence.source_up_axis}-up-source`,
        target_space: "spatial-meters-xz",
        matrix_3x3: evidence.source_up_axis === "Z"
          ? [1, 0, 0, 0, 0, 1, 0, -1, 0]
          : evidence.source_up_axis === "X"
            ? [0, -1, 0, 1, 0, 0, 0, 0, 1]
            : [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
      recommended_scope: evidence.quality.recommended_scope,
    },
    envelope: {
      floor_elevation: minY,
      ceiling_height: height,
      walls,
      openings: [],
    },
    rooms: [{
      id: "room-point-cloud-001",
      type: "unclassified",
      boundary_wall_ids: walls.map((wall) => wall.id),
      floor_elevation: minY,
      ceiling_height: height,
      provenance: {
        source_id: sourceId,
        method: "parsed",
        confidence: evidence.quality.geometry_quality_passed ? 0.9 : 0.65,
      },
    }],
    assumptions: [{
      id: "assumption-point-cloud-wall-thickness",
      message: `Wall thickness ${defaultWallThickness} m is a visualization default pending section verification.`,
    }],
    unresolved_questions: (evidence.opening_candidates || []).map((candidate) => ({
      id: `question-${candidate.id}`,
      message: `Review ${candidate.id} on ${candidate.host_wall_candidate_id}; point support suggests a ${candidate.width_meters.toFixed(2)} m void but sill and height are unresolved.`,
    })),
    validation: { status: "pending", approved_scope: null, checks: [] },
  };
}

export async function convertPointCloudToAscii(
  inputFile,
  outputFile,
  {
    command = "pdal",
    converterApproved = false,
    run = runTool,
    extractionOptions = {},
  } = {},
) {
  if (!converterApproved) {
    throw new Error("Binary point-cloud conversion requires explicit approval of the configured local converter.");
  }
  const input = resolve(inputFile);
  const output = resolve(outputFile);
  const source = await hashBoundedFile(input, {
    label: "Binary point cloud",
    maxBytes: 2 * GiB,
  });
  const tool = await inspectTool(command, ["--version"], { run });
  if (!tool.available) throw new Error(`Configured point-cloud converter is unavailable: ${tool.error}.`);
  await mkdir(dirname(output), { recursive: true });
  await run(
    command,
    ["translate", input, output, "--writers.ply.storage_mode=ascii"],
    { timeoutMs: 600000 },
  );
  const evidence = await extractPointCloudEvidence(output, {
    ...extractionOptions,
    format: "ply",
  });
  return {
    source: {
      path: input,
      sha256: source.sha256,
      bytes: source.metadata.size,
      format: extname(input).slice(1).toLowerCase(),
    },
    output: {
      path: output,
      sha256: evidence.source.sha256,
      bytes: evidence.source.bytes,
      format: "ply",
    },
    converter: {
      command,
      version: tool.version,
      arguments: ["translate", "{input}", "{output}", "--writers.ply.storage_mode=ascii"],
    },
    evidence,
  };
}

export async function extractPointCloudEvidence(
  filePath,
  options = {},
) {
  const maxSourceBytes = options.maxSourceBytes ?? 64 * 1024 * 1024;
  const maxPoints = options.maxPoints ?? 2_000_000;
  const { bytes } = await readBoundedFile(filePath, {
    label: "Point-cloud source",
    maxBytes: maxSourceBytes,
  });
  const format = (options.format || extname(filePath).slice(1)).toLowerCase();
  if (["las", "laz", "e57"].includes(format)) {
    return {
      schema_version: "1.0",
      route: "point_cloud",
      source: { path: filePath, sha256: sha256(bytes), bytes: bytes.length, format },
      quality: {
        metric_scale_confirmed: false,
        geometry_quality_passed: false,
        construction_ready: false,
        recommended_scope: null,
        limitation: "Binary scan formats are not parsed until an approved local conversion preserves units and axes.",
        blockers: [`${format.toUpperCase()} requires a configured local PDAL conversion to ASCII PLY or PCD.`],
      },
    };
  }
  const points = parseAsciiPointCloud(bytes.toString("utf8"), format, { maxPoints });
  return {
    schema_version: "1.0",
    route: "point_cloud",
    source: { path: filePath, sha256: sha256(bytes), bytes: bytes.length, format },
    ...analyzePointCloud(points, options),
  };
}

export async function extractDepthEvidence(
  depthImage,
  intrinsics,
  {
    depthScaleMeters = 0.001,
    sampleStep = 4,
    maxDepthMeters = 20,
    scaleConfirmed = true,
  } = {},
) {
  for (const key of ["fx", "fy", "cx", "cy"]) {
    if (!Number.isFinite(intrinsics?.[key])) throw new Error(`Depth intrinsics require finite ${key}.`);
  }
  if (!Number.isInteger(sampleStep) || sampleStep < 1) throw new Error("sampleStep must be a positive integer.");
  if (!Number.isFinite(depthScaleMeters) || depthScaleMeters <= 0) throw new Error("depthScaleMeters must be positive.");
  if (!Number.isFinite(maxDepthMeters) || maxDepthMeters <= 0) throw new Error("maxDepthMeters must be positive.");
  const { bytes } = await readBoundedFile(depthImage, {
    label: "Depth image",
    maxBytes: 256 * MiB,
  });
  const { data, info } = await sharp(bytes, { failOn: "error" })
    .greyscale()
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  const values = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const points = [];
  for (let y = 0; y < info.height; y += sampleStep) {
    for (let x = 0; x < info.width; x += sampleStep) {
      const depth = values[y * info.width + x] * depthScaleMeters;
      if (!(depth > 0) || depth > maxDepthMeters) continue;
      points.push([
        (x - intrinsics.cx) * depth / intrinsics.fx,
        -(y - intrinsics.cy) * depth / intrinsics.fy,
        depth,
      ]);
    }
  }
  return {
    schema_version: "1.0",
    route: "depth_image",
    source: {
      path: depthImage,
      sha256: sha256(bytes),
      width: info.width,
      height: info.height,
      depth_scale_meters: depthScaleMeters,
    },
    intrinsics,
    ...analyzePointCloud(points, {
      unitScale: 1,
      upAxis: "Y",
      scaleConfirmed,
    }),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    format: { type: "string" },
    "unit-scale": { type: "string", default: "1" },
    "up-axis": { type: "string", default: "Y" },
    "scale-confirmed": { type: "boolean" },
    "pdal-output": { type: "string" },
    "pdal-command": { type: "string", default: "pdal" },
    "allow-pdal": { type: "boolean" },
    intrinsics: { type: "string" },
    "depth-scale": { type: "string", default: "0.001" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/extract-point-cloud-evidence.mjs --input scan.ply --output point-cloud.json --unit-scale 1 --up-axis Z --scale-confirmed\n  node scripts/ingest/extract-point-cloud-evidence.mjs --input scan.laz --pdal-output scan-ascii.ply --allow-pdal --output point-cloud.json --scale-confirmed\n  node scripts/ingest/extract-point-cloud-evidence.mjs --input depth.png --intrinsics intrinsics.json --depth-scale 0.001 --output depth-evidence.json\n");
    return;
  }
  let evidence;
  if (options.intrinsics) {
    evidence = await extractDepthEvidence(
        options.input,
        await readJson(options.intrinsics, "camera intrinsics"),
        {
          depthScaleMeters: Number(options["depth-scale"]),
          scaleConfirmed: options["scale-confirmed"],
        },
      );
  } else if ([".las", ".laz", ".e57"].includes(extname(options.input).toLowerCase()) && options["pdal-output"]) {
    const conversion = await convertPointCloudToAscii(options.input, options["pdal-output"], {
      command: options["pdal-command"],
      converterApproved: options["allow-pdal"],
      extractionOptions: {
        unitScale: Number(options["unit-scale"]),
        upAxis: options["up-axis"].toUpperCase(),
        scaleConfirmed: options["scale-confirmed"],
      },
    });
    evidence = {
      ...conversion.evidence,
      conversion: {
        source: conversion.source,
        output: conversion.output,
        converter: conversion.converter,
      },
    };
  } else {
    evidence = await extractPointCloudEvidence(options.input, {
        format: options.format,
        unitScale: Number(options["unit-scale"]),
        upAxis: options["up-axis"].toUpperCase(),
        scaleConfirmed: options["scale-confirmed"],
      });
  }
  await writeJson(options.output, evidence);
  printJson({
    outputFile: options.output,
    route: evidence.route,
    sourcePoints: evidence.source_points || 0,
    filteredPoints: evidence.filtered_points || 0,
    blockers: evidence.quality.blockers,
  });
  if (evidence.quality.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import DxfParser from "dxf-parser";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { MiB, readBoundedFile } from "./file-safety.mjs";

const UNIT_BY_INSUNITS = new Map([
  [0, "unitless"],
  [1, "inches"],
  [2, "feet"],
  [4, "millimeters"],
  [5, "centimeters"],
  [6, "meters"],
]);

function finitePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  return [point.x, point.y];
}

function normalizedEntity(entity) {
  const base = {
    type: entity.type,
    layer: entity.layer || "0",
    handle: entity.handle || null,
  };
  switch (entity.type) {
    case "LINE":
      return {
        ...base,
        vertices: (entity.vertices || []).map(finitePoint).filter(Boolean),
      };
    case "LWPOLYLINE":
    case "POLYLINE":
      return {
        ...base,
        closed: Boolean(entity.shape || entity.closed),
        vertices: (entity.vertices || []).map(finitePoint).filter(Boolean),
      };
    case "ARC":
    case "CIRCLE":
      return {
        ...base,
        center: finitePoint(entity.center),
        radius: entity.radius,
        start_angle: entity.startAngle ?? null,
        end_angle: entity.endAngle ?? null,
      };
    case "INSERT":
      return {
        ...base,
        block_name: entity.name || null,
        position: finitePoint(entity.position),
        rotation_degrees: entity.rotation || 0,
        scale: [
          entity.xScale || 1,
          entity.yScale || 1,
          entity.zScale || 1,
        ],
      };
    case "TEXT":
    case "MTEXT":
      return {
        ...base,
        text: entity.text || entity.string || "",
        position: finitePoint(entity.startPoint || entity.position),
        text_height: entity.textHeight || entity.height || null,
        rotation_degrees: entity.rotation || 0,
      };
    case "DIMENSION":
      return {
        ...base,
        text: entity.text || null,
        anchor: finitePoint(entity.anchorPoint),
        actual_measurement: entity.actualMeasurement ?? null,
      };
    default:
      return base;
  }
}

function boundsForEntities(entities) {
  const points = [];
  for (const entity of entities) {
    if (Array.isArray(entity.vertices)) points.push(...entity.vertices);
    if (Array.isArray(entity.center)) points.push(entity.center);
    if (Array.isArray(entity.position)) points.push(entity.position);
    if (Array.isArray(entity.anchor)) points.push(entity.anchor);
  }
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)],
  };
}

export function extractDxfEvidence(text, source = {}) {
  const parser = new DxfParser();
  let document;
  try {
    document = parser.parseSync(text);
  } catch (error) {
    throw new Error(`DXF parsing failed: ${error.message}`);
  }
  const entities = (document.entities || []).map(normalizedEntity);
  const counts = {};
  for (const entity of entities) {
    counts[entity.type] = (counts[entity.type] || 0) + 1;
  }
  const insunits =
    document.header?.$INSUNITS?.value ??
    document.header?.$INSUNITS ??
    0;
  return {
    schema_version: "1.0",
    source,
    coordinate_system: {
      drawing_units_code: Number(insunits) || 0,
      drawing_units: UNIT_BY_INSUNITS.get(Number(insunits)) || "other",
      requires_scale_confirmation: !UNIT_BY_INSUNITS.has(Number(insunits)) || Number(insunits) === 0,
    },
    bounds: boundsForEntities(entities),
    layers: Object.keys(document.tables?.layer?.layers || {}).sort(),
    entity_counts: counts,
    entities,
    usage: {
      authoritative_for_geometry: true,
      requires_semantic_classification: true,
      note:
        "Preserve vector coordinates. Use a spatial model only to classify ambiguous layers, blocks, and room semantics.",
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ingest/extract-dxf-evidence.mjs --input plan.dxf --output dxf-evidence.json\n",
    );
    return;
  }
  const { bytes } = await readBoundedFile(options.input, {
    label: "DXF input",
    maxBytes: 512 * MiB,
  });
  const evidence = extractDxfEvidence(bytes.toString("utf8"), {
    path: options.input,
    sha256: sha256(bytes),
  });
  await writeJson(options.output, evidence);
  printJson({
    outputFile: options.output,
    entities: evidence.entities.length,
    layers: evidence.layers.length,
    drawingUnits: evidence.coordinate_system.drawing_units,
    requiresScaleConfirmation:
      evidence.coordinate_system.requires_scale_confirmation,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

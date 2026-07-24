#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import {
  distance2d,
  orderRoomPolygon,
  pointInPolygon,
} from "../geometry/spatial-geometry.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

const METERS_PER_UNIT = new Map([
  ["inches", 0.0254],
  ["feet", 0.3048],
  ["millimeters", 0.001],
  ["centimeters", 0.01],
  ["meters", 1],
]);

export const DEFAULT_DXF_MAPPING = {
  layer_patterns: {
    room: ["^ROOMS?$", "^SPACES?$", "房间"],
    wall: ["^WALLS?$", "^A-WALL", "墙"],
    door: ["^DOORS?$", "门"],
    window: ["^WINDOWS?$", "^WIN$", "窗"],
    room_label: ["^ROOM[_ -]?TEXT$", "^ROOM[_ -]?LABEL", "房名"],
  },
  defaults: {
    wall_thickness_meters: 0.2,
    wall_height_meters: 2.8,
    door_width_meters: 0.9,
    door_height_meters: 2.1,
    window_width_meters: 1.2,
    window_height_meters: 1.2,
    window_sill_meters: 0.9,
    opening_host_tolerance_meters: 0.35,
  },
  blocks: {},
};

function mergeMapping(mapping = {}) {
  return {
    layer_patterns: {
      ...DEFAULT_DXF_MAPPING.layer_patterns,
      ...(mapping.layer_patterns || {}),
    },
    defaults: {
      ...DEFAULT_DXF_MAPPING.defaults,
      ...(mapping.defaults || {}),
    },
    blocks: {
      ...DEFAULT_DXF_MAPPING.blocks,
      ...(mapping.blocks || {}),
    },
  };
}

function matchesLayer(layer, patterns = []) {
  return patterns.some((pattern) =>
    new RegExp(pattern, "iu").test(String(layer || "0")),
  );
}

function classifyEntity(entity, mapping) {
  const block = mapping.blocks[entity.block_name];
  if (block?.role) return block.role;
  for (const role of ["room", "wall", "door", "window", "room_label"]) {
    if (matchesLayer(entity.layer, mapping.layer_patterns[role])) return role;
  }
  if (["TEXT", "MTEXT"].includes(entity.type)) return "annotation";
  return "ignored";
}

function scaledPoint(point, scale) {
  return [point[0] * scale, point[1] * scale];
}

function segmentKey(start, end, tolerance = 1e-6) {
  const pointKey = (point) =>
    `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
  const keys = [pointKey(start), pointKey(end)].sort();
  return `${keys[0]}|${keys[1]}`;
}

function stableSlug(value, fallback) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}._:-]+/gu, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+$/g, "");
  return slug || fallback;
}

function entityId(entity, index) {
  return entity.handle ? `dxf:${entity.handle}` : `dxf:${entity.type}:${index}`;
}

function closedVertices(entity) {
  if (
    !["LWPOLYLINE", "POLYLINE"].includes(entity.type) ||
    !entity.closed ||
    !Array.isArray(entity.vertices) ||
    entity.vertices.length < 3
  ) {
    return null;
  }
  const vertices = [...entity.vertices];
  if (
    vertices.length > 3 &&
    distance2d(vertices[0], vertices[vertices.length - 1]) <= 1e-9
  ) {
    vertices.pop();
  }
  return vertices;
}

function segmentEntities(entity) {
  if (entity.type === "LINE" && entity.vertices?.length >= 2) {
    return [[entity.vertices[0], entity.vertices[1]]];
  }
  if (
    ["LWPOLYLINE", "POLYLINE"].includes(entity.type) &&
    entity.vertices?.length >= 2
  ) {
    const result = [];
    for (let index = 0; index < entity.vertices.length - 1; index += 1) {
      result.push([entity.vertices[index], entity.vertices[index + 1]]);
    }
    if (entity.closed) {
      result.push([
        entity.vertices[entity.vertices.length - 1],
        entity.vertices[0],
      ]);
    }
    return result;
  }
  return [];
}

function buildLoopsFromSegments(segments, tolerance = 1e-6) {
  const pointKey = (point) =>
    `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
  const nodes = new Map();
  segments.forEach((segment, index) => {
    for (const point of [segment.start, segment.end]) {
      const key = pointKey(point);
      if (!nodes.has(key)) nodes.set(key, []);
      nodes.get(key).push(index);
    }
  });
  const loops = [];
  const visited = new Set();
  for (let seed = 0; seed < segments.length; seed += 1) {
    if (visited.has(seed)) continue;
    const component = [];
    const stack = [seed];
    while (stack.length > 0) {
      const index = stack.pop();
      if (visited.has(index)) continue;
      visited.add(index);
      component.push(index);
      const segment = segments[index];
      for (const point of [segment.start, segment.end]) {
        for (const neighbor of nodes.get(pointKey(point)) || []) {
          if (!visited.has(neighbor)) stack.push(neighbor);
        }
      }
    }
    const degree = new Map();
    for (const index of component) {
      for (const point of [segments[index].start, segments[index].end]) {
        const key = pointKey(point);
        degree.set(key, (degree.get(key) || 0) + 1);
      }
    }
    if (component.length >= 3 && [...degree.values()].every((value) => value === 2)) {
      loops.push(component);
    }
  }
  return loops;
}

function projectPointToWall(point, wall) {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - wall.start[0]) * dx +
              (point[1] - wall.start[1]) * dy) /
              lengthSquared,
          ),
        );
  const projected = [wall.start[0] + dx * t, wall.start[1] + dy * t];
  return {
    projected,
    distance: distance2d(point, projected),
    offset: Math.sqrt(lengthSquared) * t,
  };
}

function openingSpec(entity, role, mapping, scale) {
  const block = mapping.blocks[entity.block_name] || {};
  const isDoor = role === "door";
  let center = entity.position ? scaledPoint(entity.position, scale) : null;
  let width =
    Number(block.width_meters) ||
    (isDoor
      ? mapping.defaults.door_width_meters
      : mapping.defaults.window_width_meters);
  if (entity.type === "LINE" && entity.vertices?.length >= 2) {
    const start = scaledPoint(entity.vertices[0], scale);
    const end = scaledPoint(entity.vertices[1], scale);
    center = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    width = distance2d(start, end);
  }
  return {
    center,
    kind:
      block.kind || (isDoor ? "hinged_door" : "window"),
    width,
    height:
      Number(block.height_meters) ||
      (isDoor
        ? mapping.defaults.door_height_meters
        : mapping.defaults.window_height_meters),
    sill_height:
      Number.isFinite(block.sill_meters)
        ? block.sill_meters
        : isDoor
          ? 0
          : mapping.defaults.window_sill_meters,
  };
}

function sourceForEvidence(evidence, sourceManifest) {
  const manifestSources = sourceManifest?.sources || [];
  const byHash = manifestSources.find(
    (source) =>
      evidence.source?.sha256 && source.sha256 === evidence.source.sha256,
  );
  const source = byHash || manifestSources[0];
  if (source) {
    return {
      id: stableSlug(source.id, "source-dxf"),
      type: "dxf_floor_plan",
      uri: source.uri || "local://dxf",
      ...(source.revision ? { revision: source.revision } : {}),
      ...(source.sha256 ? { sha256: source.sha256 } : {}),
      contains_personal_data:
        typeof source.contains_personal_data === "boolean"
          ? source.contains_personal_data
          : false,
    };
  }
  return {
    id: `source-${String(evidence.source?.sha256 || "dxf").slice(0, 12)}`,
    type: "dxf_floor_plan",
    uri: "local://dxf",
    ...(evidence.source?.sha256 ? { sha256: evidence.source.sha256 } : {}),
    contains_personal_data: false,
  };
}

export function convertDxfEvidenceToSpatial(
  evidence,
  {
    sourceManifest = null,
    mapping: mappingInput = {},
    projectId = "dxf-interior",
    revision = "rev-001",
  } = {},
) {
  if (!Array.isArray(evidence?.entities)) {
    throw new Error("DXF evidence must contain an entities array.");
  }
  const mapping = mergeMapping(mappingInput);
  const units = evidence.coordinate_system?.drawing_units;
  const scale = METERS_PER_UNIT.get(units) || null;
  const source = sourceForEvidence(evidence, sourceManifest);
  const unresolved = [];
  if (!scale) {
    unresolved.push({
      code: "dxf.units_unknown",
      message: "Confirm the DXF drawing unit before coordinate conversion.",
      source_ids: [source.id],
    });
  }
  const effectiveScale = scale || 1;
  const classified = evidence.entities.map((entity, index) => ({
    entity,
    index,
    role: classifyEntity(entity, mapping),
  }));

  const roomEntities = classified.filter(
    ({ entity, role }) => role === "room" && closedVertices(entity),
  );
  const rawSegments = [];
  const explicitWallSegments = classified
    .filter(({ role }) => role === "wall")
    .flatMap(({ entity, index }) =>
      segmentEntities(entity).map(([start, end], segmentIndex) => ({
        start: scaledPoint(start, effectiveScale),
        end: scaledPoint(end, effectiveScale),
        evidence_ids: [entityId(entity, index), `segment:${segmentIndex}`],
      })),
    );

  const roomLoops = roomEntities.map(({ entity, index }) => {
    const vertices = closedVertices(entity).map((point) =>
      scaledPoint(point, effectiveScale),
    );
    const segmentIndexes = [];
    for (let cursor = 0; cursor < vertices.length; cursor += 1) {
      segmentIndexes.push(rawSegments.length);
      rawSegments.push({
        start: vertices[cursor],
        end: vertices[(cursor + 1) % vertices.length],
        evidence_ids: [entityId(entity, index), `edge:${cursor}`],
      });
    }
    return {
      segmentIndexes,
      entity,
      entityIndex: index,
      method: "closed_room_polyline",
    };
  });

  if (roomLoops.length === 0 && explicitWallSegments.length > 0) {
    const offset = rawSegments.length;
    rawSegments.push(...explicitWallSegments);
    for (const component of buildLoopsFromSegments(explicitWallSegments)) {
      roomLoops.push({
        segmentIndexes: component.map((index) => offset + index),
        entity: null,
        entityIndex: -1,
        method: "connected_wall_cycle",
      });
    }
  }

  if (roomLoops.length === 0) {
    unresolved.push({
      code: "dxf.room_topology_missing",
      message:
        "No closed ROOM polyline or connected closed WALL cycle was found.",
      source_ids: [source.id],
    });
  }

  const uniqueSegments = new Map();
  for (const segment of rawSegments) {
    const key = segmentKey(segment.start, segment.end);
    if (!uniqueSegments.has(key)) {
      uniqueSegments.set(key, {
        ...segment,
        key,
        evidence_ids: [...segment.evidence_ids],
      });
    } else {
      uniqueSegments.get(key).evidence_ids.push(...segment.evidence_ids);
    }
  }
  const sortedSegments = [...uniqueSegments.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const wallIdByKey = new Map();
  const walls = sortedSegments.map((segment, index) => {
    const id = `wall-${String(index + 1).padStart(3, "0")}`;
    wallIdByKey.set(segment.key, id);
    return {
      id,
      start: segment.start,
      end: segment.end,
      thickness: mapping.defaults.wall_thickness_meters,
      height: mapping.defaults.wall_height_meters,
      structural_role: "unknown",
      edit_policy: "review_required",
      provenance: {
        source_id: source.id,
        source_entity_ids: [...new Set(segment.evidence_ids)].sort(),
        method: "parsed",
        confidence: roomEntities.length > 0 ? 1 : 0.95,
        tolerance_meters: 0.001,
      },
    };
  });

  const rooms = roomLoops.map((loop, index) => {
    const boundaryWallIds = loop.segmentIndexes.map((segmentIndex) => {
      const segment = rawSegments[segmentIndex];
      return wallIdByKey.get(segmentKey(segment.start, segment.end));
    });
    const boundaryWalls = boundaryWallIds
      .map((id) => walls.find((wall) => wall.id === id))
      .filter(Boolean);
    const ordered = orderRoomPolygon(boundaryWalls);
    return {
      id: `room-${String(index + 1).padStart(3, "0")}`,
      name: `Room ${index + 1}`,
      type: "unspecified",
      boundary_wall_ids: boundaryWallIds,
      ...(ordered.valid ? { area: Number(ordered.area.toFixed(6)) } : {}),
      provenance: {
        source_id: source.id,
        source_entity_ids:
          loop.entityIndex >= 0
            ? [entityId(loop.entity, loop.entityIndex)]
            : boundaryWalls.flatMap(
                (wall) => wall.provenance.source_entity_ids,
              ),
        method: "parsed",
        confidence: loop.method === "closed_room_polyline" ? 1 : 0.92,
        tolerance_meters: 0.001,
      },
    };
  });

  const roomPolygons = rooms.map((room) => ({
    room,
    ordered: orderRoomPolygon(
      room.boundary_wall_ids
        .map((id) => walls.find((wall) => wall.id === id))
        .filter(Boolean),
    ),
  }));
  for (const { entity } of classified.filter(
    ({ entity, role }) =>
      ["TEXT", "MTEXT"].includes(entity.type) &&
      ["room_label", "annotation"].includes(role) &&
      entity.position,
  )) {
    const point = scaledPoint(entity.position, effectiveScale);
    const match = roomPolygons.find(
      ({ ordered }) => ordered.valid && pointInPolygon(point, ordered.polygon),
    );
    if (match && String(entity.text || "").trim()) {
      match.room.name = String(entity.text).trim();
    }
  }

  const openings = [];
  for (const { entity, index, role } of classified.filter(({ role }) =>
    ["door", "window"].includes(role),
  )) {
    const spec = openingSpec(entity, role, mapping, effectiveScale);
    if (!spec.center || walls.length === 0) {
      unresolved.push({
        code: "dxf.opening_position_missing",
        message: `Opening ${entityId(entity, index)} has no usable position.`,
        source_ids: [source.id],
      });
      continue;
    }
    const candidates = walls
      .map((wall) => ({ wall, ...projectPointToWall(spec.center, wall) }))
      .sort((left, right) => left.distance - right.distance);
    const host = candidates[0];
    if (
      !host ||
      host.distance > mapping.defaults.opening_host_tolerance_meters
    ) {
      unresolved.push({
        code: "dxf.opening_host_missing",
        message: `Opening ${entityId(entity, index)} is not close enough to a wall.`,
        source_ids: [source.id],
      });
      continue;
    }
    const wallLength = distance2d(host.wall.start, host.wall.end);
    const width = Math.min(spec.width, wallLength);
    const offset = Math.max(
      0,
      Math.min(wallLength - width, host.offset - width / 2),
    );
    openings.push({
      id: `${role}-${String(openings.length + 1).padStart(3, "0")}`,
      kind: spec.kind,
      host_wall_id: host.wall.id,
      offset: Number(offset.toFixed(6)),
      width: Number(width.toFixed(6)),
      height: spec.height,
      sill_height: spec.sill_height,
      provenance: {
        source_id: source.id,
        source_entity_ids: [entityId(entity, index)],
        method: "parsed",
        confidence: host.distance <= 0.01 ? 1 : 0.95,
        tolerance_meters: 0.001,
      },
    });
  }

  const topologyConfidence =
    roomLoops.length === 0
      ? 0
      : roomLoops.every((loop) => loop.method === "closed_room_polyline")
        ? 1
        : 0.92;
  return {
    schema_version: "1.0",
    project: {
      id: stableSlug(projectId, "dxf-interior"),
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
      source_kind: "dxf",
      method: "deterministic-layer-entity-mapping-v1",
      scale: {
        status: scale ? "trusted" : "unknown",
        meters_per_source_unit: scale,
        drawing_units: units || "unknown",
      },
      topology_confidence: topologyConfidence,
      coordinate_transform: {
        source_space: `dxf-${units || "unknown"}`,
        target_space: "spatial-meters-xz",
        matrix_3x3: [
          effectiveScale,
          0,
          0,
          0,
          effectiveScale,
          0,
          0,
          0,
          1,
        ],
      },
      source_conflicts: [],
      mapping: {
        layer_patterns: mapping.layer_patterns,
        defaults: mapping.defaults,
      },
    },
    requirements: {
      design_intent: {},
      constraints: [],
    },
    envelope: {
      floor_elevation: 0,
      ceiling_height: mapping.defaults.wall_height_meters,
      walls,
      openings,
    },
    rooms,
    design_objects: [],
    assets: [],
    materials: {},
    assumptions: [
      "DXF layers and entities were mapped with the recorded deterministic mapping.",
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
  node scripts/spatial/dxf-to-spatial.mjs \\
    --evidence dxf-evidence.json \\
    --source-manifest source-manifest.json \\
    [--mapping dxf-mapping.json] \\
    --project-id project-001 --output spatial-draft.json \\
    [--validation-report spatial-validation.json]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    evidence: { type: "string", required: true },
    "source-manifest": { type: "string", required: true },
    mapping: { type: "string" },
    "project-id": { type: "string", required: true },
    revision: { type: "string", default: "rev-001" },
    output: { type: "string", required: true },
    "validation-report": { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  const [evidence, sourceManifest, mapping] = await Promise.all([
    readJson(options.evidence, "DXF evidence"),
    readJson(options["source-manifest"], "source manifest"),
    options.mapping
      ? readJson(options.mapping, "DXF semantic mapping")
      : Promise.resolve({}),
  ]);
  const spatial = convertDxfEvidenceToSpatial(evidence, {
    sourceManifest,
    mapping,
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
  });
  if (!validation.valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

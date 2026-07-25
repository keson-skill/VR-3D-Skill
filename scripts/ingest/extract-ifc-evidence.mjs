#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { orderRoomPolygon } from "../geometry/spatial-geometry.mjs";
import { MiB, readBoundedFile } from "./file-safety.mjs";

function splitStepArguments(value) {
  const values = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        values.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  values.push(value.slice(start).trim());
  return values;
}

function stepString(value) {
  if (!value || value === "$" || value === "*") return null;
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("''", "'")
    : value;
}

function references(value) {
  return [...String(value || "").matchAll(/#(\d+)/gu)].map((match) => match[1]);
}

function numberTuple(value) {
  const body = String(value || "").replace(/^\(+|\)+$/gu, "");
  const numbers = body.split(",").map(Number);
  return numbers.length >= 2 && numbers.every(Number.isFinite) ? numbers : null;
}

function stableIfcId(entity) {
  const globalId = stepString(entity.args[0]);
  const raw = globalId || `${entity.type.toLowerCase()}-${entity.id}`;
  const sanitized = raw.replace(/[^A-Za-z0-9._:-]+/gu, "-").replace(/^-+/u, "");
  return `ifc-${sanitized || entity.id}`;
}

function stepScalar(value) {
  const text = String(value || "").trim();
  if (!text || text === "$" || text === "*") return null;
  const typed = /^IFC[A-Z0-9_]+\(([\s\S]*)\)$/iu.exec(text);
  if (typed) return stepScalar(typed[1]);
  if (text.startsWith("'") && text.endsWith("'")) return stepString(text);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?$/iu.test(text)) return Number(text);
  if (text === ".T.") return true;
  if (text === ".F.") return false;
  if (/^\.[A-Z0-9_]+\.$/iu.test(text)) return text.slice(1, -1).toLowerCase();
  return text.slice(0, 512);
}

export function parseIfcStep(text) {
  if (typeof text !== "string" || !/ISO-10303-21\s*;/iu.test(text)) {
    throw new Error("Input is not an IFC STEP Physical File.");
  }
  const entities = new Map();
  const pattern = /#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/giu;
  for (const match of text.matchAll(pattern)) {
    entities.set(match[1], {
      id: match[1],
      type: match[2].toUpperCase(),
      args: splitStepArguments(match[3]),
      raw: match[0],
    });
  }
  if (entities.size === 0) throw new Error("IFC file contains no STEP entities.");
  return entities;
}

function lengthUnit(entities) {
  for (const entity of entities.values()) {
    if (entity.type !== "IFCSIUNIT") continue;
    const joined = entity.args.join(",").toUpperCase();
    if (!joined.includes(".LENGTHUNIT.") || !joined.includes(".METRE.")) continue;
    const prefix = entity.args.find((argument) => /^\.[A-Z]+\.$/u.test(argument) && ![".LENGTHUNIT.", ".METRE."].includes(argument));
    const scale = {
      ".MILLI.": 0.001,
      ".CENTI.": 0.01,
      ".DECI.": 0.1,
      ".DECA.": 10,
      ".HECTO.": 100,
      ".KILO.": 1000,
    }[prefix] || 1;
    return { known: true, name: prefix ? `${prefix.slice(1, -1).toLowerCase()}metre` : "metre", meters_per_unit: scale };
  }
  return { known: false, name: null, meters_per_unit: null };
}

function pointFor(entities, reference) {
  const entity = entities.get(reference);
  if (!entity || entity.type !== "IFCCARTESIANPOINT") return null;
  return numberTuple(entity.args[0]);
}

function directionFor(entities, reference) {
  const entity = entities.get(reference);
  if (!entity || entity.type !== "IFCDIRECTION") return null;
  return numberTuple(entity.args[0]);
}

function axisPlacement2d(entities, reference) {
  const entity = entities.get(reference);
  if (!entity || !["IFCAXIS2PLACEMENT2D", "IFCAXIS2PLACEMENT3D"].includes(entity.type)) {
    return { x: 0, y: 0, angle: 0 };
  }
  const location = pointFor(entities, references(entity.args[0])[0]) || [0, 0, 0];
  const directionReference = entity.type === "IFCAXIS2PLACEMENT3D"
    ? references(entity.args[2])[0]
    : references(entity.args[1])[0];
  const direction = directionFor(entities, directionReference) || [1, 0, 0];
  return {
    x: location[0],
    y: location[1],
    angle: Math.atan2(direction[1], direction[0]),
  };
}

function composePlacement(parent, child) {
  const cosine = Math.cos(parent.angle);
  const sine = Math.sin(parent.angle);
  return {
    x: parent.x + child.x * cosine - child.y * sine,
    y: parent.y + child.x * sine + child.y * cosine,
    angle: parent.angle + child.angle,
  };
}

function localPlacement2d(entities, reference, visited = new Set()) {
  if (!reference || visited.has(reference)) return { x: 0, y: 0, angle: 0 };
  visited.add(reference);
  const entity = entities.get(reference);
  if (!entity || entity.type !== "IFCLOCALPLACEMENT") return { x: 0, y: 0, angle: 0 };
  const parentReference = references(entity.args[0])[0];
  const relativeReference = references(entity.args[1])[0];
  return composePlacement(
    localPlacement2d(entities, parentReference, visited),
    axisPlacement2d(entities, relativeReference),
  );
}

function collectReachable(entities, reference, allowedType, visited = new Set()) {
  if (!reference || visited.has(reference)) return [];
  visited.add(reference);
  const entity = entities.get(reference);
  if (!entity) return [];
  const found = entity.type === allowedType ? [entity] : [];
  for (const child of entity.args.flatMap(references)) {
    found.push(...collectReachable(entities, child, allowedType, visited));
  }
  return found;
}

function transformPoint(point, placement, scale) {
  const cosine = Math.cos(placement.angle);
  const sine = Math.sin(placement.angle);
  return [
    (placement.x + point[0] * cosine - point[1] * sine) * scale,
    (placement.y + point[0] * sine + point[1] * cosine) * scale,
  ];
}

function wallAxes(entities, unit) {
  if (!unit.known) return [];
  const walls = [];
  for (const entity of entities.values()) {
    if (!["IFCWALL", "IFCWALLSTANDARDCASE"].includes(entity.type)) continue;
    const placement = localPlacement2d(entities, references(entity.args[5])[0]);
    const representationReference = references(entity.args[6])[0];
    const polylines = collectReachable(entities, representationReference, "IFCPOLYLINE");
    const line = polylines
      .map((polyline) => references(polyline.args[0]).map((reference) => pointFor(entities, reference)).filter(Boolean))
      .find((points) => points.length === 2);
    if (!line) continue;
    walls.push({
      id: stableIfcId(entity),
      ifc_entity: `#${entity.id}`,
      ifc_type: entity.type,
      name: stepString(entity.args[2]),
      start: transformPoint(line[0], placement, unit.meters_per_unit),
      end: transformPoint(line[1], placement, unit.meters_per_unit),
      geometry_source: "ifc_axis_polyline",
    });
  }
  return walls;
}

export function extractIfcEvidence(text, { path = null, fileSha256 = null } = {}) {
  const entities = parseIfcStep(text);
  const unit = lengthUnit(entities);
  const typeCounts = {};
  const semanticElements = [];
  const semanticTypes = new Set([
    "IFCPROJECT",
    "IFCSITE",
    "IFCBUILDING",
    "IFCBUILDINGSTOREY",
    "IFCSPACE",
    "IFCWALL",
    "IFCWALLSTANDARDCASE",
    "IFCOPENINGELEMENT",
    "IFCDOOR",
    "IFCWINDOW",
    "IFCSLAB",
    "IFCCOLUMN",
    "IFCBEAM",
    "IFCSTAIR",
    "IFCFURNISHINGELEMENT",
    "IFCSANITARYTERMINAL",
    "IFCDISTRIBUTIONELEMENT",
  ]);
  for (const entity of entities.values()) {
    typeCounts[entity.type] = (typeCounts[entity.type] || 0) + 1;
    if (semanticTypes.has(entity.type)) {
      semanticElements.push({
        id: stableIfcId(entity),
        ifc_entity: `#${entity.id}`,
        ifc_type: entity.type,
        global_id: stepString(entity.args[0]),
        name: stepString(entity.args[2]),
        description: stepString(entity.args[3]),
        storey_id: null,
        parent_id: null,
        host_id: null,
        opening_id: null,
        type_id: null,
        classifications: [],
        properties: {},
      });
    }
  }
  const semanticByEntity = new Map(
    semanticElements.map((element) => [element.ifc_entity.slice(1), element]),
  );
  const stableIdForReference = (reference) => {
    const semantic = semanticByEntity.get(reference);
    if (semantic) return semantic.id;
    const entity = entities.get(reference);
    return entity ? stableIfcId(entity) : null;
  };
  const propertySetFor = (reference) => {
    const propertySet = entities.get(reference);
    if (!propertySet || propertySet.type !== "IFCPROPERTYSET") return null;
    const properties = {};
    for (const propertyReference of references(propertySet.args[4])) {
      const property = entities.get(propertyReference);
      if (!property) continue;
      const name = stepString(property.args[0]) || `${property.type}-${property.id}`;
      if (property.type === "IFCPROPERTYSINGLEVALUE") {
        properties[name] = stepScalar(property.args[2]);
      } else {
        properties[name] = {
          ifc_type: property.type,
          value: stepScalar(property.args[2]),
        };
      }
    }
    return {
      id: stableIfcId(propertySet),
      name: stepString(propertySet.args[2]),
      properties,
    };
  };
  const propertySets = [];
  for (const entity of entities.values()) {
    if (entity.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const storeyId = stableIdForReference(references(entity.args[5])[0]);
      for (const reference of references(entity.args[4])) {
        const element = semanticByEntity.get(reference);
        if (element) element.storey_id = storeyId;
      }
    } else if (entity.type === "IFCRELAGGREGATES") {
      const parentId = stableIdForReference(references(entity.args[4])[0]);
      for (const reference of references(entity.args[5])) {
        const element = semanticByEntity.get(reference);
        if (element) element.parent_id = parentId;
      }
    } else if (entity.type === "IFCRELDEFINESBYPROPERTIES") {
      const propertySet = propertySetFor(references(entity.args[5])[0]);
      if (!propertySet) continue;
      if (!propertySets.some((candidate) => candidate.id === propertySet.id)) {
        propertySets.push(propertySet);
      }
      for (const reference of references(entity.args[4])) {
        const element = semanticByEntity.get(reference);
        if (element) {
          element.properties[propertySet.name || propertySet.id] = propertySet.properties;
        }
      }
    } else if (entity.type === "IFCRELDEFINESBYTYPE") {
      const typeId = stableIdForReference(references(entity.args[5])[0]);
      for (const reference of references(entity.args[4])) {
        const element = semanticByEntity.get(reference);
        if (element) element.type_id = typeId;
      }
    } else if (entity.type === "IFCRELASSOCIATESCLASSIFICATION") {
      const classificationReference = references(entity.args[5])[0];
      const classification = entities.get(classificationReference);
      const classificationRecord = classification
        ? {
            id: stableIfcId(classification),
            ifc_type: classification.type,
            identification: stepScalar(classification.args[1]),
            name: stepScalar(classification.args[2]),
          }
        : null;
      if (!classificationRecord) continue;
      for (const reference of references(entity.args[4])) {
        const element = semanticByEntity.get(reference);
        if (element) element.classifications.push(classificationRecord);
      }
    } else if (entity.type === "IFCRELVOIDSELEMENT") {
      const hostId = stableIdForReference(references(entity.args[4])[0]);
      const openingId = stableIdForReference(references(entity.args[5])[0]);
      const opening = semanticByEntity.get(references(entity.args[5])[0]);
      if (opening) opening.host_id = hostId;
      const host = semanticByEntity.get(references(entity.args[4])[0]);
      if (host && openingId) host.opening_id = openingId;
    } else if (entity.type === "IFCRELFILLSELEMENT") {
      const openingId = stableIdForReference(references(entity.args[4])[0]);
      const filling = semanticByEntity.get(references(entity.args[5])[0]);
      if (filling) filling.opening_id = openingId;
    }
  }
  const storeys = [...entities.values()]
    .filter((entity) => entity.type === "IFCBUILDINGSTOREY")
    .map((entity) => ({
      id: stableIfcId(entity),
      ifc_entity: `#${entity.id}`,
      name: stepString(entity.args[2]),
      long_name: stepString(entity.args[7]),
      elevation: stepScalar(entity.args[9]),
    }));
  const axes = wallAxes(entities, unit);
  for (const axis of axes) {
    axis.storey_id = semanticByEntity.get(axis.ifc_entity.slice(1))?.storey_id || null;
  }
  const blockers = [];
  if (!unit.known) blockers.push("IFC length unit is missing or unsupported.");
  if (axes.length < 3) blockers.push("IFC contains fewer than three extractable wall-axis polylines; use a verified IFC geometry engine or provide a mapping sidecar.");
  const wallStoreys = new Set(axes.map((wall) => wall.storey_id).filter(Boolean));
  if (wallStoreys.size > 1) {
    blockers.push("IFC wall axes span multiple storeys; select and verify one storey before creating a Spatial draft.");
  }
  return {
    schema_version: "1.0",
    route: "ifc_semantics",
    source: { path, sha256: fileSha256 },
    header_schema: /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/iu.exec(text)?.[1] || null,
    entities: { total: entities.size, by_type: typeCounts },
    length_unit: unit,
    storeys,
    semantic_elements: semanticElements,
    property_sets: propertySets,
    wall_axes: axes,
    blockers,
  };
}

export function ifcEvidenceToSpatial(
  evidence,
  {
    projectId,
    sourceUri = "local://ifc",
    revision = "rev-001",
    defaultWallThickness = 0.2,
    defaultWallHeight = 2.8,
  },
) {
  if (!evidence.length_unit?.known || evidence.wall_axes.length < 3) {
    throw new Error(`IFC evidence cannot form a Spatial draft: ${evidence.blockers.join(" ")}`);
  }
  const sourceId = "source-ifc";
  const walls = evidence.wall_axes.map((wall) => ({
    id: wall.id,
    start: wall.start,
    end: wall.end,
    thickness: defaultWallThickness,
    height: defaultWallHeight,
    structural_role: "unknown",
    edit_policy: "review_required",
    provenance: {
      source_id: sourceId,
      method: "parsed",
      confidence: 0.75,
    },
  }));
  const ordered = orderRoomPolygon(walls);
  if (!ordered.valid) {
    throw new Error(`IFC wall axes do not form one closed room: ${ordered.code}.`);
  }
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
      type: "ifc_bim",
      uri: sourceUri,
      ...(evidence.source.sha256 ? { sha256: evidence.source.sha256 } : {}),
      contains_personal_data: false,
    }],
    extraction: {
      source_kind: "ifc",
      method: "ifc_step_semantics_and_axis_polylines",
      scale: {
        status: "trusted",
        meters_per_source_unit: evidence.length_unit.meters_per_unit,
      },
      topology_confidence: 0.75,
      recommended_scope: "visualization_only",
      coordinate_transform: {
        source_space: "ifc-length-units-xy",
        target_space: "spatial-meters-xz",
        matrix_3x3: [
          evidence.length_unit.meters_per_unit, 0, 0,
          0, evidence.length_unit.meters_per_unit, 0,
          0, 0, 1,
        ],
      },
    },
    envelope: {
      floor_elevation: 0,
      ceiling_height: defaultWallHeight,
      walls,
      openings: [],
    },
    rooms: [{
      id: "room-ifc-001",
      type: "unclassified",
      boundary_wall_ids: walls.map((wall) => wall.id),
      provenance: {
        source_id: sourceId,
        method: "parsed",
        confidence: 0.75,
      },
    }],
    assumptions: [
      {
        id: "assumption-ifc-wall-defaults",
        message: `Wall thickness ${defaultWallThickness} m and height ${defaultWallHeight} m are visualization defaults, not IFC measurements.`,
      },
    ],
    unresolved_questions: evidence.semantic_elements
      .filter((element) => ["IFCDOOR", "IFCWINDOW"].includes(element.ifc_type))
      .map((element, index) => ({
        id: `question-ifc-opening-${index + 1}`,
        message: `Opening ${element.id} requires verified host-wall geometry before placement.`,
      })),
    validation: { status: "pending", approved_scope: null, checks: [] },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    spatial: { type: "string" },
    "project-id": { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/extract-ifc-evidence.mjs --input model.ifc --output ifc-evidence.json [--spatial spatial-draft.json --project-id project-001]\n");
    return;
  }
  const { bytes } = await readBoundedFile(options.input, {
    label: "IFC input",
    maxBytes: 512 * MiB,
  });
  const evidence = extractIfcEvidence(bytes.toString("utf8"), {
    path: options.input,
    fileSha256: sha256(bytes),
  });
  await writeJson(options.output, evidence);
  if (options.spatial) {
    if (!options["project-id"]) throw new Error("--spatial requires --project-id.");
    await writeJson(options.spatial, ifcEvidenceToSpatial(evidence, {
      projectId: options["project-id"],
      sourceUri: options.input,
    }));
  }
  printJson({
    outputFile: options.output,
    schema: evidence.header_schema,
    entities: evidence.entities.total,
    wallAxes: evidence.wall_axes.length,
    blockers: evidence.blockers,
  });
  if (evidence.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

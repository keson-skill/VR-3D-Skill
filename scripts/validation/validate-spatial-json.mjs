#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import {
  convexPolygonsOverlap,
  designObjectFootprint,
  orderRoomPolygon,
  pointInPolygon,
} from "../geometry/spatial-geometry.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteVector(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(Number.isFinite)
  );
}

function distance2d(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

export function collectStableIds(document) {
  const entries = [];
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (!isObject(value)) {
      return;
    }
    if (typeof value.id === "string" && value.id.trim()) {
      entries.push({ id: value.id, path: `${path}/id` });
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}/${key}`);
    }
  };
  visit(document, "");
  return entries;
}

export function validateSpatialJson(
  document,
  { requireApproved = false } = {},
) {
  const errors = [];
  const warnings = [];
  const addError = (code, path, message) =>
    errors.push({ code, path, message });
  const addWarning = (code, path, message) =>
    warnings.push({ code, path, message });

  if (!isObject(document)) {
    addError("document.type", "", "Spatial JSON must be an object.");
    return { valid: false, errors, warnings };
  }

  if (typeof document.schema_version !== "string") {
    addError(
      "schema_version.required",
      "/schema_version",
      "schema_version must be a string.",
    );
  }

  const project = document.project;
  if (!isObject(project)) {
    addError("project.required", "/project", "project must be an object.");
  } else {
    for (const key of ["id", "revision", "units", "up_axis", "forward_axis", "handedness"]) {
      if (typeof project[key] !== "string" || !project[key].trim()) {
        addError(
          `project.${key}`,
          `/project/${key}`,
          `${key} must be a non-empty string.`,
        );
      }
    }
    if (project.units !== "meters") {
      addWarning(
        "project.units",
        "/project/units",
        "Meters are the expected internal unit; record any conversion explicitly.",
      );
    }
    if (!isFiniteVector(project.origin, 3)) {
      addError(
        "project.origin",
        "/project/origin",
        "origin must contain three finite numbers.",
      );
    }
  }

  const idEntries = collectStableIds(document);
  const idPaths = new Map();
  for (const entry of idEntries) {
    if (idPaths.has(entry.id)) {
      addError(
        "id.duplicate",
        entry.path,
        `Stable ID ${entry.id} is already used at ${idPaths.get(entry.id)}.`,
      );
    } else {
      idPaths.set(entry.id, entry.path);
    }
  }

  const walls = document.envelope?.walls;
  const wallMap = new Map();
  if (!Array.isArray(walls) || walls.length === 0) {
    addError(
      "walls.required",
      "/envelope/walls",
      "At least one wall is required.",
    );
  } else {
    walls.forEach((wall, index) => {
      const path = `/envelope/walls/${index}`;
      if (!isObject(wall) || typeof wall.id !== "string") {
        addError("wall.id", `${path}/id`, "Wall ID is required.");
        return;
      }
      wallMap.set(wall.id, wall);
      if (!isFiniteVector(wall.start, 2) || !isFiniteVector(wall.end, 2)) {
        addError(
          "wall.segment",
          path,
          "Wall start and end must contain two finite numbers.",
        );
      } else if (distance2d(wall.start, wall.end) <= 1e-6) {
        addError("wall.zero_length", path, "Wall length must be greater than zero.");
      }
      for (const key of ["thickness", "height"]) {
        if (!Number.isFinite(wall[key]) || wall[key] <= 0) {
          addError(
            `wall.${key}`,
            `${path}/${key}`,
            `${key} must be a positive number.`,
          );
        }
      }
      if (wall.structural_role === "unknown" && wall.edit_policy === "editable") {
        addError(
          "wall.unsafe_edit_policy",
          `${path}/edit_policy`,
          "A wall with unknown structural role cannot be freely editable.",
        );
      }
    });
  }

  const openings = document.envelope?.openings;
  if (openings !== undefined && !Array.isArray(openings)) {
    addError(
      "openings.type",
      "/envelope/openings",
      "openings must be an array.",
    );
  } else {
    (openings || []).forEach((opening, index) => {
      const path = `/envelope/openings/${index}`;
      const wall = wallMap.get(opening?.host_wall_id);
      if (!wall) {
        addError(
          "opening.host_wall",
          `${path}/host_wall_id`,
          `Unknown host wall ${opening?.host_wall_id || "(missing)"}.`,
        );
        return;
      }
      for (const key of ["offset", "width", "height"]) {
        if (!Number.isFinite(opening[key]) || opening[key] < 0) {
          addError(
            `opening.${key}`,
            `${path}/${key}`,
            `${key} must be a non-negative finite number.`,
          );
        }
      }
      if (opening.width === 0 || opening.height === 0) {
        addError(
          "opening.zero_size",
          path,
          "Opening width and height must be greater than zero.",
        );
      }
      const sillHeight = opening.sill_height || 0;
      if (!Number.isFinite(sillHeight) || sillHeight < 0) {
        addError(
          "opening.sill_height",
          `${path}/sill_height`,
          "sill_height must be a non-negative finite number.",
        );
      } else if (
        Number.isFinite(opening.height) &&
        Number.isFinite(wall.height) &&
        sillHeight + opening.height > wall.height + 1e-6
      ) {
        addError(
          "opening.above_wall",
          path,
          "Opening sill and height extend above the host wall.",
        );
      }
      if (
        isFiniteVector(wall.start, 2) &&
        isFiniteVector(wall.end, 2) &&
        Number.isFinite(opening.offset) &&
        Number.isFinite(opening.width) &&
        opening.offset + opening.width > distance2d(wall.start, wall.end) + 1e-6
      ) {
        addError(
          "opening.outside_wall",
          path,
          "Opening extends beyond its host wall.",
        );
      }
    });
  }

  const rooms = document.rooms;
  const roomIds = new Set();
  const roomPolygons = new Map();
  if (!Array.isArray(rooms) || rooms.length === 0) {
    addError("rooms.required", "/rooms", "At least one room is required.");
  } else {
    rooms.forEach((room, index) => {
      const path = `/rooms/${index}`;
      if (typeof room?.id === "string") {
        roomIds.add(room.id);
      }
      if (!Array.isArray(room?.boundary_wall_ids) || room.boundary_wall_ids.length < 3) {
        addError(
          "room.boundary",
          `${path}/boundary_wall_ids`,
          "A room boundary requires at least three wall IDs.",
        );
        return;
      }

      const boundaryWalls = room.boundary_wall_ids
        .map((id) => wallMap.get(id))
        .filter(Boolean);
      if (boundaryWalls.length !== room.boundary_wall_ids.length) {
        addError(
          "room.wall_reference",
          `${path}/boundary_wall_ids`,
          "Room boundary references an unknown wall.",
        );
        return;
      }

      if (new Set(room.boundary_wall_ids).size !== room.boundary_wall_ids.length) {
        addError(
          "room.duplicate_wall",
          `${path}/boundary_wall_ids`,
          "Room boundary must not contain a wall more than once.",
        );
        return;
      }
      const ordered = orderRoomPolygon(boundaryWalls);
      if (!ordered.valid) {
        addError(
          ordered.code,
          `${path}/boundary_wall_ids`,
          "Boundary walls must form one connected, non-self-intersecting closed polygon.",
        );
        return;
      }
      roomPolygons.set(room.id, ordered.polygon);
      if (
        Number.isFinite(room.area) &&
        Math.abs(room.area - ordered.area) > Math.max(0.05, ordered.area * 0.02)
      ) {
        addWarning(
          "room.area_mismatch",
          `${path}/area`,
          `Declared area ${room.area} differs from wall polygon area ${ordered.area.toFixed(3)}.`,
        );
      }
    });
  }

  const openingsByWall = new Map();
  for (const opening of Array.isArray(openings) ? openings : []) {
    if (!openingsByWall.has(opening.host_wall_id)) {
      openingsByWall.set(opening.host_wall_id, []);
    }
    openingsByWall.get(opening.host_wall_id).push(opening);
  }
  for (const [wallId, hosted] of openingsByWall) {
    const sorted = [...hosted].sort((left, right) => left.offset - right.offset);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].offset < sorted[index - 1].offset + sorted[index - 1].width - 1e-6) {
        addError(
          "opening.overlap",
          "/envelope/openings",
          `Openings ${sorted[index - 1].id} and ${sorted[index].id} overlap on wall ${wallId}.`,
        );
      }
    }
  }

  const assetIds = new Set(
    Array.isArray(document.assets)
      ? document.assets.map((asset) => asset?.id).filter(Boolean)
      : [],
  );
  if (document.assets !== undefined && !Array.isArray(document.assets)) {
    addError("assets.type", "/assets", "assets must be an array.");
  }

  if (document.design_objects !== undefined && !Array.isArray(document.design_objects)) {
    addError(
      "design_objects.type",
      "/design_objects",
      "design_objects must be an array.",
    );
  } else {
    const objectFootprints = [];
    (document.design_objects || []).forEach((object, index) => {
      const path = `/design_objects/${index}`;
      if (!roomIds.has(object?.room_id)) {
        addError(
          "design_object.room",
          `${path}/room_id`,
          `Unknown room ${object?.room_id || "(missing)"}.`,
        );
      }
      if (object?.asset_id && !assetIds.has(object.asset_id)) {
        addError(
          "design_object.asset",
          `${path}/asset_id`,
          `Unknown asset ${object.asset_id}.`,
        );
      }
      if (!isFiniteVector(object?.dimensions, 3) || object.dimensions.some((value) => value <= 0)) {
        addError(
          "design_object.dimensions",
          `${path}/dimensions`,
          "Object dimensions must contain three positive numbers.",
        );
      }
      if (!isFiniteVector(object?.transform?.position, 3)) {
        addError(
          "design_object.position",
          `${path}/transform/position`,
          "Object position must contain three finite numbers.",
        );
      } else if (
        isFiniteVector(object?.dimensions, 3) &&
        object.dimensions.every((value) => value > 0)
      ) {
        const roomPolygon = roomPolygons.get(object.room_id);
        if (roomPolygon) {
          const footprint = designObjectFootprint(object);
          const center = [
            object.transform.position[0],
            object.transform.position[2],
          ];
          if (!pointInPolygon(center, roomPolygon)) {
            addError(
              "design_object.outside_room",
              `${path}/transform/position`,
              "Object center is outside its assigned room.",
            );
          } else if (footprint.some((corner) => !pointInPolygon(corner, roomPolygon))) {
            addWarning(
              "design_object.crosses_room_boundary",
              path,
              "Object footprint crosses its room boundary; confirm wall clearance and asset pivot.",
            );
          }
          objectFootprints.push({ object, footprint, path });
        }
      }
    });
    for (let left = 0; left < objectFootprints.length; left += 1) {
      for (let right = left + 1; right < objectFootprints.length; right += 1) {
        const first = objectFootprints[left];
        const second = objectFootprints[right];
        if (
          first.object.room_id === second.object.room_id &&
          convexPolygonsOverlap(first.footprint, second.footprint)
        ) {
          addError(
            "design_object.collision",
            first.path,
            `Object ${first.object.id} overlaps ${second.object.id}.`,
          );
        }
      }
    }
  }

  const paths = document.circulation?.paths;
  if (paths !== undefined && !Array.isArray(paths)) {
    addError(
      "circulation.paths",
      "/circulation/paths",
      "circulation.paths must be an array.",
    );
  } else {
    (paths || []).forEach((path, index) => {
      if (
        !Array.isArray(path?.polyline) ||
        path.polyline.length < 2 ||
        path.polyline.some((point) => !isFiniteVector(point, 2))
      ) {
        addError(
          "circulation.polyline",
          `/circulation/paths/${index}/polyline`,
          "A circulation path requires at least two 2D points.",
        );
      }
      if (!Number.isFinite(path?.minimum_width) || path.minimum_width <= 0) {
        addError(
          "circulation.width",
          `/circulation/paths/${index}/minimum_width`,
          "minimum_width must be positive.",
        );
      }
    });
  }

  if (document.xr !== undefined) {
    if (!isFiniteVector(document.xr?.spawn, 3)) {
      addError(
        "xr.spawn",
        "/xr/spawn",
        "XR spawn must contain three finite numbers.",
      );
    }
    for (const roomId of document.xr?.boundary_room_ids || []) {
      if (!roomIds.has(roomId)) {
        addError(
          "xr.boundary_room",
          "/xr/boundary_room_ids",
          `Unknown XR boundary room ${roomId}.`,
        );
      }
    }
  }

  if (requireApproved) {
    if (document.validation?.status !== "approved") {
      addError(
        "validation.not_approved",
        "/validation/status",
        "Downstream generation requires validation.status to equal approved.",
      );
    }
    if (
      Array.isArray(document.unresolved_questions) &&
      document.unresolved_questions.length > 0
    ) {
      addError(
        "validation.unresolved_questions",
        "/unresolved_questions",
        "Approved Spatial JSON cannot contain unresolved questions.",
      );
    }
    if (
      !["visualization_only", "construction_ready"].includes(
        document.validation?.approved_scope,
      )
    ) {
      addError(
        "validation.approved_scope",
        "/validation/approved_scope",
        "Approved Spatial JSON must declare visualization_only or construction_ready scope.",
      );
    }
  }

  return {
    valid: errors.length === 0,
    require_approved: requireApproved,
    errors,
    warnings,
    summary: {
      stable_ids: idEntries.length,
      walls: Array.isArray(walls) ? walls.length : 0,
      rooms: Array.isArray(rooms) ? rooms.length : 0,
      openings: Array.isArray(openings) ? openings.length : 0,
      design_objects: Array.isArray(document.design_objects)
        ? document.design_objects.length
        : 0,
    },
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/validate-spatial-json.mjs --input spatial.json [--output validation-report.json] [--require-approved]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string" },
    "require-approved": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const document = await readJson(options.input, "Spatial JSON");
  const report = validateSpatialJson(document, {
    requireApproved: options["require-approved"],
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

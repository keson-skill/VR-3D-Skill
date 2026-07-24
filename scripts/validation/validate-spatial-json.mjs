#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
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
import { verifySpatialApproval } from "../approval/spatial-approval.mjs";
import { validateSpatialSchema } from "./json-schema.mjs";

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
  {
    requireApproved = false,
    approval = null,
    sourceManifest = null,
    validationReport = null,
    approvalTrust = null,
    allowTestApproval = false,
  } = {},
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

  const schemaValidation = validateSpatialSchema(document);
  for (const error of schemaValidation.errors) {
    errors.push(error);
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

  const sourceIds = new Set(
    Array.isArray(document.sources)
      ? document.sources.map((source) => source?.id).filter(Boolean)
      : [],
  );
  function validateProvenance(fact, path, { required = false } = {}) {
    if (!isObject(fact?.provenance)) {
      if (required) {
        addError(
          "provenance.required",
          `${path}/provenance`,
          "Approved spatial facts require source-bound provenance.",
        );
      }
      return;
    }
    if (!sourceIds.has(fact.provenance.source_id)) {
      addError(
        "provenance.source",
        `${path}/provenance/source_id`,
        `Unknown provenance source ${fact.provenance.source_id || "(missing)"}.`,
      );
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
      validateProvenance(wall, path, { required: requireApproved });
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
      validateProvenance(opening, path, { required: requireApproved });
    });
  }

  const rooms = document.rooms;
  const roomIds = new Set();
  const roomPolygons = new Map();
  const defaultFloorElevation = document.envelope?.floor_elevation;
  const defaultCeilingElevation =
    Number.isFinite(defaultFloorElevation) &&
    Number.isFinite(document.envelope?.ceiling_height)
      ? defaultFloorElevation + document.envelope.ceiling_height
      : null;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    addError("rooms.required", "/rooms", "At least one room is required.");
  } else {
    rooms.forEach((room, index) => {
      const path = `/rooms/${index}`;
      if (typeof room?.id === "string") {
        roomIds.add(room.id);
      }
      const floorElevation = room?.floor_elevation ?? defaultFloorElevation;
      const ceilingElevation =
        room?.ceiling_elevation ?? defaultCeilingElevation;
      if (!Number.isFinite(floorElevation)) {
        addError(
          "room.floor_elevation",
          `${path}/floor_elevation`,
          "Room floor elevation must resolve to a finite number.",
        );
      }
      if (!Number.isFinite(ceilingElevation)) {
        addError(
          "room.ceiling_elevation",
          `${path}/ceiling_elevation`,
          "Room ceiling elevation must resolve to a finite number.",
        );
      } else if (
        Number.isFinite(floorElevation) &&
        ceilingElevation <= floorElevation + 1e-6
      ) {
        addError(
          "room.non_positive_height",
          path,
          "Room ceiling elevation must be above its floor elevation.",
        );
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
      validateProvenance(room, path, { required: requireApproved });
    });
  }

  const architecturalElements = document.envelope?.architectural_elements;
  if (
    architecturalElements !== undefined &&
    !Array.isArray(architecturalElements)
  ) {
    addError(
      "architectural_elements.type",
      "/envelope/architectural_elements",
      "architectural_elements must be an array.",
    );
  } else {
    (architecturalElements || []).forEach((element, index) => {
      const path = `/envelope/architectural_elements/${index}`;
      if (!isObject(element) || !["column", "beam", "stair"].includes(element.kind)) {
        addError(
          "architectural_element.kind",
          `${path}/kind`,
          "Architectural element kind must be column, beam, or stair.",
        );
      }
      if (
        !isFiniteVector(element?.dimensions, 3) ||
        element.dimensions.some((value) => value <= 0)
      ) {
        addError(
          "architectural_element.dimensions",
          `${path}/dimensions`,
          "Architectural element dimensions must contain three positive numbers.",
        );
      }
      if (!isFiniteVector(element?.transform?.position, 3)) {
        addError(
          "architectural_element.position",
          `${path}/transform/position`,
          "Architectural element position must contain three finite numbers.",
        );
      }
      if (
        element?.transform?.rotation_euler_degrees !== undefined &&
        !isFiniteVector(element.transform.rotation_euler_degrees, 3)
      ) {
        addError(
          "architectural_element.rotation",
          `${path}/transform/rotation_euler_degrees`,
          "Architectural element rotation must contain three finite numbers when supplied.",
        );
      }
      if (element?.kind === "stair" && (!Number.isInteger(element.step_count) || element.step_count < 2)) {
        addError(
          "architectural_element.step_count",
          `${path}/step_count`,
          "A stair requires an integer step_count of at least two.",
        );
      }
      if (element?.room_id && !roomIds.has(element.room_id)) {
        addError(
          "architectural_element.room",
          `${path}/room_id`,
          `Unknown room ${element.room_id}.`,
        );
      }
      validateProvenance(element, path, { required: requireApproved });
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

  const materials = isObject(document.materials) ? document.materials : {};
  const materialIds = new Set(Object.keys(materials));
  const builtInMaterialIds = new Set([
    "wall_default",
    "floor_default",
    "door_default",
    "glass_default",
    "furniture_proxy",
  ]);
  for (const [materialId, material] of Object.entries(materials)) {
    const textures = material?.textures;
    if (!isObject(textures)) continue;
    for (const [slot, texture] of Object.entries(textures)) {
      const path = `/materials/${materialId}/textures/${slot}`;
      const expectedColorSpace = ["base_color", "emissive"].includes(slot)
        ? "srgb"
        : "linear";
      if (texture?.color_space !== expectedColorSpace) {
        addError(
          "material.texture_color_space",
          `${path}/color_space`,
          `${slot} texture must use ${expectedColorSpace} color space.`,
        );
      }
      if (!Number.isFinite(texture?.scale_meters) || texture.scale_meters <= 0) {
        addError(
          "material.texture_scale",
          `${path}/scale_meters`,
          "Texture scale_meters must be positive and finite.",
        );
      }
    }
  }

  const hardFinishes = document.hard_finishes;
  if (hardFinishes !== undefined && !Array.isArray(hardFinishes)) {
    addError("hard_finish.type", "/hard_finishes", "hard_finishes must be an array.");
  } else {
    (hardFinishes || []).forEach((finish, index) => {
      const path = `/hard_finishes/${index}`;
      if (!materialIds.has(finish?.material_id) && !builtInMaterialIds.has(finish?.material_id)) {
        addError(
          "hard_finish.material",
          `${path}/material_id`,
          `Unknown hard-finish material ${finish?.material_id || "(missing)"}.`,
        );
      }
      const requiresWall = finish?.kind === "baseboard";
      const requiresOpening = finish?.kind === "opening_trim";
      const requiresRoom = ["dropped_ceiling", "fixed_cabinet", "fixed_fixture"].includes(finish?.kind);
      if (requiresWall && !wallMap.has(finish?.host_wall_id)) {
        addError("hard_finish.wall", `${path}/host_wall_id`, "Baseboard requires a known host wall.");
      }
      if (requiresOpening && !(openings || []).some((opening) => opening.id === finish?.opening_id)) {
        addError("hard_finish.opening", `${path}/opening_id`, "Opening trim requires a known opening.");
      }
      if (requiresRoom && !roomIds.has(finish?.room_id)) {
        addError("hard_finish.room", `${path}/room_id`, "Hard finish requires a known room.");
      }
      for (const key of requiresWall ? ["height", "depth"] : requiresOpening ? ["width", "depth"] : finish?.kind === "dropped_ceiling" ? ["drop", "thickness"] : []) {
        if (!Number.isFinite(finish?.[key]) || finish[key] <= 0) {
          addError("hard_finish.dimension", `${path}/${key}`, `${key} must be positive and finite.`);
        }
      }
      if (["fixed_cabinet", "fixed_fixture"].includes(finish?.kind)) {
        if (!isFiniteVector(finish?.dimensions, 3) || finish.dimensions.some((value) => value <= 0)) {
          addError("hard_finish.dimensions", `${path}/dimensions`, "Fixed hard finish requires three positive dimensions.");
        }
        if (!isFiniteVector(finish?.transform?.position, 3)) {
          addError("hard_finish.position", `${path}/transform/position`, "Fixed hard finish requires a finite position.");
        }
      }
      validateProvenance(finish, path, { required: requireApproved });
    });
  }

  if (document.lights !== undefined && !Array.isArray(document.lights)) {
    addError("light.type", "/lights", "lights must be an array.");
  } else {
    const supportedKinds = new Set(["natural", "sunlight", "directional", "point", "spot", "area"]);
    (document.lights || []).forEach((light, index) => {
      const path = `/lights/${index}`;
      if (!supportedKinds.has(String(light?.kind || "").toLowerCase())) {
        addError(
          "light.kind",
          `${path}/kind`,
          "P4 supports natural, sunlight, directional, point, spot, and area lights.",
        );
      }
      if (!isFiniteVector(light?.position, 3)) {
        addError("light.position", `${path}/position`, "Light position must contain three finite numbers.");
      }
      if (!Number.isFinite(light?.intensity) || light.intensity < 0) {
        addError("light.intensity", `${path}/intensity`, "Light intensity must be finite and non-negative.");
      }
      if (
        light?.spot &&
        Number.isFinite(light.spot.innerConeAngle) &&
        Number.isFinite(light.spot.outerConeAngle) &&
        light.spot.innerConeAngle > light.spot.outerConeAngle
      ) {
        addError("light.spot_cone", `${path}/spot`, "Spot inner cone angle cannot exceed outer cone angle.");
      }
    });
  }

  const renderQuality = document.render_profiles?.quality;
  if (
    renderQuality !== undefined &&
    !["draft", "standard", "presentation"].includes(renderQuality)
  ) {
    addError(
      "render_profile.quality",
      "/render_profiles/quality",
      "Render quality must be draft, standard, or presentation.",
    );
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
    if (
      Array.isArray(document.source_conflicts) &&
      document.source_conflicts.length > 0
    ) {
      addError(
        "validation.source_conflicts",
        "/source_conflicts",
        "Approved Spatial JSON cannot contain unresolved source conflicts.",
      );
    }
    if (
      Array.isArray(document.extraction?.source_conflicts) &&
      document.extraction.source_conflicts.length > 0
    ) {
      addError(
        "validation.extraction_conflicts",
        "/extraction/source_conflicts",
        "Extraction source conflicts must be resolved before approval.",
      );
    }
    if (document.extraction?.scale?.status === "unknown") {
      addError(
        "validation.unknown_scale",
        "/extraction/scale/status",
        "Unknown units or scale block approval.",
      );
    }
    if (
      Number.isFinite(document.extraction?.topology_confidence) &&
      document.extraction.topology_confidence < 0.9
    ) {
      addError(
        "validation.low_topology_confidence",
        "/extraction/topology_confidence",
        "Topology confidence below 0.9 requires human correction before approval.",
      );
    }
    if (
      document.extraction?.source_kind === "raster" &&
      (document.extraction?.scale?.status !== "trusted" ||
        document.extraction?.construction_ready_eligible !== true) &&
      document.validation?.approved_scope !== "visualization_only"
    ) {
      addError(
        "validation.raster_scope",
        "/validation/approved_scope",
        "Raster geometry without trusted scale and independent dimensional verification is limited to visualization_only.",
      );
    }
    if (!approval || !sourceManifest || !validationReport) {
      addError(
        "approval.artifact_required",
        "",
        "Downstream generation requires a source-bound human approval artifact and its validation report.",
      );
    } else {
      const approvalVerification = verifySpatialApproval({
        approval,
        sourceManifest,
        spatialJson: document,
        validationReport,
        approvalTrust,
        allowTestFixture: allowTestApproval,
      });
      for (const error of approvalVerification.errors) {
        errors.push(error);
      }
    }
  }

  return {
    report_version: "1.0",
    document_sha256: canonicalJsonSha256(document),
    valid: errors.length === 0,
    schema_valid: schemaValidation.valid,
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
      hard_finishes: Array.isArray(hardFinishes) ? hardFinishes.length : 0,
    },
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/validate-spatial-json.mjs --input spatial.json [--output validation-report.json]

Approval verification:
  node scripts/validation/validate-spatial-json.mjs \\
    --input approved-spatial.json --require-approved \\
    --source-manifest source-manifest.json \\
    --validation-report spatial-validation.json \\
    --approval spatial-approval.json \\
    --approval-trust spatial-approval-trust.json
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string" },
    "require-approved": { type: "boolean" },
    "source-manifest": { type: "string" },
    "validation-report": { type: "string" },
    approval: { type: "string" },
    "approval-trust": { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const [
    document,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
  ] =
    await Promise.all([
      readJson(options.input, "Spatial JSON"),
      options["source-manifest"]
        ? readJson(options["source-manifest"], "source manifest")
        : Promise.resolve(null),
      options["validation-report"]
        ? readJson(options["validation-report"], "validation report")
        : Promise.resolve(null),
      options.approval
        ? readJson(options.approval, "spatial approval")
        : Promise.resolve(null),
      options["approval-trust"]
        ? readJson(options["approval-trust"], "spatial approval trust store")
        : Promise.resolve(null),
    ]);
  const report = validateSpatialJson(document, {
    requireApproved: options["require-approved"],
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

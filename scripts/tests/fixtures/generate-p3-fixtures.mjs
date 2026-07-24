#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeJson } from "../../lib/cli.mjs";

const ROOT = fileURLToPath(
  new URL("../../../examples/p3-acceptance/", import.meta.url),
);

function pointKey([x, z]) {
  return `${x.toFixed(6)},${z.toFixed(6)}`;
}

function edgeKey(start, end) {
  const left = pointKey(start);
  const right = pointKey(end);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function defaultElement(id, kind, dimensions, position, extra = {}) {
  return {
    id,
    kind,
    dimensions,
    transform: { position },
    ...extra,
  };
}

const FIXTURE_SPECS = [
  { id: "p3-01-rectangle", rooms: [[[0, 0], [5, 0], [5, 4], [0, 4]]] },
  { id: "p3-02-door", rooms: [[[0, 0], [5, 0], [5, 4], [0, 4]]], opening: { room: 0, edge: 0, kind: "hinged_door", offset: 0.7, width: 0.9, height: 2.1, sill: 0 } },
  { id: "p3-03-window", rooms: [[[0, 0], [6, 0], [6, 4], [0, 4]]], opening: { room: 0, edge: 2, kind: "window", offset: 1.2, width: 2.1, height: 1.2, sill: 0.9 } },
  { id: "p3-04-l-room", rooms: [[[0, 0], [6, 0], [6, 2], [3, 2], [3, 5], [0, 5]]] },
  { id: "p3-05-u-room", rooms: [[[0, 0], [7, 0], [7, 5], [5, 5], [5, 2], [2, 2], [2, 5], [0, 5]]] },
  { id: "p3-06-two-room-vertical", rooms: [[[0, 0], [3, 0], [3, 4], [0, 4]], [[3, 0], [6, 0], [6, 4], [3, 4]]] },
  { id: "p3-07-two-room-horizontal", rooms: [[[0, 0], [6, 0], [6, 2.5], [0, 2.5]], [[0, 2.5], [6, 2.5], [6, 5], [0, 5]]] },
  { id: "p3-08-three-room-t", rooms: [[[0, 0], [2, 0], [2, 2], [0, 2]], [[2, 0], [4, 0], [4, 2], [2, 2]], [[0, 2], [4, 2], [4, 5], [0, 5]]] },
  { id: "p3-09-four-room-grid", rooms: [[[0, 0], [3, 0], [3, 3], [0, 3]], [[3, 0], [6, 0], [6, 3], [3, 3]], [[0, 3], [3, 3], [3, 6], [0, 6]], [[3, 3], [6, 3], [6, 6], [3, 6]]] },
  { id: "p3-10-corridor-living", rooms: [[[0, 0], [2, 0], [2, 6], [0, 6]], [[2, 0], [7, 0], [7, 4], [2, 4]]] },
  { id: "p3-11-slanted-pentagon", rooms: [[[0, 0], [4, 0], [5, 2], [4, 4], [0, 4]]] },
  { id: "p3-12-level-change", rooms: [[[0, 0], [3, 0], [3, 4], [0, 4]], [[3, 0], [6, 0], [6, 4], [3, 4]]], elevations: [{ floor: 0, ceiling: 2.8 }, { floor: 0.3, ceiling: 3.4 }] },
  { id: "p3-13-column", rooms: [[[0, 0], [5, 0], [5, 5], [0, 5]]], elements: [defaultElement("column-01", "column", [0.35, 2.8, 0.35], [1.1, 1.4, 1.1])] },
  { id: "p3-14-beam", rooms: [[[0, 0], [6, 0], [6, 4], [0, 4]]], elements: [defaultElement("beam-01", "beam", [3.5, 0.35, 0.35], [3, 2.55, 1])] },
  { id: "p3-15-stair", rooms: [[[0, 0], [6, 0], [6, 5], [0, 5]]], elements: [defaultElement("stair-01", "stair", [1.1, 1.2, 1.8], [4.6, 0, 2.4], { step_count: 6 })] },
  { id: "p3-16-structure-combined", rooms: [[[0, 0], [7, 0], [7, 5], [0, 5]]], elements: [defaultElement("column-02", "column", [0.3, 2.8, 0.3], [1, 1.4, 1]), defaultElement("beam-02", "beam", [2, 0.3, 0.3], [4, 2.5, 1]), defaultElement("stair-02", "stair", [1, 1.0, 1.5], [5.5, 0, 3.5], { step_count: 5 })] },
  { id: "p3-17-concave-two-room", rooms: [[[0, 0], [5, 0], [5, 2], [2, 2], [2, 5], [0, 5]], [[2, 2], [6, 2], [6, 6], [2, 6]]] },
  { id: "p3-18-narrow-openings", rooms: [[[0, 0], [8, 0], [8, 3], [0, 3]]], opening: { room: 0, edge: 0, kind: "open_passage", offset: 2.2, width: 1.1, height: 2.8, sill: 0 } },
  { id: "p3-19-unequal-heights", rooms: [[[0, 0], [3, 0], [3, 3], [0, 3]], [[3, 0], [7, 0], [7, 3], [3, 3]], [[0, 3], [7, 3], [7, 6], [0, 6]]], elevations: [{ floor: 0, ceiling: 2.6 }, { floor: 0, ceiling: 3.1 }, { floor: 0.2, ceiling: 2.9 }] },
  { id: "p3-20-complex-shared", rooms: [[[0, 0], [2, 0], [2, 3], [0, 3]], [[2, 0], [5, 0], [5, 3], [2, 3]], [[5, 0], [8, 0], [8, 3], [5, 3]], [[0, 3], [4, 3], [4, 6], [0, 6]], [[4, 3], [8, 3], [8, 6], [4, 6]]] },
];

function fixtureDocument(spec) {
  const walls = [];
  const wallByEdge = new Map();
  const roomBoundaryIds = [];
  for (const polygon of spec.rooms) {
    const boundary = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const key = edgeKey(start, end);
      let wall = wallByEdge.get(key);
      if (!wall) {
        wall = {
          id: `wall-${walls.length + 1}`,
          start,
          end,
          thickness: 0.2,
          height: 2.8,
          structural_role: "unknown",
          edit_policy: "review_required",
        };
        walls.push(wall);
        wallByEdge.set(key, wall);
      }
      boundary.push(wall.id);
    }
    roomBoundaryIds.push(boundary);
  }
  const sourceId = `source-${spec.id}`;
  const rooms = spec.rooms.map((_, index) => ({
    id: `room-${index + 1}`,
    name: `Room ${index + 1}`,
    type: "generic",
    boundary_wall_ids: roomBoundaryIds[index],
    ...(spec.elevations?.[index]
      ? {
          floor_elevation: spec.elevations[index].floor,
          ceiling_elevation: spec.elevations[index].ceiling,
        }
      : {}),
  }));
  const openings = [];
  if (spec.opening) {
    const wallId = roomBoundaryIds[spec.opening.room][spec.opening.edge];
    openings.push({
      id: `opening-${spec.id}`,
      kind: spec.opening.kind,
      host_wall_id: wallId,
      offset: spec.opening.offset,
      width: spec.opening.width,
      height: spec.opening.height,
      sill_height: spec.opening.sill,
    });
  }
  return {
    schema_version: "1.0",
    project: {
      id: spec.id,
      revision: "p3-fixture-001",
      units: "meters",
      up_axis: "Y",
      forward_axis: "-Z",
      handedness: "right",
      origin: [0, 0, 0],
    },
    sources: [{ id: sourceId, type: "synthetic_p3_geometry" }],
    extraction: {
      source_kind: "manual",
      method: "p3-regression-fixture",
      scale: { status: "trusted", meters_per_source_unit: 1 },
      topology_confidence: 1,
      coordinate_transform: {
        source_space: "meters",
        target_space: "spatial-meters-xz",
        matrix_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
    },
    envelope: {
      floor_elevation: 0,
      ceiling_height: 2.8,
      walls,
      openings,
      ...(spec.elements ? { architectural_elements: spec.elements } : {}),
    },
    rooms,
    assumptions: [],
    unresolved_questions: [],
    validation: { status: "pending", approved_scope: null, checks: [] },
  };
}

await mkdir(ROOT, { recursive: true });
const fixtures = FIXTURE_SPECS.map((spec) => {
  const spatial = fixtureDocument(spec);
  return {
    id: spec.id,
    expected: {
      rooms: spatial.rooms.length,
      walls: spatial.envelope.walls.length,
      openings: spatial.envelope.openings.length,
      structural_elements: spatial.envelope.architectural_elements?.length || 0,
    },
    spatial,
  };
});
await writeJson(join(ROOT, "fixtures.json"), {
  schema_version: "1.0",
  fixtures,
});
process.stdout.write(`Generated ${fixtures.length} deterministic P3 fixtures.\n`);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  orderRoomPolygon,
  pointInPolygon,
} from "../geometry/spatial-geometry.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

function wall(id, start, end) {
  return {
    id,
    start,
    end,
    thickness: 0.2,
    height: 2.8,
    structural_role: "unknown",
    edit_policy: "review_required",
  };
}

async function example() {
  return JSON.parse(
    await readFile(
      new URL("../../examples/one-room/spatial.json", import.meta.url),
      "utf8",
    ),
  );
}

test("orders one connected room polygon and computes area", () => {
  const result = orderRoomPolygon([
    wall("south", [0, 0], [5, 0]),
    wall("north", [5, 4], [0, 4]),
    wall("east", [5, 0], [5, 4]),
    wall("west", [0, 4], [0, 0]),
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.area, 20);
  assert.equal(pointInPolygon([2, 2], result.polygon), true);
  assert.equal(pointInPolygon([6, 2], result.polygon), false);
});

test("rejects disconnected closed loops as one room", () => {
  const result = orderRoomPolygon([
    wall("a1", [0, 0], [1, 0]),
    wall("a2", [1, 0], [0.5, 1]),
    wall("a3", [0.5, 1], [0, 0]),
    wall("b1", [3, 0], [4, 0]),
    wall("b2", [4, 0], [3.5, 1]),
    wall("b3", [3.5, 1], [3, 0]),
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "room.disconnected_loops");
});

test("rejects a self-intersecting room polygon", () => {
  const result = orderRoomPolygon([
    wall("a", [0, 0], [2, 2]),
    wall("b", [2, 2], [0, 2]),
    wall("c", [0, 2], [2, 0]),
    wall("d", [2, 0], [0, 0]),
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "room.self_intersection");
});

test("validates opening height and furniture collisions", async () => {
  const document = await example();
  document.envelope.openings[1].sill_height = 2;
  let report = validateSpatialJson(document, { requireApproved: true });
  assert.ok(report.errors.some((error) => error.code === "opening.above_wall"));

  document.envelope.openings[1].sill_height = 0.9;
  document.design_objects[1].transform.position = [2.5, 0, 3.25];
  report = validateSpatialJson(document, { requireApproved: true });
  assert.ok(
    report.errors.some((error) => error.code === "design_object.collision"),
  );
});

test("validates P3 room elevations and stair descriptors", async () => {
  const document = await example();
  document.rooms[0].floor_elevation = 0.2;
  document.rooms[0].ceiling_elevation = 3.1;
  document.envelope.architectural_elements = [
    {
      id: "stair-test",
      kind: "stair",
      dimensions: [1.1, 1.2, 1.8],
      step_count: 6,
      transform: { position: [3.5, 0.2, 1.8] },
    },
  ];
  let report = validateSpatialJson(document);
  assert.equal(report.valid, true, JSON.stringify(report.errors));

  document.envelope.architectural_elements[0].step_count = 1;
  report = validateSpatialJson(document);
  assert.ok(
    report.errors.some((error) => error.path.includes("step_count")),
  );
});

test("validates P4 material texture conventions and hard-finish references", async () => {
  const document = await example();
  document.materials.finish_paint = {
    base_color: "#E4DDD3",
    roughness: 0.74,
    metalness: 0,
    texture_budget_bytes: 524288,
    textures: {
      base_color: {
        uri: "materials/finish-paint.webp",
        mime_type: "image/webp",
        color_space: "srgb",
        scale_meters: 1,
      },
      normal: {
        uri: "materials/finish-paint-normal.webp",
        mime_type: "image/webp",
        color_space: "linear",
        scale_meters: 1,
      },
    },
  };
  document.hard_finishes = [
    {
      id: "baseboard-south",
      kind: "baseboard",
      host_wall_id: "wall-south",
      material_id: "finish_paint",
      height: 0.1,
      depth: 0.018,
    },
    {
      id: "trim-entry",
      kind: "opening_trim",
      opening_id: "door-entry",
      material_id: "finish_paint",
      width: 0.07,
      depth: 0.025,
    },
    {
      id: "ceiling-living",
      kind: "dropped_ceiling",
      room_id: "room-living",
      material_id: "finish_paint",
      drop: 0.12,
      thickness: 0.03,
    },
    {
      id: "cabinet-fixed",
      kind: "fixed_cabinet",
      room_id: "room-living",
      material_id: "finish_paint",
      dimensions: [1.2, 0.9, 0.45],
      transform: { position: [1.1, 0, 0.4] },
    },
  ];
  let report = validateSpatialJson(document);
  assert.equal(report.valid, true, JSON.stringify(report.errors));

  document.materials.finish_paint.textures.normal.color_space = "srgb";
  report = validateSpatialJson(document);
  assert.ok(report.errors.some((error) => error.code === "material.texture_color_space"));
});

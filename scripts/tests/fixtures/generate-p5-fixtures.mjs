#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { orderRoomPolygon, pointInPolygon } from "../../geometry/spatial-geometry.mjs";
import { writeJson } from "../../lib/cli.mjs";

const SOURCE = new URL("../../../examples/p4-acceptance/fixtures.json", import.meta.url);
const ROOT = fileURLToPath(new URL("../../../examples/p5-acceptance/", import.meta.url));

function interiorPosition(spatial, room) {
  const wallMap = new Map(spatial.envelope.walls.map((wall) => [wall.id, wall]));
  const polygon = orderRoomPolygon(room.boundary_wall_ids.map((id) => wallMap.get(id))).polygon;
  const openingZones = spatial.envelope.openings.map((opening) => {
    const wall = wallMap.get(opening.host_wall_id);
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const ratio = (opening.offset + opening.width / 2) / length;
    return {
      center: [wall.start[0] + (wall.end[0] - wall.start[0]) * ratio, wall.start[1] + (wall.end[1] - wall.start[1]) * ratio],
      radius: opening.width,
    };
  });
  const xs = polygon.map((point) => point[0]);
  const zs = polygon.map((point) => point[1]);
  for (let z = Math.min(...zs) + 0.4; z <= Math.max(...zs) - 0.4; z += 0.2) {
    for (let x = Math.min(...xs) + 0.4; x <= Math.max(...xs) - 0.4; x += 0.2) {
      const corners = [[x - 0.2, z - 0.2], [x + 0.2, z - 0.2], [x + 0.2, z + 0.2], [x - 0.2, z + 0.2]];
      if (
        corners.every((point) => pointInPolygon(point, polygon)) &&
        openingZones.every((zone) => corners.every((point) => Math.hypot(point[0] - zone.center[0], point[1] - zone.center[1]) >= zone.radius))
      ) return [x, 0, z];
    }
  }
  throw new Error(`No safe P5 fixture position in room ${room.id}.`);
}

const source = JSON.parse(await readFile(SOURCE, "utf8"));
const fixtures = source.fixtures.map((fixture, index) => {
  const spatial = structuredClone(fixture.spatial);
  spatial.project.revision = "p5-fixture-001";
  const object = {
    id: `chair-${index + 1}`,
    kind: "chair",
    room_id: spatial.rooms[0].id,
    asset_id: "catalog-chair",
    dimensions: [0.4, 0.8, 0.4],
    transform: { position: interiorPosition(spatial, spatial.rooms[0]), rotation_euler_degrees: [0, 0, 0], scale: [1, 1, 1] },
  };
  spatial.assets = [{
    id: "catalog-chair", kind: "chair", uri: "catalog/chair.glb", format: "glb",
    source: "licensed_catalog", license: "commercial", units: "meters",
    dimensions: [0.4, 0.8, 0.4], pivot: "bottom_center", forward_axis: "-Z",
    optimized: true, collision_proxy: true,
  }];
  spatial.design_objects = [object];
  const brief = {
    budget: { amount: 20000 + index * 1000, currency: "CNY" },
    occupants: [{ role: "adult", count: 2 }],
    activities: ["daily living", "conversation"],
    must_keep_ids: [object.id],
    minimum_clearance_meters: 0.8,
  };
  const realAlternative = {
    id: `catalog-layout-${index + 1}`,
    explanation: { zoning: "Keep the compact seat inside the primary activity zone.", tradeoff: "Uses a licensed catalog asset." },
    score: { circulation: 0.9, budget: 0.85, function: 0.88 },
    cost: { estimated_total: 12000 + index * 200, currency: "CNY" },
    risk_notes: "Catalog availability must be reconfirmed before procurement.",
    design_objects: [object],
  };
  const { asset_id: _assetId, ...proxyObject } = structuredClone(object);
  proxyObject.transform.rotation_euler_degrees = [0, 180, 0];
  const proxyAlternative = {
    id: `proxy-layout-${index + 1}`,
    explanation: { zoning: "Keep the same circulation-safe zone with an editable proxy.", tradeoff: "Visual fidelity is lower until asset resolution." },
    score: { circulation: 0.9, budget: 0.92, function: 0.82 },
    cost: { estimated_total: 9000 + index * 150, currency: "CNY" },
    risk_notes: "Proxy dimensions are valid but the final product is unresolved.",
    design_objects: [proxyObject],
  };
  return {
    id: fixture.id.replace("p4-", "p5-"),
    spatial,
    catalog: { assets: spatial.assets },
    proposal: {
      base_revision: spatial.project.revision,
      design_brief: brief,
      design_alternatives: [realAlternative, proxyAlternative],
      recommended_alternative_id: realAlternative.id,
    },
  };
});

await writeJson(join(ROOT, "fixtures.json"), { schema_version: "1.0", fixtures });
process.stdout.write(`Generated ${fixtures.length} deterministic P5 fixtures.\n`);

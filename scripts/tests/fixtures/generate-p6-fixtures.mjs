#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeContract } from "../../runtime/build-runtime-contract.mjs";
import { writeJson } from "../../lib/cli.mjs";

const SOURCE = new URL("../../../examples/p5-acceptance/fixtures.json", import.meta.url);
const ROOT = fileURLToPath(new URL("../../../examples/p6-acceptance/", import.meta.url));
const source = JSON.parse(await readFile(SOURCE, "utf8"));
const fixtures = source.fixtures.map((fixture, index) => {
  const spatial = structuredClone(fixture.spatial);
  spatial.project.revision = "p6-fixture-001";
  const initial = buildRuntimeContract(spatial);
  spatial.xr = {
    spawn: [initial.rooms[0].navigation_point[0], initial.rooms[0].floor_elevation, initial.rooms[0].navigation_point[1]],
    boundary_room_ids: spatial.rooms.map((room) => room.id),
    navigation: "teleport",
    snap_turn_degrees: index % 2 === 0 ? 30 : 45,
  };
  spatial.render_profiles = {
    ...(spatial.render_profiles || {}),
    webxr: { quality_tier: index % 3 === 0 ? "quality" : "balanced", target_asset_format: "glb", target_fps: 72, max_pixel_ratio: 1.5 },
  };
  return { id: fixture.id.replace("p5-", "p6-"), spatial };
});
await writeJson(join(ROOT, "fixtures.json"), { schema_version: "1.0", fixtures });
process.stdout.write(`Generated ${fixtures.length} deterministic P6 fixtures.\n`);

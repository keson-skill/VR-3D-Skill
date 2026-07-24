#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeJson } from "../../lib/cli.mjs";

const ROOT = fileURLToPath(new URL("../../../examples/p4-acceptance/", import.meta.url));
const P3_FIXTURES = new URL("../../../examples/p3-acceptance/fixtures.json", import.meta.url);
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5L9sAAAAASUVORK5CYII=";

const p3 = JSON.parse(await readFile(P3_FIXTURES, "utf8"));
const fixtures = p3.fixtures.map((fixture, index) => {
  const spatial = structuredClone(fixture.spatial);
  spatial.project.revision = "p4-fixture-001";
  spatial.materials = {
    finish_paint: {
      base_color: index % 2 === 0 ? "#D8C7B5" : "#B8C5BF",
      roughness: 0.68,
      metalness: 0,
      texture_budget_bytes: 4096,
      textures: {
        base_color: { uri: PIXEL, mime_type: "image/png", color_space: "srgb", scale_meters: 1 },
        normal: { uri: "missing/finish-normal.png", mime_type: "image/png", color_space: "linear", scale_meters: 1 },
      },
    },
  };
  spatial.material_overrides = { wall_default: "finish_paint" };
  spatial.hard_finishes = [
    {
      id: `baseboard-${index + 1}`,
      kind: "baseboard",
      host_wall_id: spatial.envelope.walls[0].id,
      material_id: "finish_paint",
      height: 0.1,
      depth: 0.018,
    },
  ];
  spatial.lights = [
    { id: `sun-${index + 1}`, kind: "natural", position: [0, 3, 0], intensity: 1.1, color: "#FFF1D8" },
    { id: `lamp-${index + 1}`, kind: "area", position: [1, 2.4, 1], intensity: 35, range: 4 },
  ];
  spatial.render_profiles = { quality: index % 3 === 0 ? "presentation" : "standard" };
  return {
    id: fixture.id.replace("p3-", "p4-"),
    expected: {
      rooms: spatial.rooms.length,
      lights: 2,
      embedded_images: 2,
      hard_finishes: 1,
      fallback_textures: 2,
    },
    spatial,
  };
});

await writeJson(join(ROOT, "fixtures.json"), { schema_version: "1.0", fixtures });
process.stdout.write(`Generated ${fixtures.length} deterministic P4 fixtures.\n`);

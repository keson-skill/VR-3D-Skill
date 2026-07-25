#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../lib/cli.mjs";

const source = JSON.parse(
  await readFile(
    new URL("../../../examples/p7-acceptance/fixtures.json", import.meta.url),
    "utf8",
  ),
);
const colors = ["#E8DDCD", "#D9C8B4", "#F0E4D2", "#CBBBA7"];
const fixtures = source.fixtures.map((fixture, index) => {
  const spatial = structuredClone(fixture.spatial);
  spatial.validation = {
    ...(spatial.validation || {}),
    status: "approved",
    approved_scope: "construction_ready",
    checks: Array.isArray(spatial.validation?.checks) ? spatial.validation.checks : [],
  };
  return {
    id: fixture.id.replace("p7-", "p8-"),
    spatial,
    revision: {
    revision_id: `p8-fixture-${String(index + 1).padStart(3, "0")}-rev-002`,
    base_revision: fixture.spatial.project.revision,
    intent: "Change only the main finish color and preserve geometry and layout.",
    scope: {
      target_ids: [],
      paths: ["/materials/finish_paint"],
    },
    operations: [
      {
        op: "replace",
        path: "/materials/finish_paint/base_color",
        value: colors[index % colors.length],
      },
    ],
    must_preserve_ids: [
      fixture.spatial.envelope.walls[0].id,
      fixture.spatial.design_objects[0].id,
    ],
    must_preserve_paths: ["/envelope", "/rooms", "/design_objects"],
    revalidate: ["material_bindings", "pbr", "performance"],
    provenance: {
      actor_type: "human",
      actor_id: "p8-fixture-reviewer",
      created_at: "2026-07-24T00:00:00.000Z",
    },
      rollback_reference: spatial.project.revision,
    },
  };
});

await writeJson(
  join(
    fileURLToPath(new URL("../../../examples/p8-acceptance/", import.meta.url)),
    "fixtures.json",
  ),
  { schema_version: "1.0", fixtures },
);
process.stdout.write(`Generated ${fixtures.length} deterministic P8 fixtures.\n`);

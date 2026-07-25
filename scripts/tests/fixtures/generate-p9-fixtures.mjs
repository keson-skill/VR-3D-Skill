#!/usr/bin/env node

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../lib/cli.mjs";

const cases = ["normal", "boundary", "failure"];
const categories = [
  "dwg",
  "vector_pdf",
  "scanned_pdf",
  "ifc",
  "single_photo",
  "multiview_video",
  "panorama",
  "point_cloud",
  "depth",
  "existing_3d",
  "catalog",
];
const fixtures = categories.flatMap((category) =>
  cases.map((caseName, index) => ({
    id: `p9-${category}-${caseName}`,
    category,
    case: caseName,
    expected_valid: index < 2,
  })));

await writeJson(
  join(
    fileURLToPath(new URL("../../../examples/p9-acceptance/", import.meta.url)),
    "fixtures.json",
  ),
  { schema_version: "1.0", fixtures },
);
process.stdout.write(`Generated ${fixtures.length} deterministic P9 route fixtures.\n`);

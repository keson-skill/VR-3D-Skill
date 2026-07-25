#!/usr/bin/env node

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../lib/cli.mjs";

const cases = ["normal", "boundary", "failure"];
const categories = [
  "job_definition",
  "retry_recovery",
  "audit_redaction",
  "migration",
  "security_license",
  "scene_budget",
  "device_qualification",
  "release_evidence",
  "release_manifest",
  "handler_registry",
];
const fixtures = categories.flatMap((category) =>
  cases.map((caseName, index) => ({
    id: `p10-${category}-${caseName}`,
    category,
    case: caseName,
    expected_valid: index < 2,
  })));

await writeJson(
  join(
    fileURLToPath(new URL("../../../examples/p10-acceptance/", import.meta.url)),
    "fixtures.json",
  ),
  { schema_version: "1.0", fixtures },
);
process.stdout.write(`Generated ${fixtures.length} deterministic P10 production fixtures.\n`);

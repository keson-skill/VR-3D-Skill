#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../../lib/cli.mjs";
const source = JSON.parse(await readFile(new URL("../../../examples/p6-acceptance/fixtures.json", import.meta.url), "utf8"));
const fixtures = source.fixtures.map((fixture) => ({ id: fixture.id.replace("p6-", "p7-"), spatial: { ...fixture.spatial, project: { ...fixture.spatial.project, revision: "p7-fixture-001" } } }));
await writeJson(join(fileURLToPath(new URL("../../../examples/p7-acceptance/", import.meta.url)), "fixtures.json"), { schema_version: "1.0", fixtures });
process.stdout.write(`Generated ${fixtures.length} deterministic P7 fixtures.\n`);

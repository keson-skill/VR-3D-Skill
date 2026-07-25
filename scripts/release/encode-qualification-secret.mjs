#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
} from "../lib/cli.mjs";
import { readBoundedFile } from "../ingest/file-safety.mjs";
import { validateReleaseEvidence } from "./validate-release-evidence.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    commit: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/release/encode-qualification-secret.mjs --input qualification-bundle.json [--commit <sha>]\n",
    );
    return;
  }
  const { bytes } = await readBoundedFile(options.input, {
    label: "Qualification bundle",
    maxBytes: 64 * 1024,
  });
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Qualification bundle is invalid JSON: ${error.message}`);
  }
  const validation = validateReleaseEvidence(bundle, {
    expectedCommit: options.commit || null,
  });
  if (!validation.passed) {
    throw new Error(
      `Qualification bundle is not release-ready: ${validation.errors
        .map((error) => error.code)
        .join(", ")}.`,
    );
  }
  const serialized = Buffer.from(JSON.stringify(bundle), "utf8");
  if (serialized.length > 32 * 1024) {
    throw new Error("Qualification bundle exceeds the 32 KiB transport limit.");
  }
  process.stdout.write(serialized.toString("base64"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

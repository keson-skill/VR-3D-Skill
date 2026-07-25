#!/usr/bin/env node

import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  writeJson,
} from "../lib/cli.mjs";
import { GiB, hashBoundedFile } from "./file-safety.mjs";

const TYPE_BY_EXTENSION = new Map([
  [".dwg", "cad"],
  [".dxf", "cad"],
  [".ifc", "bim"],
  [".rvt", "bim"],
  [".pdf", "document"],
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".webp", "image"],
  [".json", "structured_data"],
]);

export async function buildSourceManifest(
  inputPaths,
  {
    containsPersonalData = "unknown",
    maxFileBytes = 512 * 1024 * 1024,
    maxTotalBytes = 2 * GiB,
  } = {},
) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error("At least one source input is required.");
  }
  if (!["true", "false", "unknown"].includes(containsPersonalData)) {
    throw new Error(
      "containsPersonalData must be true, false, or unknown.",
    );
  }

  const idCounts = new Map();
  const sources = [];
  let totalBytes = 0;

  for (const filePath of inputPaths) {
    const { metadata, sha256: hash } = await hashBoundedFile(filePath, {
      label: "Source input",
      maxBytes: maxFileBytes,
    });
    totalBytes += metadata.size;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Source inputs exceed the ${maxTotalBytes}-byte total limit.`);
    }
    const idBase = `source-${hash.slice(0, 12)}`;
    const occurrence = (idCounts.get(idBase) || 0) + 1;
    idCounts.set(idBase, occurrence);
    const extension = extname(filePath).toLowerCase();

    sources.push({
      id: occurrence === 1 ? idBase : `${idBase}-${occurrence}`,
      type: TYPE_BY_EXTENSION.get(extension) || "unknown",
      name: basename(filePath),
      uri: `local://${encodeURIComponent(basename(filePath))}`,
      revision: null,
      bytes: metadata.size,
      sha256: hash,
      contains_personal_data:
        containsPersonalData === "unknown"
          ? "unknown"
          : containsPersonalData === "true",
    });
  }

  return {
    manifest_version: "1.0",
    sources,
  };
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/ingest/build-source-manifest.mjs --input plan.png [--input room.jpg] --output source-manifest.json [--contains-personal-data true|false|unknown]

The command reads local files, records fingerprints and metadata, and never uploads them.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "array", required: true },
    output: { type: "string", required: true },
    "contains-personal-data": { type: "string", default: "unknown" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }

  const manifest = await buildSourceManifest(options.input, {
    containsPersonalData: options["contains-personal-data"],
  });
  await writeJson(options.output, manifest);
  printJson({ outputFile: options.output, sourceCount: manifest.sources.length });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

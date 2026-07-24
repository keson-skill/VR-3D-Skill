#!/usr/bin/env node

import { copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson } from "../lib/cli.mjs";

const execFileAsync = promisify(execFile);

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/processing/preprocess-plan-image.mjs --input plan.png --output normalized.png [--max-pixels 3000]

On macOS this uses the local sips tool. If sips is unavailable, it preserves the
original bytes and records that no resize was applied.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    "max-pixels": { type: "string", default: "3000" },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  let method = "copy";
  try {
    await execFileAsync("sips", ["-Z", options["max-pixels"], options.input, "--out", options.output]);
    method = "sips-resize";
  } catch {
    await copyFile(options.input, options.output);
  }
  printJson({ inputFile: options.input, outputFile: options.output, method });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

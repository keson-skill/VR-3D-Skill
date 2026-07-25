#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { MiB, readBoundedFile } from "./file-safety.mjs";
import { runTool } from "./tool-runner.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/ingest/extract-ocr-evidence.mjs --input plan.png --output ocr-evidence.json [--lang chi_sim+eng] [--psm 11]

Runs local Tesseract OCR only. The output is evidence for spatial reasoning,
not authoritative geometry or construction dimensions.
`);
}

function parseTsv(tsv) {
  const entries = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (!line || line.startsWith("level\t")) continue;
    const fields = line.split("\t");
    if (fields.length < 12) continue;
    const confidence = Number(fields[10]);
    const text = fields.slice(11).join(" ").trim();
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    entries.push({
      text,
      confidence: Math.round((confidence / 100) * 1000) / 1000,
      bbox: {
        left: Number(fields[6]),
        top: Number(fields[7]),
        width: Number(fields[8]),
        height: Number(fields[9]),
      },
      level: Number(fields[0]),
      page: Number(fields[1]),
      block: Number(fields[2]),
      paragraph: Number(fields[3]),
      line: Number(fields[4]),
    });
  }
  return entries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    lang: { type: "string", default: process.env.LOCAL_OCR_LANG || "chi_sim+eng" },
    psm: { type: "string", default: process.env.LOCAL_OCR_PSM || "11" },
    help: { type: "boolean" },
  });
  if (options.help) {
    printHelp();
    return;
  }
  const { bytes } = await readBoundedFile(options.input, {
    label: "OCR image",
    maxBytes: 128 * MiB,
  });
  let stdout;
  try {
    ({ stdout } = await runTool(
      "tesseract",
      [options.input, "stdout", "--oem", "1", "--psm", options.psm, "-l", options.lang, "tsv"],
      {
        timeoutMs: 120000,
        maxOutputBytes: 16 * MiB,
      },
    ));
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || "unknown error";
    throw new Error(`Local Tesseract OCR failed: ${detail}`);
  }
  const evidence = {
    schema_version: "1.0",
    source: {
      path: options.input,
      sha256: sha256(bytes),
    },
    engine: {
      name: "tesseract",
      language: options.lang,
      page_segmentation_mode: Number(options.psm),
    },
    entries: parseTsv(stdout),
    usage: {
      authoritative_for_geometry: false,
      requires_spatial_model_review: true,
    },
  };
  await writeJson(options.output, evidence);
  printJson({
    outputFile: options.output,
    engine: evidence.engine,
    entries: evidence.entries.length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

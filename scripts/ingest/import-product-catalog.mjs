#!/usr/bin/env node

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { buildAssetManifest } from "../processing/build-asset-manifest.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index] ?? "\n";
    if (character === "\"") {
      if (quoted && text[index + 1] === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      row.push(value);
      value = "";
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Delimited catalog contains an unterminated quoted field.");
  return rows;
}

function booleanValue(value, field, row) {
  if (["true", "1", "yes"].includes(String(value).trim().toLowerCase())) return true;
  if (["false", "0", "no"].includes(String(value).trim().toLowerCase())) return false;
  throw new Error(`Catalog row ${row} has invalid boolean ${field}.`);
}

export function catalogFromRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("Catalog requires a header and at least one asset row.");
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const required = [
    "id", "kind", "uri", "format", "source", "license", "units",
    "pivot", "forward_axis", "optimized", "collision_proxy",
    "dimension_x", "dimension_y", "dimension_z",
  ];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Catalog is missing columns: ${missing.join(", ")}.`);
  const assets = rows.slice(1).map((cells, index) => {
    const row = Object.fromEntries(headers.map((header, column) => [header, cells[column]?.trim() || ""]));
    return {
      id: row.id,
      kind: row.kind,
      uri: row.uri,
      format: row.format.toLowerCase(),
      source: row.source,
      license: row.license,
      units: row.units,
      pivot: row.pivot,
      forward_axis: row.forward_axis,
      optimized: booleanValue(row.optimized, "optimized", index + 2),
      collision_proxy: booleanValue(row.collision_proxy, "collision_proxy", index + 2),
      dimensions: [row.dimension_x, row.dimension_y, row.dimension_z].map(Number),
    };
  });
  const result = buildAssetManifest(assets, { target: "web" });
  const additionalErrors = [];
  assets.forEach((asset, index) => {
    if (!asset.kind) additionalErrors.push({ path: `/assets/${index}/kind`, message: "kind is required." });
    if (!["customer", "licensed_catalog", "generated"].includes(asset.source)) {
      additionalErrors.push({ path: `/assets/${index}/source`, message: "source must be customer, licensed_catalog, or generated." });
    }
    if (asset.license === "forbidden") {
      additionalErrors.push({ path: `/assets/${index}/license`, message: "forbidden assets cannot enter the catalog." });
    }
    if (asset.units !== "meters" || asset.pivot !== "bottom_center" || asset.forward_axis !== "-Z" || asset.collision_proxy !== true) {
      additionalErrors.push({ path: `/assets/${index}`, message: "Catalog assets require meters, bottom_center, -Z, and a collision proxy." });
    }
  });
  result.report.errors.push(...additionalErrors);
  result.report.valid = result.report.errors.length === 0;
  return { catalog: { schema_version: "1.0", assets }, report: result.report };
}

async function spreadsheetToCsv(filePath, run) {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-catalog-"));
  try {
    const tool = await inspectTool("soffice", ["--version"], { run });
    if (!tool.available) throw new Error(`XLSX route requires LibreOffice: ${tool.error}.`);
    await run(
      "soffice",
      ["--headless", "--convert-to", "csv:Text - txt - csv (StarCalc)", "--outdir", directory, filePath],
      { timeoutMs: 120000 },
    );
    const files = (await readdir(directory)).filter((name) => extname(name).toLowerCase() === ".csv");
    if (files.length !== 1) throw new Error("LibreOffice did not produce exactly one CSV file.");
    return {
      text: await readFile(join(directory, files[0]), "utf8"),
      converter: { command: "soffice", version: tool.version },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function importProductCatalog(filePath, { run = runTool } = {}) {
  const bytes = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();
  let rows;
  let converter = null;
  if (extension === ".csv") rows = parseDelimited(bytes.toString("utf8"), ",");
  else if (extension === ".tsv") rows = parseDelimited(bytes.toString("utf8"), "\t");
  else if (extension === ".xlsx") {
    const converted = await spreadsheetToCsv(filePath, run);
    rows = parseDelimited(converted.text, ",");
    converter = converted.converter;
  } else {
    throw new Error("Product catalog must be CSV, TSV, or XLSX.");
  }
  const result = catalogFromRows(rows);
  return {
    source: {
      name: basename(filePath),
      sha256: sha256(bytes),
      bytes: bytes.length,
      format: extension.slice(1),
    },
    converter,
    ...result,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    report: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/import-product-catalog.mjs --input products.csv --output catalog.json [--report catalog-validation.json]\n");
    return;
  }
  const result = await importProductCatalog(options.input);
  if (result.report.valid) await writeJson(options.output, result.catalog);
  if (options.report) await writeJson(options.report, result.report);
  printJson({
    outputFile: result.report.valid ? options.output : null,
    assets: result.catalog.assets.length,
    valid: result.report.valid,
    errors: result.report.errors,
    converter: result.converter,
  });
  if (!result.report.valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { preprocessPlanImage } from "../processing/preprocess-plan-image.mjs";
import {
  MiB,
  hashBoundedFile,
  readBoundedFile,
} from "./file-safety.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

function parseKeyValueOutput(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf(":");
        return separator > 0
          ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
          : null;
      })
      .filter(Boolean),
  );
}

function parsePageSize(value) {
  const match = /([\d.]+)\s+x\s+([\d.]+)\s+pts/iu.exec(value || "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function parseImageList(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((tokens) => /^\d+$/u.test(tokens[0] || "") && /^\d+$/u.test(tokens[1] || ""))
    .map((tokens) => ({
      page: Number(tokens[0]),
      number: Number(tokens[1]),
      type: tokens[2] || null,
      width: Number(tokens[3]) || null,
      height: Number(tokens[4]) || null,
      encoding: tokens[8] || null,
      object_id: tokens[10] && tokens[11] ? `${tokens[10]} ${tokens[11]}` : null,
    }));
}

export function classifyPdfPage({
  vectorElements,
  embeddedImages,
  textWords,
}) {
  if (embeddedImages > 0 && vectorElements <= 2 && textWords === 0) return "scanned";
  if (embeddedImages > 0 && (vectorElements > 2 || textWords > 0)) return "mixed";
  if (vectorElements > 0 || textWords > 0) return "vector";
  return "empty";
}

async function readFirst(paths) {
  let lastError;
  for (const filePath of paths) {
    try {
      return {
        filePath,
        bytes: (await readBoundedFile(filePath, {
          label: "Extracted PDF vector page",
          maxBytes: 64 * MiB,
        })).bytes,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function inspectPdf(
  inputFile,
  outputDirectory,
  {
    renderDpi = 300,
    maxPages = 100,
    run = runTool,
  } = {},
) {
  const input = resolve(inputFile);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const sourceEvidence = await hashBoundedFile(input, {
    label: "PDF input",
    maxBytes: 512 * MiB,
  });
  const handle = await open(input, "r");
  const header = Buffer.alloc(5);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (!header.equals(Buffer.from("%PDF-"))) {
    throw new Error("Input does not have a PDF header.");
  }
  const tools = {};
  for (const command of ["pdfinfo", "pdfimages", "pdftotext", "pdftocairo", "pdftoppm"]) {
    tools[command] = await inspectTool(command, ["-v"], { run });
    if (!tools[command].available) {
      throw new Error(`PDF route requires ${command}: ${tools[command].error}.`);
    }
  }

  const infoResult = await run("pdfinfo", [input], { timeoutMs: 30000 });
  const info = parseKeyValueOutput(infoResult.stdout);
  const pageCount = Number(info.Pages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
    throw new Error(`PDF page count must be from 1 to ${maxPages}.`);
  }
  if (/^yes/iu.test(info.Encrypted || "")) {
    throw new Error("Encrypted PDF input must be unlocked before extraction.");
  }
  const imagesResult = await run("pdfimages", ["-list", input], { timeoutMs: 30000 });
  const imageList = parseImageList(imagesResult.stdout);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const label = `page-${String(pageNumber).padStart(3, "0")}`;
    const pageInfoResult = await run(
      "pdfinfo",
      ["-f", String(pageNumber), "-l", String(pageNumber), input],
      { timeoutMs: 30000 },
    );
    const pageInfo = parseKeyValueOutput(pageInfoResult.stdout);
    const sizePoints = parsePageSize(
      pageInfo[`Page ${pageNumber} size`] || pageInfo["Page size"],
    );
    const textLayoutPath = join(output, `${label}-text.html`);
    await run(
      "pdftotext",
      ["-f", String(pageNumber), "-l", String(pageNumber), "-bbox-layout", input, textLayoutPath],
      { timeoutMs: 30000 },
    );
    const { bytes: textBytes } = await readBoundedFile(textLayoutPath, {
      label: "Extracted PDF text page",
      maxBytes: 64 * MiB,
    });
    const text = textBytes.toString("utf8");
    const textWords = (text.match(/<word\b/gu) || []).length;

    const svgBase = join(output, `${label}-vector`);
    await run(
      "pdftocairo",
      ["-f", String(pageNumber), "-l", String(pageNumber), "-svg", input, svgBase],
      { timeoutMs: 60000 },
    );
    const svgResult = await readFirst([
      svgBase,
      `${svgBase}.svg`,
      `${svgBase}-${pageNumber}.svg`,
    ]);
    const svg = svgResult.bytes.toString("utf8");
    const vectorElements = (svg.match(/<(?:path|rect|line|polyline|polygon|circle|ellipse)\b/gu) || []).length;
    const svgImages = (svg.match(/<image\b/gu) || []).length;
    const pageImages = imageList.filter((image) => image.page === pageNumber);
    const embeddedImages = Math.max(svgImages, pageImages.length);
    const classification = classifyPdfPage({
      vectorElements,
      embeddedImages,
      textWords,
    });
    const page = {
      page: pageNumber,
      classification,
      size_points: sizePoints,
      rotation_degrees: Number(pageInfo[`Page ${pageNumber} rot`] || pageInfo["Page rot"] || 0),
      vector: {
        path: svgResult.filePath,
        sha256: sha256(svgResult.bytes),
        elements: vectorElements,
      },
      text: {
        path: textLayoutPath,
        sha256: sha256(textBytes),
        words: textWords,
      },
      embedded_images: pageImages,
      raster: null,
      blockers: [],
    };
    if (["scanned", "mixed"].includes(classification)) {
      const rasterBase = join(output, `${label}-raster`);
      await run(
        "pdftoppm",
        [
          "-f", String(pageNumber),
          "-l", String(pageNumber),
          "-singlefile",
          "-r", String(renderDpi),
          "-png",
          input,
          rasterBase,
        ],
        { timeoutMs: 120000 },
      );
      const rasterPath = `${rasterBase}.png`;
      const normalizedPath = join(output, `${label}-normalized.png`);
      const preprocessing = await preprocessPlanImage(rasterPath, normalizedPath);
      const { bytes: normalizedBytes } = await readBoundedFile(normalizedPath, {
        label: "Normalized PDF raster page",
        maxBytes: 64 * MiB,
      });
      page.raster = {
        source_path: rasterPath,
        normalized_path: normalizedPath,
        sha256: sha256(normalizedBytes),
        dpi: renderDpi,
        coordinate_transform: preprocessing.coordinate_transform,
      };
    }
    if (classification === "empty") {
      page.blockers.push("Page contains no extractable vector, text, or raster evidence.");
    }
    if (!sizePoints) page.blockers.push("Page dimensions could not be determined.");
    pages.push(page);
  }

  const classifications = new Set(pages.map((page) => page.classification));
  const documentKind =
    classifications.size === 1
      ? `${[...classifications][0]}_pdf`
      : "mixed_pdf";
  return {
    schema_version: "1.0",
    route: "pdf",
    source: {
      path: input,
      sha256: sourceEvidence.sha256,
      bytes: sourceEvidence.metadata.size,
      pdf_version: info["PDF version"] || null,
    },
    document_kind: documentKind,
    page_count: pageCount,
    pages,
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, status]) => [name, status.version]),
    ),
    blockers: pages.flatMap((page) =>
      page.blockers.map((message) => ({ page: page.page, message }))),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    evidence: { type: "string", required: true },
    dpi: { type: "string", default: "300" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/inspect-pdf.mjs --input plan.pdf --output evidence/pdf --evidence pdf-evidence.json [--dpi 300]\n");
    return;
  }
  const result = await inspectPdf(options.input, options.output, {
    renderDpi: Number(options.dpi),
  });
  await writeJson(options.evidence, result);
  printJson({
    evidenceFile: options.evidence,
    documentKind: result.document_kind,
    pageCount: result.page_count,
    blockers: result.blockers.length,
  });
  if (result.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson, writeJson } from "../lib/cli.mjs";

const execFileAsync = promisify(execFile);
const PYTHON = String.raw`
import json, sys
import cv2
import numpy as np

source = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
render = cv2.imread(sys.argv[2], cv2.IMREAD_GRAYSCALE)
if source is None or render is None:
    raise SystemExit('Could not read one of the images with OpenCV.')
size = (512, 512)
source = cv2.resize(source, size, interpolation=cv2.INTER_AREA)
render = cv2.resize(render, size, interpolation=cv2.INTER_AREA)
source_edges = cv2.Canny(source, 50, 150)
render_edges = cv2.Canny(render, 50, 150)
correlation = float(cv2.matchTemplate(render_edges, source_edges, cv2.TM_CCOEFF_NORMED)[0][0])
edge_overlap = float(np.logical_and(source_edges > 0, render_edges > 0).sum() / max(1, np.logical_or(source_edges > 0, render_edges > 0).sum()))
print(json.dumps({
  'source_dimensions': [int(source.shape[1]), int(source.shape[0])],
  'render_dimensions': [int(render.shape[1]), int(render.shape[0])],
  'edge_correlation': round(correlation, 4),
  'edge_overlap': round(edge_overlap, 4),
  'passed': bool(correlation >= 0.65 and edge_overlap >= 0.18),
  'note': 'This is a visual alignment signal, not a construction or dimensional certification.'
}))
`;

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/validation/compare-plan-render.mjs --source plan.png --render top-view.png --output alignment.json
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    source: { type: "string", required: true },
    render: { type: "string", required: true },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  let stdout;
  try {
    ({ stdout } = await execFileAsync("python3", ["-c", PYTHON, options.source, options.render], { maxBuffer: 1024 * 1024 }));
  } catch (error) {
    throw new Error(`Plan/render comparison failed: ${error?.stderr?.trim() || error.message}`);
  }
  const report = JSON.parse(stdout);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, ...report });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

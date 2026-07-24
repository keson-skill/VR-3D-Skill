#!/usr/bin/env node

import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { printJson } from "./lib/cli.mjs";

const execFileAsync = promisify(execFile);

async function commandStatus(command, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      available: true,
      version: (stdout || stderr).split(/\r?\n/)[0].trim(),
    };
  } catch (error) {
    return {
      available: false,
      error: error.code === "ENOENT" ? "not installed" : error.message,
    };
  }
}

async function moduleStatus(path) {
  try {
    await access(new URL(path, import.meta.url));
    return { available: true };
  } catch {
    return { available: false, error: "run npm install" };
  }
}

const report = {
  node: {
    available: Number(process.versions.node.split(".")[0]) >= 20,
    version: process.versions.node,
    required: ">=20",
  },
  dependencies: {
    ajv: await moduleStatus("../node_modules/ajv/package.json"),
    three: await moduleStatus("../node_modules/three/build/three.module.js"),
    sharp: await moduleStatus("../node_modules/sharp/package.json"),
    dxf_parser: await moduleStatus("../node_modules/dxf-parser/package.json"),
  },
  optional_tools: {
    tesseract: await commandStatus("tesseract"),
    blender: await commandStatus("blender"),
  },
};
report.ready_for_p2_spatial =
  report.node.available &&
  report.dependencies.ajv.available &&
  report.dependencies.sharp.available &&
  report.dependencies.dxf_parser.available;
report.ready_for_parametric_web_scene =
  report.node.available &&
  Object.values(report.dependencies).every((item) => item.available);
report.ready_for_local_ocr = report.optional_tools.tesseract.available;
report.ready_for_high_fidelity_rendering = report.optional_tools.blender.available;
report.ready_for_plan_render_alignment =
  report.node.available && report.dependencies.sharp.available;

printJson(report);
if (!report.ready_for_p2_spatial || !report.ready_for_parametric_web_scene) {
  process.exitCode = 1;
}

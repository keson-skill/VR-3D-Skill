#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "./ingest/tool-runner.mjs";

async function collectScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectScripts(path));
    } else if (extname(entry.name) === ".mjs") {
      files.push(path);
    }
  }
  return files.sort();
}

async function checkSyntax(file) {
  await runTool(process.execPath, ["--check", file], {
    timeoutMs: 10000,
    maxOutputBytes: 1024 * 1024,
  });
}

async function checkPythonSyntax(file) {
  const source = "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec')";
  const python = process.env.PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  await runTool(python, ["-c", source, file], {
    timeoutMs: 10000,
    maxOutputBytes: 1024 * 1024,
  });
}

const files = await collectScripts(fileURLToPath(new URL(".", import.meta.url)));
files.push(fileURLToPath(new URL("../assets/web-viewer/app.js", import.meta.url)));
for (const file of files) {
  await checkSyntax(file);
}
await checkPythonSyntax(fileURLToPath(new URL("./blender/render_scene.py", import.meta.url)));
process.stdout.write(`Syntax OK: ${files.length} JavaScript files and 1 Blender Python script\n`);

#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

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

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${file}\n${stderr.trim()}`));
      }
    });
  });
}

const files = await collectScripts(new URL(".", import.meta.url).pathname);
files.push(new URL("../assets/web-viewer/app.js", import.meta.url).pathname);
for (const file of files) {
  await checkSyntax(file);
}
process.stdout.write(`Syntax OK: ${files.length} scripts\n`);

#!/usr/bin/env node

import {
  access,
  mkdtemp,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  arch,
  cpus,
  freemem,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  parseArgs,
  printJson,
  writeJson,
} from "./lib/cli.mjs";
import { sanitizeError } from "./runtime/redaction.mjs";

const execFileAsync = promisify(execFile);
const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const PROFILES = new Set(["core", "input", "render", "release"]);

async function commandStatus(command, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    return {
      available: true,
      version: (stdout || stderr)
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.trim() || "unknown",
    };
  } catch (error) {
    return {
      available: false,
      error: error.code === "ENOENT" ? "not installed" : sanitizeError(error).message,
    };
  }
}

async function moduleStatus(path) {
  try {
    await access(new URL(path, import.meta.url));
    return { available: true };
  } catch {
    return { available: false, error: "run npm ci" };
  }
}

async function writableTemporaryStatus() {
  let directory = null;
  try {
    directory = await mkdtemp(join(tmpdir(), "vr-3d-doctor-"));
    await writeFile(join(directory, "write-check.txt"), "ok\n", "utf8");
    return { available: true, directory_kind: "system_temporary" };
  } catch (error) {
    return { available: false, error: sanitizeError(error).message };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function diskStatus() {
  try {
    const value = await statfs(process.cwd());
    const freeBytes = Number(value.bavail) * Number(value.bsize);
    return {
      available: Number.isFinite(freeBytes) && freeBytes >= 1024 * 1024 * 1024,
      free_bytes: freeBytes,
      required_free_bytes: 1024 * 1024 * 1024,
    };
  } catch (error) {
    return { available: false, error: sanitizeError(error).message };
  }
}

async function manifestStatus() {
  try {
    const [packageJson, lock] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    const lockRoot = lock.packages?.[""] || {};
    const dependencyMismatch = Object.entries(packageJson.dependencies || {})
      .filter(([name, version]) => lockRoot.dependencies?.[name] !== version)
      .map(([name]) => name);
    return {
      available:
        packageJson.name === "vr-3d-skill"
        && packageJson.version === lockRoot.version
        && dependencyMismatch.length === 0,
      package_version: packageJson.version,
      lockfile_version: lock.lockfileVersion,
      dependency_mismatch: dependencyMismatch,
    };
  } catch (error) {
    return { available: false, error: sanitizeError(error).message };
  }
}

function configuredEnvironment() {
  const names = [
    "REALMROUTER_SPATIAL_API_KEY",
    "REALMROUTER_IMAGE_API_KEY",
    "KIMI_CODE_API_KEY",
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
  ];
  return Object.fromEntries(names.map((name) => [name, Boolean(process.env[name])]));
}

export async function buildDoctorReport() {
  const major = Number(process.versions.node.split(".")[0]);
  const [
    temporary,
    disk,
    manifests,
    git,
    npm,
    tesseract,
    blender,
    pdfinfo,
    pdfimages,
    pdftotext,
    pdftocairo,
    pdftoppm,
    ffmpeg,
    ffprobe,
    libreoffice,
    pdal,
    ifcconvert,
    assimp,
  ] = await Promise.all([
    writableTemporaryStatus(),
    diskStatus(),
    manifestStatus(),
    commandStatus("git"),
    commandStatus("npm"),
    commandStatus("tesseract"),
    commandStatus("blender"),
    commandStatus("pdfinfo", ["-v"]),
    commandStatus("pdfimages", ["-v"]),
    commandStatus("pdftotext", ["-v"]),
    commandStatus("pdftocairo", ["-v"]),
    commandStatus("pdftoppm", ["-v"]),
    commandStatus("ffmpeg", ["-version"]),
    commandStatus("ffprobe", ["-version"]),
    commandStatus("soffice", ["--version"]),
    commandStatus("pdal", ["--version"]),
    commandStatus("IfcConvert", ["--version"]),
    commandStatus("assimp", ["version"]),
  ]);
  const dependencies = {
    ajv: await moduleStatus("../node_modules/ajv/package.json"),
    three: await moduleStatus("../node_modules/three/build/three.module.js"),
    sharp: await moduleStatus("../node_modules/sharp/package.json"),
    dxf_parser: await moduleStatus("../node_modules/dxf-parser/package.json"),
  };
  const optionalTools = {
    tesseract,
    blender,
    pdfinfo,
    pdfimages,
    pdftotext,
    pdftocairo,
    pdftoppm,
    ffmpeg,
    ffprobe,
    libreoffice,
    pdal,
    ifcconvert,
    assimp,
  };
  const capabilities = {
    core_spatial:
      major >= 20
      && SUPPORTED_PLATFORMS.has(platform())
      && temporary.available
      && manifests.available
      && Object.values(dependencies).every((item) => item.available),
    local_ocr: tesseract.available,
    pdf_ingest: [pdfinfo, pdfimages, pdftotext, pdftocairo, pdftoppm]
      .every((item) => item.available),
    video_ingest: ffmpeg.available && ffprobe.available,
    xlsx_catalog_ingest: libreoffice.available,
    binary_point_cloud_ingest: pdal.available,
    ifc_geometry_conversion: ifcconvert.available,
    fbx_scene_conversion: assimp.available,
    high_fidelity_rendering: blender.available,
    release_tooling:
      major >= 20
      && SUPPORTED_PLATFORMS.has(platform())
      && temporary.available
      && disk.available
      && manifests.available
      && git.available
      && npm.available
      && Object.values(dependencies).every((item) => item.available),
  };
  return {
    schema_version: "1.0",
    host: {
      platform: platform(),
      platform_release: release(),
      architecture: arch(),
      supported_platform: SUPPORTED_PLATFORMS.has(platform()),
      logical_cpus: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
    },
    node: {
      available: major >= 20,
      version: process.versions.node,
      required: ">=20",
      tested_majors: [20, 22],
    },
    filesystem: {
      writable_temporary: temporary,
      disk,
    },
    manifests,
    dependencies,
    required_tools: { git, npm },
    optional_tools: optionalTools,
    provider_credentials_configured: configuredEnvironment(),
    capabilities,
  };
}

function profileReady(report, profile) {
  if (profile === "core") return report.capabilities.core_spatial;
  if (profile === "input") {
    return (
      report.capabilities.core_spatial
      && report.capabilities.pdf_ingest
      && report.capabilities.video_ingest
    );
  }
  if (profile === "render") {
    return report.capabilities.core_spatial && report.capabilities.high_fidelity_rendering;
  }
  return report.capabilities.release_tooling;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    profile: { type: "string", default: "core" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: npm run doctor -- [--profile core|input|render|release] [--output doctor.json]\n");
    return;
  }
  if (!PROFILES.has(options.profile)) {
    throw new Error("--profile must be core, input, render, or release.");
  }
  const report = await buildDoctorReport();
  const result = {
    ...report,
    selected_profile: options.profile,
    ready: profileReady(report, options.profile),
  };
  if (options.output) await writeJson(options.output, result);
  printJson(result);
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

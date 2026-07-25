#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";

const SAFE_RELEASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

async function hashReleaseSibling(
  manifestFile,
  fileName,
  label,
  maxBytes,
) {
  if (typeof fileName !== "string" || !SAFE_RELEASE_FILE.test(fileName)) {
    throw new Error(`${label} file name is unsafe.`);
  }
  const filePath = join(dirname(manifestFile), fileName);
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if (metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(`${label} size is outside the release verification limit.`);
  }
  const hashes = {
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > metadata.size || bytes > maxBytes) {
      throw new Error(`${label} changed or exceeded its limit while hashing.`);
    }
    for (const hash of Object.values(hashes)) hash.update(chunk);
  }
  if (bytes !== metadata.size) {
    throw new Error(`${label} changed while it was being hashed.`);
  }
  return {
    filePath,
    bytes,
    sha1: hashes.sha1.digest("hex"),
    sha256: hashes.sha256.digest("hex"),
    npmIntegrity: `sha512-${hashes.sha512.digest("base64")}`,
  };
}

export async function verifyReleaseManifest(manifestFile, { tag = null } = {}) {
  const manifest = await readJson(
    manifestFile,
    "release manifest",
    { maxBytes: 4 * 1024 * 1024 },
  );
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const candidate = { ...manifest };
  delete candidate.manifest_sha256;
  if (
    !SHA256.test(manifest.manifest_sha256 || "")
    || canonicalJsonSha256(candidate) !== manifest.manifest_sha256
  ) {
    add("release.manifest_hash", "Release manifest hash mismatch.");
  }
  if (manifest.schema_version !== "1.0") {
    add("release.schema", "Release manifest schema_version must be 1.0.");
  }
  if (
    manifest.source?.available !== true
    || !/^[a-f0-9]{40,64}$/u.test(manifest.source?.commit_sha || "")
    || manifest.source?.dirty !== false
  ) {
    add("release.source", "Release source must be a clean, commit-bound git worktree.");
  }
  let artifact = null;
  try {
    artifact = await hashReleaseSibling(
      manifestFile,
      manifest.artifact?.file,
      "Release artifact",
      2 * 1024 * 1024 * 1024,
    );
    if (
      !SHA256.test(manifest.artifact?.sha256 || "")
      || artifact.sha256 !== manifest.artifact.sha256
    ) {
      add("release.artifact_hash", "Release artifact hash mismatch.");
    }
    if (
      !Number.isSafeInteger(manifest.artifact?.bytes)
      || artifact.bytes !== manifest.artifact.bytes
    ) {
      add("release.artifact_size", "Release artifact size mismatch.");
    }
    if (manifest.artifact?.npm_shasum !== artifact.sha1) {
      add("release.artifact_npm_shasum", "npm artifact SHA-1 mismatch.");
    }
    if (manifest.artifact?.npm_integrity !== artifact.npmIntegrity) {
      add("release.artifact_npm_integrity", "npm artifact SHA-512 integrity mismatch.");
    }
  } catch (error) {
    add("release.artifact_missing", error.message);
  }
  let sbomArtifact = null;
  try {
    sbomArtifact = await hashReleaseSibling(
      manifestFile,
      manifest.sbom?.file,
      "Release SBOM",
      64 * 1024 * 1024,
    );
    if (
      !SHA256.test(manifest.sbom?.sha256 || "")
      || sbomArtifact.sha256 !== manifest.sbom.sha256
    ) {
      add("release.sbom_hash", "SBOM hash mismatch.");
    }
    const sbom = await readJson(
      sbomArtifact.filePath,
      "release SBOM",
      { maxBytes: 64 * 1024 * 1024 },
    );
    const sbomBody = structuredClone(sbom);
    delete sbomBody.document_sha256;
    if (
      !SHA256.test(sbom.document_sha256 || "")
      || canonicalJsonSha256(sbomBody) !== sbom.document_sha256
      || manifest.sbom?.document_sha256 !== sbom.document_sha256
    ) {
      add("release.sbom_document_hash", "SBOM document hash mismatch.");
    }
    if (
      sbom.bomFormat !== "CycloneDX"
      || sbom.specVersion !== "1.6"
      || sbom.metadata?.component?.name !== manifest.package?.name
      || sbom.metadata?.component?.version !== manifest.package?.version
      || !Array.isArray(sbom.components)
      || sbom.components.length !== manifest.sbom?.components
      || !Array.isArray(sbom.dependencies)
    ) {
      add(
        "release.sbom_identity",
        "SBOM format, package identity, component count, or dependency graph does not match the release manifest.",
      );
    }
  } catch (error) {
    add("release.sbom_missing", error.message);
  }
  if (tag && tag !== `v${manifest.package?.version}`) {
    add("release.tag", `Tag ${tag} does not match package version v${manifest.package?.version}.`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.package?.version || "")) {
    add("release.version", "Production release version must be a stable MAJOR.MINOR.PATCH.");
  }
  for (const field of [
    "security_passed",
    "doctor_release_ready",
    "qualification_passed",
    "clean_worktree",
    "stable_version",
  ]) {
    if (manifest.preflight?.[field] !== true) {
      add(`release.preflight_${field}`, `Preflight ${field} did not pass.`);
    }
  }
  if (manifest.release_ready !== true) {
    add("release.not_ready", "Manifest is explicitly marked as not release-ready.");
  }
  const report = {
    schema_version: "1.0",
    valid: errors.length === 0,
    package: manifest.package || null,
    tag,
    errors,
    artifact_sha256: manifest.artifact?.sha256 || null,
    manifest_sha256: manifest.manifest_sha256 || null,
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    manifest: { type: "string", required: true },
    tag: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/verify-release.mjs --manifest dist/release.json [--tag v1.0.0] [--output verification.json]\n");
    return;
  }
  const report = await verifyReleaseManifest(options.manifest, { tag: options.tag || null });
  if (options.output) await writeJson(options.output, report);
  printJson(report);
  if (!report.valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

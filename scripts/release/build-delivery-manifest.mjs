#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import { verifySpatialApproval } from "../approval/spatial-approval.mjs";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  writeJson,
} from "../lib/cli.mjs";

const MODES = new Set(["shell", "hard-furnishing", "furnished"]);
const SCOPES = new Set(["visualization_only", "construction_ready"]);
const ARTIFACT_ROLES = new Set([
  "scene",
  "viewer",
  "render",
  "panorama",
  "walkthrough",
  "blender",
  "report",
  "bill_of_materials",
  "other",
]);
const REQUIRED_BINDINGS = [
  "source_manifest",
  "spatial_json",
  "validation_report",
  "approval",
  "approval_trust",
];
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const UNRESOLVED_LICENSES = new Set([
  "forbidden",
  "missing",
  "none",
  "pending",
  "unknown",
  "unlicensed",
  "unspecified",
  "verify_before_distribution",
]);

function parseNamedPath(value, allowedNames, label) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`${label} must use name=relative/path syntax.`);
  }
  const name = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (!allowedNames.has(name)) throw new Error(`Unsupported ${label} name ${name}.`);
  if (isAbsolute(path)) throw new Error(`${label} paths must be relative to --root.`);
  return { name, path };
}

function containedPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}

async function sha256File(filePath, expectedBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > expectedBytes) {
      throw new Error(`File changed while it was being hashed: ${filePath}`);
    }
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) {
    throw new Error(`File changed while it was being hashed: ${filePath}`);
  }
  return hash.digest("hex");
}

async function inspectFile(root, entry) {
  const absolute = resolve(root, entry.path);
  if (!containedPath(root, absolute)) {
    throw new Error(`${entry.name} escapes the delivery root.`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${entry.path} must be a regular non-symlink file.`);
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(`${entry.path} exceeds the 2 GiB per-file delivery limit.`);
  }
  const canonical = await realpath(absolute);
  if (!containedPath(root, canonical)) {
    throw new Error(`${entry.path} resolves outside the delivery root.`);
  }
  if (resolve(canonical) !== absolute) {
    throw new Error(`${entry.path} traverses a symbolic-link path.`);
  }
  const digest = await sha256File(absolute, metadata.size);
  const after = await lstat(absolute);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || after.size !== metadata.size
    || after.mtimeMs !== metadata.mtimeMs
  ) {
    throw new Error(`${entry.path} changed while it was being inspected.`);
  }
  return {
    ...entry,
    path: relative(root, absolute).replaceAll("\\", "/"),
    bytes: metadata.size,
    sha256: digest,
    absolute,
    canonical,
  };
}

async function readInspectedJson(entry, label, maxBytes) {
  if (entry.bytes > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte JSON limit.`);
  }
  const bytes = await readFile(entry.absolute);
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`${label} changed after it was inspected.`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function reviewAssetLicenses(assetManifest) {
  if (!assetManifest) {
    return {
      provided: false,
      asset_count: 0,
      passed: true,
      blockers: [],
    };
  }
  const assets = Array.isArray(assetManifest.assets) ? assetManifest.assets : [];
  const blockers = [];
  assets.forEach((asset, index) => {
    if (typeof asset.license !== "string" || !asset.license.trim()) {
      blockers.push({
        code: "delivery.asset_license_missing",
        path: `/assets/${index}/license`,
      });
    } else if (
      UNRESOLVED_LICENSES.has(
        asset.license.trim().toLowerCase().replaceAll(/\s+/gu, "_"),
      )
    ) {
      blockers.push({
        code: "delivery.asset_license_unresolved",
        path: `/assets/${index}/license`,
      });
    }
  });
  return {
    provided: true,
    asset_count: assets.length,
    passed: blockers.length === 0,
    blockers,
  };
}

export async function buildDeliveryManifest(
  {
    rootDirectory,
    projectId,
    revision,
    scope,
    mode,
    bindingEntries,
    artifactEntries,
    assetManifestEntry = null,
    limitations = [],
  },
  {
    allowTestApproval = false,
    generatedAt = new Date().toISOString(),
  } = {},
) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("projectId is required.");
  }
  if (typeof revision !== "string" || !revision.trim()) {
    throw new Error("revision is required.");
  }
  if (!SCOPES.has(scope)) throw new Error("scope is invalid.");
  if (!MODES.has(mode)) throw new Error("mode is invalid.");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generatedAt is invalid.");
  if (!Array.isArray(artifactEntries) || artifactEntries.length < 1) {
    throw new Error("At least one explicit delivery artifact is required.");
  }
  if (artifactEntries.length > MAX_FILES) {
    throw new Error(`A delivery may contain at most ${MAX_FILES} files.`);
  }
  const root = await realpath(resolve(rootDirectory));
  const bindingNames = new Set(bindingEntries.map((entry) => entry.name));
  const missing = REQUIRED_BINDINGS.filter((name) => !bindingNames.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing delivery bindings: ${missing.join(", ")}.`);
  }
  if (bindingNames.size !== bindingEntries.length) {
    throw new Error("Delivery binding names must be unique.");
  }
  if (artifactEntries.some((entry) => !ARTIFACT_ROLES.has(entry.name))) {
    throw new Error("Delivery artifact contains an unsupported role.");
  }
  const allEntries = [
    ...bindingEntries,
    ...artifactEntries,
    ...(assetManifestEntry ? [assetManifestEntry] : []),
  ];
  const inspected = await Promise.all(allEntries.map((entry) => inspectFile(root, entry)));
  const inspectedBindings = inspected.slice(0, bindingEntries.length);
  const inspectedArtifacts = inspected.slice(
    bindingEntries.length,
    bindingEntries.length + artifactEntries.length,
  );
  const inspectedAssetManifest = assetManifestEntry ? inspected.at(-1) : null;
  const canonicalPaths = inspected.map((entry) => entry.canonical);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    throw new Error("Delivery bindings and artifacts must reference distinct files.");
  }
  if (inspectedBindings.some((entry) => entry.bytes > 16 * 1024 * 1024)) {
    throw new Error("A delivery JSON binding exceeds the 16 MiB limit.");
  }
  if (inspectedAssetManifest?.bytes > 64 * 1024 * 1024) {
    throw new Error("Asset manifest exceeds the 64 MiB limit.");
  }
  const totalBytes = inspected.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("Delivery exceeds the 10 GiB total file limit.");
  }
  const bindingFiles = Object.fromEntries(
    inspectedBindings
      .map((entry) => [entry.name, entry]),
  );
  const documents = Object.fromEntries(
    await Promise.all(REQUIRED_BINDINGS.map(async (name) => [
      name,
      await readInspectedJson(
        bindingFiles[name],
        `Delivery binding ${name}`,
        16 * 1024 * 1024,
      ),
    ])),
  );
  if (
    documents.spatial_json?.project?.id !== projectId
    || documents.spatial_json?.project?.revision !== revision
  ) {
    throw new Error("Delivery project ID/revision does not match Spatial JSON.");
  }
  if (documents.approval?.decision?.scope !== scope) {
    throw new Error("Delivery scope does not match the independent approval.");
  }
  const approvalVerification = verifySpatialApproval({
    approval: documents.approval,
    sourceManifest: documents.source_manifest,
    spatialJson: documents.spatial_json,
    validationReport: documents.validation_report,
    approvalTrust: documents.approval_trust,
    allowTestFixture: allowTestApproval,
  });
  const assetDocument = assetManifestEntry
    ? await readInspectedJson(
        inspectedAssetManifest,
        "Delivery asset manifest",
        64 * 1024 * 1024,
      )
    : null;
  const licenses = reviewAssetLicenses(assetDocument);
  const blockers = [];
  if (!approvalVerification.valid) {
    blockers.push({
      code: "delivery.approval_invalid",
      error_codes: approvalVerification.errors.map((error) => error.code),
    });
  }
  if (mode === "furnished" && !assetManifestEntry) {
    blockers.push({ code: "delivery.asset_manifest_required" });
  }
  blockers.push(...licenses.blockers);
  const normalizedLimitations = [...new Set(
    limitations.map((item) => String(item).trim()).filter(Boolean),
  )];
  if (scope === "visualization_only") {
    normalizedLimitations.unshift(
      "Visualization only: do not use this delivery for construction, structural, regulatory, procurement, or exact-site decisions.",
    );
  }
  const artifacts = inspectedArtifacts
    .map(({ name: role, path, bytes, sha256 }) => ({ role, path, bytes, sha256 }));
  const bindings = Object.fromEntries(
    REQUIRED_BINDINGS.map((name) => {
      const { path, bytes, sha256 } = bindingFiles[name];
      return [name, { path, bytes, sha256 }];
    }),
  );
  if (assetManifestEntry) {
    const asset = inspectedAssetManifest;
    bindings.asset_manifest = {
      path: asset.path,
      bytes: asset.bytes,
      sha256: asset.sha256,
    };
  }
  const manifest = {
    schema_version: "1.0",
    kind: "interior_delivery",
    project: { id: projectId, revision },
    generated_at: generatedAt,
    scope,
    mode,
    bindings,
    approval_verification: {
      valid: approvalVerification.valid,
      error_codes: approvalVerification.errors.map((error) => error.code),
      report_sha256: canonicalJsonSha256(approvalVerification),
    },
    asset_licenses: licenses,
    artifacts,
    aggregate: {
      artifact_count: artifacts.length,
      total_bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    },
    limitations: normalizedLimitations,
    blockers,
    delivery_ready: blockers.length === 0,
  };
  return {
    ...manifest,
    delivery_manifest_sha256: canonicalJsonSha256(manifest),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    root: { type: "string", required: true },
    "project-id": { type: "string", required: true },
    revision: { type: "string", required: true },
    scope: { type: "string", required: true },
    mode: { type: "string", required: true },
    binding: { type: "array", required: true },
    artifact: { type: "array", required: true },
    "asset-manifest": { type: "string" },
    limitation: { type: "array" },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/release/build-delivery-manifest.mjs --root runs/project-001 \\
    --project-id project-001 --revision rev-001 --scope visualization_only --mode furnished \\
    --binding source_manifest=source-manifest.json \\
    --binding spatial_json=spatial.json \\
    --binding validation_report=spatial-validation.json \\
    --binding approval=spatial-approval.json \\
    --binding approval_trust=spatial-approval-trust.json \\
    --asset-manifest asset-manifest.json \\
    --artifact scene=viewer/scene.glb --artifact viewer=viewer/index.html \\
    --output delivery-manifest.json

Every input path must be a regular file below --root. Test approvals are never accepted.
`);
    return;
  }
  const bindingAllowed = new Set(REQUIRED_BINDINGS);
  const bindingEntries = options.binding.map((entry) =>
    parseNamedPath(entry, bindingAllowed, "binding"));
  const artifactEntries = options.artifact.map((entry) =>
    parseNamedPath(entry, ARTIFACT_ROLES, "artifact"));
  const manifest = await buildDeliveryManifest({
    rootDirectory: options.root,
    projectId: options["project-id"],
    revision: options.revision,
    scope: options.scope,
    mode: options.mode,
    bindingEntries,
    artifactEntries,
    assetManifestEntry: options["asset-manifest"]
      ? { name: "asset_manifest", path: options["asset-manifest"] }
      : null,
    limitations: options.limitation,
  });
  await writeJson(options.output, manifest);
  printJson({
    outputFile: options.output,
    deliveryReady: manifest.delivery_ready,
    artifactCount: manifest.aggregate.artifact_count,
    manifestSha256: manifest.delivery_manifest_sha256,
    blockers: manifest.blockers,
  });
  if (!manifest.delivery_ready) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { validateReleaseEvidence } from "./validate-release-evidence.mjs";

const PLATFORMS = new Set(["linux", "darwin", "win32"]);
const TARGETS = new Set(["web_desktop", "web_mobile", "web_xr", "blender"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUALIFICATION_BUNDLE_BYTES = 32 * 1024;

function withoutHash(record, field) {
  const body = structuredClone(record);
  delete body[field];
  return body;
}

function assertEmbeddedHash(record, field, label) {
  if (
    !SHA256.test(record?.[field] || "")
    || canonicalJsonSha256(withoutHash(record, field)) !== record[field]
  ) {
    throw new Error(`${label} has an invalid ${field}.`);
  }
}

function parseTargetPath(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--target must use target=report.json syntax.");
  }
  const target = value.slice(0, separator);
  if (!TARGETS.has(target)) throw new Error(`Unknown qualification target ${target}.`);
  return { target, path: value.slice(separator + 1) };
}

export function assembleQualificationBundle({
  commitSha,
  platformRecords,
  targetReports,
  projectAcceptances,
}) {
  const platforms = {};
  for (const record of platformRecords) {
    if (!PLATFORMS.has(record?.platform)) {
      throw new Error(`Unknown platform record ${record?.platform || "(missing)"}.`);
    }
    if (platforms[record.platform]) {
      throw new Error(`Duplicate platform record ${record.platform}.`);
    }
    assertEmbeddedHash(record, "record_sha256", `${record.platform} platform record`);
    if (record.status !== "passed" || record.commit_sha !== commitSha) {
      throw new Error(`${record.platform} platform record did not pass for the release commit.`);
    }
    platforms[record.platform] = structuredClone(record);
  }
  const targets = {};
  for (const { target, report } of targetReports) {
    if (targets[target]) throw new Error(`Duplicate target report ${target}.`);
    assertEmbeddedHash(report, "report_sha256", `${target} qualification report`);
    if (
      report.target !== target
      || report.qualified !== true
      || report.evidence_kind !== "actual_device_capture"
      || !SHA256.test(report.capture_record_sha256 || "")
      || report.execution?.commit_sha !== commitSha
      || !SHA256.test(report.execution?.artifact_sha256 || "")
      || !Number.isFinite(Date.parse(report.execution?.captured_at))
    ) {
      throw new Error(`${target} is not qualified for the release commit.`);
    }
    targets[target] = structuredClone(report);
  }
  const projects = projectAcceptances.map((record, index) => {
    assertEmbeddedHash(record, "acceptance_report_sha256", `Project acceptance ${index + 1}`);
    if (
      record.schema_version !== "1.0"
      || record.kind !== "real_project_acceptance"
      || record.data_classification !== "anonymized_real_project"
      || record.synthetic !== false
      || record.accepted !== true
      || record.commit_sha !== commitSha
      || record.attestation?.method !== "interactive_human_review"
      || record.privacy_review?.anonymized !== true
      || record.privacy_review?.customer_authorized_use !== true
      || !SHA256.test(record.source_manifest_sha256 || "")
      || !SHA256.test(record.delivery_manifest_sha256 || "")
      || !Number.isFinite(Date.parse(record.accepted_at))
      || typeof record.approver_id !== "string"
      || !record.approver_id.trim()
    ) {
      throw new Error(`Project acceptance ${index + 1} is incomplete or synthetic.`);
    }
    return structuredClone(record);
  });
  const bundle = {
    schema_version: "1.0",
    commit_sha: commitSha,
    platforms,
    targets,
    projects,
  };
  const withHash = {
    ...bundle,
    qualification_bundle_sha256: canonicalJsonSha256(bundle),
  };
  if (
    Buffer.byteLength(JSON.stringify(withHash), "utf8")
    > MAX_QUALIFICATION_BUNDLE_BYTES
  ) {
    throw new Error(
      "Qualification bundle exceeds 32 KiB; keep raw captures external and embed only bounded records plus artifact hashes.",
    );
  }
  const validation = validateReleaseEvidence(withHash, { expectedCommit: commitSha });
  if (!validation.passed) {
    throw new Error(`Qualification bundle is incomplete: ${validation.errors
      .map((error) => error.code)
      .join(", ")}.`);
  }
  return withHash;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    commit: { type: "string", required: true },
    platform: { type: "array", required: true },
    target: { type: "array", required: true },
    project: { type: "array", required: true },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/release/assemble-qualification-bundle.mjs --commit <sha> \\
    --platform linux-evidence.json --platform macos-evidence.json --platform windows-evidence.json \\
    --target web_desktop=desktop-report.json --target web_mobile=mobile-report.json \\
    --target web_xr=xr-report.json --target blender=blender-report.json \\
    --project artifacts/qualification/real-project-acceptance.json \\
    --output artifacts/qualification/qualification-bundle.json
`);
    return;
  }
  const targetPaths = options.target.map(parseTargetPath);
  const [platformRecords, targetReports, projectAcceptances] = await Promise.all([
    Promise.all(options.platform.map((path) =>
      readJson(path, "platform evidence", { maxBytes: 16 * 1024 * 1024 }))),
    Promise.all(targetPaths.map(async ({ target, path }) => ({
      target,
      report: await readJson(path, `${target} qualification`, { maxBytes: 16 * 1024 * 1024 }),
    }))),
    Promise.all(options.project.map((path) =>
      readJson(path, "real-project acceptance", { maxBytes: 16 * 1024 * 1024 }))),
  ]);
  const bundle = assembleQualificationBundle({
    commitSha: options.commit,
    platformRecords,
    targetReports,
    projectAcceptances,
  });
  await writeJson(options.output, bundle);
  printJson({
    outputFile: options.output,
    qualificationBundleSha256: bundle.qualification_bundle_sha256,
    platforms: Object.keys(bundle.platforms),
    targets: Object.keys(bundle.targets),
    projects: bundle.projects.length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

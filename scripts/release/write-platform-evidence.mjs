#!/usr/bin/env node

import { arch, platform } from "node:os";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { readBoundedFile } from "../ingest/file-safety.mjs";

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;

export function buildPlatformEvidence(
  {
    acceptance,
    acceptanceBytes,
    doctor,
    doctorBytes,
    commitSha,
    workflowUrl,
  },
  {
    hostPlatform = platform(),
    hostArchitecture = arch(),
    nodeVersion = process.versions.node,
    capturedAt = new Date().toISOString(),
    ciProvider = "github_actions",
  } = {},
) {
  if (!SUPPORTED_PLATFORMS.has(hostPlatform)) {
    throw new Error(`Unsupported release platform ${hostPlatform}.`);
  }
  if (!COMMIT_PATTERN.test(commitSha || "")) {
    throw new Error("Platform evidence requires a 40- or 64-character commit SHA.");
  }
  if (
    typeof workflowUrl !== "string"
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/u.test(workflowUrl)
  ) {
    throw new Error("Platform evidence requires the current GitHub Actions run URL.");
  }
  if (ciProvider !== "github_actions") {
    throw new Error("Platform evidence must be emitted by the configured CI provider.");
  }
  if (
    acceptance?.stage !== "P10"
    || acceptance?.acceptance_scope !== "code_only"
    || acceptance?.passed !== true
    || acceptance?.code_passed !== true
  ) {
    throw new Error("The P10 code-acceptance report did not pass.");
  }
  if (
    doctor?.ready !== true
    || doctor?.selected_profile !== "release"
    || doctor?.host?.platform !== hostPlatform
  ) {
    throw new Error("The release doctor report did not pass on the current platform.");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("Platform evidence capture time is invalid.");
  }
  const inputHashes = {
    p10_code_acceptance: sha256(acceptanceBytes),
    doctor_release: sha256(doctorBytes),
  };
  const bundleHash = canonicalJsonSha256({
    commit_sha: commitSha,
    platform: hostPlatform,
    node_version: nodeVersion,
    inputs: inputHashes,
  });
  const record = {
    schema_version: "1.0",
    platform: hostPlatform,
    status: "passed",
    commit_sha: commitSha,
    captured_at: capturedAt,
    workflow_url: workflowUrl,
    artifact_sha256: bundleHash,
    environment: {
      architecture: hostArchitecture,
      node_version: nodeVersion,
      ci_provider: ciProvider,
    },
    inputs: inputHashes,
    explicit_non_claim:
      "This record proves CI execution on one host platform only; it does not qualify a physical mobile or XR device, GPU performance, Blender rendering, or a real customer project.",
  };
  return {
    ...record,
    record_sha256: canonicalJsonSha256(record),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    acceptance: { type: "string", required: true },
    doctor: { type: "string", required: true },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/write-platform-evidence.mjs --acceptance p10.json --doctor doctor.json --output platform-evidence.json\n");
    return;
  }
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || !process.env.GITHUB_SHA
    || !process.env.GITHUB_RUN_ID
    || !process.env.GITHUB_REPOSITORY
  ) {
    throw new Error("Platform qualification evidence can only be emitted inside GitHub Actions.");
  }
  const [acceptanceBytes, doctorBytes] = await Promise.all([
    readBoundedFile(options.acceptance, {
      label: "P10 code acceptance",
      maxBytes: 16 * 1024 * 1024,
    }).then((result) => result.bytes),
    readBoundedFile(options.doctor, {
      label: "Release doctor report",
      maxBytes: 16 * 1024 * 1024,
    }).then((result) => result.bytes),
  ]);
  const workflowUrl =
    `${process.env.GITHUB_SERVER_URL || "https://github.com"}/`
    + `${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const record = buildPlatformEvidence({
    acceptance: JSON.parse(acceptanceBytes.toString("utf8")),
    acceptanceBytes,
    doctor: JSON.parse(doctorBytes.toString("utf8")),
    doctorBytes,
    commitSha: process.env.GITHUB_SHA,
    workflowUrl,
  });
  await writeJson(options.output, record);
  printJson({
    outputFile: options.output,
    platform: record.platform,
    commitSha: record.commit_sha,
    recordSha256: record.record_sha256,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

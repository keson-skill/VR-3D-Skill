#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import { validateQualificationRecord } from "../performance/validate-qualification.mjs";

const REQUIRED_PLATFORMS = ["linux", "darwin", "win32"];
const REQUIRED_TARGETS = ["web_desktop", "web_mobile", "web_xr", "blender"];
const MAX_QUALIFICATION_BUNDLE_BYTES = 32 * 1024;
const QUALIFICATION_BUDGETS = JSON.parse(await readFile(
  new URL("../../config/performance-budgets.json", import.meta.url),
  "utf8",
));

function sha(value, lengths = [40, 64]) {
  return lengths.some((length) =>
    new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value || ""));
}

function embeddedHashValid(record, field) {
  const body = structuredClone(record || {});
  delete body[field];
  return (
    sha(record?.[field], [64])
    && canonicalJsonSha256(body) === record[field]
  );
}

export function validateReleaseEvidence(bundle, { expectedCommit = null } = {}) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (
    Buffer.byteLength(JSON.stringify(bundle || {}), "utf8")
    > MAX_QUALIFICATION_BUNDLE_BYTES
  ) {
    add(
      "release_evidence.bundle_size",
      "/",
      "Qualification bundle exceeds the 32 KiB transport limit.",
    );
  }
  const bundleBody = structuredClone(bundle || {});
  delete bundleBody.qualification_bundle_sha256;
  if (
    !sha(bundle?.qualification_bundle_sha256, [64])
    || canonicalJsonSha256(bundleBody) !== bundle.qualification_bundle_sha256
  ) {
    add(
      "release_evidence.bundle_hash",
      "/qualification_bundle_sha256",
      "Qualification bundle must have a valid canonical SHA-256.",
    );
  }
  if (bundle?.schema_version !== "1.0") add("release_evidence.schema", "/schema_version", "schema_version must be 1.0.");
  if (!sha(bundle?.commit_sha)) add("release_evidence.commit", "/commit_sha", "A commit SHA is required.");
  if (expectedCommit && bundle?.commit_sha !== expectedCommit) {
    add("release_evidence.commit_mismatch", "/commit_sha", "Evidence does not match the release commit.");
  }
  for (const platform of REQUIRED_PLATFORMS) {
    const record = bundle?.platforms?.[platform];
    if (
      record?.schema_version !== "1.0"
      || record?.platform !== platform
      || record?.status !== "passed"
    ) {
      add("release_evidence.platform", `/platforms/${platform}`, `${platform} CI evidence must pass.`);
      continue;
    }
    if (!embeddedHashValid(record, "record_sha256")) {
      add(
        "release_evidence.platform_record",
        `/platforms/${platform}/record_sha256`,
        `${platform} embedded platform record hash is invalid.`,
      );
    }
    if (record.commit_sha !== bundle.commit_sha || !Number.isFinite(Date.parse(record.captured_at))) {
      add("release_evidence.platform_binding", `/platforms/${platform}`, `${platform} evidence must bind the commit and timestamp.`);
    }
    if (
      typeof record.workflow_url !== "string"
      || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/u
        .test(record.workflow_url)
      || !sha(record.artifact_sha256, [64])
      || record.environment?.ci_provider !== "github_actions"
      || !sha(record.inputs?.p10_code_acceptance, [64])
      || !sha(record.inputs?.doctor_release, [64])
    ) {
      add("release_evidence.platform_artifact", `/platforms/${platform}`, `${platform} evidence requires workflow URL and artifact hash.`);
    }
  }
  for (const target of REQUIRED_TARGETS) {
    const record = bundle?.targets?.[target];
    if (record?.qualified !== true || record?.target !== target) {
      add("release_evidence.target", `/targets/${target}`, `${target} requires a passing qualification report.`);
    }
    if (!sha(record?.report_sha256, [64])) {
      add("release_evidence.target_hash", `/targets/${target}/report_sha256`, `${target} report hash is required.`);
    }
    if (!sha(record?.capture_record_sha256, [64])) {
      add(
        "release_evidence.target_capture_hash",
        `/targets/${target}/capture_record_sha256`,
        `${target} raw capture record hash is required.`,
      );
    }
    if (!embeddedHashValid(record, "report_sha256")) {
      add(
        "release_evidence.target_report",
        `/targets/${target}/report_sha256`,
        `${target} embedded qualification report hash is invalid.`,
      );
    }
    if (
      !record?.capture_record
      || canonicalJsonSha256(record.capture_record) !== record.capture_record_sha256
    ) {
      add(
        "release_evidence.target_capture",
        `/targets/${target}/capture_record`,
        `${target} must embed the raw capture record bound by its hash.`,
      );
    } else {
      const regenerated = validateQualificationRecord(
        record.capture_record,
        QUALIFICATION_BUDGETS,
      );
      if (
        regenerated.qualified !== true
        || regenerated.report_sha256 !== record.report_sha256
      ) {
        add(
          "release_evidence.target_validation",
          `/targets/${target}`,
          `${target} report does not reproduce from the embedded capture record.`,
        );
      }
    }
    if (
      record?.execution?.commit_sha !== bundle?.commit_sha
      || !sha(record?.execution?.artifact_sha256, [64])
    ) {
      add("release_evidence.target_binding", `/targets/${target}`, `${target} evidence must bind the release commit and artifact.`);
    }
  }
  const projects = bundle?.projects;
  if (!Array.isArray(projects) || projects.length < 1) {
    add("release_evidence.real_project", "/projects", "At least one anonymized real-project end-to-end acceptance is required.");
  } else {
    projects.forEach((project, index) => {
      if (
        project.schema_version !== "1.0"
        || project.kind !== "real_project_acceptance"
        || project.data_classification !== "anonymized_real_project"
        || project.synthetic !== false
        || project.accepted !== true
        || project.commit_sha !== bundle?.commit_sha
        || !sha(project.source_manifest_sha256, [64])
        || !sha(project.delivery_manifest_sha256, [64])
        || !sha(project.acceptance_report_sha256, [64])
        || !Number.isFinite(Date.parse(project.accepted_at))
        || typeof project.approver_id !== "string"
        || !project.approver_id.trim()
        || project.privacy_review?.anonymized !== true
        || project.privacy_review?.customer_authorized_use !== true
        || project.attestation?.method !== "interactive_human_review"
        || !embeddedHashValid(project, "acceptance_report_sha256")
      ) {
        add(
          "release_evidence.project_binding",
          `/projects/${index}`,
          "Real-project evidence requires anonymization, acceptance, and source/delivery hashes.",
        );
      }
    });
  }
  const report = {
    schema_version: "1.0",
    commit_sha: bundle?.commit_sha || null,
    passed: errors.length === 0,
    errors,
    required_platforms: REQUIRED_PLATFORMS,
    required_targets: REQUIRED_TARGETS,
    project_count: Array.isArray(projects) ? projects.length : 0,
    explicit_non_claim:
      errors.length === 0
        ? null
        : "The build is a release candidate only and is not fully production-qualified.",
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    commit: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/validate-release-evidence.mjs --input qualification-bundle.json [--commit sha] [--output report.json]\n");
    return;
  }
  const bundle = await readJson(
    options.input,
    "release qualification bundle",
    { maxBytes: 64 * 1024 * 1024 },
  );
  const report = validateReleaseEvidence(bundle, { expectedCommit: options.commit || null });
  if (options.output) await writeJson(options.output, report);
  printJson(report);
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

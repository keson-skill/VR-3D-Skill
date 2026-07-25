#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import {
  containsCredentialField,
  containsUnredactedSecret,
} from "../runtime/redaction.mjs";

const TARGETS = new Set(["web_desktop", "web_mobile", "web_xr", "blender"]);
const SAFE_OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_EVIDENCE_FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const ALLOWED_CAPTURE_KEYS = {
  root: new Set([
    "schema_version",
    "qualification_id",
    "target",
    "execution",
    "hardware",
    "software",
    "measurements",
    "checks",
    "evidence",
    "artifacts",
  ]),
  execution: new Set([
    "status",
    "evidence_kind",
    "synthetic",
    "captured_at",
    "operator",
    "commit_sha",
    "artifact_sha256",
  ]),
  hardware: new Set([
    "manufacturer",
    "model",
    "device_class",
    "os",
    "os_version",
    "gpu",
    "cpu",
  ]),
  software: new Set([
    "browser",
    "browser_version",
    "blender_version",
    "render_engine",
  ]),
  measurements: new Set([
    "capture_seconds",
    "average_fps",
    "p95_frame_time_ms",
    "memory_growth_bytes",
    "rendered_frames",
    "average_render_seconds_per_frame",
  ]),
  checks: new Set([
    "launch",
    "navigate",
    "pause_resume",
    "recover_failure",
    "session_enter",
    "session_exit",
    "session_reenter",
    "tracking_loss_recovery",
    "controller_reconnect",
  ]),
};

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actualCapture(record) {
  return (
    record?.execution?.status === "executed"
    && record?.execution?.evidence_kind === "actual_device_capture"
    && record?.execution?.synthetic === false
  );
}

export function validateQualificationRecord(record, budgets) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  for (const [name, value] of [
    ["root", record],
    ["execution", record?.execution],
    ["hardware", record?.hardware],
    ["software", record?.software],
    ["measurements", record?.measurements],
    ["checks", record?.checks],
  ]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!ALLOWED_CAPTURE_KEYS[name].has(key)) {
        add(
          "qualification.unexpected_field",
          name === "root" ? `/${key}` : `/${name}/${key}`,
          `Unexpected qualification capture field ${key}.`,
        );
      }
    }
  }
  if (
    containsCredentialField(record)
    || containsUnredactedSecret(record)
  ) {
    add(
      "qualification.sensitive_data",
      "/",
      "Qualification captures must not contain credentials or secrets.",
    );
  }
  const target = record?.target;
  const budget = budgets?.profiles?.[target];
  if (record?.schema_version !== "1.0") add("qualification.schema", "/schema_version", "schema_version must be 1.0.");
  if (!TARGETS.has(target) || !budget) add("qualification.target", "/target", "Target profile is unknown.");
  if (!actualCapture(record)) {
    add(
      "qualification.actual_capture",
      "/execution",
      "Qualification requires an executed, non-synthetic actual_device_capture record.",
    );
  }
  if (!nonempty(record?.qualification_id)) add("qualification.id", "/qualification_id", "Stable qualification ID is required.");
  if (!Number.isFinite(Date.parse(record?.execution?.captured_at))) {
    add("qualification.time", "/execution/captured_at", "Capture time must be an ISO timestamp.");
  }
  for (const field of ["operator", "commit_sha", "artifact_sha256"]) {
    if (!nonempty(record?.execution?.[field])) {
      add(`qualification.${field}`, `/execution/${field}`, `${field} is required.`);
    }
  }
  if (!SAFE_OPERATOR_ID.test(record?.execution?.operator || "")) {
    add(
      "qualification.operator_id",
      "/execution/operator",
      "operator must be a stable non-personal identifier.",
    );
  }
  if (!/^[a-f0-9]{40,64}$/u.test(record?.execution?.commit_sha || "")) {
    add("qualification.commit_hash", "/execution/commit_sha", "commit_sha must be a 40- or 64-character hexadecimal commit hash.");
  }
  if (!/^[a-f0-9]{64}$/u.test(record?.execution?.artifact_sha256 || "")) {
    add("qualification.artifact_hash", "/execution/artifact_sha256", "artifact_sha256 must be a SHA-256.");
  }
  for (const field of ["manufacturer", "model", "os", "os_version"]) {
    if (!nonempty(record?.hardware?.[field])) {
      add(`qualification.hardware_${field}`, `/hardware/${field}`, `Hardware ${field} is required.`);
    }
  }
  const measurements = record?.measurements || {};
  if (target && target !== "blender") {
    if (!nonempty(record?.software?.browser) || !nonempty(record?.software?.browser_version)) {
      add("qualification.browser", "/software", "Browser name and version are required.");
    }
    if (!nonempty(record?.hardware?.gpu)) {
      add("qualification.gpu", "/hardware/gpu", "GPU identity is required.");
    }
    if (
      !Array.isArray(record?.evidence)
      || record.evidence.length === 0
      || record.evidence.length > 100
      || record.evidence.some((item) =>
        !nonempty(item.file)
        || !SAFE_EVIDENCE_FILE.test(item.file)
        || item.file.split("/").includes("..")
        || !/^[a-f0-9]{64}$/u.test(item.sha256 || "")
        || Object.keys(item).some((key) => !["file", "sha256"].includes(key)))
    ) {
      add("qualification.capture_evidence", "/evidence", "At least one hashed performance capture is required.");
    }
    for (const field of [
      "capture_seconds",
      "average_fps",
      "p95_frame_time_ms",
      "memory_growth_bytes",
    ]) {
      if (!Number.isFinite(measurements[field]) || measurements[field] < 0) {
        add(`qualification.${field}`, `/measurements/${field}`, `${field} must be a non-negative number.`);
      }
    }
    if (measurements.capture_seconds < budget?.minimum_capture_seconds) {
      add("qualification.capture_duration", "/measurements/capture_seconds", "Capture duration is below the target budget.");
    }
    if (measurements.average_fps < budget?.minimum_fps) {
      add("qualification.fps", "/measurements/average_fps", "Average FPS is below the minimum.");
    }
    if (measurements.p95_frame_time_ms > budget?.max_p95_frame_time_ms) {
      add("qualification.frame_time", "/measurements/p95_frame_time_ms", "P95 frame time exceeds the budget.");
    }
    if (measurements.memory_growth_bytes > budget?.max_memory_growth_bytes) {
      add("qualification.memory", "/measurements/memory_growth_bytes", "Memory growth exceeds the budget.");
    }
    for (const lifecycle of ["launch", "navigate", "pause_resume", "recover_failure"]) {
      if (record?.checks?.[lifecycle] !== true) {
        add(`qualification.check_${lifecycle}`, `/checks/${lifecycle}`, `${lifecycle} must pass.`);
      }
    }
  }
  if (target === "web_xr") {
    if (record?.hardware?.device_class !== "xr_headset") {
      add("qualification.xr_device", "/hardware/device_class", "WebXR qualification requires a physical XR headset.");
    }
    for (const lifecycle of [
      "session_enter",
      "session_exit",
      "session_reenter",
      "tracking_loss_recovery",
      "controller_reconnect",
    ]) {
      if (record?.checks?.[lifecycle] !== true) {
        add(`qualification.xr_${lifecycle}`, `/checks/${lifecycle}`, `${lifecycle} must pass on-device.`);
      }
    }
  }
  if (target === "web_mobile" && record?.hardware?.device_class !== "mobile") {
    add("qualification.mobile_device", "/hardware/device_class", "Mobile qualification requires a physical mobile device.");
  }
  if (target === "web_desktop" && record?.hardware?.device_class !== "desktop") {
    add("qualification.desktop_device", "/hardware/device_class", "Desktop qualification requires a desktop-class host.");
  }
  if (target === "blender") {
    if (!nonempty(record?.software?.blender_version)) {
      add("qualification.blender_version", "/software/blender_version", "Actual Blender version is required.");
    }
    if (!nonempty(record?.software?.render_engine)) {
      add("qualification.blender_engine", "/software/render_engine", "Actual Blender render engine is required.");
    }
    if (!nonempty(record?.hardware?.cpu) && !nonempty(record?.hardware?.gpu)) {
      add("qualification.blender_device", "/hardware", "Blender qualification requires the actual CPU or GPU identity.");
    }
    if (
      !Number.isInteger(measurements.rendered_frames)
      || measurements.rendered_frames < (budget?.minimum_rendered_frames || Infinity)
    ) {
      add("qualification.blender_frames", "/measurements/rendered_frames", "Too few Blender frames were rendered.");
    }
    if (
      !Number.isFinite(measurements.average_render_seconds_per_frame)
      || measurements.average_render_seconds_per_frame > (budget?.max_average_render_seconds_per_frame || -1)
    ) {
      add("qualification.blender_time", "/measurements/average_render_seconds_per_frame", "Blender render time exceeds the budget.");
    }
    if (
      !Array.isArray(record?.artifacts)
      || record.artifacts.length < 2
      || record.artifacts.length > 100
    ) {
      add("qualification.blender_artifacts", "/artifacts", "Blender qualification requires hashed render and blend artifacts.");
    } else if (record.artifacts.some((artifact) =>
      !nonempty(artifact.file)
      || !SAFE_EVIDENCE_FILE.test(artifact.file)
      || artifact.file.split("/").includes("..")
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256 || "")
      || Object.keys(artifact).some((key) => !["file", "sha256"].includes(key)))) {
      add("qualification.blender_hash", "/artifacts", "Every Blender artifact requires a SHA-256.");
    }
  }
  const captureRecordSha256 = canonicalJsonSha256(record || {});
  const report = {
    schema_version: "1.0",
    qualification_id: record?.qualification_id || null,
    target: target || null,
    qualified: errors.length === 0,
    errors,
    evidence_kind: record?.execution?.evidence_kind || null,
    capture_record_sha256: captureRecordSha256,
    execution: {
      operator: record?.execution?.operator || null,
      commit_sha: record?.execution?.commit_sha || null,
      artifact_sha256: record?.execution?.artifact_sha256 || null,
      captured_at: record?.execution?.captured_at || null,
    },
    hardware: record?.hardware || null,
    software: record?.software || null,
    measurements: record?.measurements || null,
    checks: record?.checks || null,
    evidence: record?.evidence || record?.artifacts || [],
    capture_record: structuredClone(record || {}),
    explicit_non_claim:
      errors.length === 0
        ? null
        : "This record does not qualify the target device or renderer.",
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    budgets: { type: "string", default: "config/performance-budgets.json" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/performance/validate-qualification.mjs --input device-capture.json [--output report.json]\n");
    return;
  }
  const [record, budgets] = await Promise.all([
    readJson(options.input, "qualification capture", { maxBytes: 16 * 1024 * 1024 }),
    readJson(options.budgets, "performance budgets", { maxBytes: 1024 * 1024 }),
  ]);
  const report = validateQualificationRecord(record, budgets);
  if (options.output) await writeJson(options.output, report);
  printJson(report);
  if (!report.qualified) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

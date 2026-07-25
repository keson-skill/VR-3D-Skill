#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import {
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { runTool } from "../ingest/tool-runner.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";

const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".css", ".csv", ".html", ".ini", ".js", ".json", ".jsonl",
  ".md", ".mjs", ".py", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "runs",
  "dist",
  "coverage",
]);
const EXCLUDED_GENERATED_REPORTS = new Set([
  "examples/p10-acceptance/automated-evidence.json",
  "examples/p10-acceptance/code-evidence.json",
  "examples/p10-acceptance/core-benchmark.json",
  "examples/p10-acceptance/code-evidence-core-benchmark.json",
  "examples/p10-acceptance/security-audit.json",
  "examples/p10-acceptance/code-evidence-security-audit.json",
]);
const ALLOWED_DEPENDENCY_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
]);
const ALLOWED_DEPENDENCY_LICENSE_EXPRESSIONS = new Set([
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
]);
const SECRET_PATTERNS = [
  {
    code: "secret.private_key",
    pattern: /-----BEGIN [^-]+ PRIVATE KEY-----/gu,
  },
  {
    code: "secret.github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu,
  },
  {
    code: "secret.github_fine_grained",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  },
  {
    code: "secret.aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    code: "secret.bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu,
  },
  {
    code: "secret.api_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  },
];

function placeholderSecret(value) {
  return /(?:example|fixture|sample|test|dummy|redacted|your[_-]|x{4,})/iu.test(value);
}

function finding({
  severity,
  code,
  path,
  line = null,
  message,
  evidence = null,
}) {
  return {
    severity,
    code,
    path,
    line,
    message,
    evidence_sha256: evidence ? sha256(Buffer.from(evidence, "utf8")) : null,
  };
}

async function walk(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, output);
    } else if (entry.isFile()) {
      output.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return output;
}

async function trackedFiles(root) {
  try {
    const result = await runTool(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024 },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch {
    return walk(root);
  }
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function scanText(path, text) {
  const findings = [];
  for (const rule of SECRET_PATTERNS) {
    for (const match of text.matchAll(rule.pattern)) {
      if (placeholderSecret(match[0]) || match[0].includes("[")) continue;
      findings.push(finding({
        severity: "blocker",
        code: rule.code,
        path,
        line: lineNumber(text, match.index),
        message: "Potential committed credential or private key.",
        evidence: match[0],
      }));
    }
  }
  const assignmentPatterns = [
    /^(?:[A-Z0-9_]*(?:API_KEY|SECRET(?:_KEY|_ID)?|ACCESS_TOKEN|PASSWORD))[ \t]*=[ \t]*([^\s#]{8,})/gimu,
    /\b(?:apiKey|secretKey|secretId|accessToken|password)[ \t]*:[ \t]*["']([^"']{8,})["']/giu,
  ];
  for (const assignmentPattern of assignmentPatterns) {
    for (const match of text.matchAll(assignmentPattern)) {
      if (placeholderSecret(match[1])) continue;
      findings.push(finding({
        severity: "blocker",
        code: "secret.assignment",
        path,
        line: lineNumber(text, match.index),
        message: "A credential-like variable has a non-placeholder value.",
        evidence: match[1],
      }));
    }
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)) {
    if (/@(?:example|localhost|invalid)\./iu.test(match[0]) || /@example\.com$/iu.test(match[0])) {
      continue;
    }
    findings.push(finding({
      severity: "warning",
      code: "privacy.email",
      path,
      line: lineNumber(text, match.index),
      message: "Review committed email address for customer or employee data.",
      evidence: match[0],
    }));
  }
  return findings;
}

function validSriIntegrity(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const digestBytes = new Map([
    ["sha256", 32],
    ["sha384", 48],
    ["sha512", 64],
  ]);
  return value.trim().split(/\s+/u).every((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u
      .exec(token);
    if (!match) return false;
    const decoded = Buffer.from(match[2], "base64");
    return (
      decoded.length === digestBytes.get(match[1])
      && decoded.toString("base64") === match[2]
    );
  });
}

function auditDependencyLicenses(packageJson, lock) {
  const findings = [];
  const dependencies = [];
  const directDependencies = packageJson.dependencies || {};
  for (const [lockfilePath, record] of Object.entries(lock.packages || {})) {
    if (!lockfilePath || !record?.version) continue;
    const name = record.name
      || lockfilePath.replace(/^node_modules\//u, "").split("/node_modules/").at(-1);
    const license = record.license || null;
    const integrity = record.integrity || null;
    const integrityValid = validSriIntegrity(integrity);
    const direct = Object.hasOwn(directDependencies, name);
    dependencies.push({
      name,
      requested: direct ? directDependencies[name] : null,
      version: record.version,
      license,
      direct,
      optional: record.optional === true,
      lockfile_path: lockfilePath,
      integrity_present: integrityValid,
    });
    if (
      !license
      || (
        !ALLOWED_DEPENDENCY_LICENSES.has(license)
        && !ALLOWED_DEPENDENCY_LICENSE_EXPRESSIONS.has(license)
      )
    ) {
      findings.push(finding({
        severity: "blocker",
        code: "license.dependency",
        path: "package-lock.json",
        message: `Locked dependency ${name}@${record.version} has an unapproved or unknown license: ${license || "missing"}.`,
      }));
    }
    if (!integrityValid) {
      findings.push(finding({
        severity: "blocker",
        code: "dependency.integrity",
        path: "package-lock.json",
        message: `Locked dependency ${name}@${record.version} has no valid lockfile SRI integrity hash.`,
      }));
    }
  }
  dependencies.sort((left, right) =>
    left.lockfile_path.localeCompare(right.lockfile_path));
  return { dependencies, findings };
}

function auditProviderGates(files) {
  const findings = [];
  const tasks = files.filter((entry) =>
    entry.path.startsWith("scripts/tasks/")
    && entry.text.includes("adapters/"));
  for (const task of tasks) {
    if (
      !task.text.includes("requireProviderApproval")
      || !task.text.includes("requireProviderApproval(options)")
      || !task.text.includes("\"allow-provider\"")
    ) {
      findings.push(finding({
        severity: "blocker",
        code: "provider.approval_gate",
        path: task.path,
        message: "External-provider task is missing the explicit per-command approval gate.",
      }));
    }
  }
  return {
    checked_tasks: tasks.map((task) => task.path),
    findings,
  };
}

function auditProcessPolicy(files) {
  const allowed = new Set([
    "scripts/doctor.mjs",
    "scripts/ingest/tool-runner.mjs",
    "scripts/security/audit-release.mjs",
  ]);
  const findings = [];
  for (const file of files.filter((entry) =>
    entry.text.includes("node:child_process"))) {
    if (allowed.has(file.path)) continue;
    findings.push(finding({
      severity: "blocker",
      code: "process.unreviewed_child_process",
      path: file.path,
      message: "External processes must use the bounded no-shell tool runner or an explicitly reviewed fixed-command utility.",
    }));
  }
  return { findings };
}

function auditWorkflowActions(files) {
  const findings = [];
  let checked = 0;
  for (const file of files.filter((entry) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry.path))) {
    for (const match of file.text.matchAll(
      /^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)/gmu,
    )) {
      checked += 1;
      if (!/^[a-f0-9]{40}$/u.test(match[2])) {
        findings.push(finding({
          severity: "blocker",
          code: "workflow.action_unpinned",
          path: file.path,
          line: lineNumber(file.text, match.index),
          message: `Workflow action ${match[1]} must be pinned to a full commit SHA.`,
        }));
      }
    }
  }
  return { checked, findings };
}

export async function auditRelease(
  rootDirectory,
  {
    filePaths = null,
  } = {},
) {
  const root = resolve(rootDirectory);
  const paths = (filePaths || await trackedFiles(root))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path && !path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment)))
    .filter((path) => !EXCLUDED_GENERATED_REPORTS.has(path))
    .sort();
  const findings = [];
  const textFiles = [];
  let scannedBytes = 0;
  for (const path of paths) {
    if (path === ".env" || (/^\.env\./u.test(path) && path !== ".env-example")) {
      findings.push(finding({
        severity: "blocker",
        code: "secret.env_tracked",
        path,
        message: "Environment files with potential credentials must not be committed.",
      }));
    }
    if (path.startsWith("runs/")) {
      findings.push(finding({
        severity: "blocker",
        code: "privacy.runtime_artifact",
        path,
        message: "Runtime/customer artifacts must not be committed.",
      }));
    }
    const extension = extname(path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    let bytes;
    try {
      ({ bytes } = await readBoundedFile(join(root, path), {
        label: "Audited repository text file",
        maxBytes: 4 * MiB,
        allowEmpty: true,
      }));
    } catch (error) {
      findings.push(finding({
        severity: "blocker",
        code: "repository.unscannable_text",
        path,
        message: `Text file cannot be scanned safely: ${error.message}`,
      }));
      continue;
    }
    scannedBytes += bytes.length;
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    textFiles.push({ path, text });
    findings.push(...scanText(path, text));
  }

  let packageAudit = { dependencies: [], findings: [] };
  try {
    const [packageJson, lock] = await Promise.all([
      readJson(join(root, "package.json"), "package manifest", { maxBytes: 4 * MiB }),
      readJson(join(root, "package-lock.json"), "package lock", { maxBytes: 16 * MiB }),
    ]);
    packageAudit = auditDependencyLicenses(packageJson, lock);
    findings.push(...packageAudit.findings);
  } catch (error) {
    findings.push(finding({
      severity: "blocker",
      code: "dependency.manifest",
      path: "package.json",
      message: `Cannot audit dependency manifests: ${error.message}`,
    }));
  }

  const providerAudit = auditProviderGates(textFiles);
  findings.push(...providerAudit.findings);
  const processAudit = auditProcessPolicy(textFiles);
  findings.push(...processAudit.findings);
  const workflowAudit = auditWorkflowActions(textFiles);
  findings.push(...workflowAudit.findings);
  const uniqueFindings = [...new Map(
    findings.map((item) => [
      `${item.severity}:${item.code}:${item.path}:${item.line}:${item.evidence_sha256}`,
      item,
    ]),
  ).values()];
  const aggregate = {
    files_considered: paths.length,
    text_files_scanned: textFiles.length,
    bytes_scanned: scannedBytes,
    dependencies_checked: packageAudit.dependencies.length,
    provider_tasks_checked: providerAudit.checked_tasks.length,
    workflow_actions_checked: workflowAudit.checked,
    blockers: uniqueFindings.filter((item) => item.severity === "blocker").length,
    warnings: uniqueFindings.filter((item) => item.severity === "warning").length,
  };
  const report = {
    schema_version: "1.0",
    audit: "release_security_privacy_license",
    passed: aggregate.blockers === 0,
    aggregate,
    findings: uniqueFindings,
    dependencies: packageAudit.dependencies,
    provider_tasks: providerAudit.checked_tasks,
    limitations: [
      "Pattern scanning does not replace provider-side secret scanning or manual privacy review.",
      "Transitive dependency vulnerabilities require a current registry-backed npm audit in release CI.",
      "Customer asset redistribution rights require review of the exact delivery asset manifest.",
      "Generated P10 acceptance/audit/benchmark reports are excluded to avoid self-referential evidence; their generators and source fixtures remain scanned.",
    ],
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    root: { type: "string", default: "." },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/security/audit-release.mjs [--root .] [--output security-audit.json]\n");
    return;
  }
  const report = await auditRelease(options.root);
  if (options.output) await writeJson(options.output, report);
  printJson({
    outputFile: options.output || null,
    passed: report.passed,
    aggregate: report.aggregate,
    reportSha256: report.report_sha256,
  });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

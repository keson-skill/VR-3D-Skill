#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";
import { runTool } from "../ingest/tool-runner.mjs";
import { redactValue } from "../runtime/redaction.mjs";

const STATEMENT =
  "I reviewed an anonymized real project end to end, verified the approved source binding and delivery, confirmed customer-authorized use, and accept the recorded limitations.";
const ACCEPTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function verifyDeliveryManifest(manifest) {
  const body = structuredClone(manifest);
  delete body.delivery_manifest_sha256;
  return (
    manifest?.delivery_ready === true
    && /^[a-f0-9]{64}$/u.test(manifest?.delivery_manifest_sha256 || "")
    && canonicalJsonSha256(body) === manifest.delivery_manifest_sha256
  );
}

export function verifyRealProjectBindings({
  sourceManifestBytes,
  deliveryManifest,
  projectId,
}) {
  if (!verifyDeliveryManifest(deliveryManifest)) {
    throw new Error("Delivery manifest is not ready or its integrity hash is invalid.");
  }
  if (deliveryManifest.project?.id !== projectId) {
    throw new Error("Project ID does not match the delivery manifest.");
  }
  const sourceHash = createHash("sha256")
    .update(sourceManifestBytes)
    .digest("hex");
  if (deliveryManifest.bindings?.source_manifest?.sha256 !== sourceHash) {
    throw new Error("Source manifest does not match the delivery binding.");
  }
  return sourceHash;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "source-manifest": { type: "string", required: true },
    "delivery-manifest": { type: "string", required: true },
    "project-id": { type: "string", required: true },
    "approver-id": { type: "string", required: true },
    commit: { type: "string", required: true },
    output: { type: "string", required: true },
    notes: { type: "string", default: "" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/approve-real-project.mjs --source-manifest source-manifest.json --delivery-manifest delivery-manifest.json --project-id anonymized-001 --approver-id product-owner-001 --commit <release-commit-sha> --output artifacts/qualification/real-project-acceptance.json\n");
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Real-project acceptance requires an interactive terminal.");
  }
  if (
    !ACCEPTANCE_ID.test(options["project-id"])
    || !ACCEPTANCE_ID.test(options["approver-id"])
  ) {
    throw new Error("Project and approver IDs must be stable non-personal identifiers.");
  }
  if (!/^[a-f0-9]{40,64}$/u.test(options.commit)) {
    throw new Error("Release commit must be a 40- or 64-character hexadecimal hash.");
  }
  if (Buffer.byteLength(options.notes, "utf8") > 2048) {
    throw new Error("Acceptance notes must not exceed 2048 bytes.");
  }
  const [sourceManifestFile, deliveryManifest] = await Promise.all([
    readBoundedFile(options["source-manifest"], {
      label: "source manifest",
      maxBytes: 16 * MiB,
    }),
    readJson(options["delivery-manifest"], "delivery manifest", { maxBytes: 16 * 1024 * 1024 }),
  ]);
  try {
    JSON.parse(sourceManifestFile.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Source manifest is invalid JSON: ${error.message}`);
  }
  const sourceHash = verifyRealProjectBindings({
    sourceManifestBytes: sourceManifestFile.bytes,
    deliveryManifest,
    projectId: options["project-id"],
  });
  const [head, status] = await Promise.all([
    runTool("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 30000,
      maxOutputBytes: MiB,
    }),
    runTool("git", ["status", "--porcelain"], {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 30000,
      maxOutputBytes: MiB,
    }),
  ]);
  if (head.stdout.trim() !== options.commit) {
    throw new Error("Checked-out repository does not match the requested release commit.");
  }
  if (status.stdout.trim()) {
    throw new Error("Real-project acceptance requires a clean release worktree.");
  }
  const confirmation = createHash("sha256")
    .update(
      `${STATEMENT}\n${options.commit}\n${sourceHash}\n`
      + `${deliveryManifest.delivery_manifest_sha256}\n${options["approver-id"]}`,
      "utf8",
    )
    .digest("hex");
  const prompt = `${STATEMENT}\n\nType ${confirmation.slice(0, 16)} to accept: `;
  const readline = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
  if (answer !== confirmation.slice(0, 16)) {
    throw new Error("Real-project acceptance was not confirmed.");
  }
  const record = {
    schema_version: "1.0",
    kind: "real_project_acceptance",
    project_id: options["project-id"],
    data_classification: "anonymized_real_project",
    synthetic: false,
    accepted: true,
    accepted_at: new Date().toISOString(),
    approver_id: options["approver-id"],
    commit_sha: options.commit,
    source_manifest_sha256: sourceHash,
    delivery_manifest_sha256: deliveryManifest.delivery_manifest_sha256,
    privacy_review: {
      anonymized: true,
      customer_authorized_use: true,
    },
    attestation: {
      method: "interactive_human_review",
      statement: STATEMENT,
      confirmation_digest: confirmation,
    },
    notes: redactValue(options.notes),
  };
  const withHash = {
    ...record,
    acceptance_report_sha256: canonicalJsonSha256(record),
  };
  await writeJson(options.output, withHash);
  printJson({
    outputFile: options.output,
    projectId: withHash.project_id,
    acceptedAt: withHash.accepted_at,
    acceptanceReportSha256: withHash.acceptance_report_sha256,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

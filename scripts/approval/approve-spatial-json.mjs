#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  readText,
  writeJson,
} from "../lib/cli.mjs";
import { createInteractiveHumanApprovalRecord } from "./spatial-approval.mjs";

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/approval/approve-spatial-json.mjs \\
    --source-manifest source-manifest.json \\
    --spatial-json corrected-spatial.json \\
    --validation-report spatial-validation.json \\
    --signing-key /secure/path/reviewer-ed25519.pem \\
    --key-id reviewer-001 \\
    --output spatial-approval.json

This command deliberately requires a human-operated TTY. It will not approve in
CI, a model task, or another non-interactive process. Review and correct the
source overlay before running it.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "source-manifest": { type: "string", required: true },
    "spatial-json": { type: "string", required: true },
    "validation-report": { type: "string", required: true },
    "signing-key": { type: "string", required: true },
    "key-id": { type: "string", required: true },
    output: { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Human approval refused: run this command yourself in an interactive terminal.",
    );
  }
  const [sourceManifest, spatialJson, validationReport, signingKeyPem] =
    await Promise.all([
      readJson(options["source-manifest"], "source manifest"),
      readJson(options["spatial-json"], "Spatial JSON"),
      readJson(options["validation-report"], "validation report"),
      readText(options["signing-key"], "approval signing key"),
    ]);
  const spatialHash = canonicalJsonSha256(spatialJson);
  const scope = spatialJson.validation?.approved_scope;
  process.stdout.write(
    `\nProject: ${spatialJson.project?.id}\nRevision: ${spatialJson.project?.revision}\nScope: ${scope}\nSpatial SHA-256: ${spatialHash}\nValidation errors: ${validationReport.errors?.length ?? "unknown"}\n\n`,
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const approver = (await prompt.question("Human approver name: ")).trim();
    const notes = await prompt.question("Review notes (may be blank): ");
    const phrase = `APPROVE ${spatialHash.slice(0, 12)}`;
    const confirmation = (
      await prompt.question(`Type exactly "${phrase}" to bind this decision: `)
    ).trim();
    if (confirmation !== phrase) {
      throw new Error("Approval cancelled: confirmation text did not match.");
    }
    const record = createInteractiveHumanApprovalRecord({
      sourceManifest,
      spatialJson,
      validationReport,
      approver,
      scope,
      notes,
      signingKeyPem,
      signingKeyId: options["key-id"],
      paths: {
        sourceManifest: options["source-manifest"],
        spatialJson: options["spatial-json"],
        validationReport: options["validation-report"],
      },
    });
    await writeJson(options.output, record);
    printJson({
      outputFile: options.output,
      approvalId: record.approval_id,
      project: record.project,
      scope: record.decision.scope,
      approver: record.decision.approver,
      approvedAt: record.decision.approved_at,
    });
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

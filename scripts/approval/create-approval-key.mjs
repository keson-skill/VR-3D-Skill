#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, printJson } from "../lib/cli.mjs";
import { validateSpatialApprovalTrustSchema } from "../validation/json-schema.mjs";

function insideWorkingDirectory(path) {
  const relation = relative(resolve(process.cwd()), resolve(path));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/approval/create-approval-key.mjs \\
    --key-id reviewer-001 --owner "Reviewer name" \\
    --private-key /secure/outside/repo/reviewer-ed25519.pem \\
    --trust-store config/spatial-approval-trust.json

Creates one Ed25519 reviewer key and a public trust store. The private key path
must be outside the current workspace and is created with owner-only permissions.
Neither file is overwritten. Back up the private key securely.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    "key-id": { type: "string", required: true },
    owner: { type: "string", required: true },
    "private-key": { type: "string", required: true },
    "trust-store": { type: "string", required: true },
    help: { type: "boolean" },
  });
  if (options.help) return printHelp();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Reviewer key creation refused: run this command yourself in an interactive terminal.",
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(options["key-id"])) {
    throw new Error(
      "--key-id must start with a letter and contain only letters, numbers, ., _, :, or -.",
    );
  }
  if (insideWorkingDirectory(options["private-key"])) {
    throw new Error(
      "The approval private key must be stored outside the current workspace.",
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const phrase = `CREATE REVIEWER KEY ${options["key-id"]}`;
    const confirmation = (
      await prompt.question(
        `Type exactly "${phrase}" to create a new trust root: `,
      )
    ).trim();
    if (confirmation !== phrase) {
      throw new Error("Reviewer key creation cancelled.");
    }
  } finally {
    prompt.close();
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  });
  const trustStore = {
    schema_version: "1.0",
    kind: "spatial_approval_trust",
    keys: [
      {
        id: options["key-id"],
        algorithm: "ed25519",
        public_key_pem: publicKeyPem,
        status: "active",
        owner: options.owner,
      },
    ],
  };
  const schema = validateSpatialApprovalTrustSchema(trustStore);
  if (!schema.valid) {
    throw new Error(
      `Generated trust store is invalid: ${JSON.stringify(schema.errors)}`,
    );
  }
  await Promise.all([
    mkdir(dirname(resolve(options["private-key"])), { recursive: true }),
    mkdir(dirname(resolve(options["trust-store"])), { recursive: true }),
  ]);
  await writeFile(resolve(options["private-key"]), privateKeyPem, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await writeFile(
      resolve(options["trust-store"]),
      `${JSON.stringify(trustStore, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    throw new Error(
      `Private key was created but trust store was not. Securely remove or retain ${resolve(options["private-key"])} before retrying: ${error.message}`,
    );
  }
  printJson({
    trustStore: resolve(options["trust-store"]),
    keyId: options["key-id"],
    owner: options.owner,
    privateKeyStored: true,
    privateKeyPathDisclosed: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

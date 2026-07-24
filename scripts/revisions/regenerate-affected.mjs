#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";

function runCommand(command, args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export async function regenerateAffected(
  dependencyPlan,
  {
    handlers,
    previousManifest = { artifacts: {} },
    approvalVerified = false,
  },
) {
  if (!dependencyPlan || !Array.isArray(dependencyPlan.regenerate)) {
    throw new Error("A valid dependency plan is required.");
  }
  const requiredApproval = new Set(dependencyPlan.approval_required_for || []);
  const missingHandlers = dependencyPlan.regenerate.filter(
    (artifact) => typeof handlers?.[artifact] !== "function",
  );
  if (missingHandlers.length > 0) {
    throw new Error(`No regeneration handler for: ${missingHandlers.join(", ")}.`);
  }
  if (!approvalVerified) {
    const blocked = dependencyPlan.regenerate.filter((artifact) => requiredApproval.has(artifact));
    if (blocked.length > 0) {
      throw new Error(`Reapproval is required before regenerating: ${blocked.join(", ")}.`);
    }
  }

  const regenerated = {};
  for (const artifact of dependencyPlan.regenerate) {
    regenerated[artifact] = {
      status: "regenerated",
      ...await handlers[artifact]({ artifact, dependencyPlan }),
    };
  }
  const affected = new Set(dependencyPlan.regenerate);
  const reused = Object.fromEntries(
    Object.entries(previousManifest.artifacts || {})
      .filter(([artifact]) => !affected.has(artifact))
      .map(([artifact, value]) => [artifact, { ...value, status: "reused" }]),
  );
  return {
    schema_version: "1.0",
    changed_roots: dependencyPlan.changed_roots,
    artifacts: { ...reused, ...regenerated },
    regenerated: dependencyPlan.regenerate,
    reused: Object.keys(reused),
  };
}

function commandHandlers(config, outputRoot) {
  return Object.fromEntries(
    Object.entries(config.artifacts || {}).map(([artifact, specification]) => [
      artifact,
      async () => {
        if (
          typeof specification.command !== "string"
          || !Array.isArray(specification.args)
          || specification.args.some((argument) => typeof argument !== "string")
        ) {
          throw new Error(`Invalid command configuration for ${artifact}.`);
        }
        const result = await runCommand(
          specification.command,
          specification.args,
          specification.cwd ? resolve(specification.cwd) : process.cwd(),
        );
        const metadata = {
          command: specification.command,
          args: specification.args,
          stdout: result.stdout.trim(),
        };
        if (specification.output) {
          const outputFile = resolve(outputRoot, specification.output);
          const bytes = await readFile(outputFile);
          metadata.output = outputFile;
          metadata.bytes = bytes.byteLength;
          metadata.sha256 = sha256(bytes);
        }
        return metadata;
      },
    ]),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    plan: { type: "string", required: true },
    config: { type: "string", required: true },
    output: { type: "string", required: true },
    "previous-manifest": { type: "string" },
    "output-root": { type: "string", default: "." },
    "approval-verified": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/revisions/regenerate-affected.mjs --plan dependency-plan.json --config regeneration-config.json --output manifest.json --approval-verified\n");
    return;
  }
  const [plan, config, previousManifest] = await Promise.all([
    readJson(options.plan, "dependency plan"),
    readJson(options.config, "regeneration configuration"),
    options["previous-manifest"]
      ? readJson(options["previous-manifest"], "previous artifact manifest")
      : Promise.resolve({ artifacts: {} }),
  ]);
  const manifest = await regenerateAffected(plan, {
    handlers: commandHandlers(config, options["output-root"]),
    previousManifest,
    approvalVerified: options["approval-verified"],
  });
  await writeJson(options.output, manifest);
  printJson({
    outputFile: options.output,
    regenerated: manifest.regenerated,
    reused: manifest.reused,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { MiB, readBoundedFile } from "../ingest/file-safety.mjs";
import { runTool } from "../ingest/tool-runner.mjs";

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
  if (
    dependencyPlan.regenerate.length > 100
    || dependencyPlan.regenerate.some((artifact) =>
      !/^[A-Za-z][A-Za-z0-9._:-]{0,79}$/u.test(artifact))
    || new Set(dependencyPlan.regenerate).size !== dependencyPlan.regenerate.length
  ) {
    throw new Error("Regeneration artifact IDs must be unique, safe, and limited to 100.");
  }
  const requiredApproval = new Set(dependencyPlan.approval_required_for || []);
  const missingHandlers = dependencyPlan.regenerate.filter(
    (artifact) =>
      !Object.hasOwn(handlers || {}, artifact)
      || typeof handlers[artifact] !== "function",
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

  const regenerated = Object.create(null);
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

function commandHandlers(config, outputRoot, { allowCommands = false, run = runTool } = {}) {
  const artifacts = Object.entries(config.artifacts || {});
  if (artifacts.length > 0 && !allowCommands) {
    throw new Error("Configured regeneration commands require explicit --allow-command approval.");
  }
  const root = resolve(outputRoot);
  return Object.fromEntries(
    artifacts.map(([artifact, specification]) => [
      artifact,
      async () => {
        if (
          typeof specification.command !== "string"
          || specification.command.length > 4096
          || !Array.isArray(specification.args)
          || specification.args.length > 100
          || specification.args.some((argument) =>
            typeof argument !== "string" || argument.length > 8192)
        ) {
          throw new Error(`Invalid command configuration for ${artifact}.`);
        }
        const timeoutMs = Number(specification.timeout_ms || 600000);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
          throw new Error(`Invalid timeout for ${artifact}.`);
        }
        const result = await run(
          specification.command,
          specification.args,
          {
            cwd: specification.cwd ? resolve(specification.cwd) : process.cwd(),
            timeoutMs,
            maxOutputBytes: 4 * MiB,
          },
        );
        const metadata = {
          command: basename(specification.command).slice(0, 255),
          args_count: specification.args.length,
          stdout_bytes: Buffer.byteLength(result.stdout),
          stdout_sha256: sha256(Buffer.from(result.stdout, "utf8")),
        };
        if (specification.output) {
          const outputFile = resolve(root, specification.output);
          const outputRelative = relative(root, outputFile);
          if (
            !outputRelative
            || outputRelative.startsWith("..")
            || isAbsolute(outputRelative)
          ) {
            throw new Error(`Regeneration output for ${artifact} escapes --output-root.`);
          }
          const canonicalRoot = await realpath(root);
          const canonicalOutput = await realpath(outputFile);
          const canonicalRelative = relative(canonicalRoot, canonicalOutput);
          if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
            throw new Error(`Regeneration output for ${artifact} resolves outside --output-root.`);
          }
          const { bytes } = await readBoundedFile(canonicalOutput, {
            label: `Regenerated ${artifact}`,
            maxBytes: 2 * 1024 * MiB,
          });
          metadata.output = outputRelative.replaceAll("\\", "/");
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
    "allow-command": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/revisions/regenerate-affected.mjs --plan dependency-plan.json --config regeneration-config.json --output manifest.json --approval-verified --allow-command\n");
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
    handlers: commandHandlers(config, options["output-root"], {
      allowCommands: options["allow-command"],
    }),
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

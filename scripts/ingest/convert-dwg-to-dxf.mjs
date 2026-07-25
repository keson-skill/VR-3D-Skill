#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { extractDxfEvidence } from "./extract-dxf-evidence.mjs";
import { GiB, MiB, readBoundedFile } from "./file-safety.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

const DWG_VERSIONS = new Map([
  ["AC1009", "R12"],
  ["AC1012", "R13"],
  ["AC1014", "R14"],
  ["AC1015", "2000"],
  ["AC1018", "2004"],
  ["AC1021", "2007"],
  ["AC1024", "2010"],
  ["AC1027", "2013"],
  ["AC1032", "2018+"],
]);

export function inspectDwgHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6) {
    return { valid: false, signature: null, version: null };
  }
  const signature = bytes.subarray(0, 6).toString("ascii");
  return {
    valid: DWG_VERSIONS.has(signature),
    signature,
    version: DWG_VERSIONS.get(signature) || null,
  };
}

function expandArguments(argumentsTemplate, inputFile, outputFile) {
  if (!argumentsTemplate.includes("{input}") || !argumentsTemplate.includes("{output}")) {
    throw new Error("Converter arguments must include {input} and {output} placeholders.");
  }
  return argumentsTemplate.map((argument) =>
    argument.replaceAll("{input}", inputFile).replaceAll("{output}", outputFile));
}

export async function convertDwgToDxf(
  inputFile,
  outputFile,
  {
    command,
    argumentsTemplate,
    versionArgs = ["--version"],
    converterApproved = false,
    run = runTool,
  },
) {
  if (!converterApproved) {
    throw new Error("DWG conversion requires explicit approval of the configured local converter.");
  }
  const input = resolve(inputFile);
  const output = resolve(outputFile);
  const { bytes: sourceBytes } = await readBoundedFile(input, {
    label: "DWG input",
    maxBytes: GiB,
  });
  const header = inspectDwgHeader(sourceBytes);
  if (!header.valid) {
    throw new Error(`Input is not a recognized DWG header (${header.signature || "missing"}).`);
  }
  await mkdir(dirname(output), { recursive: true });
  const tool = await inspectTool(command, versionArgs, { run });
  if (!tool.available) {
    throw new Error(`Configured DWG converter is unavailable: ${tool.error}.`);
  }
  const args = expandArguments(argumentsTemplate, input, output);
  await run(command, args, { timeoutMs: 300000 });
  const { bytes: outputBytes } = await readBoundedFile(output, {
    label: "Converted DXF",
    maxBytes: 512 * MiB,
  });
  const dxfText = outputBytes.toString("utf8");
  if (!/\bSECTION\b/u.test(dxfText) || !/\bEOF\b/u.test(dxfText)) {
    throw new Error("DWG converter did not produce a recognizable ASCII DXF.");
  }
  const evidence = extractDxfEvidence(dxfText, {
    path: output,
    sha256: sha256(outputBytes),
  });
  return {
    schema_version: "1.0",
    route: "dwg_to_dxf",
    source: {
      path: input,
      sha256: sha256(sourceBytes),
      signature: header.signature,
      dwg_version: header.version,
    },
    converter: {
      command,
      version: tool.version,
      arguments: args.map((argument) =>
        argument === input ? "{input}" : argument === output ? "{output}" : argument),
    },
    output: {
      path: output,
      sha256: sha256(outputBytes),
      bytes: outputBytes.length,
    },
    dxf_evidence: evidence,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    converter: { type: "string", required: true },
    arg: { type: "array", required: true },
    "version-arg": { type: "array" },
    evidence: { type: "string" },
    "allow-converter": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/convert-dwg-to-dxf.mjs --input plan.dwg --output plan.dxf --converter dwg2dxf --arg {input} --arg {output} --allow-converter [--evidence conversion.json]\n");
    return;
  }
  const result = await convertDwgToDxf(options.input, options.output, {
    command: options.converter,
    argumentsTemplate: options.arg,
    versionArgs: options["version-arg"].length ? options["version-arg"] : ["--version"],
    converterApproved: options["allow-converter"],
  });
  if (options.evidence) await writeJson(options.evidence, result);
  printJson({
    outputFile: result.output.path,
    outputSha256: result.output.sha256,
    converterVersion: result.converter.version,
    drawingUnits: result.dxf_evidence.coordinate_system.drawing_units,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

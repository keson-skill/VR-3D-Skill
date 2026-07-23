#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_MODEL = "k3";
const DEFAULT_EFFORT = "high";
const DEFAULT_TIMEOUT_MS = 120000;
const ALLOWED_EFFORTS = new Set(["low", "high", "max"]);

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("KIMI_CODE_BASE_URL must not be empty.");
  }
  return normalized;
}

export function buildChatEndpoint(baseUrl = DEFAULT_BASE_URL) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export function buildRequest({
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_EFFORT,
  system,
  prompt,
}) {
  if (!ALLOWED_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      `Unsupported Kimi K3 reasoning effort: ${reasoningEffort}. Use low, high, or max.`,
    );
  }
  if (!prompt || !prompt.trim()) {
    throw new Error("A non-empty engineering prompt is required.");
  }

  const messages = [];
  if (system?.trim()) {
    messages.push({ role: "system", content: system.trim() });
  }
  messages.push({ role: "user", content: prompt.trim() });

  return {
    model,
    messages,
    reasoning_effort: reasoningEffort,
    stream: false,
  };
}

export function extractAssistantText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : "",
      )
      .join("");
    if (text.trim()) {
      return text;
    }
  }
  throw new Error("Kimi Code returned no assistant text.");
}

export function composeEngineeringPrompt({
  task,
  spatialJson = null,
  assetManifest = null,
}) {
  if (!task?.trim()) {
    throw new Error("A non-empty engineering task is required.");
  }

  const sections = [task.trim()];
  for (const [label, value] of [
    ["Approved Spatial JSON", spatialJson],
    ["Approved asset manifest", assetManifest],
  ]) {
    if (value !== null && value !== undefined) {
      sections.push(
        `${label}:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
      );
    }
  }
  return sections.join("\n\n");
}

export async function callKimiCode({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_EFFORT,
  system,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey?.trim()) {
    throw new Error("KIMI_CODE_API_KEY is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This adapter requires Node.js 18+ with global fetch support.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildChatEndpoint(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "User-Agent": "vr-3d-skill-kimi-adapter/1.0",
      },
      body: JSON.stringify(
        buildRequest({ model, reasoningEffort, system, prompt }),
      ),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { error: { message: raw || "Empty response body" } };
    }

    if (!response.ok) {
      const upstream =
        payload?.error?.message || payload?.message || response.statusText;
      const safeMessage = String(upstream || "Unknown upstream error").replaceAll(
        apiKey.trim(),
        "[REDACTED]",
      );
      throw new Error(
        `Kimi Code request failed (${response.status}): ${safeMessage}`,
      );
    }

    return {
      text: extractAssistantText(payload),
      model: payload.model || model,
      id: payload.id || null,
      usage: payload.usage || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    promptFile: null,
    systemFile: null,
    spatialJsonFile: null,
    assetManifestFile: null,
    outputFile: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--prompt-file") {
      options.promptFile = argv[++index];
    } else if (arg === "--system-file") {
      options.systemFile = argv[++index];
    } else if (arg === "--spatial-json") {
      options.spatialJsonFile = argv[++index];
    } else if (arg === "--asset-manifest") {
      options.assetManifestFile = argv[++index];
    } else if (arg === "--output") {
      options.outputFile = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/kimi-code-engineer.mjs --check
  node --env-file=.env scripts/kimi-code-engineer.mjs --prompt-file TASK.md [--spatial-json spatial.json] [--asset-manifest assets.json] [--system-file SYSTEM.md] [--output RESULT.md]

The adapter reads KIMI_CODE_API_KEY, KIMI_CODE_BASE_URL,
KIMI_CODE_ENGINEERING_MODEL, KIMI_CODE_REASONING_EFFORT, and
KIMI_CODE_TIMEOUT_MS from the environment. It never prints the API key.
`);
}

async function readPrompt(options) {
  let task;
  if (options.promptFile) {
    task = await readFile(options.promptFile, "utf8");
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    task = Buffer.concat(chunks).toString("utf8");
  } else {
    throw new Error("Pass --prompt-file or pipe a prompt through stdin.");
  }

  const attachments = {};
  for (const [label, filePath] of [
    ["Approved Spatial JSON", options.spatialJsonFile],
    ["Approved asset manifest", options.assetManifestFile],
  ]) {
    if (!filePath) {
      continue;
    }
    const raw = await readFile(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} is not valid JSON: ${filePath}`);
    }
    if (label === "Approved Spatial JSON") {
      attachments.spatialJson = parsed;
    } else {
      attachments.assetManifest = parsed;
    }
  }

  return composeEngineeringPrompt({ task, ...attachments });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const apiKey = process.env.KIMI_CODE_API_KEY || "";
  const baseUrl = process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.KIMI_CODE_ENGINEERING_MODEL || DEFAULT_MODEL;
  const reasoningEffort =
    process.env.KIMI_CODE_REASONING_EFFORT || DEFAULT_EFFORT;
  const timeoutMs = Number(
    process.env.KIMI_CODE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("KIMI_CODE_TIMEOUT_MS must be a positive number.");
  }
  if (!ALLOWED_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      "KIMI_CODE_REASONING_EFFORT must be low, high, or max.",
    );
  }

  if (options.check) {
    process.stdout.write(
      `${JSON.stringify(
        {
          endpoint: buildChatEndpoint(baseUrl),
          model,
          reasoningEffort,
          apiKeyPresent: Boolean(apiKey),
          apiKeyLooksLikeKimiCode: apiKey.startsWith("sk-kimi-"),
          timeoutMs,
        },
        null,
        2,
      )}\n`,
    );
    if (!apiKey) {
      process.exitCode = 2;
    }
    return;
  }

  const prompt = await readPrompt(options);
  const system = options.systemFile
    ? await readFile(options.systemFile, "utf8")
    : "Act as the engineering-generation specialist for a VR interior-design pipeline. Consume only the approved Spatial JSON, constraints, asset manifest, and repository context provided. Preserve stable IDs, measured geometry, locked structural elements, and circulation constraints. Return reviewable implementation artifacts and explicit validation steps.";

  const result = await callKimiCode({
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    system,
    prompt,
    timeoutMs,
  });

  if (options.outputFile) {
    await writeFile(options.outputFile, `${result.text}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        outputFile: options.outputFile,
        model: result.model,
        requestId: result.id,
        usage: result.usage,
      })}\n`,
    );
  } else {
    process.stdout.write(`${result.text}\n`);
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    const message =
      error?.name === "AbortError"
        ? "Kimi Code request timed out."
        : error?.message || String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

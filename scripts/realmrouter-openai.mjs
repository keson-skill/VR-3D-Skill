#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://realmrouter.cn";
const DEFAULT_SPATIAL_MODEL = "gpt-5.6-sol";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_IMAGE_SIZE = "1536x1024";
const DEFAULT_IMAGE_QUALITY = "medium";
const DEFAULT_TIMEOUT_MS = 120000;
const ALLOWED_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const ALLOWED_IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("REALMROUTER_BASE_URL must not be empty.");
  }
  return normalized;
}

export function normalizeApiBaseUrl(value = DEFAULT_BASE_URL) {
  const normalized = normalizeBaseUrl(value);
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function buildEndpoint(baseUrl, route) {
  const normalized = normalizeApiBaseUrl(baseUrl);
  const suffix = route.startsWith("/") ? route : `/${route}`;
  return `${normalized}${suffix}`;
}

export function buildModelEndpointCandidates(baseUrl = DEFAULT_BASE_URL) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) {
    return [`${normalized}/models`];
  }
  return [`${normalized}/v1/models`, `${normalized}/models`];
}

export function extractModelIds(payload) {
  const candidates = [
    ...(Array.isArray(payload?.data) ? payload.data : []),
    ...(Array.isArray(payload?.models) ? payload.models : []),
    ...(Array.isArray(payload?.items) ? payload.items : []),
  ];

  return [
    ...new Set(
      candidates
        .map((item) =>
          typeof item === "string"
            ? item
            : item?.id || item?.name || item?.model || "",
        )
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim()),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
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
      return text.trim();
    }
  }
  throw new Error("RealmRouter Chat Completions returned no assistant text.");
}

export function parseJsonResponse(text) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFence);
  } catch {
    throw new Error(
      "The spatial model did not return valid JSON. Preserve the raw response and retry with validator feedback.",
    );
  }
}

function safeUpstreamMessage(payload, statusText, apiKey) {
  const message =
    payload?.error?.message ||
    payload?.message ||
    statusText ||
    "Unknown upstream error";
  return String(message).replaceAll(apiKey.trim(), "[REDACTED]");
}

async function request({
  endpoint,
  apiKey,
  method = "GET",
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey?.trim()) {
    throw new Error("A RealmRouter API key is required for this route.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This adapter requires Node.js 18+ with global fetch support.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "vr-3d-skill-realmrouter-adapter/1.0",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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
      const error = new Error(
        `RealmRouter request failed (${response.status}): ${safeUpstreamMessage(
          payload,
          response.statusText,
          apiKey,
        )}`,
      );
      error.status = response.status;
      throw error;
    }

    return { payload, headers: response.headers, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverModels({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const failures = [];

  for (const endpoint of buildModelEndpointCandidates(baseUrl)) {
    try {
      const { payload } = await request({
        endpoint,
        apiKey,
        timeoutMs,
        fetchImpl,
      });
      const hasCatalogShape =
        Array.isArray(payload?.data) ||
        Array.isArray(payload?.models) ||
        Array.isArray(payload?.items);
      if (!hasCatalogShape) {
        failures.push(`${endpoint} returned no recognized model catalog.`);
        continue;
      }
      return { endpoint, modelIds: extractModelIds(payload) };
    } catch (error) {
      failures.push(error.message);
      if (error.status && error.status !== 404) {
        break;
      }
    }
  }

  throw new Error(`Model discovery failed: ${failures.join(" | ")}`);
}

export async function generateSpatialJson({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_SPATIAL_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  prompt,
  imageDataUrls = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!ALLOWED_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      "REALMROUTER_SPATIAL_REASONING_EFFORT must be none, low, medium, high, or xhigh.",
    );
  }
  if (!prompt?.trim()) {
    throw new Error("A non-empty spatial prompt is required.");
  }

  const { payload } = await request({
    endpoint: buildEndpoint(baseUrl, "/chat/completions"),
    apiKey,
    method: "POST",
    body: {
      model,
      messages: [
        {
          role: "system",
          content:
            "Act as the spatial-reasoning specialist for a VR interior-design pipeline. Return one valid JSON object only. Preserve source measurements, stable IDs, confidence, provenance, assumptions, unresolved conflicts, locked geometry, and circulation constraints. Never invent a construction dimension.",
        },
        {
          role: "user",
          content: imageDataUrls.length
            ? [
                { type: "text", text: prompt.trim() },
                ...imageDataUrls.map((url) => ({
                  type: "image_url",
                  image_url: { url },
                })),
              ]
            : prompt.trim(),
        },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: reasoningEffort,
      stream: false,
    },
    timeoutMs,
    fetchImpl,
  });

  return {
    spatialJson: parseJsonResponse(extractChatText(payload)),
    model: payload.model || model,
    requestId: payload.id || null,
    usage: payload.usage || null,
  };
}

export async function generateImage({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_IMAGE_MODEL,
  prompt,
  size = DEFAULT_IMAGE_SIZE,
  quality = DEFAULT_IMAGE_QUALITY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!prompt?.trim()) {
    throw new Error("A non-empty image prompt is required.");
  }
  if (!ALLOWED_IMAGE_QUALITIES.has(quality)) {
    throw new Error(
      "REALMROUTER_IMAGE_QUALITY must be low, medium, high, or auto.",
    );
  }

  const { payload } = await request({
    endpoint: buildEndpoint(baseUrl, "/images/generations"),
    apiKey,
    method: "POST",
    body: { model, prompt: prompt.trim(), size, quality },
    timeoutMs,
    fetchImpl,
  });

  const result = payload?.data?.[0];
  if (typeof result?.b64_json === "string" && result.b64_json) {
    return {
      bytes: Buffer.from(result.b64_json, "base64"),
      sourceUrl: null,
      model: payload.model || model,
      requestId: payload.id || null,
    };
  }
  if (typeof result?.url === "string" && result.url) {
    const response = await fetchImpl(result.url);
    if (!response.ok) {
      throw new Error(`Generated image download failed (${response.status}).`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      sourceUrl: result.url,
      model: payload.model || model,
      requestId: payload.id || null,
    };
  }
  throw new Error("RealmRouter Images returned neither b64_json nor a URL.");
}

function parseArgs(argv) {
  const options = {
    command:
      argv[0] === "--help" || argv[0] === "-h" ? "help" : argv[0] || "help",
    promptFile: null,
    inputImages: [],
    outputFile: null,
    size: null,
    quality: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt-file") {
      options.promptFile = argv[++index];
    } else if (arg === "--input-image") {
      options.inputImages.push(argv[++index]);
    } else if (arg === "--output") {
      options.outputFile = argv[++index];
    } else if (arg === "--size") {
      options.size = argv[++index];
    } else if (arg === "--quality") {
      options.quality = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  node --env-file=.env scripts/realmrouter-openai.mjs check
  node --env-file=.env scripts/realmrouter-openai.mjs models
  node --env-file=.env scripts/realmrouter-openai.mjs spatial --prompt-file TASK.md [--input-image plan.png] --output spatial.json
  node --env-file=.env scripts/realmrouter-openai.mjs image --prompt-file PROMPT.md --output preview.png [--size 1536x1024] [--quality medium]

The adapter reads REALMROUTER_SPATIAL_API_KEY, REALMROUTER_IMAGE_API_KEY,
REALMROUTER_BASE_URL,
REALMROUTER_SPATIAL_MODEL, REALMROUTER_IMAGE_MODEL,
REALMROUTER_SPATIAL_REASONING_EFFORT, REALMROUTER_IMAGE_SIZE,
REALMROUTER_IMAGE_QUALITY, and REALMROUTER_TIMEOUT_MS.
It never prints the API key.
`);
}

async function readRequiredFile(filePath, label) {
  if (!filePath) {
    throw new Error(`${label} requires --prompt-file.`);
  }
  const value = await readFile(filePath, "utf8");
  if (!value.trim()) {
    throw new Error(`${filePath} is empty.`);
  }
  return value;
}

async function readImageDataUrls(filePaths) {
  const mimeByExtension = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
  ]);
  const results = [];

  for (const filePath of filePaths) {
    const extension = filePath
      .slice(filePath.lastIndexOf("."))
      .toLowerCase();
    const mime = mimeByExtension.get(extension);
    if (!mime) {
      throw new Error(
        `Unsupported spatial input image: ${filePath}. Use PNG, JPEG, or WebP.`,
      );
    }
    const bytes = await readFile(filePath);
    results.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  const spatialApiKey = process.env.REALMROUTER_SPATIAL_API_KEY || "";
  const imageApiKey = process.env.REALMROUTER_IMAGE_API_KEY || "";
  const baseUrl = process.env.REALMROUTER_BASE_URL || DEFAULT_BASE_URL;
  const spatialModel =
    process.env.REALMROUTER_SPATIAL_MODEL || DEFAULT_SPATIAL_MODEL;
  const imageModel =
    process.env.REALMROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const reasoningEffort =
    process.env.REALMROUTER_SPATIAL_REASONING_EFFORT ||
    DEFAULT_REASONING_EFFORT;
  const imageSize =
    options.size || process.env.REALMROUTER_IMAGE_SIZE || DEFAULT_IMAGE_SIZE;
  const imageQuality =
    options.quality ||
    process.env.REALMROUTER_IMAGE_QUALITY ||
    DEFAULT_IMAGE_QUALITY;
  const timeoutMs = Number(
    process.env.REALMROUTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("REALMROUTER_TIMEOUT_MS must be a positive number.");
  }

  if (options.command === "check") {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseUrl: normalizeBaseUrl(baseUrl),
          spatialEndpoint: buildEndpoint(baseUrl, "/chat/completions"),
          imagesEndpoint: buildEndpoint(baseUrl, "/images/generations"),
          modelEndpointCandidates: buildModelEndpointCandidates(baseUrl),
          spatialModel,
          imageModel,
          reasoningEffort,
          imageSize,
          imageQuality,
          timeoutMs,
          spatialApiKeyPresent: Boolean(spatialApiKey),
          imageApiKeyPresent: Boolean(imageApiKey),
        },
        null,
        2,
      )}\n`,
    );
    if (!spatialApiKey || !imageApiKey) {
      process.exitCode = 2;
    }
    return;
  }

  if (options.command === "models") {
    const [spatialCatalog, imageCatalog] = await Promise.all([
      discoverModels({ apiKey: spatialApiKey, baseUrl, timeoutMs }),
      discoverModels({ apiKey: imageApiKey, baseUrl, timeoutMs }),
    ]);
    const available = {
      [spatialModel]: spatialCatalog.modelIds.includes(spatialModel),
      [imageModel]: imageCatalog.modelIds.includes(imageModel),
    };
    process.stdout.write(
      `${JSON.stringify(
        {
          endpoints: {
            spatial: spatialCatalog.endpoint,
            image: imageCatalog.endpoint,
          },
          available,
          discoveredModelCounts: {
            spatial: spatialCatalog.modelIds.length,
            image: imageCatalog.modelIds.length,
          },
          note:
            "Catalog presence does not prove invocation permission; the token group and balance must also allow the endpoint.",
        },
        null,
        2,
      )}\n`,
    );
    if (Object.values(available).some((value) => !value)) {
      process.exitCode = 3;
    }
    return;
  }

  if (options.command === "spatial") {
    if (!options.outputFile) {
      throw new Error("spatial requires --output.");
    }
    const prompt = await readRequiredFile(options.promptFile, "spatial");
    const imageDataUrls = await readImageDataUrls(options.inputImages);
    const result = await generateSpatialJson({
      apiKey: spatialApiKey,
      baseUrl,
      model: spatialModel,
      reasoningEffort,
      prompt,
      imageDataUrls,
      timeoutMs,
    });
    await writeFile(
      options.outputFile,
      `${JSON.stringify(result.spatialJson, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({
        outputFile: options.outputFile,
        model: result.model,
        requestId: result.requestId,
        usage: result.usage,
      })}\n`,
    );
    return;
  }

  if (options.command === "image") {
    if (!options.outputFile) {
      throw new Error("image requires --output.");
    }
    const prompt = await readRequiredFile(options.promptFile, "image");
    const result = await generateImage({
      apiKey: imageApiKey,
      baseUrl,
      model: imageModel,
      prompt,
      size: imageSize,
      quality: imageQuality,
      timeoutMs,
    });
    await writeFile(options.outputFile, result.bytes);
    process.stdout.write(
      `${JSON.stringify({
        outputFile: options.outputFile,
        model: result.model,
        requestId: result.requestId,
        bytes: result.bytes.length,
      })}\n`,
    );
    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    const message =
      error?.name === "AbortError"
        ? "RealmRouter request timed out."
        : error?.message || String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

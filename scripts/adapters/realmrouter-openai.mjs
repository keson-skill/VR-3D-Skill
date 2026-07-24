#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://realmrouter.cn";
const DEFAULT_SPATIAL_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_IMAGE_SIZE = "1536x1024";
const DEFAULT_IMAGE_QUALITY = "high";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
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

function safeNetworkMessage(error, apiKey) {
  const cause = error?.cause;
  const code = cause?.code || error?.code || null;
  const message = cause?.message || error?.message || "Unknown network error";
  const suffix = code ? ` (${code})` : "";
  return `${String(message).replaceAll(apiKey.trim(), "[REDACTED]")}${suffix}`;
}

function isRetryable(error) {
  if (!Number.isInteger(error?.status)) {
    return true;
  }
  return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function requestOnce({
  endpoint,
  apiKey,
  method = "GET",
  body,
  headers = {},
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
  let timeout;

  try {
    const fetchPromise = Promise.resolve(fetchImpl(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        ...(body && !(typeof FormData !== "undefined" && body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
        "User-Agent": "vr-3d-skill-realmrouter-adapter/1.0",
      },
      ...(body
        ? {
            body:
              typeof body === "string" ||
              (typeof FormData !== "undefined" && body instanceof FormData)
                ? body
                : JSON.stringify(body),
          }
        : {}),
      signal: controller.signal,
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error(
          `RealmRouter request exceeded ${timeoutMs} ms without a response.`,
        );
        error.code = "ETIMEDOUT";
        reject(error);
      }, timeoutMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);

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

async function request({
  endpoint,
  apiKey,
  method = "GET",
  body,
  headers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
    throw new Error("REALMROUTER_MAX_RETRIES must be an integer from 0 to 8.");
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await requestOnce({
        endpoint,
        apiKey,
        method,
        body,
        headers,
        timeoutMs,
        fetchImpl,
      });
      return { ...result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) {
        break;
      }
      await wait(retryDelayMs * 2 ** attempt);
    }
  }

  if (!Number.isInteger(lastError?.status)) {
    throw new Error(
      `RealmRouter network request failed after ${maxRetries + 1} attempts: ${safeNetworkMessage(lastError, apiKey)}.`,
    );
  }
  throw lastError;
}

export async function discoverModels({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = globalThis.fetch,
}) {
  const failures = [];

  for (const endpoint of buildModelEndpointCandidates(baseUrl)) {
    try {
      const { payload, attempts } = await request({
        endpoint,
        apiKey,
        timeoutMs,
        maxRetries,
        retryDelayMs,
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
      return { endpoint, modelIds: extractModelIds(payload), attempts };
    } catch (error) {
      failures.push(error.message);
      if (error.status && error.status !== 404) {
        break;
      }
    }
  }

  throw new Error(`Model discovery failed: ${failures.join(" | ")}`);
}

export async function assertModelAvailable({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model,
  routeLabel = "provider",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!model?.trim()) {
    throw new Error(`${routeLabel} model must not be empty.`);
  }
  const catalog = await discoverModels({
    apiKey,
    baseUrl,
    timeoutMs,
    maxRetries,
    retryDelayMs,
    fetchImpl,
  });
  if (!catalog.modelIds.includes(model)) {
    throw new Error(
      `${routeLabel} model ${model} is not available for this API key. ` +
        `Available models: ${catalog.modelIds.join(", ") || "none"}.`,
    );
  }
  return catalog;
}

export async function generateSpatialJson({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_SPATIAL_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  prompt,
  imageDataUrls = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
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

  const { payload, attempts } = await request({
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
    maxRetries,
    retryDelayMs,
    fetchImpl,
  });

  return {
    spatialJson: parseJsonResponse(extractChatText(payload)),
    model: payload.model || model,
    requestId: payload.id || null,
    usage: payload.usage || null,
    attempts,
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
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
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

  const { payload, attempts } = await request({
    endpoint: buildEndpoint(baseUrl, "/images/generations"),
    apiKey,
    method: "POST",
    body: { model, prompt: prompt.trim(), size, quality },
    timeoutMs,
    maxRetries,
    retryDelayMs,
    fetchImpl,
  });

  const result = payload?.data?.[0];
  if (typeof result?.b64_json === "string" && result.b64_json) {
    return {
      bytes: Buffer.from(result.b64_json, "base64"),
      sourceUrl: null,
      model: payload.model || model,
      requestId: payload.id || null,
      attempts,
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
      attempts,
    };
  }
  throw new Error("RealmRouter Images returned neither b64_json nor a URL.");
}

export async function editImage({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_IMAGE_MODEL,
  prompt,
  inputImage,
  maskImage = null,
  size = DEFAULT_IMAGE_SIZE,
  quality = DEFAULT_IMAGE_QUALITY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!prompt?.trim()) throw new Error("A non-empty image edit prompt is required.");
  if (!inputImage) throw new Error("Image edits require --input-image.");
  if (!ALLOWED_IMAGE_QUALITIES.has(quality)) {
    throw new Error("REALMROUTER_IMAGE_QUALITY must be low, medium, high, or auto.");
  }
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt.trim());
  form.append("size", size);
  form.append("quality", quality);
  form.append("image", new Blob([await readFile(inputImage)]), inputImage.split("/").pop());
  if (maskImage) {
    form.append("mask", new Blob([await readFile(maskImage)]), maskImage.split("/").pop());
  }
  const { payload, attempts } = await request({
    endpoint: buildEndpoint(baseUrl, "/images/edits"),
    apiKey,
    method: "POST",
    body: form,
    timeoutMs,
    maxRetries,
    retryDelayMs,
    fetchImpl,
  });
  const result = payload?.data?.[0];
  if (typeof result?.b64_json === "string" && result.b64_json) {
    return { bytes: Buffer.from(result.b64_json, "base64"), sourceUrl: null, model: payload.model || model, requestId: payload.id || null, attempts };
  }
  if (typeof result?.url === "string" && result.url) {
    const response = await fetchImpl(result.url);
    if (!response.ok) throw new Error(`Edited image download failed (${response.status}).`);
    return { bytes: Buffer.from(await response.arrayBuffer()), sourceUrl: result.url, model: payload.model || model, requestId: payload.id || null, attempts };
  }
  throw new Error("RealmRouter Images edit returned neither b64_json nor a URL.");
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
    inputImage: null,
    maskImage: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt-file") {
      options.promptFile = argv[++index];
    } else if (arg === "--input-image") {
      const value = argv[++index];
      if (options.command === "spatial") options.inputImages.push(value);
      else options.inputImage = value;
    } else if (arg === "--mask-image") {
      options.maskImage = argv[++index];
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
  node --env-file=.env scripts/adapters/realmrouter-openai.mjs check
  node --env-file=.env scripts/adapters/realmrouter-openai.mjs models
  node --env-file=.env scripts/adapters/realmrouter-openai.mjs spatial --prompt-file TASK.md [--input-image plan.png] --output spatial.json
  node --env-file=.env scripts/adapters/realmrouter-openai.mjs image --prompt-file PROMPT.md --output preview.png [--size 1536x1024] [--quality high]
  node --env-file=.env scripts/adapters/realmrouter-openai.mjs edit --prompt-file PROMPT.md --input-image reference.png --output preview.png [--mask-image mask.png]

The adapter reads REALMROUTER_SPATIAL_API_KEY, REALMROUTER_IMAGE_API_KEY,
REALMROUTER_BASE_URL,
REALMROUTER_SPATIAL_MODEL, REALMROUTER_IMAGE_MODEL,
REALMROUTER_SPATIAL_REASONING_EFFORT, REALMROUTER_IMAGE_SIZE,
REALMROUTER_IMAGE_QUALITY, and REALMROUTER_TIMEOUT_MS.
Set REALMROUTER_MAX_RETRIES (0-8, default 3) for transient network or upstream retries.
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
  const maxRetries = Number(
    process.env.REALMROUTER_MAX_RETRIES || DEFAULT_MAX_RETRIES,
  );

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("REALMROUTER_TIMEOUT_MS must be a positive number.");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
    throw new Error("REALMROUTER_MAX_RETRIES must be an integer from 0 to 8.");
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
          maxRetries,
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
      discoverModels({ apiKey: spatialApiKey, baseUrl, timeoutMs, maxRetries }),
      discoverModels({ apiKey: imageApiKey, baseUrl, timeoutMs, maxRetries }),
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
          attempts: {
            spatial: spatialCatalog.attempts,
            image: imageCatalog.attempts,
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
    await assertModelAvailable({
      apiKey: spatialApiKey,
      baseUrl,
      model: spatialModel,
      routeLabel: "spatial",
      timeoutMs,
      maxRetries,
    });
    const result = await generateSpatialJson({
      apiKey: spatialApiKey,
      baseUrl,
      model: spatialModel,
      reasoningEffort,
      prompt,
      imageDataUrls,
      timeoutMs,
      maxRetries,
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
        attempts: result.attempts,
      })}\n`,
    );
    return;
  }

  if (options.command === "image" || options.command === "edit") {
    if (!options.outputFile) {
      throw new Error(`${options.command} requires --output.`);
    }
    const prompt = await readRequiredFile(options.promptFile, "image");
    await assertModelAvailable({
      apiKey: imageApiKey,
      baseUrl,
      model: imageModel,
      routeLabel: "image",
      timeoutMs,
      maxRetries,
    });
    const result = options.command === "edit"
      ? await editImage({
          apiKey: imageApiKey,
          baseUrl,
          model: imageModel,
          prompt,
          inputImage: options.inputImage,
          maskImage: options.maskImage,
          size: imageSize,
          quality: imageQuality,
          timeoutMs,
          maxRetries,
        })
      : await generateImage({
          apiKey: imageApiKey,
          baseUrl,
          model: imageModel,
          prompt,
          size: imageSize,
          quality: imageQuality,
          timeoutMs,
          maxRetries,
        });
    await writeFile(options.outputFile, result.bytes);
    process.stdout.write(
      `${JSON.stringify({
        outputFile: options.outputFile,
        model: result.model,
        requestId: result.requestId,
        bytes: result.bytes.length,
        attempts: result.attempts,
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
    process.exit(1);
  });
}

#!/usr/bin/env node

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import {
  imageFileToDataUrl,
  readText,
  writeBytes,
  writeJson,
} from "../lib/cli.mjs";
import {
  MiB,
  readBoundedFile,
} from "../ingest/file-safety.mjs";
import { sanitizeError } from "../runtime/redaction.mjs";

const DEFAULT_BASE_URL = "https://realmrouter.cn";
const DEFAULT_SPATIAL_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_IMAGE_SIZE = "1536x1024";
const DEFAULT_IMAGE_QUALITY = "high";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 60000;
const MAX_RESPONSE_BYTES = 64 * MiB;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_INPUT_IMAGES = 20;
const ALLOWED_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const ALLOWED_IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const raw = value.trim();
  if (!raw) {
    throw new Error("REALMROUTER_BASE_URL must not be empty.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("REALMROUTER_BASE_URL must be a valid absolute URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("REALMROUTER_BASE_URL must use HTTPS, except for explicit loopback development.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("REALMROUTER_BASE_URL must not contain credentials, query parameters, or fragments.");
  }
  return parsed.toString().replace(/\/+$/, "");
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
  return sanitizeError(
    new Error(String(message).replaceAll(apiKey.trim(), "[REDACTED]")),
  ).message;
}

function safeNetworkMessage(error, apiKey) {
  const cause = error?.cause;
  const code = cause?.code || error?.code || null;
  const message = cause?.message || error?.message || "Unknown network error";
  const suffix = code ? ` (${code})` : "";
  return sanitizeError(
    new Error(`${String(message).replaceAll(apiKey.trim(), "[REDACTED]")}${suffix}`),
  ).message;
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

async function readBoundedResponseBytes(
  response,
  {
    maxBytes = MAX_RESPONSE_BYTES,
    label = "RealmRouter response",
  } = {},
) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response_size_limit");
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validatePrompt(prompt, label) {
  if (!prompt?.trim()) throw new Error(`A non-empty ${label} prompt is required.`);
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error(`${label} prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit.`);
  }
}

function validateImageOptions(size, quality) {
  if (!ALLOWED_IMAGE_QUALITIES.has(quality)) {
    throw new Error("Image quality must be low, medium, high, or auto.");
  }
  if (size === "auto") return;
  const match = /^(\d{3,4})x(\d{3,4})$/u.exec(size || "");
  if (
    !match
    || Number(match[1]) < 256
    || Number(match[1]) > 4096
    || Number(match[2]) < 256
    || Number(match[2]) > 4096
  ) {
    throw new Error("Image size must be auto or WIDTHxHEIGHT from 256 to 4096 pixels.");
  }
}

function isPrivateIpAddress(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(address) === 6) {
    // Public IPv6 unicast is 2000::/3. Reject loopback, link-local, ULA,
    // multicast, documentation and IPv4-mapped forms.
    return !/^[23][0-9a-f]{0,3}:/u.test(address);
  }
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const [first, second, third] = parts;
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && [18, 19].includes(second))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
  );
}

export function isPrivateDownloadHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".home.arpa")
  ) {
    return true;
  }
  return isPrivateIpAddress(host);
}

async function assertPublicDownloadHost(parsed, fetchImpl) {
  if (isPrivateDownloadHost(parsed.hostname)) {
    throw new Error("Generated image download URL must resolve to a public host.");
  }
  // Custom fetch implementations are test/integration seams and may not use
  // the operating-system resolver. Production global fetch gets a DNS check.
  if (fetchImpl !== globalThis.fetch || isIP(parsed.hostname.replace(/^\[|\]$/gu, ""))) {
    return;
  }
  let addresses;
  try {
    addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Generated image download host could not be resolved safely.");
  }
  if (
    addresses.length === 0
    || addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new Error("Generated image download URL must resolve only to public addresses.");
  }
}

function assertGeneratedImageBytes(bytes, label) {
  const png =
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  const jpeg =
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) {
    throw new Error(`${label} is not a PNG, JPEG, or WebP image.`);
  }
  return bytes;
}

async function downloadGeneratedImage(url, { fetchImpl, timeoutMs, label }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} returned an invalid download URL.`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || isPrivateDownloadHost(parsed.hostname)
  ) {
    throw new Error(`${label} download URL must be credential-free public HTTPS.`);
  }
  await assertPublicDownloadHost(parsed, fetchImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`${label} download failed (${response.status}).`);
    }
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: MAX_RESPONSE_BYTES,
      label: `${label} download`,
    });
    return assertGeneratedImageBytes(bytes, `${label} download`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} download exceeded ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) {
    throw new Error("RealmRouter timeout must be an integer from 1 ms to 10 minutes.");
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
      redirect: "error",
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

    const raw = (await readBoundedResponseBytes(response)).toString("utf8");
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
  if (
    !Number.isSafeInteger(retryDelayMs)
    || retryDelayMs < 0
    || retryDelayMs > 60000
  ) {
    throw new Error("RealmRouter retry delay must be an integer from 0 to 60000 ms.");
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
      await wait(Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2 ** attempt));
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
  validatePrompt(prompt, "spatial");
  if (
    !Array.isArray(imageDataUrls)
    || imageDataUrls.length > MAX_INPUT_IMAGES
    || imageDataUrls.some((url) =>
      typeof url !== "string"
      || !url.startsWith("data:image/")
      || Buffer.byteLength(url, "utf8") > MAX_RESPONSE_BYTES)
    || imageDataUrls.reduce(
      (total, url) => total + Buffer.byteLength(url, "utf8"),
      0,
    ) > 128 * MiB
  ) {
    throw new Error(`Spatial input images must be at most ${MAX_INPUT_IMAGES} bounded image data URLs.`);
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
  validatePrompt(prompt, "image");
  validateImageOptions(size, quality);

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
    if (Buffer.byteLength(result.b64_json, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Generated image base64 payload exceeds the response limit.");
    }
    const bytes = Buffer.from(result.b64_json, "base64");
    if (bytes.length < 1) throw new Error("Generated image base64 payload is empty.");
    return {
      bytes: assertGeneratedImageBytes(bytes, "Generated image base64 payload"),
      sourceUrl: null,
      model: payload.model || model,
      requestId: payload.id || null,
      attempts,
    };
  }
  if (typeof result?.url === "string" && result.url) {
    return {
      bytes: await downloadGeneratedImage(result.url, {
        fetchImpl,
        timeoutMs,
        label: "Generated image",
      }),
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
  validatePrompt(prompt, "image edit");
  if (!inputImage) throw new Error("Image edits require --input-image.");
  validateImageOptions(size, quality);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt.trim());
  form.append("size", size);
  form.append("quality", quality);
  const input = await readBoundedFile(inputImage, {
    label: "Image edit input",
    maxBytes: 64 * MiB,
  });
  form.append("image", new Blob([input.bytes]), inputImage.split(/[\\/]/u).pop());
  if (maskImage) {
    const mask = await readBoundedFile(maskImage, {
      label: "Image edit mask",
      maxBytes: 64 * MiB,
    });
    form.append("mask", new Blob([mask.bytes]), maskImage.split(/[\\/]/u).pop());
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
    if (Buffer.byteLength(result.b64_json, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Edited image base64 payload exceeds the response limit.");
    }
    const bytes = Buffer.from(result.b64_json, "base64");
    if (bytes.length < 1) throw new Error("Edited image base64 payload is empty.");
    return {
      bytes: assertGeneratedImageBytes(bytes, "Edited image base64 payload"),
      sourceUrl: null,
      model: payload.model || model,
      requestId: payload.id || null,
      attempts,
    };
  }
  if (typeof result?.url === "string" && result.url) {
    return {
      bytes: await downloadGeneratedImage(result.url, {
        fetchImpl,
        timeoutMs,
        label: "Edited image",
      }),
      sourceUrl: result.url,
      model: payload.model || model,
      requestId: payload.id || null,
      attempts,
    };
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
  return readText(filePath, `${label} prompt`, { maxBytes: MAX_PROMPT_BYTES });
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
    const dataUrl = await imageFileToDataUrl(filePath);
    if (!dataUrl.startsWith(`data:${mime};`)) {
      throw new Error(`Image MIME mismatch for ${filePath}.`);
    }
    results.push(dataUrl);
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
    await writeJson(options.outputFile, result.spatialJson);
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
    await writeBytes(options.outputFile, result.bytes);
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

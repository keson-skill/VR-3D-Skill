import { canonicalJsonSha256 } from "../lib/cli.mjs";

const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)/iu;
const CUSTOMER_KEY_PATTERN =
  /(?:address|email|phone|customer|client_name|original_name|file_name|filename|local_path|source_path|stored_path|uri)$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function scrubString(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|AKIA|ASIA)-?[A-Za-z0-9_/-]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(
      /\b(authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*[^\s,;]{4,}/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|root|workspace|tmp)\/)[^\s"'`]+/gu, "[REDACTED_PATH]")
    .slice(0, 2048);
}

export function redactValue(value, { includeCustomerData = false, depth = 0 } = {}) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value === null || typeof value === "boolean" || Number.isFinite(value)) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) =>
      redactValue(item, { includeCustomerData, depth: depth + 1 }));
  }
  if (!value || typeof value !== "object") return String(value);
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED_SECRET]";
    } else if (!includeCustomerData && CUSTOMER_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED_CUSTOMER_DATA]";
    } else {
      result[key] = redactValue(child, {
        includeCustomerData,
        depth: depth + 1,
      });
    }
  }
  return result;
}

export function sanitizeError(error) {
  const rawCode = error?.code || error?.name || "runtime_error";
  const code = String(rawCode)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .slice(0, 80) || "runtime_error";
  return {
    code,
    message: scrubString(error?.message || String(error)),
    retryable: error?.retryable === true,
  };
}

function safeId(value, field) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!SAFE_ID_PATTERN.test(text)) {
    throw new Error(`${field} contains unsafe characters or is too long.`);
  }
  return text;
}

function safeHashes(value) {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, hash]) =>
        SAFE_ID_PATTERN.test(key) && SAFE_HASH_PATTERN.test(String(hash)))
      .slice(0, 100),
  );
}

export function buildAuditEvent({
  timestamp = new Date().toISOString(),
  event,
  jobId,
  stage = null,
  state = null,
  attempt = null,
  durationMs = null,
  requestId = null,
  model = null,
  assetVersions = [],
  hashes = {},
  error = null,
  detail = null,
  previousEventSha256 = null,
}) {
  const record = {
    schema_version: "1.0",
    timestamp,
    event: safeId(event, "event"),
    job_id: safeId(jobId, "jobId"),
    stage: safeId(stage, "stage"),
    state: safeId(state, "state"),
    attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : null,
    duration_ms: Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs)
      : null,
    request_id: safeId(requestId, "requestId"),
    model: safeId(model, "model"),
    asset_versions: Array.isArray(assetVersions)
      ? assetVersions.map((item) => safeId(item, "assetVersion")).filter(Boolean).slice(0, 100)
      : [],
    hashes: safeHashes(hashes),
    error: error ? sanitizeError(error) : null,
    detail: detail ? redactValue(detail) : null,
    previous_event_sha256:
      previousEventSha256 && SAFE_HASH_PATTERN.test(previousEventSha256)
        ? previousEventSha256
        : null,
  };
  record.event_sha256 = canonicalJsonSha256(record);
  return record;
}

export function containsUnredactedSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    /-----BEGIN [^-]+ PRIVATE KEY-----/iu.test(text)
    || /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/iu.test(text)
    || /\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_/-]{12,}\b/u.test(text)
  );
}

export function containsCredentialField(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialField(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    SECRET_KEY_PATTERN.test(key)
    || containsCredentialField(child, depth + 1));
}

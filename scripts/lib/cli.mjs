import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname } from "node:path";

export function parseArgs(argv, schema) {
  const options = {};

  for (const [name, definition] of Object.entries(schema)) {
    if (definition.type === "array") {
      options[name] = [];
    } else if (definition.type === "boolean") {
      options[name] = false;
    } else if (Object.hasOwn(definition, "default")) {
      options[name] = definition.default;
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    const name = argument.slice(2);
    const definition = schema[name];
    if (!definition) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (definition.type === "boolean") {
      options[name] = true;
      continue;
    }

    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    if (definition.type === "array") {
      options[name].push(value);
    } else {
      options[name] = value;
    }
  }

  for (const [name, definition] of Object.entries(schema)) {
    if (!options.help && definition.required && !options[name]?.length) {
      throw new Error(`--${name} is required.`);
    }
  }

  return options;
}

function sameFileSnapshot(before, after) {
  return (
    !after.isSymbolicLink()
    && after.isFile()
    && after.size === before.size
    && after.dev === before.dev
    && after.ino === before.ino
    && after.mtimeMs === before.mtimeMs
    && after.ctimeMs === before.ctimeMs
  );
}

export async function readJson(
  filePath,
  label = "JSON file",
  { maxBytes = 64 * 1024 * 1024 } = {},
) {
  let raw;
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`file must be regular, non-symlink, and no larger than ${maxBytes} bytes`);
    }
    raw = await readFile(filePath, "utf8");
    const after = await lstat(filePath);
    if (
      Buffer.byteLength(raw, "utf8") !== metadata.size
      || !sameFileSnapshot(metadata, after)
    ) {
      throw new Error("file changed while it was being read");
    }
  } catch (error) {
    const wrapped = new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
    if (error.code) wrapped.code = error.code;
    throw wrapped;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${filePath}): ${error.message}`);
  }
}

export async function readText(
  filePath,
  label = "text file",
  { maxBytes = 64 * 1024 * 1024 } = {},
) {
  let value;
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`file must be regular, non-symlink, and no larger than ${maxBytes} bytes`);
    }
    value = await readFile(filePath, "utf8");
    const after = await lstat(filePath);
    if (
      Buffer.byteLength(value, "utf8") !== metadata.size
      || !sameFileSnapshot(metadata, after)
    ) {
      throw new Error("file changed while it was being read");
    }
  } catch (error) {
    const wrapped = new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
    if (error.code) wrapped.code = error.code;
    throw wrapped;
  }
  if (!value.trim()) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  return value;
}

async function ensureParentDirectory(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator > 0) {
    await mkdir(normalized.slice(0, separator), { recursive: true });
  }
}

async function atomicWrite(filePath, bytes) {
  await ensureParentDirectory(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeJson(filePath, value) {
  await atomicWrite(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

export async function writeBytes(filePath, bytes) {
  await atomicWrite(filePath, bytes);
}

export async function writeText(filePath, value) {
  await atomicWrite(filePath, Buffer.from(value, "utf8"));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalizeJsonValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot hash non-finite JSON number at ${path}.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalizeJsonValue(item, `${path}[${index}]`),
    );
  }
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new Error(`Cannot hash undefined JSON value at ${path}.${key}.`);
      }
      result[key] = canonicalizeJsonValue(value[key], `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`Cannot hash non-JSON value at ${path}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function canonicalJsonSha256(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function requireProviderApproval(options) {
  if (!options["allow-provider"]) {
    throw new Error(
      "External provider call blocked. Re-run with --allow-provider only after the user approves the provider and the exact project data being sent.",
    );
  }
}

export function sanitizeSpatialForProvider(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return document;
  }
  const clone = structuredClone(document);
  if (Array.isArray(clone.sources)) {
    clone.sources = clone.sources.map(
      ({ uri: _uri, name: _name, ...source }) => source,
    );
  }
  return clone;
}

export function sanitizeSourceManifestForProvider(manifest) {
  const clone = structuredClone(manifest);
  if (Array.isArray(clone?.sources)) {
    clone.sources = clone.sources.map(
      ({ uri: _uri, name: _name, ...source }) => source,
    );
  }
  return clone;
}

export async function imageFileToDataUrl(
  filePath,
  {
    expectedSha256 = null,
    maxBytes = 64 * 1024 * 1024,
  } = {},
) {
  const mimeTypes = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
  ]);
  const extension = extname(filePath).toLowerCase();
  const mimeType = mimeTypes.get(extension);
  if (!mimeType) {
    throw new Error(
      `Unsupported image ${filePath}. Use PNG, JPEG, or WebP.`,
    );
  }
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size < 1
    || metadata.size > maxBytes
  ) {
    throw new Error(`Image must be a regular non-symlink file from 1 byte to ${maxBytes} bytes: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (bytes.length !== metadata.size || !sameFileSnapshot(metadata, after)) {
    throw new Error(`Image changed while it was being read: ${filePath}`);
  }
  if (
    expectedSha256 !== null
    && (
      !/^[a-f0-9]{64}$/u.test(expectedSha256)
      || sha256(bytes) !== expectedSha256
    )
  ) {
    throw new Error(`Image does not match visual evidence SHA-256: ${filePath}`);
  }
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

export function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

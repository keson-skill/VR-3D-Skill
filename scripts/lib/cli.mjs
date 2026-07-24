import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function readJson(filePath, label = "JSON file") {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${filePath}): ${error.message}`);
  }
}

export async function readText(filePath, label = "text file") {
  let value;
  try {
    value = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} ${filePath}: ${error.message}`);
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

export async function writeJson(filePath, value) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeBytes(filePath, bytes) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, bytes);
}

export async function writeText(filePath, value) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, value, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

export async function imageFileToDataUrl(filePath) {
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
  const bytes = await readFile(filePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

export function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

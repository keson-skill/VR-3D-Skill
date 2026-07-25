import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
} from "node:fs/promises";

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

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

export async function inspectRegularFile(
  filePath,
  {
    label = "Input",
    maxBytes = 512 * MiB,
    allowEmpty = false,
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  if (!allowEmpty && metadata.size === 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${filePath}`);
  }
  return metadata;
}

export async function readBoundedFile(filePath, options = {}) {
  const metadata = await inspectRegularFile(filePath, options);
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (bytes.length !== metadata.size || !sameFileSnapshot(metadata, after)) {
    throw new Error(`${options.label || "Input"} changed while it was being read: ${filePath}`);
  }
  return { bytes, metadata };
}

export async function hashBoundedFile(filePath, options = {}) {
  const metadata = await inspectRegularFile(filePath, options);
  const hash = createHash("sha256");
  let bytesRead = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytesRead += chunk.length;
    if (bytesRead > metadata.size) {
      throw new Error(`${options.label || "Input"} changed while it was being hashed: ${filePath}`);
    }
    hash.update(chunk);
  }
  if (bytesRead !== metadata.size) {
    throw new Error(`${options.label || "Input"} changed while it was being hashed: ${filePath}`);
  }
  const after = await lstat(filePath);
  if (!sameFileSnapshot(metadata, after)) {
    throw new Error(`${options.label || "Input"} changed while it was being hashed: ${filePath}`);
  }
  return {
    metadata,
    sha256: hash.digest("hex"),
  };
}

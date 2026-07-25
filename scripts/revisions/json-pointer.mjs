function isObject(value) {
  return value !== null && typeof value === "object";
}

export function isJsonPointer(value, { allowRoot = true } = {}) {
  if (typeof value !== "string") return false;
  if (allowRoot && value === "") return true;
  return value.startsWith("/") && !/(^|[^~])~(?![01])/u.test(value);
}

export function decodeJsonPointer(pointer) {
  if (!isJsonPointer(pointer)) {
    throw new Error(`Invalid RFC 6901 JSON Pointer: ${pointer}.`);
  }
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function encodeJsonPointer(segments) {
  if (!Array.isArray(segments)) {
    throw new Error("JSON Pointer segments must be an array.");
  }
  if (segments.length === 0) return "";
  return `/${segments
    .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

export function isDurablePointer(
  value,
  { allowRoot = false } = {},
) {
  return (
    isJsonPointer(value, { allowRoot })
    && (allowRoot || value !== "")
    && !value.includes("*")
    && !/(^|\/)(?:\d+|-)(?=\/|$)/u.test(value)
  );
}

export function pointerContains(parent, candidate) {
  if (parent === "") return true;
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function resolvePointer(root, pointer, { allowMissingFinal = false } = {}) {
  const segments = decodeJsonPointer(pointer);
  if (segments.length === 0) {
    return {
      exists: true,
      value: root,
      parent: null,
      key: null,
      segments,
      pointer,
    };
  }

  let parent = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!isObject(parent) || !Object.hasOwn(parent, segment)) {
      throw new Error(`JSON Pointer parent does not exist: ${encodeJsonPointer(segments.slice(0, index + 1))}.`);
    }
    parent = parent[segment];
  }

  if (!isObject(parent)) {
    throw new Error(`JSON Pointer parent is not a container: ${encodeJsonPointer(segments.slice(0, -1))}.`);
  }
  const key = segments.at(-1);
  if (Array.isArray(parent) && !/^\d+$/u.test(key)) {
    throw new Error(`JSON Pointer array segment must be an index resolved internally: ${pointer}.`);
  }
  const exists = Object.hasOwn(parent, key);
  if (!exists && !allowMissingFinal) {
    throw new Error(`JSON Pointer does not exist: ${pointer}.`);
  }
  return {
    exists,
    value: exists ? parent[key] : undefined,
    parent,
    key,
    segments,
    pointer,
  };
}

export function findStableId(root, targetId) {
  const matches = [];
  const visit = (value, segments, parent, key) => {
    if (!isObject(value)) return;
    if (!Array.isArray(value) && value.id === targetId) {
      matches.push({
        value,
        parent,
        key,
        pointer: encodeJsonPointer(segments),
      });
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...segments, index], value, index));
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, [...segments, childKey], value, childKey);
    }
  };
  visit(root, [], null, null);
  if (matches.length === 0) {
    throw new Error(`Unknown stable ID ${targetId}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Stable ID ${targetId} is ambiguous (${matches.length} matches).`);
  }
  return matches[0];
}

export function durableCollectionPointer(internalPointer) {
  const segments = decodeJsonPointer(internalPointer);
  if (segments.length === 0 || !/^\d+$/u.test(String(segments.at(-1)))) {
    throw new Error(`Target ${internalPointer} is not an array member.`);
  }
  const parentSegments = segments.slice(0, -1);
  if (parentSegments.some((segment) => /^\d+$/u.test(String(segment)))) {
    throw new Error(`Nested array member ${internalPointer} has no durable collection pointer.`);
  }
  return encodeJsonPointer(parentSegments);
}

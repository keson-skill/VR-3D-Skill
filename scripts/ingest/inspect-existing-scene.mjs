#!/usr/bin/env node

import { mkdir, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  posix,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  printJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { parseGlb } from "../validation/validate-glb.mjs";
import { GiB, MiB, readBoundedFile } from "./file-safety.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

function semanticKind(name) {
  const value = String(name || "");
  if (/wall|墙/iu.test(value)) return "wall";
  if (/floor|slab|地面|楼板/iu.test(value)) return "floor";
  if (/ceiling|顶/iu.test(value)) return "ceiling";
  if (/door|门/iu.test(value)) return "door";
  if (/window|窗/iu.test(value)) return "window";
  if (/column|柱/iu.test(value)) return "column";
  if (/beam|梁/iu.test(value)) return "beam";
  if (/stair|楼梯/iu.test(value)) return "stair";
  if (/room|space|房间/iu.test(value)) return "room";
  return "unclassified";
}

function stableSceneId(name, index) {
  const normalized = String(name || `node-${index + 1}`)
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+/u, "");
  return `scene-${normalized || `node-${index + 1}`}`;
}

function combineBounds(items, unitScale = 1) {
  const valid = items.filter((item) =>
    Array.isArray(item.min)
    && Array.isArray(item.max)
    && item.min.length === 3
    && item.max.length === 3
    && [...item.min, ...item.max].every(Number.isFinite));
  if (valid.length === 0) return null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const item of valid) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], item.min[axis] * unitScale);
      maximum[axis] = Math.max(maximum[axis], item.max[axis] * unitScale);
    }
  }
  return {
    min: minimum,
    max: maximum,
    dimensions: maximum.map((value, axis) => value - minimum[axis]),
  };
}

function decodedResourceUri(uri) {
  try {
    return decodeURIComponent(uri).replaceAll("\\", "/");
  } catch {
    return null;
  }
}

function localResourceEntries(gltf) {
  const resources = [];
  for (const [kind, entries] of [["buffer", gltf.buffers || []], ["image", gltf.images || []]]) {
    entries.forEach((entry, index) => {
      if (entry.uri && !entry.uri.startsWith("data:")) {
        resources.push({ kind, index, uri: entry.uri });
      }
    });
  }
  return resources;
}

function resourceUriIssue(uri) {
  const decoded = decodedResourceUri(uri);
  if (!decoded) return "URI contains invalid percent encoding";
  const normalized = posix.normalize(decoded);
  if (
    decoded.includes("\0")
    || isAbsolute(decoded)
    || decoded.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(decoded)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    return "URI is absolute, remote, or escapes the scene directory";
  }
  return null;
}

function externalUriIssues(gltf) {
  const issues = [];
  for (const resource of localResourceEntries(gltf)) {
    if (resourceUriIssue(resource.uri)) {
      issues.push(`${resource.kind} ${resource.index} uses a non-packaged or unsafe URI: ${resource.uri}.`);
    }
  }
  return issues;
}

export function inspectGltfDocument(gltf, { unitScale = 1, container = "gltf" } = {}) {
  const blockers = [];
  const warnings = [];
  if (gltf?.asset?.version !== "2.0") blockers.push("glTF asset.version must be 2.0.");
  if (!Number.isFinite(unitScale) || unitScale <= 0) blockers.push("Unit scale must be positive.");
  blockers.push(...externalUriIssues(gltf || {}));
  const accessors = Array.isArray(gltf?.accessors) ? gltf.accessors : [];
  const positionBounds = accessors
    .filter((accessor) => accessor.type === "VEC3" && accessor.min && accessor.max)
    .map((accessor) => ({ min: accessor.min, max: accessor.max }));
  const bounds = combineBounds(positionBounds, unitScale);
  if (!bounds) blockers.push("Scene has no POSITION accessor bounds; dimensions cannot be verified.");
  const nodes = Array.isArray(gltf?.nodes) ? gltf.nodes : [];
  const semanticCandidates = nodes.map((node, index) => ({
    id: stableSceneId(node.name, index),
    source_node: index,
    name: node.name || null,
    kind: semanticKind(node.name),
    mesh: Number.isInteger(node.mesh) ? node.mesh : null,
    transform: {
      translation: node.translation || [0, 0, 0],
      rotation: node.rotation || [0, 0, 0, 1],
      scale: node.scale || [1, 1, 1],
      matrix: node.matrix || null,
    },
  }));
  if (nodes.some((node) => Array.isArray(node.matrix))) {
    warnings.push("Node matrices are preserved, but aggregate accessor bounds do not include node transforms.");
  }
  const classified = semanticCandidates.filter((candidate) => candidate.kind !== "unclassified");
  return {
    container,
    asset: gltf?.asset || null,
    coordinate_system: {
      units: "meters",
      source_unit_scale_to_meters: unitScale,
      up_axis: gltf?.asset?.extras?.up_axis || "Y",
      forward_axis: gltf?.asset?.extras?.forward_axis || "-Z",
      handedness: gltf?.asset?.extras?.handedness || "right",
    },
    counts: {
      scenes: gltf?.scenes?.length || 0,
      nodes: nodes.length,
      meshes: gltf?.meshes?.length || 0,
      materials: gltf?.materials?.length || 0,
      images: gltf?.images?.length || 0,
      animations: gltf?.animations?.length || 0,
    },
    bounds_meters: bounds,
    semantic_candidates: semanticCandidates,
    semantic_coverage: nodes.length ? classified.length / nodes.length : 0,
    blockers,
    warnings,
  };
}

function validateObjAxes(upAxis, forwardAxis, handedness) {
  const blockers = [];
  const directions = new Set(["X", "Y", "Z", "-X", "-Y", "-Z"]);
  if (!directions.has(upAxis)) blockers.push("OBJ requires an explicit up axis: X, Y, Z, -X, -Y, or -Z.");
  if (!directions.has(forwardAxis)) blockers.push("OBJ requires an explicit forward axis: X, Y, Z, -X, -Y, or -Z.");
  if (
    directions.has(upAxis)
    && directions.has(forwardAxis)
    && upAxis.replace("-", "") === forwardAxis.replace("-", "")
  ) {
    blockers.push("OBJ up and forward axes must be orthogonal.");
  }
  if (!["left", "right"].includes(handedness)) {
    blockers.push("OBJ requires handedness left or right.");
  }
  return blockers;
}

export function inspectObjText(
  text,
  {
    unitScale = null,
    upAxis = null,
    forwardAxis = null,
    handedness = null,
  } = {},
) {
  let vertexCount = 0;
  let faceCount = 0;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const groups = [];
  let omittedGroups = 0;
  let currentGroup = "default";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...tokens] = line.split(/\s+/u);
    if (keyword === "v") {
      const point = tokens.slice(0, 3).map(Number);
      if (point.length === 3 && point.every(Number.isFinite)) {
        vertexCount += 1;
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    } else if (keyword === "f") {
      faceCount += 1;
    } else if (keyword === "o" || keyword === "g") {
      currentGroup = tokens.join(" ") || `group-${groups.length + 1}`;
      if (groups.length < 10000) groups.push(currentGroup);
      else omittedGroups += 1;
    }
  }
  const blockers = [];
  if (vertexCount < 3 || faceCount < 1) blockers.push("OBJ requires vertices and at least one face.");
  if (!Number.isFinite(unitScale) || unitScale <= 0) blockers.push("OBJ has no standard unit; provide a positive unit scale to meters.");
  if (omittedGroups > 0) blockers.push("OBJ contains more than 10000 object or group declarations.");
  blockers.push(...validateObjAxes(upAxis, forwardAxis, handedness));
  const bounds = vertexCount > 0 && Number.isFinite(unitScale) && unitScale > 0
    ? combineBounds([{
        min: minimum,
        max: maximum,
      }], unitScale)
    : null;
  return {
    container: "obj",
    coordinate_system: {
      units: Number.isFinite(unitScale) ? "meters" : "unknown",
      source_unit_scale_to_meters: unitScale,
      up_axis: upAxis || "user_confirmation_required",
      forward_axis: forwardAxis || "user_confirmation_required",
      handedness: handedness || "user_confirmation_required",
    },
    counts: {
      vertices: vertexCount,
      faces: faceCount,
      groups: groups.length + omittedGroups,
    },
    bounds_meters: bounds,
    semantic_candidates: groups.map((name, index) => ({
      id: stableSceneId(name, index),
      source_group: name,
      name,
      kind: semanticKind(name),
    })),
    semantic_coverage: groups.length
      ? groups.filter((name) => semanticKind(name) !== "unclassified").length / groups.length
      : 0,
    blockers,
    warnings: [],
  };
}

function inspectFbxBytes(bytes) {
  const binary = bytes.subarray(0, 23).toString("binary").startsWith("Kaydara FBX Binary");
  const ascii = bytes.subarray(0, 80).toString("utf8").includes("FBX");
  if (!binary && !ascii) throw new Error("Input is not a recognized FBX file.");
  const text = binary ? bytes.toString("latin1") : bytes.toString("utf8");
  const names = [...text.matchAll(/(?:Model|NodeAttribute):[^,\r\n]*,\s*"[^"]*::([^"]+)"/gu)]
    .map((match) => match[1])
    .slice(0, 10000);
  return {
    container: "fbx",
    format: binary ? "binary" : "ascii",
    semantic_candidates: names.map((name, index) => ({
      id: stableSceneId(name, index),
      name,
      kind: semanticKind(name),
    })),
    blockers: ["FBX requires an explicitly approved local conversion to GLB before dimensions, axes, topology, and asset import can be validated."],
    warnings: [],
  };
}

export function buildSceneImportContract(
  inspection,
  {
    mode,
    assetId = null,
    license = null,
    pivot = null,
    collisionProxy = false,
  },
) {
  if (!["asset", "spatial_reference"].includes(mode)) {
    throw new Error("Scene import mode must be asset or spatial_reference.");
  }
  const blockers = [...inspection.blockers];
  if (mode === "asset" && (typeof assetId !== "string" || !assetId.trim())) {
    blockers.push("Asset import requires a stable asset ID.");
  }
  if (mode === "asset" && !license) blockers.push("Asset import requires an explicit distribution license.");
  if (mode === "asset" && license === "forbidden") blockers.push("Forbidden assets cannot be imported.");
  if (mode === "asset" && pivot !== "bottom_center") {
    blockers.push("Asset import requires a verified bottom_center pivot.");
  }
  if (mode === "asset" && collisionProxy !== true) {
    blockers.push("Asset import requires a verified collision proxy.");
  }
  if (
    mode === "spatial_reference"
    && !inspection.semantic_candidates.some((candidate) => ["wall", "floor", "room"].includes(candidate.kind))
  ) {
    blockers.push("Scene has no wall, floor, or room semantic candidates.");
  }
  return {
    schema_version: "1.0",
    route: "existing_3d",
    mode,
    inspection,
    asset: mode === "asset"
      ? {
          id: assetId,
          format: inspection.container,
          dimensions: inspection.bounds_meters?.dimensions || null,
          units: inspection.coordinate_system?.units || "unknown",
          pivot: pivot || "review_required",
          forward_axis: inspection.coordinate_system?.forward_axis || "review_required",
          collision_proxy: collisionProxy,
          license,
        }
      : null,
    spatial_semantics: mode === "spatial_reference"
      ? inspection.semantic_candidates
      : [],
    recommended_scope: blockers.length === 0 ? "visualization_only" : null,
    blockers,
  };
}

function expandArguments(argumentsTemplate, inputFile, outputFile) {
  if (!argumentsTemplate.includes("{input}") || !argumentsTemplate.includes("{output}")) {
    throw new Error("Converter arguments must include {input} and {output} placeholders.");
  }
  return argumentsTemplate.map((argument) =>
    argument.replaceAll("{input}", inputFile).replaceAll("{output}", outputFile));
}

export async function convertSceneToGlb(
  inputFile,
  outputFile,
  {
    command,
    argumentsTemplate,
    converterApproved = false,
    versionArgs = ["--version"],
    run = runTool,
  },
) {
  if (!converterApproved) throw new Error("Scene conversion requires explicit approval of the configured local converter.");
  const input = resolve(inputFile);
  const output = resolve(outputFile);
  const { bytes: sourceBytes } = await readBoundedFile(input, {
    label: "Scene conversion input",
    maxBytes: GiB,
  });
  if (extname(input).toLowerCase() === ".fbx") inspectFbxBytes(sourceBytes);
  const tool = await inspectTool(command, versionArgs, { run });
  if (!tool.available) throw new Error(`Configured scene converter is unavailable: ${tool.error}.`);
  await mkdir(dirname(output), { recursive: true });
  await run(command, expandArguments(argumentsTemplate, input, output), { timeoutMs: 300000 });
  const { bytes } = await readBoundedFile(output, {
    label: "Converted GLB",
    maxBytes: GiB,
  });
  const parsed = parseGlb(bytes);
  if (!parsed.valid || !parsed.gltf) {
    throw new Error(`Scene converter produced invalid GLB: ${parsed.errors[0]?.message || "unknown error"}.`);
  }
  return {
    source: {
      path: input,
      sha256: sha256(sourceBytes),
      bytes: sourceBytes.length,
      extension: extname(input).toLowerCase(),
    },
    output,
    sha256: sha256(bytes),
    bytes: bytes.length,
    converter: { command, version: tool.version },
    inspection: inspectGltfDocument(parsed.gltf, { container: "glb" }),
  };
}

export async function inspectExistingScene(
  filePath,
  {
    unitScale = null,
    upAxis = null,
    forwardAxis = null,
    handedness = null,
  } = {},
) {
  const extension = extname(filePath).toLowerCase();
  const { bytes } = await readBoundedFile(filePath, {
    label: "Existing 3D scene",
    maxBytes: extension === ".glb" ? GiB : 256 * MiB,
  });
  let inspection;
  let gltf = null;
  if (extension === ".glb") {
    const parsed = parseGlb(bytes);
    if (!parsed.gltf) throw new Error(`Invalid GLB: ${parsed.errors[0]?.message || "missing JSON chunk"}.`);
    gltf = parsed.gltf;
    inspection = inspectGltfDocument(gltf, { unitScale: 1, container: "glb" });
    inspection.blockers.unshift(...parsed.errors.map((error) => error.message));
  } else if (extension === ".gltf") {
    gltf = JSON.parse(bytes.toString("utf8"));
    inspection = inspectGltfDocument(gltf, { unitScale: 1, container: "gltf" });
  } else if (extension === ".obj") {
    inspection = inspectObjText(bytes.toString("utf8"), {
      unitScale,
      upAxis,
      forwardAxis,
      handedness,
    });
  } else if (extension === ".fbx") {
    inspection = inspectFbxBytes(bytes);
  } else {
    throw new Error(`Unsupported existing-scene extension: ${extension || "(none)"}.`);
  }
  const result = {
    source: {
      path: resolve(filePath),
      sha256: sha256(bytes),
      bytes: bytes.length,
      extension,
    },
    ...inspection,
  };
  if (gltf) {
    result.external_resources = [];
    const baseDirectory = await realpath(dirname(resolve(filePath)));
    const resources = localResourceEntries(gltf);
    if (resources.length > 1000) {
      result.blockers.push("Scene references more than 1000 external resources.");
    }
    let externalBytes = 0;
    for (const resource of resources.slice(0, 1000)) {
      if (resourceUriIssue(resource.uri)) continue;
      const decoded = decodedResourceUri(resource.uri);
      try {
        const resourcePath = await realpath(resolve(baseDirectory, decoded));
        if (!resourcePath.startsWith(`${baseDirectory}${sep}`)) {
          result.blockers.push(
            `${resource.kind} ${resource.index} resource ${resource.uri} resolves outside the scene directory.`,
          );
          continue;
        }
        const { bytes: resourceBytes } = await readBoundedFile(resourcePath, {
          label: "Scene external resource",
          maxBytes: 512 * MiB,
        });
        externalBytes += resourceBytes.length;
        if (externalBytes > 2 * GiB) {
          result.blockers.push("Scene external resources exceed the 2 GiB total limit.");
          break;
        }
        result.external_resources.push({
          ...resource,
          sha256: sha256(resourceBytes),
          bytes: resourceBytes.length,
        });
      } catch (error) {
        result.blockers.push(
          `${resource.kind} ${resource.index} resource ${resource.uri} cannot be read: ${error.message}.`,
        );
      }
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "string", required: true },
    output: { type: "string", required: true },
    mode: { type: "string", default: "spatial_reference" },
    "unit-scale": { type: "string" },
    "up-axis": { type: "string" },
    "forward-axis": { type: "string" },
    handedness: { type: "string" },
    "asset-id": { type: "string" },
    license: { type: "string" },
    pivot: { type: "string" },
    "collision-proxy": { type: "boolean" },
    converter: { type: "string" },
    "converter-arg": { type: "array" },
    "converter-version-arg": { type: "array" },
    "converted-output": { type: "string" },
    "allow-converter": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/inspect-existing-scene.mjs --input scene.glb --output scene-evidence.json --mode spatial_reference\n  node scripts/ingest/inspect-existing-scene.mjs --input chair.obj --unit-scale 0.01 --up-axis Y --forward-axis -Z --handedness right --mode asset --asset-id chair-001 --license commercial --pivot bottom_center --collision-proxy --output asset-evidence.json\n  node scripts/ingest/inspect-existing-scene.mjs --input scene.fbx --converter assimp --converter-arg export --converter-arg {input} --converter-arg {output} --converted-output scene.glb --allow-converter --output scene-evidence.json\n");
    return;
  }
  let inspection;
  let conversion = null;
  if (extname(options.input).toLowerCase() === ".fbx" && options.converter) {
    if (!options["converted-output"]) {
      throw new Error("--converted-output is required when converting FBX.");
    }
    conversion = await convertSceneToGlb(options.input, options["converted-output"], {
      command: options.converter,
      argumentsTemplate: options["converter-arg"],
      versionArgs: options["converter-version-arg"].length
        ? options["converter-version-arg"]
        : ["--version"],
      converterApproved: options["allow-converter"],
    });
    inspection = await inspectExistingScene(options["converted-output"]);
    inspection.conversion = {
      source: conversion.source,
      output: {
        path: conversion.output,
        sha256: conversion.sha256,
        bytes: conversion.bytes,
      },
      converter: conversion.converter,
    };
  } else {
    inspection = await inspectExistingScene(options.input, {
    unitScale: options["unit-scale"] ? Number(options["unit-scale"]) : null,
      upAxis: options["up-axis"]?.toUpperCase() || null,
      forwardAxis: options["forward-axis"]?.toUpperCase() || null,
      handedness: options.handedness?.toLowerCase() || null,
    });
  }
  const contract = buildSceneImportContract(inspection, {
    mode: options.mode,
    assetId: options["asset-id"],
    license: options.license,
    pivot: options.pivot,
    collisionProxy: options["collision-proxy"],
  });
  await writeJson(options.output, contract);
  printJson({
    outputFile: options.output,
    container: inspection.container,
    mode: contract.mode,
    semanticCoverage: inspection.semantic_coverage || 0,
    blockers: contract.blockers,
  });
  if (contract.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

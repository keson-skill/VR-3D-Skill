import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

export const P4_QUALITY_PROFILES = {
  draft: { maxTextureSize: 512, webpQuality: 68, lightMultiplier: 0.8 },
  standard: { maxTextureSize: 1024, webpQuality: 82, lightMultiplier: 1 },
  presentation: { maxTextureSize: 2048, webpQuality: 90, lightMultiplier: 1.15 },
};

function align4(value) {
  return (value + 3) & ~3;
}

function hexToFactor(value, fallback) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    return fallback;
  }
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
    1,
  ];
}

function colorChannels(value, fallback = "#FFFFFF") {
  const factor = hexToFactor(value, hexToFactor(fallback, [1, 1, 1, 1]));
  return factor.slice(0, 3).map((channel) => Math.round(channel * 255));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseDataUri(uri) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(uri || "");
  return match ? { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") } : null;
}

function fallbackColor(material, slot) {
  if (slot === "base_color") return colorChannels(material?.base_color, "#B0B0B0");
  if (slot === "emissive") return colorChannels(material?.emissive_color, "#000000");
  if (slot === "normal") return [128, 128, 255];
  if (slot === "metallic_roughness") return [0, 178, 178];
  return [255, 255, 255];
}

async function makeFallbackTexture(material, slot, quality) {
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: fallbackColor(material, slot) },
  })
    .webp({ quality: quality.webpQuality })
    .toBuffer();
  return { bytes, mimeType: "image/webp" };
}

async function packTexture(bytes, mimeType, quality) {
  if (mimeType === "image/ktx2") return { bytes, mimeType };
  const packed = await sharp(bytes, { failOn: "none" })
    .resize({
      width: quality.maxTextureSize,
      height: quality.maxTextureSize,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: quality.webpQuality })
    .toBuffer();
  return { bytes: packed, mimeType: "image/webp" };
}

/**
 * Resolves only data URIs and files relative to the approved Spatial JSON.
 * Network and absolute paths intentionally downgrade to a deterministic fallback,
 * so a packaged scene has no undeclared runtime asset dependency.
 */
export async function prepareTextureAssets(
  document,
  { textureDirectory = null, quality = "standard", materialIds = null } = {},
) {
  const profile = P4_QUALITY_PROFILES[quality];
  if (!profile) throw new Error(`Unknown P4 quality profile: ${quality}.`);
  const allowedMaterialIds = materialIds ? new Set(materialIds) : null;
  const assets = [];
  const report = [];
  const requestedMaterialIds = allowedMaterialIds || new Set(Object.keys(document.materials || {}));
  for (const materialId of requestedMaterialIds) {
    const resolvedMaterialId = document.material_overrides?.[materialId] || materialId;
    const material = document.materials?.[resolvedMaterialId];
    if (!material) continue;
    for (const [slot, texture] of Object.entries(material.textures || {})) {
      let packed;
      let status = "packed";
      let reason = null;
      let sourceBytes = null;
      try {
        const dataUri = parseDataUri(texture.uri);
        if (dataUri) {
          sourceBytes = dataUri.bytes;
          packed = await packTexture(sourceBytes, dataUri.mimeType, profile);
        } else if (
          textureDirectory &&
          !isAbsolute(texture.uri) &&
          !/^[a-z][a-z0-9+.-]*:/i.test(texture.uri)
        ) {
          sourceBytes = await readFile(resolve(textureDirectory, texture.uri));
          packed = await packTexture(sourceBytes, texture.mime_type, profile);
        } else {
          throw new Error("texture URI must be a data URI or a relative local file");
        }
      } catch (error) {
        status = "fallback";
        reason = error.message;
        packed = await makeFallbackTexture(material, slot, profile);
      }
      const asset = {
        material_id: materialId,
        resolved_material_id: resolvedMaterialId,
        slot,
        mime_type: packed.mimeType,
        color_space: texture.color_space,
        bytes: packed.bytes,
        status,
      };
      assets.push(asset);
      report.push({
        material_id: materialId,
        resolved_material_id: resolvedMaterialId,
        slot,
        source_uri: texture.uri,
        source_filename: basename(texture.uri.split("?")[0]) || null,
        declared_mime_type: texture.mime_type,
        packaged_mime_type: packed.mimeType,
        color_space: texture.color_space,
        scale_meters: texture.scale_meters,
        status,
        reason,
        source_sha256: sourceBytes ? sha256(sourceBytes) : null,
        packaged_sha256: sha256(packed.bytes),
        packaged_bytes: packed.bytes.length,
      });
    }
  }
  return { assets, report, profile: quality };
}

const DEFAULT_MATERIALS = {
  wall_default: { base_color: "#E9E4DC", roughness: 0.82, metalness: 0 },
  floor_default: { base_color: "#B88A5A", roughness: 0.7, metalness: 0 },
  door_default: { base_color: "#8B5E3C", roughness: 0.64, metalness: 0 },
  glass_default: {
    base_color: "#B9DCE8",
    roughness: 0.12,
    metalness: 0,
    alpha: 0.32,
  },
  furniture_proxy: { base_color: "#7693A7", roughness: 0.68, metalness: 0 },
};

function cubeGeometry() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const faces = [
    { normal: [1, 0, 0], corners: [[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5],[0.5,-0.5,0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,-0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5,0.5,-0.5],[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5,-0.5,0.5],[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5]] },
    { normal: [0, 0, 1], corners: [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]] },
    { normal: [0, 0, -1], corners: [[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5]] },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    area += points[index][0] * points[next][1] - points[next][0] * points[index][1];
  }
  return area / 2;
}

function triangleContains(point, a, b, c) {
  const sign = (p1, p2, p3) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) -
    (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function triangulate(points) {
  const order = points.map((_, index) => index);
  if (polygonArea(points) < 0) order.reverse();
  const triangles = [];
  let guard = points.length * points.length;
  while (order.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let cursor = 0; cursor < order.length; cursor += 1) {
      const previous = order[(cursor - 1 + order.length) % order.length];
      const current = order[cursor];
      const next = order[(cursor + 1) % order.length];
      const a = points[previous];
      const b = points[current];
      const c = points[next];
      const cross =
        (b[0] - a[0]) * (c[1] - b[1]) -
        (b[1] - a[1]) * (c[0] - b[0]);
      if (cross <= 1e-9) continue;
      if (
        order.some(
          (candidate) =>
            candidate !== previous &&
            candidate !== current &&
            candidate !== next &&
            triangleContains(points[candidate], a, b, c),
        )
      ) {
        continue;
      }
      triangles.push(previous, current, next);
      order.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (order.length === 3) triangles.push(...order);
  if (triangles.length !== (points.length - 2) * 3) {
    throw new Error("Could not triangulate a room floor polygon.");
  }
  return triangles;
}

function polygonGeometry(primitive) {
  const normalY = primitive.normal_y ?? 1;
  const indices = triangulate(primitive.polygon);
  // Spatial polygons use X/Z winding. In glTF's Y-up coordinates, a
  // counter-clockwise X/Z polygon faces -Y, so reverse only upward faces.
  if (normalY > 0) {
    for (let index = 0; index < indices.length; index += 3) {
      [indices[index + 1], indices[index + 2]] = [
        indices[index + 2],
        indices[index + 1],
      ];
    }
  }
  return {
    positions: primitive.polygon.flatMap(([x, z]) => [x, primitive.elevation, z]),
    normals: primitive.polygon.flatMap(() => [0, normalY, 0]),
    uvs: primitive.polygon.flatMap(([x, z]) => [x, z]),
    indices,
  };
}

function extrudedPolygonGeometry(primitive) {
  const points = primitive.footprint;
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error("Extruded polygon requires a footprint with at least three points.");
  }
  const bottom = primitive.bottom_elevation;
  const top = primitive.top_elevation;
  if (!Number.isFinite(bottom) || !Number.isFinite(top) || top <= bottom) {
    throw new Error("Extruded polygon requires finite elevations with top above bottom.");
  }
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const appendVertex = (position, normal, uv) => {
    positions.push(...position);
    normals.push(...normal);
    uvs.push(...uv);
    return positions.length / 3 - 1;
  };
  const appendTriangle = (left, middle, right) => indices.push(left, middle, right);
  const faceTriangles = triangulate(points);
  const topVertices = points.map(([x, z]) => appendVertex([x, top, z], [0, 1, 0], [x, z]));
  for (let index = 0; index < faceTriangles.length; index += 3) {
    appendTriangle(
      topVertices[faceTriangles[index]],
      topVertices[faceTriangles[index + 2]],
      topVertices[faceTriangles[index + 1]],
    );
  }
  const bottomVertices = points.map(([x, z]) => appendVertex([x, bottom, z], [0, -1, 0], [x, z]));
  for (let index = 0; index < faceTriangles.length; index += 3) {
    appendTriangle(
      bottomVertices[faceTriangles[index]],
      bottomVertices[faceTriangles[index + 1]],
      bottomVertices[faceTriangles[index + 2]],
    );
  }
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const edge = [next[0] - current[0], next[1] - current[1]];
    const length = Math.hypot(edge[0], edge[1]) || 1;
    const normal = [edge[1] / length, 0, -edge[0] / length];
    const base = positions.length / 3;
    appendVertex([current[0], bottom, current[1]], normal, [0, 0]);
    appendVertex([current[0], top, current[1]], normal, [0, top - bottom]);
    appendVertex([next[0], top, next[1]], normal, [length, top - bottom]);
    appendVertex([next[0], bottom, next[1]], normal, [length, 0]);
    appendTriangle(base, base + 1, base + 2);
    appendTriangle(base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

function minMax(values, stride) {
  const min = Array(stride).fill(Number.POSITIVE_INFINITY);
  const max = Array(stride).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < values.length; index += stride) {
    for (let component = 0; component < stride; component += 1) {
      min[component] = Math.min(min[component], values[index + component]);
      max[component] = Math.max(max[component], values[index + component]);
    }
  }
  return { min, max };
}

function quaternionY(radians) {
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

export function buildGlb(document, primitives, { textureAssets = [], quality = "standard" } = {}) {
  const qualityProfile = P4_QUALITY_PROFILES[quality];
  if (!qualityProfile) throw new Error(`Unknown P4 quality profile: ${quality}.`);
  const materialSource = {
    ...DEFAULT_MATERIALS,
    ...(document.materials || {}),
  };
  const materialIds = [...new Set(primitives.map((item) => item.material_id))];
  const textureAssetsByMaterial = new Map();
  for (const asset of textureAssets) {
    if (!textureAssetsByMaterial.has(asset.material_id)) {
      textureAssetsByMaterial.set(asset.material_id, []);
    }
    textureAssetsByMaterial.get(asset.material_id).push(asset);
  }
  const materials = materialIds.map((id) => {
    const resolvedMaterialId = document.material_overrides?.[id] || id;
    const source = materialSource[resolvedMaterialId] || DEFAULT_MATERIALS.furniture_proxy;
    const color = hexToFactor(source.base_color, [0.6, 0.6, 0.6, 1]);
    color[3] = Number.isFinite(source.alpha) ? source.alpha : 1;
    const emissive = hexToFactor(source.emissive_color, [0, 0, 0, 1]);
    const emissiveStrength = Number.isFinite(source.emissive_strength)
      ? source.emissive_strength
      : 0;
    const alphaMode = source.alpha_mode || (color[3] < 1 ? "BLEND" : "OPAQUE");
    return {
      name: id,
      pbrMetallicRoughness: {
        baseColorFactor: color,
        metallicFactor: source.metalness ?? 0,
        roughnessFactor: source.roughness ?? 0.7,
      },
      ...(emissiveStrength > 0
        ? {
            emissiveFactor: emissive.slice(0, 3).map(
              (value) => Math.min(1, value * emissiveStrength),
            ),
          }
        : {}),
      ...(alphaMode !== "OPAQUE" ? { alphaMode } : {}),
      ...(source.double_sided === true || color[3] < 1 ? { doubleSided: true } : {}),
      ...(source.textures || Number.isInteger(source.texture_budget_bytes)
        ? {
            extras: {
            texture_slots: source.textures || {},
            texture_budget_bytes: source.texture_budget_bytes || 0,
            material_binding: { source_material_id: id, resolved_material_id: resolvedMaterialId },
              texture_embedding: textureAssetsByMaterial.has(id)
                ? "p4_glb_embedded"
                : "deferred_p4_asset_pipeline",
            },
          }
        : {}),
    };
  });
  const materialIndex = new Map(materialIds.map((id, index) => [id, index]));

  const bufferParts = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];

  function appendTypedArray(typedArray, target) {
    const padding = align4(byteOffset) - byteOffset;
    if (padding) {
      bufferParts.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const buffer = Buffer.from(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
    const index = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: buffer.length,
      ...(target ? { target } : {}),
    });
    bufferParts.push(buffer);
    byteOffset += buffer.length;
    return index;
  }

  function appendBuffer(buffer, target) {
    const padding = align4(byteOffset) - byteOffset;
    if (padding) {
      bufferParts.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const index = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: buffer.length,
      ...(target ? { target } : {}),
    });
    bufferParts.push(buffer);
    byteOffset += buffer.length;
    return index;
  }

  function addGeometry(geometry, materialId, name) {
    const positionValues = new Float32Array(geometry.positions);
    const normalValues = new Float32Array(geometry.normals);
    const uvValues = new Float32Array(geometry.uvs || []);
    const indexValues = new Uint32Array(geometry.indices);
    const positionView = appendTypedArray(positionValues, 34962);
    const normalView = appendTypedArray(normalValues, 34962);
    const uvView = appendTypedArray(uvValues, 34962);
    const indexView = appendTypedArray(indexValues, 34963);
    const bounds = minMax(geometry.positions, 3);
    const positionAccessor = accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: geometry.positions.length / 3,
      type: "VEC3",
      min: bounds.min,
      max: bounds.max,
    }) - 1;
    const normalAccessor = accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: geometry.normals.length / 3,
      type: "VEC3",
    }) - 1;
    const uvAccessor = accessors.push({
      bufferView: uvView,
      componentType: 5126,
      count: geometry.uvs.length / 2,
      type: "VEC2",
    }) - 1;
    const indexAccessor = accessors.push({
      bufferView: indexView,
      componentType: 5125,
      count: geometry.indices.length,
      type: "SCALAR",
      min: [Math.min(...geometry.indices)],
      max: [Math.max(...geometry.indices)],
    }) - 1;
    return meshes.push({
      name,
      primitives: [{
        attributes: {
          POSITION: positionAccessor,
          NORMAL: normalAccessor,
          TEXCOORD_0: uvAccessor,
        },
        indices: indexAccessor,
        material: materialIndex.get(materialId),
      }],
    }) - 1;
  }

  const cubeMeshes = new Map();
  const nodes = [];
  for (const primitive of primitives) {
    let mesh;
    if (primitive.shape === "box") {
      if (!cubeMeshes.has(primitive.material_id)) {
        cubeMeshes.set(
          primitive.material_id,
          addGeometry(cubeGeometry(), primitive.material_id, `cube-${primitive.material_id}`),
        );
      }
      mesh = cubeMeshes.get(primitive.material_id);
    } else if (primitive.shape === "extruded_polygon") {
      mesh = addGeometry(
        extrudedPolygonGeometry(primitive),
        primitive.material_id,
        primitive.name,
      );
    } else {
      mesh = addGeometry(
        polygonGeometry(primitive),
        primitive.material_id,
        primitive.name,
      );
    }
    nodes.push({
      name: primitive.name,
      mesh,
      ...(primitive.translation ? { translation: primitive.translation } : {}),
      ...(primitive.rotation_y_radians
        ? { rotation: quaternionY(primitive.rotation_y_radians) }
        : {}),
      ...(primitive.scale ? { scale: primitive.scale } : {}),
      extras: {
        category: primitive.category,
        kind: primitive.kind,
        source_id: primitive.source_id,
        proxy: Boolean(primitive.proxy),
        fixed: Boolean(primitive.fixed),
      },
    });
  }

  const images = [];
  const textures = [];
  const embeddedTextureIndices = new Map();
  const materialTextureTargets = {
    base_color: ["pbrMetallicRoughness", "baseColorTexture"],
    metallic_roughness: ["pbrMetallicRoughness", "metallicRoughnessTexture"],
    normal: ["normalTexture"],
    occlusion: ["occlusionTexture"],
    emissive: ["emissiveTexture"],
  };
  for (const [materialId, assets] of textureAssetsByMaterial) {
    const material = materials[materialIndex.get(materialId)];
    if (!material) continue;
    const statuses = [];
    for (const asset of assets) {
      const target = materialTextureTargets[asset.slot];
      if (!target || !Buffer.isBuffer(asset.bytes) || asset.bytes.length === 0) continue;
      const assetKey = `${asset.resolved_material_id || asset.material_id}:${asset.slot}:${asset.mime_type}:${sha256(asset.bytes)}`;
      let textureIndex = embeddedTextureIndices.get(assetKey);
      if (textureIndex === undefined) {
        const imageIndex = images.push({
          name: `${asset.resolved_material_id || materialId}-${asset.slot}`,
          bufferView: appendBuffer(asset.bytes),
          mimeType: asset.mime_type,
        }) - 1;
        textureIndex = textures.push({ source: imageIndex, name: `${asset.resolved_material_id || materialId}-${asset.slot}` }) - 1;
        embeddedTextureIndices.set(assetKey, textureIndex);
      }
      const textureInfo = { index: textureIndex };
      if (target.length === 2) {
        material[target[0]][target[1]] = textureInfo;
      } else {
        material[target[0]] = textureInfo;
      }
      statuses.push({ slot: asset.slot, status: asset.status, mime_type: asset.mime_type });
    }
    if (statuses.length > 0) {
      material.extras = {
        ...(material.extras || {}),
        texture_embedding: "p4_glb_embedded",
        texture_asset_status: statuses,
      };
    }
  }

  const punctualLights = [];
  const lightNodes = [];
  const kindToType = {
    directional: "directional",
    natural: "directional",
    sunlight: "directional",
    point: "point",
    spot: "spot",
    area: "point",
  };
  for (const light of document.lights || []) {
    const type = kindToType[String(light.kind || "").toLowerCase()] || "point";
    const lightIndex = punctualLights.push({
      name: light.id,
      type,
      color: hexToFactor(light.color, [1, 1, 1, 1]).slice(0, 3),
      intensity: light.intensity * qualityProfile.lightMultiplier,
      ...(Number.isFinite(light.range) && light.range > 0 ? { range: light.range } : {}),
      ...(type === "spot" && light.spot ? { spot: light.spot } : {}),
      extras: { source_kind: light.kind, color_temperature_kelvin: light.color_temperature_kelvin || null },
    }) - 1;
    lightNodes.push({
      name: `light-${light.id}`,
      ...(type !== "directional" ? { translation: light.position } : {}),
      extensions: { KHR_lights_punctual: { light: lightIndex } },
      extras: { category: "lighting", source_id: light.id, kind: light.kind },
    });
  }
  nodes.push(...lightNodes);

  const binary = Buffer.concat(bufferParts);
  const gltf = {
    asset: {
      version: "2.0",
      generator: "vr-3d-skill deterministic GLB writer",
      extras: {
        units: document.project?.units || "meters",
        up_axis: document.project?.up_axis || "Y",
        forward_axis: document.project?.forward_axis || "-Z",
        handedness: document.project?.handedness || "right",
      },
    },
    scene: 0,
    scenes: [{ name: "Interior", nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
    ...(images.length > 0 ? { images, textures } : {}),
    ...(punctualLights.length > 0
      ? {
          extensionsUsed: ["KHR_lights_punctual"],
          extensions: { KHR_lights_punctual: { lights: punctualLights } },
        }
      : {}),
  };
  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const paddedJson = Buffer.alloc(align4(json.length), 0x20);
  json.copy(paddedJson);
  const paddedBinary = Buffer.alloc(align4(binary.length));
  binary.copy(paddedBinary);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([
    header,
    jsonHeader,
    paddedJson,
    binaryHeader,
    paddedBinary,
  ]);
}

export async function writeGlb(
  filePath,
  document,
  primitives,
  { textureDirectory = null, quality = "standard" } = {},
) {
  const materialIds = [...new Set(primitives.map((item) => item.material_id))];
  const textures = await prepareTextureAssets(document, {
    textureDirectory,
    quality,
    materialIds,
  });
  const glb = buildGlb(document, primitives, { textureAssets: textures.assets, quality });
  await writeFile(filePath, glb);
  return { bytes: glb.length, textureReport: textures.report, quality: textures.profile };
}

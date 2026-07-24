import { writeFile } from "node:fs/promises";

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
  if (normalY < 0) {
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

export function buildGlb(document, primitives) {
  const materialSource = {
    ...DEFAULT_MATERIALS,
    ...(document.materials || {}),
  };
  const materialIds = [...new Set(primitives.map((item) => item.material_id))];
  const materials = materialIds.map((id) => {
    const source = materialSource[id] || DEFAULT_MATERIALS.furniture_proxy;
    const color = hexToFactor(source.base_color, [0.6, 0.6, 0.6, 1]);
    color[3] = Number.isFinite(source.alpha) ? source.alpha : 1;
    return {
      name: id,
      pbrMetallicRoughness: {
        baseColorFactor: color,
        metallicFactor: source.metalness ?? 0,
        roughnessFactor: source.roughness ?? 0.7,
      },
      ...(color[3] < 1 ? { alphaMode: "BLEND", doubleSided: true } : {}),
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

export async function writeGlb(filePath, document, primitives) {
  await writeFile(filePath, buildGlb(document, primitives));
}

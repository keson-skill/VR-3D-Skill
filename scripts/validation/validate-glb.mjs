const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function finiteArray(value, expectedLength) {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.every(Number.isFinite)
  );
}

function componentCount(type) {
  return {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  }[type] || 0;
}

export function parseGlb(bytes) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (!Buffer.isBuffer(bytes)) {
    add("glb.bytes", "GLB input must be a Buffer.");
    return { valid: false, errors, gltf: null, binaryLength: 0 };
  }
  if (bytes.length < 20) {
    add("glb.length", "GLB is shorter than its required header and JSON chunk.");
    return { valid: false, errors, gltf: null, binaryLength: 0 };
  }
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) add("glb.magic", "GLB magic is invalid.");
  if (bytes.readUInt32LE(4) !== GLB_VERSION) add("glb.version", "GLB must use version 2.");
  if (bytes.readUInt32LE(8) !== bytes.length) {
    add("glb.total_length", "GLB header length does not match the file length.");
  }

  let offset = 12;
  const chunks = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > bytes.length) {
      add("glb.chunk_bounds", "GLB chunk extends beyond the file length.");
      break;
    }
    chunks.push({ type, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (offset !== bytes.length) add("glb.trailing", "GLB has an incomplete trailing chunk.");
  if (chunks[0]?.type !== JSON_CHUNK) add("glb.json_chunk", "First GLB chunk must be JSON.");
  if (chunks.length < 2 || chunks[1]?.type !== BIN_CHUNK) {
    add("glb.binary_chunk", "GLB must contain a binary chunk after JSON.");
  }

  let gltf = null;
  if (chunks[0]?.type === JSON_CHUNK) {
    try {
      gltf = JSON.parse(chunks[0].bytes.toString("utf8").trim());
    } catch (error) {
      add("glb.json_parse", `GLB JSON chunk is invalid: ${error.message}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    gltf,
    binaryLength: chunks.find((chunk) => chunk.type === BIN_CHUNK)?.bytes.length || 0,
  };
}

export function validateGlbBytes(bytes, { expectedProject = null } = {}) {
  const parsed = parseGlb(bytes);
  const errors = [...parsed.errors];
  const add = (code, path, message) => errors.push({ code, path, message });
  const gltf = parsed.gltf;
  if (!gltf || typeof gltf !== "object") {
    return { valid: false, errors, summary: { nodes: 0, meshes: 0, triangles: 0 } };
  }
  if (gltf.asset?.version !== "2.0") {
    add("gltf.asset_version", "/asset/version", "glTF asset version must be 2.0.");
  }
  const expectedCoordinates = expectedProject || {};
  for (const key of ["units", "up_axis", "forward_axis", "handedness"]) {
    if (
      expectedCoordinates[key] !== undefined &&
      gltf.asset?.extras?.[key] !== expectedCoordinates[key]
    ) {
      add(
        "gltf.coordinate_system",
        `/asset/extras/${key}`,
        `GLB ${key} must match the approved Spatial JSON.`,
      );
    }
  }

  const buffers = Array.isArray(gltf.buffers) ? gltf.buffers : [];
  if (buffers.length !== 1 || !Number.isInteger(buffers[0]?.byteLength)) {
    add("gltf.buffers", "/buffers", "GLB must declare exactly one binary buffer.");
  } else if (buffers[0].byteLength > parsed.binaryLength) {
    add("gltf.buffer_length", "/buffers/0/byteLength", "Declared binary buffer exceeds GLB binary chunk.");
  }
  const bufferViews = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : [];
  bufferViews.forEach((view, index) => {
    const offset = view.byteOffset || 0;
    if (
      view.buffer !== 0 ||
      !Number.isInteger(offset) ||
      !Number.isInteger(view.byteLength) ||
      offset < 0 ||
      view.byteLength <= 0 ||
      offset + view.byteLength > parsed.binaryLength
    ) {
      add("gltf.buffer_view", `/bufferViews/${index}`, "Buffer view is outside the GLB binary chunk.");
    }
  });
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  accessors.forEach((accessor, index) => {
    if (
      !Number.isInteger(accessor.bufferView) ||
      !bufferViews[accessor.bufferView] ||
      !Number.isInteger(accessor.componentType) ||
      !Number.isInteger(accessor.count) ||
      accessor.count <= 0 ||
      componentCount(accessor.type) === 0
    ) {
      add("gltf.accessor", `/accessors/${index}`, "Accessor has an invalid view, component type, count, or shape.");
    }
    if (
      accessor.min !== undefined &&
      (!finiteArray(accessor.min, componentCount(accessor.type)) ||
        !finiteArray(accessor.max, componentCount(accessor.type)) ||
        accessor.min.some((value, axis) => value > accessor.max[axis]))
    ) {
      add("gltf.accessor_bounds", `/accessors/${index}`, "Accessor bounds must be finite and ordered.");
    }
  });

  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const images = Array.isArray(gltf.images) ? gltf.images : [];
  const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
  images.forEach((image, index) => {
    if (
      !Number.isInteger(image.bufferView) ||
      !bufferViews[image.bufferView] ||
      !["image/png", "image/jpeg", "image/webp", "image/ktx2"].includes(image.mimeType)
    ) {
      add("gltf.image", `/images/${index}`, "Embedded image requires a valid buffer view and supported MIME type.");
    }
  });
  textures.forEach((texture, index) => {
    if (!Number.isInteger(texture.source) || !images[texture.source]) {
      add("gltf.texture", `/textures/${index}`, "Texture must reference a valid embedded image.");
    }
  });
  const validateTextureInfo = (info, path) => {
    if (info !== undefined && (!Number.isInteger(info?.index) || !textures[info.index])) {
      add("gltf.material_texture", path, "Material texture reference is invalid.");
    }
  };
  materials.forEach((material, index) => {
    validateTextureInfo(material?.pbrMetallicRoughness?.baseColorTexture, `/materials/${index}/pbrMetallicRoughness/baseColorTexture`);
    validateTextureInfo(material?.pbrMetallicRoughness?.metallicRoughnessTexture, `/materials/${index}/pbrMetallicRoughness/metallicRoughnessTexture`);
    validateTextureInfo(material?.normalTexture, `/materials/${index}/normalTexture`);
    validateTextureInfo(material?.occlusionTexture, `/materials/${index}/occlusionTexture`);
    validateTextureInfo(material?.emissiveTexture, `/materials/${index}/emissiveTexture`);
  });
  let triangles = 0;
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  meshes.forEach((mesh, meshIndex) => {
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
      add("gltf.mesh_primitives", `/meshes/${meshIndex}`, "Mesh must contain at least one primitive.");
      return;
    }
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const path = `/meshes/${meshIndex}/primitives/${primitiveIndex}`;
      const attributes = primitive.attributes || {};
      for (const [semantic, type] of [["POSITION", "VEC3"], ["NORMAL", "VEC3"], ["TEXCOORD_0", "VEC2"]]) {
        const accessor = accessors[attributes[semantic]];
        if (!accessor || accessor.type !== type || accessor.componentType !== 5126) {
          add("gltf.attribute", `${path}/attributes/${semantic}`, `${semantic} must reference a float ${type} accessor.`);
        }
      }
      const position = accessors[attributes.POSITION];
      const normal = accessors[attributes.NORMAL];
      const uv = accessors[attributes.TEXCOORD_0];
      if (position && normal && position.count !== normal.count) {
        add("gltf.attribute_count", path, "POSITION and NORMAL accessor counts must match.");
      }
      if (position && uv && position.count !== uv.count) {
        add("gltf.uv_count", path, "POSITION and TEXCOORD_0 accessor counts must match.");
      }
      const indices = accessors[primitive.indices];
      if (!indices || indices.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.componentType)) {
        add("gltf.indices", `${path}/indices`, "Primitive indices must reference an unsigned scalar accessor.");
      } else {
        if (indices.count % 3 !== 0) add("gltf.triangle_count", `${path}/indices`, "Triangle index count must be divisible by three.");
        triangles += Math.floor(indices.count / 3);
      }
      if (primitive.material !== undefined && !materials[primitive.material]) {
        add("gltf.material", `${path}/material`, "Primitive material index is invalid.");
      }
    });
  });
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const punctualLights = gltf.extensions?.KHR_lights_punctual?.lights || [];
  nodes.forEach((node, index) => {
    const punctualLight = node.extensions?.KHR_lights_punctual?.light;
    const hasLight = Number.isInteger(punctualLight) && punctualLights[punctualLight];
    if (!hasLight && (!Number.isInteger(node.mesh) || !meshes[node.mesh])) {
      add("gltf.node_mesh", `/nodes/${index}/mesh`, "Node must reference a valid mesh.");
    }
    if (node.extensions?.KHR_lights_punctual && !hasLight) {
      add("gltf.node_light", `/nodes/${index}/extensions/KHR_lights_punctual/light`, "Light node must reference a valid punctual light.");
    }
    for (const key of ["translation", "scale"]) {
      if (node[key] !== undefined && !finiteArray(node[key], 3)) {
        add("gltf.node_transform", `/nodes/${index}/${key}`, `${key} must contain three finite numbers.`);
      }
    }
    if (node.scale?.some((value) => value <= 0)) {
      add("gltf.node_scale", `/nodes/${index}/scale`, "Node scale values must be positive.");
    }
    if (node.rotation !== undefined && !finiteArray(node.rotation, 4)) {
      add("gltf.node_rotation", `/nodes/${index}/rotation`, "Rotation must contain four finite quaternion values.");
    }
  });
  punctualLights.forEach((light, index) => {
    if (!(["directional", "point", "spot"].includes(light?.type)) || !finiteArray(light?.color, 3) || !Number.isFinite(light?.intensity) || light.intensity < 0) {
      add("gltf.punctual_light", `/extensions/KHR_lights_punctual/lights/${index}`, "Punctual light has an invalid type, color, or intensity.");
    }
  });
  return {
    valid: errors.length === 0,
    errors,
    summary: { nodes: nodes.length, meshes: meshes.length, triangles, images: images.length, lights: punctualLights.length },
  };
}

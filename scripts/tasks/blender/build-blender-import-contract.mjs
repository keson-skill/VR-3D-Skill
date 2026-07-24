import { parseGlb } from "../../validation/validate-glb.mjs";

/**
 * P4 interchange contract only. It describes the standard glTF content that a
 * Blender glTF importer must preserve; it does not invoke Blender or create a
 * rendered panorama (both are P7 work).
 */
export function buildBlenderImportContract(document, glb) {
  const parsed = parseGlb(glb);
  if (!parsed.valid || !parsed.gltf) {
    throw new Error(`Cannot build Blender import contract: ${parsed.errors.map((error) => error.code).join(", ")}`);
  }
  const gltf = parsed.gltf;
  return {
    schema_version: "1.0",
    stage: "P4",
    target: "Blender glTF 2.0 importer",
    coordinate_system: {
      units: gltf.asset.extras?.units,
      up_axis: gltf.asset.extras?.up_axis,
      forward_axis: gltf.asset.extras?.forward_axis,
      handedness: gltf.asset.extras?.handedness,
    },
    materials: (gltf.materials || []).map((material) => ({
      source_material_id: material.extras?.material_binding?.source_material_id || material.name,
      resolved_material_id: material.extras?.material_binding?.resolved_material_id || material.name,
      pbr: Boolean(material.pbrMetallicRoughness),
      embedded_texture_slots: Object.entries({
        base_color: material.pbrMetallicRoughness?.baseColorTexture,
        metallic_roughness: material.pbrMetallicRoughness?.metallicRoughnessTexture,
        normal: material.normalTexture,
        occlusion: material.occlusionTexture,
        emissive: material.emissiveTexture,
      })
        .filter(([, texture]) => Number.isInteger(texture?.index))
        .map(([slot]) => slot),
    })),
    nodes: (gltf.nodes || [])
      .filter((node) => node.extras?.source_id)
      .map((node) => ({ source_id: node.extras.source_id, category: node.extras.category, kind: node.extras.kind })),
    lights: (gltf.extensions?.KHR_lights_punctual?.lights || []).map((light) => ({
      id: light.name,
      type: light.type,
      intensity: light.intensity,
    })),
    invariants: [
      "Preserve meter units, Y-up axis, forward axis, and right-handedness.",
      "Import embedded PBR images without resolving external texture paths.",
      "Preserve node extras.source_id and material source/resolved IDs for traceability.",
      "Treat KHR_lights_punctual as basic-light interchange; final Blender rendering remains P7.",
    ],
    spatial_project_id: document.project?.id || null,
  };
}

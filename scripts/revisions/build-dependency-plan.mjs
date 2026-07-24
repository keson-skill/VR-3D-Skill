const RULES = {
  project: {
    validations: ["spatial_schema", "stable_ids", "approval_binding"],
    artifacts: ["spatial_validation", "design_proposal", "asset_manifest", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  sources: {
    validations: ["source_traceability", "spatial_schema", "spatial_geometry", "approval_binding"],
    artifacts: ["spatial_validation", "design_proposal", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  requirements: {
    validations: ["design_requirements", "layout", "budget"],
    artifacts: ["design_proposal", "asset_manifest", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  extraction: {
    validations: ["source_traceability", "scale", "spatial_geometry", "approval_binding"],
    artifacts: ["spatial_validation", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  envelope: {
    validations: ["spatial_schema", "spatial_geometry", "openings", "layout", "circulation", "xr_navigation"],
    artifacts: ["spatial_validation", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  rooms: {
    validations: ["spatial_schema", "room_topology", "layout", "circulation", "xr_navigation"],
    artifacts: ["spatial_validation", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  circulation: {
    validations: ["circulation", "door_clearance", "layout", "xr_navigation"],
    artifacts: ["spatial_validation", "design_proposal", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  design_objects: {
    validations: ["stable_ids", "asset_bindings", "layout", "collision", "circulation"],
    artifacts: ["design_proposal", "asset_manifest", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  assets: {
    validations: ["stable_ids", "asset_metadata", "asset_bindings", "license"],
    artifacts: ["asset_manifest", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  surfaces: {
    validations: ["stable_ids", "material_bindings", "pbr"],
    artifacts: ["scene_glb", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  hard_finishes: {
    validations: ["stable_ids", "material_bindings", "pbr", "collision"],
    artifacts: ["scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  materials: {
    validations: ["material_bindings", "pbr", "texture_budget"],
    artifacts: ["scene_glb", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  material_overrides: {
    validations: ["material_bindings", "pbr"],
    artifacts: ["scene_glb", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  lights: {
    validations: ["lighting", "performance"],
    artifacts: ["scene_glb", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
  xr: {
    validations: ["xr_navigation", "xr_lifecycle", "accessibility"],
    artifacts: ["runtime_contract", "web_viewer"],
  },
  render_profiles: {
    validations: ["performance", "render_configuration"],
    artifacts: ["web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
  },
};

const FALLBACK = {
  validations: ["spatial_schema", "stable_ids"],
  artifacts: ["spatial_validation", "scene_glb", "runtime_contract", "web_viewer", "blender_plan", "stills", "panorama", "walkthrough"],
};

function rootFromPointer(pointer) {
  return pointer.split("/").filter(Boolean)[0] || "project";
}

export function buildDependencyPlan(changedPointers, requestedValidations = []) {
  const roots = [...new Set(changedPointers.map(rootFromPointer))].sort();
  const validations = new Set(requestedValidations);
  const artifacts = new Set();
  for (const root of roots) {
    const rule = RULES[root] || FALLBACK;
    rule.validations.forEach((item) => validations.add(item));
    rule.artifacts.forEach((item) => artifacts.add(item));
  }
  return {
    schema_version: "1.0",
    changed_roots: roots,
    revalidate: [...validations].sort(),
    regenerate: [...artifacts],
    approvals_invalidated: ["spatial_approval", "design_approval"],
    approval_required_for: [...artifacts].filter(
      (artifact) => artifact !== "spatial_validation",
    ),
  };
}

export const REVISION_DEPENDENCY_RULES = Object.freeze(structuredClone(RULES));

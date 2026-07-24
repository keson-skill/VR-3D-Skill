import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validates provider-neutral P5 alternatives before any one is applied. */
export function evaluateDesignProposal(baseSpatial, proposal) {
  const errors = [];
  const warnings = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!isObject(proposal)) {
    return { valid: false, errors: [{ code: "design.type", path: "", message: "Design proposal must be an object." }], warnings, alternatives: [] };
  }
  if (proposal.base_revision !== baseSpatial.project?.revision) {
    add("design.base_revision", "/base_revision", "Proposal must target the current approved Spatial revision.");
  }
  const alternatives = Array.isArray(proposal.design_alternatives) ? proposal.design_alternatives : [];
  if (alternatives.length < 2) add("design.alternatives", "/design_alternatives", "P5 requires at least two comparable alternatives.");
  const assetIds = new Set((baseSpatial.assets || []).map((asset) => asset.id));
  const results = alternatives.map((alternative, index) => {
    const path = `/design_alternatives/${index}`;
    const candidate = structuredClone(baseSpatial);
    if (!isObject(alternative) || typeof alternative.id !== "string" || !alternative.id) {
      add("design.alternative_id", `${path}/id`, "Alternative requires a stable ID.");
    }
    if (!Array.isArray(alternative.design_objects) || alternative.design_objects.length === 0) {
      add("design.objects", `${path}/design_objects`, "Alternative must contain placed design objects.");
    } else {
      candidate.design_objects = alternative.design_objects;
    }
    if (!isObject(alternative.explanation) || typeof alternative.explanation.zoning !== "string") {
      add("design.explanation", `${path}/explanation`, "Alternative requires explainable zoning and trade-offs.");
    }
    const realAssets = [];
    const proxyAssets = [];
    for (const object of alternative.design_objects || []) {
      if (!object.asset_id) proxyAssets.push(object.id || "(unnamed)");
      else if (!assetIds.has(object.asset_id)) add("design.asset", `${path}/design_objects`, `Unknown asset ${object.asset_id}.`);
      else {
        const asset = baseSpatial.assets.find((item) => item.id === object.asset_id);
        (asset.source === "proxy" ? proxyAssets : realAssets).push(object.id);
      }
    }
    const validation = validateSpatialJson(candidate);
    for (const error of validation.errors) add("design.layout", path, `${alternative.id || index}: ${error.code} ${error.message}`);
    if (proxyAssets.length) warnings.push({ code: "design.proxy_assets", path, message: `Alternative uses proxies: ${proxyAssets.join(", ")}.` });
    return { id: alternative.id || null, valid: validation.valid, real_assets: realAssets, proxy_assets: proxyAssets, score: alternative.score || null };
  });
  if (!alternatives.some((alternative) => alternative.id === proposal.recommended_alternative_id)) {
    add("design.recommendation", "/recommended_alternative_id", "recommended_alternative_id must select a declared alternative.");
  }
  return { valid: errors.length === 0, errors, warnings, alternatives: results };
}

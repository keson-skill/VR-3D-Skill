import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";
import { designObjectFootprint, pointInPolygon } from "../../geometry/spatial-geometry.mjs";
import { validateDesignBrief } from "./validate-design-brief.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + dx * ratio), point[1] - (start[1] + dz * ratio));
}

function validateClearances(document, path, add) {
  const objects = document.design_objects || [];
  for (const object of objects) {
    const footprint = designObjectFootprint(object);
    for (const route of document.circulation?.paths || []) {
      for (let index = 1; index < route.polyline.length; index += 1) {
        const start = route.polyline[index - 1];
        const end = route.polyline[index];
        const blocked =
          footprint.some((point) => distanceToSegment(point, start, end) < route.minimum_width / 2 - 1e-6) ||
          pointInPolygon(start, footprint) ||
          pointInPolygon(end, footprint);
        if (blocked) add("design.circulation_blocked", path, `${object.id} blocks circulation path ${route.id}.`);
      }
    }
    for (const opening of document.envelope?.openings || []) {
      if (!["hinged_door", "sliding_door", "open_passage"].includes(opening.kind)) continue;
      const wall = document.envelope.walls.find((item) => item.id === opening.host_wall_id);
      if (!wall) continue;
      const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
      const ratio = (opening.offset + opening.width / 2) / length;
      const center = [
        wall.start[0] + (wall.end[0] - wall.start[0]) * ratio,
        wall.start[1] + (wall.end[1] - wall.start[1]) * ratio,
      ];
      if (pointInPolygon(center, footprint) || footprint.some((point) => Math.hypot(point[0] - center[0], point[1] - center[1]) < opening.width * 0.75)) {
        add("design.opening_clearance", path, `${object.id} occupies the clearance zone of ${opening.id}.`);
      }
    }
  }
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
  const briefValidation = validateDesignBrief(proposal.design_brief, baseSpatial);
  errors.push(...briefValidation.errors);
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
    if (
      !isObject(alternative.explanation) ||
      typeof alternative.explanation.zoning !== "string" ||
      typeof alternative.explanation.tradeoff !== "string"
    ) {
      add("design.explanation", `${path}/explanation`, "Alternative requires explainable zoning and trade-offs.");
    }
    if (
      !isObject(alternative.score) ||
      !["circulation", "budget", "function"].every(
        (key) => Number.isFinite(alternative.score[key]) && alternative.score[key] >= 0 && alternative.score[key] <= 1,
      )
    ) {
      add("design.score", `${path}/score`, "Alternative requires circulation, budget, and function scores from 0 to 1.");
    }
    if (!isObject(alternative.cost) || !Number.isFinite(alternative.cost.estimated_total) || typeof alternative.risk_notes !== "string") {
      add("design.cost_risk", path, "Alternative requires an estimated cost and risk notes.");
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
    validateClearances(candidate, path, add);
    if (proxyAssets.length) warnings.push({ code: "design.proxy_assets", path, message: `Alternative uses proxies: ${proxyAssets.join(", ")}.` });
    const objectIds = new Set((alternative.design_objects || []).map((object) => object.id));
    for (const keptId of proposal.design_brief?.must_keep_ids || []) {
      if ((baseSpatial.design_objects || []).some((object) => object.id === keptId) && !objectIds.has(keptId)) {
        add("design.must_keep", `${path}/design_objects`, `Alternative removed required object ${keptId}.`);
      }
    }
    return { id: alternative.id || null, valid: validation.valid, real_assets: realAssets, proxy_assets: proxyAssets, score: alternative.score || null };
  });
  if (!alternatives.some((alternative) => alternative.id === proposal.recommended_alternative_id)) {
    add("design.recommendation", "/recommended_alternative_id", "recommended_alternative_id must select a declared alternative.");
  }
  return { valid: errors.length === 0, errors, warnings, brief: briefValidation.summary, alternatives: results };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateDesignBrief(brief, spatialJson) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!isObject(brief)) {
    return { valid: false, errors: [{ code: "brief.type", path: "", message: "Design brief must be an object." }] };
  }
  if (!isObject(brief.budget) || !Number.isFinite(brief.budget.amount) || brief.budget.amount <= 0 || typeof brief.budget.currency !== "string") {
    add("brief.budget", "/budget", "Budget requires a positive amount and currency.");
  }
  if (!Array.isArray(brief.occupants) || brief.occupants.length === 0) {
    add("brief.occupants", "/occupants", "At least one occupant profile is required.");
  } else {
    brief.occupants.forEach((occupant, index) => {
      if (!Number.isInteger(occupant.count) || occupant.count <= 0 || typeof occupant.role !== "string") {
        add("brief.occupant", `/occupants/${index}`, "Occupant requires a role and positive integer count.");
      }
    });
  }
  if (!Array.isArray(brief.activities) || brief.activities.length === 0) {
    add("brief.activities", "/activities", "At least one intended activity is required.");
  }
  const stableIds = new Set([
    ...(spatialJson.rooms || []).map((item) => item.id),
    ...(spatialJson.design_objects || []).map((item) => item.id),
    ...(spatialJson.assets || []).map((item) => item.id),
  ]);
  for (const id of brief.must_keep_ids || []) {
    if (!stableIds.has(id)) add("brief.keep_id", "/must_keep_ids", `Unknown preserved ID ${id}.`);
  }
  if (!Number.isFinite(brief.minimum_clearance_meters) || brief.minimum_clearance_meters <= 0) {
    add("brief.clearance", "/minimum_clearance_meters", "Minimum clearance must be positive meters.");
  }
  return {
    valid: errors.length === 0,
    errors,
    summary: {
      occupant_count: (brief.occupants || []).reduce((sum, item) => sum + (Number.isInteger(item.count) ? item.count : 0), 0),
      activities: Array.isArray(brief.activities) ? brief.activities.length : 0,
      preserved_items: Array.isArray(brief.must_keep_ids) ? brief.must_keep_ids.length : 0,
    },
  };
}

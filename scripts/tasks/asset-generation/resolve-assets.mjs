/** Resolve P5 objects against an approved local/catalog asset list, never a network source. */
export function resolveAssets(designObjects, catalog, { dimensionTolerance = 0.12 } = {}) {
  const assets = Array.isArray(catalog?.assets) ? catalog.assets : [];
  const resolved = [];
  const errors = [];
  const warnings = [];
  const sourcePriority = new Map([
    ["customer", 0],
    ["licensed_catalog", 1],
    ["generated", 2],
  ]);
  for (const object of designObjects || []) {
    if (!Array.isArray(object.dimensions) || object.dimensions.length !== 3 || object.dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
      errors.push({ code: "asset.object_dimensions", path: `/design_objects/${object.id}`, message: "Object dimensions must be three positive meter values." });
      continue;
    }
    const candidates = assets
      .filter((asset) =>
        asset.kind === object.kind &&
        sourcePriority.has(asset.source) &&
        typeof asset.uri === "string" &&
        asset.format === "glb" &&
        asset.license &&
        asset.license !== "forbidden" &&
        asset.units === "meters" &&
        asset.pivot === "bottom_center" &&
        asset.forward_axis === "-Z" &&
        asset.optimized === true &&
        asset.collision_proxy === true &&
        Array.isArray(asset.dimensions) &&
        asset.dimensions.length === 3 &&
        asset.dimensions.every((value) => Number.isFinite(value) && value > 0)
      )
      .map((asset) => ({
        asset,
        priority: sourcePriority.get(asset.source),
        delta: Math.max(...asset.dimensions.map((value, index) => Math.abs(value - object.dimensions[index]) / object.dimensions[index])),
      }))
      .filter((candidate) => candidate.delta <= dimensionTolerance)
      .sort((left, right) => left.priority - right.priority || left.delta - right.delta || String(left.asset.id).localeCompare(String(right.asset.id)));
    const match = candidates[0]?.asset;
    if (match) {
      resolved.push({ design_object_id: object.id, asset_id: match.id, representation: "real_asset", source: match.source, uri: match.uri, license: match.license, dimensions: match.dimensions, units: match.units, pivot: match.pivot, forward_axis: match.forward_axis, collision_proxy: true, optimized: true });
    } else {
      resolved.push({ design_object_id: object.id, asset_id: null, representation: "proxy", reason: "no licensed dimensionally compatible catalog asset", dimensions: object.dimensions });
      warnings.push({ code: "asset.proxy_fallback", path: `/design_objects/${object.id}`, message: "No compliant real asset was found; retain the dimensionally correct proxy." });
    }
  }
  return { valid: errors.length === 0, errors, warnings, resolved, summary: { real_assets: resolved.filter((item) => item.representation === "real_asset").length, proxies: resolved.filter((item) => item.representation === "proxy").length } };
}

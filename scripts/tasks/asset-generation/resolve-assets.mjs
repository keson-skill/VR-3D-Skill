/** Resolve P5 objects against an approved local/catalog asset list, never a network source. */
export function resolveAssets(designObjects, catalog, { dimensionTolerance = 0.12 } = {}) {
  const assets = Array.isArray(catalog?.assets) ? catalog.assets : [];
  const resolved = [];
  const errors = [];
  for (const object of designObjects || []) {
    const candidates = assets
      .filter((asset) => asset.kind === object.kind && asset.license && asset.license !== "forbidden")
      .map((asset) => ({
        asset,
        delta: Math.max(...asset.dimensions.map((value, index) => Math.abs(value - object.dimensions[index]) / object.dimensions[index])),
      }))
      .filter((candidate) => candidate.delta <= dimensionTolerance)
      .sort((left, right) => left.delta - right.delta || String(left.asset.id).localeCompare(String(right.asset.id)));
    const match = candidates[0]?.asset;
    if (match) {
      resolved.push({ design_object_id: object.id, asset_id: match.id, representation: "real_asset", uri: match.uri, license: match.license, dimensions: match.dimensions });
    } else {
      resolved.push({ design_object_id: object.id, asset_id: null, representation: "proxy", reason: "no licensed dimensionally compatible catalog asset", dimensions: object.dimensions });
    }
    if (!Array.isArray(object.dimensions) || object.dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
      errors.push({ code: "asset.object_dimensions", path: `/design_objects/${object.id}`, message: "Object dimensions must be positive meters." });
    }
  }
  return { valid: errors.length === 0, errors, resolved, summary: { real_assets: resolved.filter((item) => item.representation === "real_asset").length, proxies: resolved.filter((item) => item.representation === "proxy").length } };
}

import { createSpatialApprovalRecord } from "../../approval/spatial-approval.mjs";
import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";

export function createTestApprovalContext(spatialJson) {
  const sourceManifest = {
    manifest_version: "1.0",
    sources: (spatialJson.sources || []).map((source) => ({
      id: source.id,
      type: source.type,
      uri: source.uri || "local://test-fixture",
      ...(source.sha256 ? { sha256: source.sha256 } : {}),
    })),
  };
  const validationReport = validateSpatialJson(spatialJson);
  if (!validationReport.valid) {
    throw new Error(
      `Cannot approve invalid test fixture: ${JSON.stringify(validationReport.errors)}`,
    );
  }
  const approval = createSpatialApprovalRecord({
    sourceManifest,
    spatialJson,
    validationReport,
    approver: "Automated test fixture",
    scope: spatialJson.validation.approved_scope,
    notes: "Not valid for production or a real downstream job.",
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvalKind: "test_fixture",
  });
  return {
    sourceManifest,
    validationReport,
    approval,
    allowTestApproval: true,
  };
}

import {
  createPrivateKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256,
} from "../lib/cli.mjs";
import {
  validateSpatialApprovalSchema,
  validateSpatialApprovalTrustSchema,
} from "../validation/json-schema.mjs";

export const APPROVAL_STATEMENT =
  "I reviewed the source alignment, spatial geometry, unresolved issues, validation report, and approval scope.";
const INTERACTIVE_HUMAN_APPROVAL = Symbol("interactive-human-approval");

function binding(value, path) {
  return {
    algorithm: "sha256",
    canonicalization: "json-key-sort-v1",
    sha256: canonicalJsonSha256(value),
    ...(path ? { path } : {}),
  };
}

function signaturePayload(record) {
  const unsigned = structuredClone(record);
  delete unsigned.signature;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function buildApprovalBindings(
  { sourceManifest, spatialJson, validationReport },
  paths = {},
) {
  return {
    source_manifest: binding(sourceManifest, paths.sourceManifest),
    spatial_json: binding(spatialJson, paths.spatialJson),
    validation_report: binding(validationReport, paths.validationReport),
  };
}

export function createSpatialApprovalRecord({
  sourceManifest,
  spatialJson,
  validationReport,
  approver,
  scope,
  notes = "",
  approvedAt = new Date().toISOString(),
  approvalKind = "human",
  paths = {},
  interactiveToken = null,
  signingKeyPem = null,
  signingKeyId = null,
}) {
  if (
    approvalKind === "human" &&
    interactiveToken !== INTERACTIVE_HUMAN_APPROVAL
  ) {
    throw new Error(
      "Human approval records can only be created by the interactive TTY approval command.",
    );
  }
  if (!["visualization_only", "construction_ready"].includes(scope)) {
    throw new Error(
      "Approval scope must be visualization_only or construction_ready.",
    );
  }
  const approverName =
    typeof approver === "string" ? approver.trim() : approver?.name?.trim();
  if (!approverName) {
    throw new Error("A non-empty human approver name is required.");
  }
  if (approvalKind === "human" && spatialJson.validation?.status !== "approved") {
    throw new Error(
      "Human approval requires validation.status=approved in the exact Spatial JSON being bound.",
    );
  }
  if (spatialJson.validation?.approved_scope !== scope) {
    throw new Error(
      "Approval scope must match validation.approved_scope in Spatial JSON.",
    );
  }
  if (
    !validationReport?.valid ||
    !Array.isArray(validationReport.errors) ||
    validationReport.errors.length > 0
  ) {
    throw new Error("The bound validation report must pass with zero errors.");
  }
  if (
    validationReport.document_sha256 !== canonicalJsonSha256(spatialJson)
  ) {
    throw new Error(
      "The validation report does not belong to the exact Spatial JSON being approved.",
    );
  }
  const manifestSources = sourceManifest?.sources || [];
  const missingSpatialSource = (spatialJson.sources || []).find(
    (spatialSource) =>
      !manifestSources.some(
        (manifestSource) =>
          manifestSource.id === spatialSource.id &&
          (!spatialSource.sha256 ||
            manifestSource.sha256 === spatialSource.sha256),
      ),
  );
  if (missingSpatialSource) {
    throw new Error(
      `Spatial source ${missingSpatialSource.id} is not bound to the source manifest.`,
    );
  }
  if (hasEntries(sourceManifest?.blockers)) {
    throw new Error("The source manifest still contains blockers.");
  }
  if (
    hasEntries(spatialJson.unresolved_questions) ||
    hasEntries(spatialJson.source_conflicts) ||
    hasEntries(spatialJson.extraction?.source_conflicts)
  ) {
    throw new Error(
      "Unresolved questions or source conflicts must be cleared before approval.",
    );
  }
  if (spatialJson.extraction?.scale?.status === "unknown") {
    throw new Error("Unknown source units or scale block approval.");
  }
  if (
    Number.isFinite(spatialJson.extraction?.topology_confidence) &&
    spatialJson.extraction.topology_confidence < 0.9
  ) {
    throw new Error(
      "Topology confidence below 0.9 must be corrected before approval.",
    );
  }
  if (
    scope === "construction_ready" &&
    spatialJson.extraction?.source_kind === "raster" &&
    (spatialJson.extraction?.scale?.status !== "trusted" ||
      spatialJson.extraction?.construction_ready_eligible !== true)
  ) {
    throw new Error(
      "Raster extraction requires a trusted scale and recorded independent dimensional verification for construction_ready.",
    );
  }
  const bindings = buildApprovalBindings(
    { sourceManifest, spatialJson, validationReport },
    paths,
  );
  const confirmationDigest = sha256(
    Buffer.from(
      `${APPROVAL_STATEMENT}\n${bindings.source_manifest.sha256}\n${bindings.spatial_json.sha256}\n${bindings.validation_report.sha256}\n${scope}\n${approverName}`,
      "utf8",
    ),
  );
  const record = {
    schema_version: "1.0",
    kind: "spatial_approval",
    approval_id: `approval-${spatialJson.project.id}-${spatialJson.project.revision}-${bindings.spatial_json.sha256.slice(0, 12)}`,
    approval_kind: approvalKind,
    project: {
      id: spatialJson.project.id,
      revision: spatialJson.project.revision,
    },
    bindings,
    decision: {
      status: "approved",
      scope,
      approver:
        typeof approver === "string"
          ? { name: approverName }
          : {
              name: approverName,
              ...(approver.id ? { id: String(approver.id) } : {}),
            },
      approved_at: approvedAt,
      notes: String(notes),
    },
    attestation: {
      method: approvalKind === "test_fixture" ? "test_fixture" : "interactive_tty",
      statement: APPROVAL_STATEMENT,
      confirmation_digest: confirmationDigest,
    },
  };
  if (approvalKind === "human") {
    if (!signingKeyPem || !String(signingKeyId || "").trim()) {
      throw new Error(
        "Human approval requires an Ed25519 private key and trusted key ID.",
      );
    }
    let privateKey;
    try {
      privateKey = createPrivateKey(signingKeyPem);
    } catch (error) {
      throw new Error(`Cannot read approval signing key: ${error.message}`);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Approval signing key must be Ed25519.");
    }
    record.signature = {
      algorithm: "ed25519",
      key_id: String(signingKeyId).trim(),
      value_base64: signBytes(
        null,
        signaturePayload(record),
        privateKey,
      ).toString("base64"),
    };
  } else {
    record.signature = {
      algorithm: "test_fixture",
      key_id: "test-fixture",
      value_base64: Buffer.from(
        sha256(signaturePayload(record)),
        "hex",
      ).toString("base64"),
    };
  }
  const schema = validateSpatialApprovalSchema(record);
  if (!schema.valid) {
    throw new Error(
      `Generated approval record failed its schema: ${schema.errors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
    );
  }
  return record;
}

export function createInteractiveHumanApprovalRecord(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Human approval refused: an interactive terminal is required.",
    );
  }
  return createSpatialApprovalRecord({
    ...options,
    approvalKind: "human",
    interactiveToken: INTERACTIVE_HUMAN_APPROVAL,
  });
}

function hasEntries(value) {
  return Array.isArray(value) && value.length > 0;
}

export function verifySpatialApproval({
  approval,
  sourceManifest,
  spatialJson,
  validationReport,
  approvalTrust = null,
  allowTestFixture = false,
}) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  const schema = validateSpatialApprovalSchema(approval);
  for (const error of schema.errors) {
    errors.push(error);
  }
  if (!schema.valid) {
    return { valid: false, errors };
  }

  if (approval.approval_kind === "test_fixture" && !allowTestFixture) {
    add(
      "approval.test_fixture_forbidden",
      "/approval_kind",
      "A test-fixture approval is never valid for a real downstream job.",
    );
  }
  if (
    approval.approval_kind === "human" &&
    approval.attestation.method !== "interactive_tty"
  ) {
    add(
      "approval.human_attestation",
      "/attestation/method",
      "Human approval must come from the interactive local approval command.",
    );
  }
  if (approval.approval_kind === "human") {
    const trustSchema = validateSpatialApprovalTrustSchema(approvalTrust);
    if (!trustSchema.valid) {
      for (const error of trustSchema.errors) {
        add(
          `approval.trust_${error.code}`,
          `/approval_trust${error.path}`,
          error.message,
        );
      }
    } else {
      const trustedKey = approvalTrust.keys.find(
        (key) =>
          key.id === approval.signature.key_id &&
          key.algorithm === "ed25519" &&
          key.status === "active",
      );
      if (!trustedKey) {
        add(
          "approval.untrusted_key",
          "/signature/key_id",
          "Approval signing key is missing, revoked, or not trusted.",
        );
      } else {
        let signatureValid = false;
        try {
          signatureValid = verifyBytes(
            null,
            signaturePayload(approval),
            trustedKey.public_key_pem,
            Buffer.from(approval.signature.value_base64, "base64"),
          );
        } catch {
          signatureValid = false;
        }
        if (!signatureValid) {
          add(
            "approval.signature_invalid",
            "/signature/value_base64",
            "Approval signature does not verify against the trusted reviewer key.",
          );
        }
      }
    }
  } else {
    const expectedFixtureSignature = Buffer.from(
      sha256(signaturePayload(approval)),
      "hex",
    ).toString("base64");
    if (approval.signature.value_base64 !== expectedFixtureSignature) {
      add(
        "approval.test_signature_invalid",
        "/signature/value_base64",
        "Test-fixture approval integrity check failed.",
      );
    }
  }

  const expectedBindings = buildApprovalBindings({
    sourceManifest,
    spatialJson,
    validationReport,
  });
  for (const key of [
    "source_manifest",
    "spatial_json",
    "validation_report",
  ]) {
    if (approval.bindings[key].sha256 !== expectedBindings[key].sha256) {
      add(
        "approval.hash_mismatch",
        `/bindings/${key}/sha256`,
        `${key} changed after approval or is not the approved artifact.`,
      );
    }
  }

  if (
    approval.project.id !== spatialJson.project?.id ||
    approval.project.revision !== spatialJson.project?.revision
  ) {
    add(
      "approval.project_mismatch",
      "/project",
      "Approval project and revision must match Spatial JSON.",
    );
  }
  if (
    approval.decision.scope !== spatialJson.validation?.approved_scope ||
    spatialJson.validation?.status !== "approved"
  ) {
    add(
      "approval.scope_mismatch",
      "/decision/scope",
      "Approval scope and approved Spatial JSON status must match.",
    );
  }
  if (
    !validationReport?.valid ||
    !Array.isArray(validationReport?.errors) ||
    validationReport.errors.length > 0
  ) {
    add(
      "approval.validation_failed",
      "/bindings/validation_report",
      "The bound validation report must pass with zero errors.",
    );
  }
  if (
    validationReport?.document_sha256 !== canonicalJsonSha256(spatialJson)
  ) {
    add(
      "approval.validation_document_mismatch",
      "/bindings/validation_report",
      "The validation report was not produced for this exact Spatial JSON.",
    );
  }
  const manifestSources = sourceManifest?.sources || [];
  for (const spatialSource of spatialJson.sources || []) {
    const match = manifestSources.some(
      (manifestSource) =>
        manifestSource.id === spatialSource.id &&
        (!spatialSource.sha256 ||
          manifestSource.sha256 === spatialSource.sha256),
    );
    if (!match) {
      add(
        "approval.source_manifest_mismatch",
        "/bindings/source_manifest",
        `Spatial source ${spatialSource.id} is not present with the same identity and hash in the source manifest.`,
      );
    }
  }
  if (hasEntries(sourceManifest?.blockers)) {
    add(
      "approval.source_blocked",
      "/bindings/source_manifest",
      "The bound source manifest still contains blockers.",
    );
  }
  if (
    hasEntries(spatialJson.unresolved_questions) ||
    hasEntries(spatialJson.source_conflicts) ||
    hasEntries(spatialJson.extraction?.source_conflicts)
  ) {
    add(
      "approval.unresolved_evidence",
      "/bindings/spatial_json",
      "Unresolved questions or source conflicts block approval.",
    );
  }
  if (spatialJson.extraction?.scale?.status === "unknown") {
    add(
      "approval.unknown_scale",
      "/bindings/spatial_json",
      "Unknown source units or scale block approval.",
    );
  }
  if (
    Number.isFinite(spatialJson.extraction?.topology_confidence) &&
    spatialJson.extraction.topology_confidence < 0.9
  ) {
    add(
      "approval.low_topology_confidence",
      "/bindings/spatial_json",
      "Topology confidence below 0.9 must be corrected before approval.",
    );
  }
  if (
    approval.decision.scope === "construction_ready" &&
    spatialJson.extraction?.source_kind === "raster" &&
    (spatialJson.extraction?.scale?.status !== "trusted" ||
      spatialJson.extraction?.construction_ready_eligible !== true)
  ) {
    add(
      "approval.raster_scope",
      "/decision/scope",
      "Raster extraction without trusted scale and independent dimensional verification is visualization_only.",
    );
  }

  const expectedConfirmation = sha256(
    Buffer.from(
      `${APPROVAL_STATEMENT}\n${approval.bindings.source_manifest.sha256}\n${approval.bindings.spatial_json.sha256}\n${approval.bindings.validation_report.sha256}\n${approval.decision.scope}\n${approval.decision.approver.name}`,
      "utf8",
    ),
  );
  if (approval.attestation.confirmation_digest !== expectedConfirmation) {
    add(
      "approval.attestation_mismatch",
      "/attestation/confirmation_digest",
      "Approval attestation does not match the bound hashes and reviewer.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    approval_id: approval.approval_id,
    scope: approval.decision.scope,
    approver: approval.decision.approver,
    approved_at: approval.decision.approved_at,
    bindings: expectedBindings,
  };
}

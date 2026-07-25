import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const [
  spatialSchema,
  approvalSchema,
  approvalTrustSchema,
  productionJobSchema,
] = await Promise.all([
  readFile(
    new URL("../../schemas/spatial.schema.json", import.meta.url),
    "utf8",
  ).then(JSON.parse),
  readFile(
    new URL("../../schemas/spatial-approval.schema.json", import.meta.url),
    "utf8",
  ).then(JSON.parse),
  readFile(
    new URL("../../schemas/spatial-approval-trust.schema.json", import.meta.url),
    "utf8",
  ).then(JSON.parse),
  readFile(
    new URL("../../schemas/production-job.schema.json", import.meta.url),
    "utf8",
  ).then(JSON.parse),
]);

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  validateFormats: false,
});

const validateSpatial = ajv.compile(spatialSchema);
const validateApproval = ajv.compile(approvalSchema);
const validateApprovalTrust = ajv.compile(approvalTrustSchema);
const validateProductionJob = ajv.compile(productionJobSchema);

function escapePointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizeErrors(errors = []) {
  return (errors || []).map((error) => {
    let path = error.instancePath || "";
    if (error.keyword === "required" && error.params?.missingProperty) {
      path = `${path}/${escapePointerToken(error.params.missingProperty)}`;
    }
    return {
      code: `schema.${error.keyword}`,
      path,
      message: error.message || "JSON Schema validation failed.",
      schema_path: error.schemaPath,
      params: error.params,
    };
  });
}

function run(validator, value) {
  const valid = validator(value);
  return {
    valid: Boolean(valid),
    errors: normalizeErrors(validator.errors),
  };
}

export function validateSpatialSchema(value) {
  return run(validateSpatial, value);
}

export function validateSpatialApprovalSchema(value) {
  return run(validateApproval, value);
}

export function validateSpatialApprovalTrustSchema(value) {
  return run(validateApprovalTrust, value);
}

export function validateProductionJobSchema(value) {
  return run(validateProductionJob, value);
}

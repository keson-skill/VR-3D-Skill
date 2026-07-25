#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
} from "../lib/cli.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";
import { applyRevision, RevisionApplicationError } from "./apply-revision.mjs";
import { buildDependencyPlan } from "./build-dependency-plan.mjs";

const INDEX_FILE = "index.json";
const AUDIT_FILE = "audit-log.json";
const LOCK_FILE = ".revision-store.lock";

function revisionFileName(revisionId, suffix = "") {
  const digest = canonicalJsonSha256(revisionId).slice(0, 24);
  return `${digest}${suffix}.json`;
}

async function readJsonIfPresent(filePath) {
  try {
    return await readJson(
      filePath,
      "revision store JSON",
      { maxBytes: 16 * 1024 * 1024 },
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

function resolveStorePath(storeDirectory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new RevisionApplicationError(
      "revision_store.path",
      "Revision store index contains an invalid file path.",
    );
  }
  const root = resolve(storeDirectory);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new RevisionApplicationError(
      "revision_store.path",
      `Revision store path escapes its root: ${relativePath}.`,
    );
  }
  return filePath;
}

async function withStoreLock(storeDirectory, action) {
  await mkdir(storeDirectory, { recursive: true });
  const lockPath = join(storeDirectory, LOCK_FILE);
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RevisionApplicationError(
        "revision_store.locked",
        `Revision store is already being modified: ${storeDirectory}.`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

function verifyAuditEvents(events) {
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.previous_audit_sha256 !== previous) {
      throw new RevisionApplicationError(
        "revision_store.audit_chain",
        `Audit event ${index} has an invalid previous hash.`,
      );
    }
    const { audit_sha256: recorded, ...payload } = event;
    const computed = canonicalJsonSha256(payload);
    if (recorded !== computed) {
      throw new RevisionApplicationError(
        "revision_store.audit_hash",
        `Audit event ${index} failed hash verification.`,
      );
    }
    previous = recorded;
  }
  return previous;
}

async function ensureStoreDirectories(storeDirectory) {
  await Promise.all([
    mkdir(join(storeDirectory, "versions"), { recursive: true }),
    mkdir(join(storeDirectory, "revisions"), { recursive: true }),
    mkdir(join(storeDirectory, "inverse"), { recursive: true }),
    mkdir(join(storeDirectory, "diffs"), { recursive: true }),
  ]);
}

async function initializeIndex(storeDirectory, baseDocument, createdAt) {
  const versionFile = join("versions", revisionFileName(baseDocument.project.revision));
  await atomicWriteJson(join(storeDirectory, versionFile), baseDocument);
  const index = {
    schema_version: "1.0",
    project_id: baseDocument.project.id,
    current_revision: baseDocument.project.revision,
    versions: {
      [baseDocument.project.revision]: {
        file: versionFile,
        document_sha256: canonicalJsonSha256(baseDocument),
        parent_revision: null,
        event_type: "store_initialized",
        created_at: createdAt,
      },
    },
  };
  await atomicWriteJson(join(storeDirectory, INDEX_FILE), index);
  await atomicWriteJson(join(storeDirectory, AUDIT_FILE), {
    schema_version: "1.0",
    events: [],
  });
  return index;
}

async function readStoreState(storeDirectory) {
  const index = await readJsonIfPresent(join(storeDirectory, INDEX_FILE));
  if (!index) return null;
  if (
    typeof index.project_id !== "string"
    || typeof index.current_revision !== "string"
    || !index.versions
    || typeof index.versions !== "object"
    || !index.versions[index.current_revision]
  ) {
    throw new RevisionApplicationError(
      "revision_store.index",
      "Revision store index is missing its project, current revision, or version record.",
    );
  }
  const auditLog = await readJsonIfPresent(join(storeDirectory, AUDIT_FILE));
  if (!auditLog || !Array.isArray(auditLog.events)) {
    throw new RevisionApplicationError(
      "revision_store.audit_missing",
      "Revision store audit log is missing or invalid.",
    );
  }
  const lastAuditSha256 = verifyAuditEvents(auditLog.events);
  return { index, auditLog, lastAuditSha256 };
}

async function persistAppliedResult(
  storeDirectory,
  state,
  result,
  { eventType = "revision_applied", extraVersionMetadata = {} } = {},
) {
  const revisionId = result.document.project.revision;
  if (state.index.versions[revisionId]) {
    throw new RevisionApplicationError(
      "revision_store.duplicate_revision",
      `Revision ${revisionId} already exists in the store.`,
    );
  }
  const versionFile = join("versions", revisionFileName(revisionId));
  const revisionFile = join("revisions", revisionFileName(revisionId, "-revision"));
  const inverseFile = join("inverse", revisionFileName(revisionId, "-inverse"));
  const diffFile = join("diffs", revisionFileName(revisionId, "-diff"));

  await atomicWriteJson(join(storeDirectory, versionFile), result.document);
  await atomicWriteJson(join(storeDirectory, revisionFile), result.revision);
  await atomicWriteJson(join(storeDirectory, inverseFile), result.inverse_revision);
  await atomicWriteJson(join(storeDirectory, diffFile), result.diff);

  state.auditLog.events.push(result.audit);
  await atomicWriteJson(join(storeDirectory, AUDIT_FILE), state.auditLog);
  state.index.versions[revisionId] = {
    file: versionFile,
    revision_file: revisionFile,
    inverse_file: inverseFile,
    diff_file: diffFile,
    document_sha256: canonicalJsonSha256(result.document),
    parent_revision: result.revision.base_revision,
    event_type: eventType,
    created_at: result.audit.applied_at,
    audit_sha256: result.audit.audit_sha256,
    ...extraVersionMetadata,
  };
  state.index.current_revision = revisionId;
  await atomicWriteJson(join(storeDirectory, INDEX_FILE), state.index);
  return {
    current_revision: revisionId,
    document_sha256: state.index.versions[revisionId].document_sha256,
    audit_sha256: result.audit.audit_sha256,
    requires_reapproval: true,
    dependency_plan: result.dependency_plan,
  };
}

async function applyUnlocked(storeDirectory, baseDocument, revision, appliedAt) {
  await ensureStoreDirectories(storeDirectory);
  const baseValidation = validateSpatialJson(baseDocument);
  if (!baseValidation.valid) {
    throw new RevisionApplicationError(
      "revision_store.invalid_base",
      `Base document is invalid: ${baseValidation.errors[0]?.message || "unknown error"}`,
    );
  }
  let state = await readStoreState(storeDirectory);
  if (!state) {
    const index = await initializeIndex(storeDirectory, baseDocument, appliedAt);
    state = {
      index,
      auditLog: { schema_version: "1.0", events: [] },
      lastAuditSha256: null,
    };
  }
  if (state.index.project_id !== baseDocument.project.id) {
    throw new RevisionApplicationError(
      "revision_store.project",
      "Base document belongs to a different project.",
    );
  }
  if (state.index.current_revision !== revision.base_revision) {
    throw new RevisionApplicationError(
      "revision_store.stale_base",
      `Store is at ${state.index.current_revision}; revision targets ${revision.base_revision}.`,
    );
  }
  const currentRecord = state.index.versions[state.index.current_revision];
  if (currentRecord.document_sha256 !== canonicalJsonSha256(baseDocument)) {
    throw new RevisionApplicationError(
      "revision_store.base_hash",
      "Base document does not match the current stored revision hash.",
    );
  }
  const result = applyRevision(baseDocument, revision, {
    appliedAt,
    previousAuditSha256: state.lastAuditSha256,
  });
  return {
    result,
    persisted: await persistAppliedResult(storeDirectory, state, result),
  };
}

export async function applyRevisionToStore(
  storeDirectory,
  baseDocument,
  revision,
  { appliedAt = new Date().toISOString() } = {},
) {
  return withStoreLock(
    storeDirectory,
    () => applyUnlocked(storeDirectory, baseDocument, revision, appliedAt),
  );
}

async function loadVersionDocument(storeDirectory, state, revisionId) {
  const record = state.index.versions[revisionId];
  if (!record) {
    throw new RevisionApplicationError(
      "revision_store.unknown_revision",
      `Revision ${revisionId} is not present in the store.`,
    );
  }
  const document = await readJson(
    resolveStorePath(storeDirectory, record.file),
    `stored revision ${revisionId}`,
  );
  if (canonicalJsonSha256(document) !== record.document_sha256) {
    throw new RevisionApplicationError(
      "revision_store.version_hash",
      `Stored revision ${revisionId} failed hash verification.`,
    );
  }
  return document;
}

export async function loadCurrentRevision(storeDirectory) {
  const state = await readStoreState(storeDirectory);
  if (!state) {
    throw new RevisionApplicationError(
      "revision_store.missing",
      `Revision store does not exist: ${storeDirectory}.`,
    );
  }
  return loadVersionDocument(storeDirectory, state, state.index.current_revision);
}

export async function undoCurrentRevision(
  storeDirectory,
  newRevisionId,
  {
    actorId = "revision-store-operator",
    appliedAt = new Date().toISOString(),
  } = {},
) {
  const observedState = await readStoreState(storeDirectory);
  if (!observedState) {
    throw new RevisionApplicationError("revision_store.missing", "Revision store does not exist.");
  }
  const observedCurrent = observedState.index.current_revision;
  const observedRecord = observedState.index.versions[observedCurrent];
  if (observedRecord.undo_snapshot_revision) {
    return rollbackToRevision(
      storeDirectory,
      observedRecord.undo_snapshot_revision,
      newRevisionId,
      {
        actorId,
        appliedAt,
        expectedCurrentRevision: observedCurrent,
      },
    );
  }
  return withStoreLock(storeDirectory, async () => {
    const state = await readStoreState(storeDirectory);
    if (!state) {
      throw new RevisionApplicationError("revision_store.missing", "Revision store does not exist.");
    }
    const currentId = state.index.current_revision;
    if (currentId !== observedCurrent) {
      throw new RevisionApplicationError(
        "revision_store.stale_undo",
        `Expected current revision ${observedCurrent}, found ${currentId}.`,
      );
    }
    const currentRecord = state.index.versions[currentId];
    if (!currentRecord.inverse_file) {
      throw new RevisionApplicationError(
        "revision_store.undo_unavailable",
        `Revision ${currentId} has no inverse revision.`,
      );
    }
    const currentDocument = await loadVersionDocument(storeDirectory, state, currentId);
    const inverse = await readJson(
      resolveStorePath(storeDirectory, currentRecord.inverse_file),
      `inverse revision for ${currentId}`,
    );
    inverse.revision_id = newRevisionId;
    inverse.base_revision = currentId;
    inverse.intent = `Undo ${currentId}`;
    inverse.rollback_reference = currentId;
    inverse.provenance = {
      actor_type: "human",
      actor_id: actorId,
      created_at: appliedAt,
    };
    const result = applyRevision(currentDocument, inverse, {
      appliedAt,
      previousAuditSha256: state.lastAuditSha256,
    });
    result.audit.event_type = "revision_undone";
    const { audit_sha256: _oldHash, ...auditPayload } = result.audit;
    result.audit.audit_sha256 = canonicalJsonSha256(auditPayload);
    return {
      result,
      persisted: await persistAppliedResult(
        storeDirectory,
        state,
        result,
        {
          eventType: "revision_undone",
          extraVersionMetadata: { undone_revision: currentId },
        },
      ),
    };
  });
}

export async function rollbackToRevision(
  storeDirectory,
  targetRevision,
  newRevisionId,
  {
    actorId = "revision-store-operator",
    appliedAt = new Date().toISOString(),
    expectedCurrentRevision = null,
  } = {},
) {
  return withStoreLock(storeDirectory, async () => {
    const state = await readStoreState(storeDirectory);
    if (!state) {
      throw new RevisionApplicationError("revision_store.missing", "Revision store does not exist.");
    }
    if (
      expectedCurrentRevision
      && state.index.current_revision !== expectedCurrentRevision
    ) {
      throw new RevisionApplicationError(
        "revision_store.stale_undo",
        `Expected current revision ${expectedCurrentRevision}, found ${state.index.current_revision}.`,
      );
    }
    if (state.index.versions[newRevisionId]) {
      throw new RevisionApplicationError(
        "revision_store.duplicate_revision",
        `Revision ${newRevisionId} already exists in the store.`,
      );
    }
    const currentRevision = state.index.current_revision;
    const currentDocument = await loadVersionDocument(storeDirectory, state, currentRevision);
    const targetDocument = await loadVersionDocument(storeDirectory, state, targetRevision);
    const restored = structuredClone(targetDocument);
    restored.project.revision = newRevisionId;
    restored.validation = {
      ...(restored.validation || {}),
      status: "pending",
      approved_scope: null,
      checks: [
        ...(Array.isArray(restored.validation?.checks) ? restored.validation.checks : []),
        {
          code: "rollback.requires_reapproval",
          rollback_target: targetRevision,
          previous_revision: currentRevision,
        },
      ],
    };
    const validation = validateSpatialJson(restored);
    if (!validation.valid) {
      throw new RevisionApplicationError(
        "revision_store.rollback_invalid",
        `Rollback target produced invalid Spatial JSON: ${validation.errors[0]?.message || "unknown error"}`,
      );
    }
    const dependencyPlan = buildDependencyPlan(
      ["/project", "/sources", "/envelope", "/rooms", "/design_objects", "/assets", "/materials", "/lights", "/xr", "/render_profiles"],
      ["full_spatial_validation"],
    );
    const revision = {
      revision_id: newRevisionId,
      base_revision: currentRevision,
      intent: `Rollback ${currentRevision} to snapshot ${targetRevision}`,
      scope: { target_ids: [], paths: ["/project"] },
      operations: [{ op: "test", path: "/project/id", value: currentDocument.project.id }],
      must_preserve_ids: [],
      must_preserve_paths: [],
      revalidate: dependencyPlan.revalidate,
      provenance: {
        actor_type: "human",
        actor_id: actorId,
        created_at: appliedAt,
      },
      rollback_reference: currentRevision,
      rollback_target: targetRevision,
    };
    const diff = [{
      operation_index: 0,
      operation: { op: "restore_snapshot", target_revision: targetRevision },
      resolved_pointer: "",
      before: {
        exists: true,
        value: null,
        sha256: canonicalJsonSha256(currentDocument),
      },
      after: {
        exists: true,
        value: null,
        sha256: canonicalJsonSha256(restored),
      },
    }];
    const auditPayload = {
      schema_version: "1.0",
      event_type: "revision_rolled_back",
      event_id: `audit-${newRevisionId}`,
      project_id: restored.project.id,
      base_revision: currentRevision,
      revision_id: newRevisionId,
      rollback_target: targetRevision,
      intent: revision.intent,
      provenance: revision.provenance,
      applied_at: appliedAt,
      base_document_sha256: canonicalJsonSha256(currentDocument),
      result_document_sha256: canonicalJsonSha256(restored),
      revision_sha256: canonicalJsonSha256(revision),
      diff,
      dependency_plan: dependencyPlan,
      approval_transition: {
        from: currentDocument.validation?.status || null,
        to: restored.validation.status,
        requires_reapproval: true,
      },
      previous_audit_sha256: state.lastAuditSha256,
    };
    const audit = {
      ...auditPayload,
      audit_sha256: canonicalJsonSha256(auditPayload),
    };
    const inverseRevision = {
      revision_id: `undo-${newRevisionId}`,
      base_revision: newRevisionId,
      intent: `Undo rollback ${newRevisionId}`,
      scope: { target_ids: [], paths: ["/project"] },
      operations: [],
      must_preserve_ids: [],
      must_preserve_paths: [],
      revalidate: dependencyPlan.revalidate,
      provenance: {
        actor_type: "system",
        actor_id: "revision-engine",
        created_at: appliedAt,
      },
      rollback_reference: newRevisionId,
    };
    const result = {
      schema_version: "1.0",
      document: restored,
      revision,
      inverse_revision: inverseRevision,
      diff,
      dependency_plan: dependencyPlan,
      spatial_validation: validation,
      requires_reapproval: true,
      audit,
    };
    return {
      result,
      persisted: await persistAppliedResult(
        storeDirectory,
        state,
        result,
        {
          eventType: "revision_rolled_back",
          extraVersionMetadata: {
            rollback_target: targetRevision,
            undo_snapshot_revision: currentRevision,
          },
        },
      ),
    };
  });
}

export async function verifyRevisionStore(storeDirectory) {
  const state = await readStoreState(storeDirectory);
  if (!state) {
    throw new RevisionApplicationError("revision_store.missing", "Revision store does not exist.");
  }
  for (const revisionId of Object.keys(state.index.versions)) {
    await loadVersionDocument(storeDirectory, state, revisionId);
  }
  return {
    valid: true,
    project_id: state.index.project_id,
    current_revision: state.index.current_revision,
    versions: Object.keys(state.index.versions).length,
    audit_events: state.auditLog.events.length,
    last_audit_sha256: state.lastAuditSha256,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    action: { type: "string", required: true },
    store: { type: "string", required: true },
    base: { type: "string" },
    revision: { type: "string" },
    target: { type: "string" },
    "revision-id": { type: "string" },
    "actor-id": { type: "string", default: "revision-store-operator" },
    output: { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/revisions/revision-store.mjs --action apply --store run/revisions --base spatial.json --revision revision.json\n  node scripts/revisions/revision-store.mjs --action undo --store run/revisions --revision-id rev-undo --actor-id reviewer\n  node scripts/revisions/revision-store.mjs --action rollback --store run/revisions --target rev-001 --revision-id rev-rollback --actor-id reviewer\n  node scripts/revisions/revision-store.mjs --action verify --store run/revisions\n");
    return;
  }
  let result;
  if (options.action === "apply") {
    if (!options.base || !options.revision) throw new Error("apply requires --base and --revision.");
    result = await applyRevisionToStore(
      options.store,
      await readJson(options.base, "base Spatial JSON"),
      await readJson(options.revision, "revision"),
    );
  } else if (options.action === "undo") {
    if (!options["revision-id"]) throw new Error("undo requires --revision-id.");
    result = await undoCurrentRevision(options.store, options["revision-id"], {
      actorId: options["actor-id"],
    });
  } else if (options.action === "rollback") {
    if (!options.target || !options["revision-id"]) throw new Error("rollback requires --target and --revision-id.");
    result = await rollbackToRevision(options.store, options.target, options["revision-id"], {
      actorId: options["actor-id"],
    });
  } else if (options.action === "verify") {
    result = await verifyRevisionStore(options.store);
  } else {
    throw new Error("action must be apply, undo, rollback, or verify.");
  }
  if (options.output) await atomicWriteJson(options.output, result);
  printJson(result.persisted || result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}

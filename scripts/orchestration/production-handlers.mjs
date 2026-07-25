import {
  lstat,
  mkdir,
  readdir,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { prepareInteriorJob } from "./prepare-interior-job.mjs";
import { renderDeliverables } from "../tasks/blender/render-deliverables.mjs";
import { buildViewableScene } from "../tasks/scene-generation/build-viewable-scene.mjs";
import { readJson, writeJson } from "../lib/cli.mjs";
import {
  GiB,
  hashBoundedFile,
} from "../ingest/file-safety.mjs";
import {
  JobPauseError,
  JobRuntimeError,
} from "../runtime/job-runtime.mjs";
import { verifyXrConfig } from "../runtime/verify-xr-config.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

const HANDLER_REQUIRED_PARAMETERS = {
  prepare_interior_job: ["inputs", "output_directory"],
  validate_spatial: ["input", "output"],
  await_spatial_approval: [
    "spatial_json",
    "source_manifest",
    "validation_report",
    "approval",
    "approval_trust",
    "output",
  ],
  build_viewable_scene: [
    "spatial_json",
    "source_manifest",
    "validation_report",
    "approval",
    "approval_trust",
    "output_directory",
  ],
  verify_xr: [
    "spatial_json",
    "source_manifest",
    "validation_report",
    "approval",
    "approval_trust",
    "output",
  ],
  render_blender: [
    "spatial_json",
    "source_manifest",
    "validation_report",
    "approval",
    "approval_trust",
    "scene",
    "scene_manifest",
    "output_directory",
  ],
};
const HANDLER_OUTPUT_PARAMETERS = {
  prepare_interior_job: ["output_directory"],
  validate_spatial: ["output"],
  await_spatial_approval: ["output"],
  build_viewable_scene: ["output_directory"],
  verify_xr: ["output"],
  render_blender: ["output_directory"],
};

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path && !path.startsWith("..") && !isAbsolute(path);
}

export async function assertWorkspaceDestination(
  workspaceRoot,
  candidate,
  label,
  {
    directoryOutput = false,
  } = {},
) {
  const root = resolve(workspaceRoot);
  const target = resolve(candidate);
  if (!contained(root, target)) {
    throw new JobRuntimeError(
      "output_path_outside_workspace",
      `${label} must stay below the production workspace.`,
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new JobRuntimeError(
      "unsafe_workspace",
      "Production workspace must be a regular non-symlink directory.",
    );
  }
  const segments = relative(root, target).split(/[\\/]/u).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new JobRuntimeError(
          "output_symlink_traversal",
          `${label} must not traverse a symbolic link.`,
        );
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw new JobRuntimeError(
          "output_parent_not_directory",
          `${label} has a non-directory parent.`,
        );
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  if (directoryOutput) {
    const pending = [target];
    let entries = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const child of children) {
        entries += 1;
        if (entries > 10000) {
          throw new JobRuntimeError(
            "output_tree_limit",
            `${label} exceeds the 10000-entry safety scan limit.`,
          );
        }
        const childPath = join(directory, child.name);
        const metadata = await lstat(childPath);
        if (metadata.isSymbolicLink()) {
          throw new JobRuntimeError(
            "output_symlink_traversal",
            `${label} contains a symbolic link.`,
          );
        }
        if (metadata.isDirectory()) pending.push(childPath);
      }
    }
  }
}

export function validateProductionStages(
  stages,
  {
    workspaceRoot = null,
  } = {},
) {
  const errors = [];
  for (const [index, stage] of (stages || []).entries()) {
    const required = HANDLER_REQUIRED_PARAMETERS[stage.handler];
    if (!required) {
      errors.push({
        code: "production.handler_unknown",
        path: `/stages/${index}/handler`,
        message: `Unknown production handler ${stage.handler}.`,
      });
      continue;
    }
    for (const name of required) {
      const value = stage.parameters?.[name];
      if (
        value === undefined
        || value === null
        || (typeof value === "string" && !value.trim())
        || (name === "inputs" && (!Array.isArray(value) || value.length === 0))
      ) {
        errors.push({
          code: "production.parameter_required",
          path: `/stages/${index}/parameters/${name}`,
          message: `${stage.handler} requires ${name}.`,
        });
      }
    }
    if (workspaceRoot) {
      for (const name of HANDLER_OUTPUT_PARAMETERS[stage.handler] || []) {
        const value = stage.parameters?.[name];
        if (typeof value !== "string" || !value.trim()) continue;
        const root = resolve(workspaceRoot);
        if (!contained(root, resolve(value))) {
          errors.push({
            code: "production.output_workspace",
            path: `/stages/${index}/parameters/${name}`,
            message: `${stage.handler} output ${name} must stay below the production workspace.`,
          });
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

async function fileHash(filePath) {
  return (await hashBoundedFile(filePath, {
    label: "Production artifact",
    maxBytes: 2 * GiB,
  })).sha256;
}

async function readDependency(filePath, label, state = "blocked") {
  try {
    return await readJson(filePath, label, { maxBytes: 16 * 1024 * 1024 });
  } catch (error) {
    throw new JobPauseError(
      `${label.replace(/[^A-Za-z0-9]+/gu, "_").toLowerCase()}_unavailable`,
      `${label} is missing or invalid.`,
      {
        state,
        detail: {
          dependency: label,
          error_code: error.code || "invalid_json",
        },
      },
    );
  }
}

async function approvalInputs(parameters) {
  return Promise.all([
    readDependency(parameters.spatial_json, "approved Spatial JSON"),
    readDependency(parameters.source_manifest, "source manifest"),
    readDependency(parameters.validation_report, "validation report"),
    readDependency(
      parameters.approval,
      "spatial approval",
      "awaiting_approval",
    ),
    readDependency(
      parameters.approval_trust,
      "spatial approval trust store",
      "awaiting_approval",
    ),
  ]);
}

function requireApprovedContext([
  spatial,
  sourceManifest,
  validationReport,
  approval,
  approvalTrust,
]) {
  const report = validateSpatialJson(spatial, {
    requireApproved: true,
    sourceManifest,
    validationReport,
    approval,
    approvalTrust,
    allowTestApproval: false,
  });
  if (!report.valid) {
    const approvalOnly = report.errors.every((error) =>
      /approval|signature|trust/iu.test(error.code));
    throw new JobPauseError(
      "spatial_approval_required",
      "A valid independent production Spatial approval is required.",
      {
        state: approvalOnly ? "awaiting_approval" : "blocked",
        detail: {
          error_codes: report.errors.map((error) => error.code),
        },
      },
    );
  }
  return report;
}

export function buildProductionHandlers({ workspaceRoot = "runs" } = {}) {
  const guardOutput = (parameters, name, handler) =>
    assertWorkspaceDestination(
      workspaceRoot,
      parameters[name],
      `${handler}.${name}`,
      { directoryOutput: name === "output_directory" },
    );
  return {
    prepare_interior_job: async ({ parameters }) => {
      await guardOutput(parameters, "output_directory", "prepare_interior_job");
      const job = await prepareInteriorJob(parameters.inputs, {
        ...(parameters.options || {}),
        outputDirectory: parameters.output_directory,
      });
      const jobFile = `${parameters.output_directory}/job.json`;
      if (job.stage === "blocked") {
        throw new JobPauseError(
          "input_preparation_blocked",
          "Input preparation produced unresolved blockers.",
          {
            state: "blocked",
            detail: {
              blocker_codes: job.blockers.map((blocker) => blocker.route).filter(Boolean),
            },
          },
        );
      }
      return {
        outputs: {
          job: jobFile,
          source_manifest: job.source_manifest,
        },
        hashes: {
          job: await fileHash(jobFile),
          source_manifest: await fileHash(job.source_manifest),
        },
      };
    },

    validate_spatial: async ({ parameters }) => {
      await guardOutput(parameters, "output", "validate_spatial");
      const spatial = await readDependency(parameters.input, "Spatial JSON");
      const report = validateSpatialJson(spatial);
      await writeJson(parameters.output, report);
      if (!report.valid) {
        throw new JobPauseError(
          "spatial_validation_failed",
          "Spatial validation has unresolved errors.",
          {
            state: "blocked",
            detail: {
              error_codes: report.errors.map((error) => error.code),
            },
          },
        );
      }
      return {
        outputs: { validation_report: parameters.output },
        hashes: { validation_report: await fileHash(parameters.output) },
      };
    },

    await_spatial_approval: async ({ parameters }) => {
      await guardOutput(parameters, "output", "await_spatial_approval");
      const [
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ] = await approvalInputs(parameters);
      const report = requireApprovedContext([
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ]);
      await writeJson(parameters.output, report);
      return {
        outputs: {
          approval: parameters.approval,
          approval_verification: parameters.output || null,
        },
        hashes: {
          approval: await fileHash(parameters.approval),
          spatial: await fileHash(parameters.spatial_json),
          approval_verification: await fileHash(parameters.output),
        },
      };
    },

    build_viewable_scene: async ({ parameters }) => {
      await guardOutput(
        parameters,
        "output_directory",
        "build_viewable_scene",
      );
      const [
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ] = await approvalInputs(parameters);
      requireApprovedContext([
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ]);
      const result = await buildViewableScene(spatial, {
        outputDirectory: parameters.output_directory,
        mode: parameters.mode || "furnished",
        quality: parameters.quality || null,
        sourcePath: parameters.spatial_json,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
        allowTestApproval: false,
      });
      return {
        outputs: {
          scene: result.sceneFile,
          viewer: result.viewer,
        },
        hashes: {
          scene: result.manifest.scene_sha256,
          spatial: approval.bindings.spatial_json.sha256,
        },
      };
    },

    verify_xr: async ({ parameters }) => {
      await guardOutput(parameters, "output", "verify_xr");
      const [
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ] = await approvalInputs(parameters);
      requireApprovedContext([
        spatial,
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
      ]);
      const report = verifyXrConfig(spatial, {
        sourceManifest,
        validationReport,
        approval,
        approvalTrust,
        allowTestApproval: false,
      });
      await writeJson(parameters.output, report);
      if (!report.valid) {
        throw new JobPauseError(
          "xr_configuration_blocked",
          "XR configuration is not ready.",
          {
            state: "blocked",
            detail: { error_codes: report.errors.map((error) => error.code) },
          },
        );
      }
      return {
        outputs: { xr_report: parameters.output },
        hashes: { xr_report: await fileHash(parameters.output) },
      };
    },

    render_blender: async ({ parameters }) => {
      await guardOutput(parameters, "output_directory", "render_blender");
      const approved = await approvalInputs(parameters);
      requireApprovedContext(approved);
      const [spatial, , , approval] = approved;
      const sceneManifest = await readDependency(
        parameters.scene_manifest,
        "scene manifest",
      );
      const sceneSha256 = await fileHash(parameters.scene);
      if (
        sceneManifest.project?.id !== spatial.project?.id
        || sceneManifest.project?.revision !== spatial.project?.revision
        || sceneManifest.scene_sha256 !== sceneSha256
        || sceneManifest.spatial_approval?.spatial_sha256
          !== approval.bindings?.spatial_json?.sha256
      ) {
        throw new JobPauseError(
          "scene_approval_binding_invalid",
          "The Blender source scene is not bound to the approved Spatial revision.",
          { state: "blocked" },
        );
      }
      try {
        const result = await renderDeliverables(spatial, {
          sceneFile: parameters.scene,
          outputDirectory: parameters.output_directory,
          blender: parameters.blender || "blender",
          walkthrough: parameters.walkthrough === true,
          force: parameters.force === true,
          renderTimeoutMs: parameters.render_timeout_ms
            ? Number(parameters.render_timeout_ms)
            : undefined,
        });
        return {
          outputs: {
            render_manifest: `${parameters.output_directory}/render-manifest.json`,
            panorama: result.manifest.panorama,
            blend_file: result.manifest.blend_file,
          },
          hashes: Object.fromEntries(
            [
              ["scene", sceneSha256],
              ...result.manifest.artifacts
              .slice(0, 100)
              .map((artifact, index) => [`artifact-${index + 1}`, artifact.sha256]),
            ],
          ),
          asset_versions: [
            `blender-${result.manifest.blender_version
              .replace(/[^A-Za-z0-9._:-]+/gu, "-")
              .slice(0, 100)}`,
          ],
        };
      } catch (error) {
        if (
          error.code === "BLENDER_UNAVAILABLE"
          || /not found|spawn.*ENOENT/iu.test(error.message)
        ) {
          throw new JobPauseError(
            "blender_unavailable",
            "Blender is unavailable on this worker.",
            { state: "blocked" },
          );
        }
        throw new JobRuntimeError(
          "blender_render_failed",
          error.message,
          {
            retryable: ["TOOL_TIMEOUT", "TOOL_EXIT_NONZERO"]
              .includes(error.code),
          },
        );
      }
    },
  };
}

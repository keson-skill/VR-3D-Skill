#!/usr/bin/env node

import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
} from "../lib/cli.mjs";
import {
  GiB,
  hashBoundedFile,
  readBoundedFile,
} from "../ingest/file-safety.mjs";
import { runTool } from "../ingest/tool-runner.mjs";
import { buildDoctorReport } from "../doctor.mjs";
import { sanitizeError } from "../runtime/redaction.mjs";
import { auditRelease } from "../security/audit-release.mjs";
import { generateSbom } from "./generate-sbom.mjs";
import { validateReleaseEvidence } from "./validate-release-evidence.mjs";

async function writeJsonExclusive(filePath, value, maxBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maxBytes) {
    throw new Error(`Release metadata ${basename(filePath)} exceeds its size limit.`);
  }
  try {
    await writeFile(filePath, bytes, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readBoundedFile(filePath, {
      label: `Existing release metadata ${basename(filePath)}`,
      maxBytes,
    });
    if (!existing.bytes.equals(bytes)) {
      throw new Error(`Release metadata ${filePath} already exists with different content.`);
    }
  }
}

async function gitState(root, run) {
  try {
    const [commit, status] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 30000 }),
      run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30000 }),
    ]);
    return {
      available: true,
      commit_sha: commit.stdout.trim(),
      dirty: Boolean(status.stdout.trim()),
    };
  } catch (error) {
    return {
      available: false,
      commit_sha: null,
      dirty: true,
      error: sanitizeError(error),
    };
  }
}

export async function buildRelease(
  rootDirectory,
  outputDirectory,
  {
    qualificationBundle = null,
    allowDirty = false,
    run = runTool,
  } = {},
) {
  const root = resolve(rootDirectory);
  const requestedOutput = resolve(outputDirectory);
  await mkdir(requestedOutput, { recursive: true, mode: 0o700 });
  const outputMetadata = await lstat(requestedOutput);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("Release output must be a regular non-symlink directory.");
  }
  const output = await realpath(requestedOutput);
  const [packageJson, lock, security, doctor, source] = await Promise.all([
    readJson(join(root, "package.json"), "package manifest", {
      maxBytes: 4 * 1024 * 1024,
    }),
    readJson(join(root, "package-lock.json"), "package lock", {
      maxBytes: 16 * 1024 * 1024,
    }),
    auditRelease(root),
    buildDoctorReport(),
    gitState(root, run),
  ]);
  if (!security.passed) throw new Error("Release security/privacy/license audit has blockers.");
  if (!doctor.capabilities.release_tooling) throw new Error("Doctor release profile is not ready.");
  if (source.dirty && !allowDirty) throw new Error("Release packaging requires a clean git worktree.");
  const sbom = generateSbom(packageJson, lock);
  const stableVersion = /^\d+\.\d+\.\d+$/u.test(packageJson.version || "");
  const qualification = qualificationBundle
    ? validateReleaseEvidence(qualificationBundle, {
        expectedCommit: source.commit_sha,
      })
    : {
        passed: false,
        report_sha256: null,
        explicit_non_claim: "No release qualification bundle was supplied.",
      };
  const releaseLimitations = [];
  if (!qualification.passed) {
    releaseLimitations.push(
      qualification.explicit_non_claim
      || "The artifact lacks complete qualification evidence.",
    );
  }
  if (!stableVersion) {
    releaseLimitations.push(
      "The package version is a prerelease and cannot be promoted as a stable production release.",
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), "vr-3d-release-"));
  try {
    const packed = await run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      {
        cwd: root,
        timeoutMs: 120000,
        maxOutputBytes: 4 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_cache: join(temporary, "npm-cache"),
        },
      },
    );
    const packResult = JSON.parse(packed.stdout);
    if (!Array.isArray(packResult) || packResult.length !== 1) {
      throw new Error("npm pack did not return exactly one artifact.");
    }
    if (
      typeof packResult[0].filename !== "string"
      || basename(packResult[0].filename) !== packResult[0].filename
    ) {
      throw new Error("npm pack returned an unsafe artifact filename.");
    }
    const sourceArtifact = join(temporary, packResult[0].filename);
    const sourceArtifactEvidence = await hashBoundedFile(sourceArtifact, {
      label: "npm pack artifact",
      maxBytes: 2 * GiB,
    });
    const artifact = join(output, basename(sourceArtifact));
    try {
      await copyFile(sourceArtifact, artifact, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await hashBoundedFile(artifact, {
        label: "Existing release artifact",
        maxBytes: 2 * GiB,
      });
      if (existing.sha256 !== sourceArtifactEvidence.sha256) {
        throw new Error(`Release artifact ${artifact} already exists with different content.`);
      }
    }
    const artifactEvidence = await hashBoundedFile(artifact, {
      label: "Copied release artifact",
      maxBytes: 2 * GiB,
    });
    if (artifactEvidence.sha256 !== sourceArtifactEvidence.sha256) {
      throw new Error("Copied release artifact does not match the npm pack output.");
    }
    const sbomFile = join(output, `${packageJson.name}-${packageJson.version}.sbom.cdx.json`);
    await writeJsonExclusive(sbomFile, sbom, 64 * 1024 * 1024);
    const sbomEvidence = await hashBoundedFile(sbomFile, {
      label: "Release SBOM",
      maxBytes: 64 * 1024 * 1024,
    });
    const manifest = {
      schema_version: "1.0",
      package: {
        name: packageJson.name,
        version: packageJson.version,
        private: packageJson.private === true,
      },
      source,
      artifact: {
        file: basename(artifact),
        bytes: artifactEvidence.metadata.size,
        sha256: artifactEvidence.sha256,
        npm_shasum: packResult[0].shasum || null,
        npm_integrity: packResult[0].integrity || null,
      },
      sbom: {
        file: basename(sbomFile),
        sha256: sbomEvidence.sha256,
        document_sha256: sbom.document_sha256,
        components: sbom.components.length,
      },
      preflight: {
        security_passed: security.passed,
        security_report_sha256: security.report_sha256,
        doctor_release_ready: doctor.capabilities.release_tooling,
        qualification_passed: qualification.passed,
        qualification_report_sha256: qualification.report_sha256,
        clean_worktree: !source.dirty,
        stable_version: stableVersion,
      },
      release_ready:
        security.passed
        && doctor.capabilities.release_tooling
        && !source.dirty
        && qualification.passed
        && stableVersion,
      explicit_non_claim:
        releaseLimitations.length > 0
          ? releaseLimitations.join(" ")
          : null,
    };
    const withHash = { ...manifest, manifest_sha256: canonicalJsonSha256(manifest) };
    const manifestFile = join(output, `${packageJson.name}-${packageJson.version}.release.json`);
    await writeJsonExclusive(manifestFile, withHash, 4 * 1024 * 1024);
    return {
      artifact,
      sbomFile,
      manifestFile,
      manifest: withHash,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    root: { type: "string", default: "." },
    output: { type: "string", default: "dist" },
    qualification: { type: "string" },
    "allow-dirty": { type: "boolean" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/build-release.mjs [--output dist] [--qualification qualification-bundle.json] [--allow-dirty]\n");
    return;
  }
  const qualificationBundle = options.qualification
    ? await readJson(
        options.qualification,
        "release qualification bundle",
        { maxBytes: 64 * 1024 * 1024 },
      )
    : null;
  const result = await buildRelease(options.root, options.output, {
    qualificationBundle,
    allowDirty: options["allow-dirty"],
  });
  printJson({
    artifact: result.artifact,
    sbom: result.sbomFile,
    manifest: result.manifestFile,
    releaseReady: result.manifest.release_ready,
    explicitNonClaim: result.manifest.explicit_non_claim,
  });
  if (!result.manifest.release_ready) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

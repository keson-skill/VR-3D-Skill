import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildSourceManifest } from "../ingest/build-source-manifest.mjs";
import { writeJson } from "../lib/cli.mjs";
import { auditRelease } from "../security/audit-release.mjs";
import { createViewerServer } from "../serve-viewer.mjs";

async function writeDependencyFixture(directory, license = "MIT") {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({
      name: "security-fixture",
      version: "1.0.0",
      dependencies: { fixture: "1.0.0" },
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "package-lock.json"),
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { fixture: "1.0.0" } },
        "node_modules/fixture": {
          version: "1.0.0",
          license,
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
      },
    })}\n`,
    "utf8",
  );
}

test("source manifest and atomic output helpers enforce regular-file boundaries", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-source-limit-"));
  try {
    const input = join(directory, "plan.dxf");
    await writeFile(input, "0123456789", "utf8");
    const manifest = await buildSourceManifest([input], { maxFileBytes: 10 });
    assert.equal(manifest.sources[0].bytes, 10);
    assert.match(manifest.sources[0].sha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      buildSourceManifest([input], { maxFileBytes: 9 }),
      /exceeds the 9-byte limit/u,
    );
    const protectedFile = join(directory, "protected.json");
    const output = join(directory, "output.json");
    await writeFile(protectedFile, "{\"preserve\":true}\n", "utf8");
    try {
      await symlink(protectedFile, output);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      context.diagnostic("Atomic symlink replacement check skipped on this host.");
      return;
    }
    await writeJson(output, { replacement: true });
    assert.equal(await readFile(protectedFile, "utf8"), "{\"preserve\":true}\n");
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      replacement: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release audit passes clean inputs and reports dependency provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-security-clean-"));
  try {
    await writeDependencyFixture(directory);
    await writeFile(join(directory, "main.mjs"), "export const ready = true;\n", "utf8");
    const report = await auditRelease(directory, {
      filePaths: ["package.json", "package-lock.json", "main.mjs"],
    });
    assert.equal(report.passed, true, JSON.stringify(report.findings));
    assert.equal(report.dependencies[0].license, "MIT");
    assert.equal(report.dependencies[0].integrity_present, true);
    assert.match(report.report_sha256, /^[a-f0-9]{64}$/u);
    await mkdir(join(directory, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(directory, ".github", "workflows", "validate.yml"),
      "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
      "utf8",
    );
    const unpinned = await auditRelease(directory, {
      filePaths: [
        "package.json",
        "package-lock.json",
        ".github/workflows/validate.yml",
      ],
    });
    assert.equal(unpinned.passed, false);
    assert.ok(unpinned.findings.some((item) =>
      item.code === "workflow.action_unpinned"));
    await writeFile(
      join(directory, ".github", "workflows", "validate.yml"),
      "jobs:\n  delegated:\n    uses: owner/repository/.github/workflows/validate.yml@main\n",
      "utf8",
    );
    const reusable = await auditRelease(directory, {
      filePaths: [
        "package.json",
        "package-lock.json",
        ".github/workflows/validate.yml",
      ],
    });
    assert.equal(reusable.passed, false);
    assert.ok(reusable.findings.some((item) =>
      item.code === "workflow.action_unpinned"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release audit checks transitive dependency licenses and integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-security-transitive-"));
  try {
    await writeDependencyFixture(directory);
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    lock.packages["node_modules/transitive"] = {
      version: "2.0.0",
      license: "GPL-3.0-only",
      integrity: "not-an-sri",
    };
    await writeFile(
      join(directory, "package-lock.json"),
      `${JSON.stringify(lock)}\n`,
      "utf8",
    );
    const report = await auditRelease(directory, {
      filePaths: ["package.json", "package-lock.json"],
    });
    assert.equal(report.aggregate.dependencies_checked, 2);
    assert.equal(report.passed, false);
    assert.ok(report.dependencies.some((item) =>
      item.name === "transitive" && item.direct === false));
    assert.ok(report.findings.some((item) =>
      item.code === "license.dependency" && item.message.includes("transitive@2.0.0")));
    assert.ok(report.findings.some((item) =>
      item.code === "dependency.integrity" && item.message.includes("transitive@2.0.0")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release audit blocks secrets, tracked env files, and unapproved licenses without echoing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-security-block-"));
  try {
    await writeDependencyFixture(directory, "GPL-3.0-only");
    const credential = ["sk", "live", "A".repeat(28)].join("-");
    await writeFile(join(directory, ".env"), `API_KEY=${credential}\n`, "utf8");
    const report = await auditRelease(directory, {
      filePaths: ["package.json", "package-lock.json", ".env"],
    });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((item) => item.code === "secret.env_tracked"));
    assert.ok(report.findings.some((item) => item.code.startsWith("secret.")));
    assert.ok(report.findings.some((item) => item.code === "license.dependency"));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(credential, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("viewer server denies unsafe methods and paths and returns production security headers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p10-viewer-security-"));
  const outside = await mkdtemp(join(tmpdir(), "vr-3d-p10-viewer-outside-"));
  const server = createViewerServer(directory);
  try {
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Fixture</title>", "utf8");
    await writeFile(join(directory, ".env"), "SHOULD_NOT_BE_SERVED=true\n", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside\n", "utf8");
    try {
      await symlink(join(outside, "outside.txt"), join(directory, "linked.txt"));
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      context.diagnostic("Symlink containment check skipped on this host.");
    }
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy"), /object-src 'none'/u);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-inline/u);
    assert.match(response.headers.get("permissions-policy"), /xr-spatial-tracking/u);

    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/.env`)).status, 403);
    assert.equal((await fetch(`${base}/..%2Foutside.txt`)).status, 403);
    const linked = await fetch(`${base}/linked.txt`);
    if (linked.status !== 404) assert.equal(linked.status, 403);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

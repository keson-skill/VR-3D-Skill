#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  readJson,
  writeJson,
} from "../lib/cli.mjs";

function uuidFrom(value) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function packageName(path, record) {
  if (record.name) return record.name;
  return path.replace(/^node_modules\//u, "").split("/node_modules/").at(-1);
}

function packagePurl(name, version) {
  const path = name.startsWith("@") && name.includes("/")
    ? name.split("/").map((part) => encodeURIComponent(part)).join("/")
    : encodeURIComponent(name);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

function resolveDependencyPath(packages, parentPath, name) {
  let scope = parentPath;
  while (true) {
    const candidate = scope
      ? `${scope}/node_modules/${name}`
      : `node_modules/${name}`;
    if (packages[candidate]?.version) return candidate;
    if (!scope) return null;
    const marker = scope.lastIndexOf("/node_modules/");
    scope = marker >= 0 ? scope.slice(0, marker) : "";
  }
}

function cyclonedxLicense(value) {
  if (!value) return [];
  if (value === "UNLICENSED") {
    return [{ license: { name: "Proprietary; all rights reserved" } }];
  }
  if (/\s(?:AND|OR|WITH)\s|[()]/u.test(value)) {
    return [{ expression: value }];
  }
  return [{ license: { id: value } }];
}

export function generateSbom(packageJson, lock) {
  const lockedPackages = Object.entries(lock.packages || {})
    .filter(([path, record]) => path && record.version)
    .sort(([left], [right]) => left.localeCompare(right));
  const references = new Map(
    lockedPackages.map(([path, record]) => [
      path,
      `urn:uuid:${uuidFrom(
        `component:${path}:${packageName(path, record)}@${record.version}`,
      )}`,
    ]),
  );
  const components = lockedPackages
    .map(([path, record]) => {
      const name = packageName(path, record);
      const purl = packagePurl(name, record.version);
      return {
        type: "library",
        "bom-ref": references.get(path),
        name,
        version: record.version,
        licenses: cyclonedxLicense(record.license),
        purl,
        properties: [
          {
            name: "vr3d:lockfile-path",
            value: path,
          },
          {
            name: "vr3d:integrity",
            value: record.integrity || "missing",
          },
        ],
      };
    })
    .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
  const rootRef = packagePurl(packageJson.name, packageJson.version);
  const dependencyGraph = [
    {
      ref: rootRef,
      dependsOn: Object.keys(packageJson.dependencies || {})
        .map((name) =>
          references.get(resolveDependencyPath(lock.packages || {}, "", name)))
        .filter(Boolean)
        .sort(),
    },
    ...lockedPackages.map(([path, record]) => ({
      ref: references.get(path),
      dependsOn: [
        ...new Set([
          ...Object.keys(record.dependencies || {}),
          ...Object.keys(record.optionalDependencies || {}),
        ].map((name) =>
          references.get(resolveDependencyPath(lock.packages || {}, path, name)))
          .filter(Boolean)),
      ].sort(),
    })),
  ].sort((left, right) => left.ref.localeCompare(right.ref));
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${uuidFrom(`${packageJson.name}@${packageJson.version}`)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: packageJson.name,
        version: packageJson.version,
        licenses: cyclonedxLicense(packageJson.license),
        purl: rootRef,
      },
      properties: [
        { name: "vr3d:lockfileVersion", value: String(lock.lockfileVersion) },
      ],
    },
    components,
    dependencies: dependencyGraph,
  };
  return { ...document, document_sha256: canonicalJsonSha256(document) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    package: { type: "string", default: "package.json" },
    lock: { type: "string", default: "package-lock.json" },
    output: { type: "string", default: "release/sbom.cdx.json" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/release/generate-sbom.mjs [--output release/sbom.cdx.json]\n");
    return;
  }
  const [packageJson, lock] = await Promise.all([
    readJson(options.package, "package manifest", { maxBytes: 4 * 1024 * 1024 }),
    readJson(options.lock, "package lock", { maxBytes: 16 * 1024 * 1024 }),
  ]);
  const sbom = generateSbom(packageJson, lock);
  await writeJson(options.output, sbom);
  printJson({
    outputFile: options.output,
    components: sbom.components.length,
    documentSha256: sbom.document_sha256,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

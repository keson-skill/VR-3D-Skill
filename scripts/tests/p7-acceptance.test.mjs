import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { renderDeliverables } from "../tasks/blender/render-deliverables.mjs";
import { runP7Acceptance } from "../validation/run-p7-acceptance.mjs";

test("passes twenty P7 Blender and panorama contract fixtures", async () => {
  const report = await runP7Acceptance();
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
});

test("render orchestrator records version, hashes artifacts, and reuses a completed checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p7-"));
  try {
    const fakeBlender = join(directory, "fake-blender.mjs");
    const source = `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
if (process.argv.includes("--version")) {
  process.stdout.write("Blender 4.3.2 fake\\n");
  process.exit(0);
}
const planFile = process.argv[process.argv.indexOf("--") + 1];
const plan = JSON.parse(await readFile(planFile, "utf8"));
for (const item of plan.stills) {
  await mkdir(dirname(join(plan.output_directory, item.file)), { recursive: true });
  await writeFile(join(plan.output_directory, item.file), item.camera_id);
}
await mkdir(dirname(join(plan.output_directory, plan.panorama.file)), { recursive: true });
await writeFile(join(plan.output_directory, plan.panorama.file), "panorama");
await writeFile(join(plan.output_directory, plan.blend_file), "blend");
if (plan.optional_walkthrough.enabled) {
  await mkdir(dirname(join(plan.output_directory, plan.optional_walkthrough.file)), { recursive: true });
  await writeFile(join(plan.output_directory, plan.optional_walkthrough.file), "walkthrough");
}
await writeFile(join(plan.output_directory, plan.checkpoint_file), JSON.stringify({
  state: "completed",
  detail: { plan_sha256: plan.plan_sha256 },
  history: [{ state: "completed" }]
}));
`;
    await writeFile(fakeBlender, source, "utf8");
    await chmod(fakeBlender, 0o755);
    const fixtureSuite = JSON.parse(
      await readFile(new URL("../../examples/p7-acceptance/fixtures.json", import.meta.url), "utf8"),
    );
    const sceneFile = join(directory, "scene.glb");
    await writeFile(sceneFile, "fake glb");
    const outputDirectory = join(directory, "render");
    const first = await renderDeliverables(fixtureSuite.fixtures[0].spatial, {
      sceneFile,
      outputDirectory,
      blender: fakeBlender,
      walkthrough: true,
    });
    assert.equal(first.resumed, false);
    assert.equal(first.manifest.blender_version, "Blender 4.3.2 fake");
    assert.equal(first.manifest.artifacts.length, first.plan.stills.length + 3);
    assert.ok(first.manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256)));

    const second = await renderDeliverables(fixtureSuite.fixtures[0].spatial, {
      sceneFile,
      outputDirectory,
      blender: "/definitely/not/needed/on-resume",
      walkthrough: true,
    });
    assert.equal(second.resumed, true);
    assert.deepEqual(second.manifest, first.manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

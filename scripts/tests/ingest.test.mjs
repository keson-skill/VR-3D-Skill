import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { detectInput } from "../ingest/detect-input.mjs";
import { extractDxfEvidence } from "../ingest/extract-dxf-evidence.mjs";
import { prepareInteriorJob } from "../orchestration/prepare-interior-job.mjs";

const MINIMAL_DXF = [
  "0", "SECTION",
  "2", "HEADER",
  "9", "$INSUNITS",
  "70", "6",
  "0", "ENDSEC",
  "0", "SECTION",
  "2", "ENTITIES",
  "0", "LINE",
  "8", "WALL",
  "10", "0",
  "20", "0",
  "30", "0",
  "11", "4",
  "21", "0",
  "31", "0",
  "0", "ENDSEC",
  "0", "EOF",
].join("\n");

test("routes current and conversion-required input formats", () => {
  assert.deepEqual(detectInput("plan.dxf").route, "dxf");
  assert.deepEqual(detectInput("plan.PNG").route, "image");
  assert.deepEqual(detectInput("plan.dwg").route, "convert_dwg_to_dxf");
  assert.equal(detectInput("plan.unknown").supported_now, false);
});

test("extracts vector evidence and drawing units from DXF", () => {
  const evidence = extractDxfEvidence(MINIMAL_DXF);
  assert.equal(evidence.entity_counts.LINE, 1);
  assert.deepEqual(evidence.entities[0].vertices, [[0, 0], [4, 0]]);
  assert.equal(evidence.coordinate_system.drawing_units, "meters");
  assert.equal(evidence.coordinate_system.requires_scale_confirmation, false);
});

test("prepares a raster and DXF job without an external provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-ingest-"));
  try {
    const image = join(directory, "plan.png");
    const dxf = join(directory, "plan.dxf");
    await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: "#ffffff",
      },
    }).png().toFile(image);
    await writeFile(dxf, MINIMAL_DXF, "utf8");
    const output = join(directory, "job");
    const job = await prepareInteriorJob([image, dxf], {
      outputDirectory: output,
      maxEdge: 512,
    });
    assert.equal(job.stage, "prepared");
    assert.equal(job.routes.length, 2);
    assert.equal(job.routes[0].evidence[0].type, "normalized_raster");
    assert.equal(job.routes[1].evidence[0].drawing_units, "meters");
    assert.equal((await stat(join(output, "job.json"))).isFile(), true);
    const manifest = JSON.parse(
      await readFile(join(output, "source-manifest.json"), "utf8"),
    );
    assert.equal(manifest.prepared_sources.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

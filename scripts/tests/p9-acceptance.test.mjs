import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import sharp from "sharp";
import { buildGlb } from "../builders/glb-writer.mjs";
import { compileScenePrimitives } from "../geometry/spatial-geometry.mjs";
import { convertDwgToDxf } from "../ingest/convert-dwg-to-dxf.mjs";
import {
  analyzePointCloud,
  convertPointCloudToAscii,
  detectOpeningCandidates,
  extractDepthEvidence,
  extractPointCloudEvidence,
  pointCloudEvidenceToSpatial,
} from "../ingest/extract-point-cloud-evidence.mjs";
import {
  buildSceneImportContract,
  inspectExistingScene,
} from "../ingest/inspect-existing-scene.mjs";
import { inspectPdf } from "../ingest/inspect-pdf.mjs";
import {
  buildVisualReconstructionEvidence,
  inspectImageMedia,
  inspectVideoMedia,
} from "../ingest/inspect-visual-media.mjs";
import { importProductCatalog } from "../ingest/import-product-catalog.mjs";
import { inspectTool, runTool } from "../ingest/tool-runner.mjs";
import { prepareInteriorJob } from "../orchestration/prepare-interior-job.mjs";
import {
  buildVisualReconstructionPrompt,
  extractVisualSpatial,
  validateVisualReconstructionResult,
} from "../tasks/visual-reconstruction/extract-visual-spatial.mjs";
import { runP9Acceptance } from "../validation/run-p9-acceptance.mjs";
import { validateSpatialJson } from "../validation/validate-spatial-json.mjs";

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
  "11", "4",
  "21", "0",
  "0", "ENDSEC",
  "0", "EOF",
].join("\n");

function buildPdf(objects) {
  const chunks = [Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n", "binary")];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const header = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "ascii");
    const footer = Buffer.from("\nendobj\n", "ascii");
    chunks.push(header, body, footer);
    length += header.length + body.length + footer.length;
  });
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function vectorPdf() {
  const content = "0 0 0 RG 50 50 500 700 re S BT /F1 16 Tf 72 720 Td (Room 4.0m) Tj ET";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function scannedPdf(jpeg, width, height) {
  const content = "q 612 0 0 792 0 0 cm /Im0 Do Q";
  const image = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "ascii"),
    jpeg,
    Buffer.from("\nendstream", "ascii"),
  ]);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    image,
  ]);
}

function registrationFor(views) {
  return {
    views: views.map((view, index) => ({
      source_sha256: view.sha256,
      intrinsics: { fx: 900, fy: 900, cx: 400, cy: 300 },
      camera_to_world: [
        1, 0, 0, index,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
    })),
    rms_reprojection_error_px: 1.2,
    scale: { anchor_id: "wall-01", meters_per_unit: 1 },
  };
}

function pointCloudText() {
  const points = [];
  for (let index = 0; index < 6000; index += 1) {
    const u = (index % 100) / 99;
    const v = (Math.floor(index / 100) % 60) / 59;
    const face = index % 5;
    if (face === 0) points.push(`${u * 4} 0 ${v * 3}`);
    else if (face === 1) points.push(`0 ${v * 2.8} ${u * 3}`);
    else if (face === 2) points.push(`4 ${v * 2.8} ${u * 3}`);
    else if (face === 3) points.push(`${u * 4} ${v * 2.8} 0`);
    else points.push(`${u * 4} ${v * 2.8} 3`);
  }
  return points.join("\n");
}

test("passes thirty-three P9 normal, boundary, and failure route fixtures", async () => {
  const report = await runP9Acceptance();
  assert.equal(report.passed, true, JSON.stringify(report.aggregate));
});

test("catalog table route preserves quoted fields and rejects forbidden licenses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-catalog-"));
  try {
    const header = "id,kind,uri,format,source,license,units,pivot,forward_axis,optimized,collision_proxy,dimension_x,dimension_y,dimension_z\n";
    const validFile = join(directory, "catalog.csv");
    await writeFile(
      validFile,
      `${header}chair-001,chair,\"assets/chair,blue.glb\",glb,licensed_catalog,commercial,meters,bottom_center,-Z,true,true,0.6,0.8,0.6\n`,
      "utf8",
    );
    const valid = await importProductCatalog(validFile);
    assert.equal(valid.report.valid, true, JSON.stringify(valid.report.errors));
    assert.equal(valid.catalog.assets[0].uri, "assets/chair,blue.glb");

    const forbiddenFile = join(directory, "forbidden.tsv");
    await writeFile(
      forbiddenFile,
      header.replaceAll(",", "\t")
        + "chair-002\tchair\tassets/chair.glb\tglb\tlicensed_catalog\tforbidden\tmeters\tbottom_center\t-Z\ttrue\ttrue\t0.6\t0.8\t0.6\n",
      "utf8",
    );
    const forbidden = await importProductCatalog(forbiddenFile);
    assert.equal(forbidden.report.valid, false);
    assert.ok(forbidden.report.errors.some((error) => error.path.endsWith("/license")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DWG route requires approval and validates the converted DXF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-dwg-"));
  try {
    const input = join(directory, "plan.dwg");
    const output = join(directory, "plan.dxf");
    await writeFile(input, Buffer.from("AC1032 fixture DWG payload"));
    await assert.rejects(
      convertDwgToDxf(input, output, {
        command: "fixture-converter",
        argumentsTemplate: ["{input}", "{output}"],
        converterApproved: false,
      }),
      /explicit approval/u,
    );
    const result = await convertDwgToDxf(input, output, {
      command: "fixture-converter",
      argumentsTemplate: ["{input}", "{output}"],
      converterApproved: true,
      run: async (_command, args) => {
        if (args.includes("--version")) return { stdout: "Fixture DWG Converter 1.0\n", stderr: "" };
        await writeFile(args[1], MINIMAL_DXF, "utf8");
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(result.source.dwg_version, "2018+");
    assert.equal(result.dxf_evidence.coordinate_system.drawing_units, "meters");
    assert.match(result.output.sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Poppler route distinguishes an actual vector PDF from an actual scanned PDF", async (context) => {
  const required = await Promise.all(
    ["pdfinfo", "pdfimages", "pdftotext", "pdftocairo", "pdftoppm"].map((command) =>
      inspectTool(command, ["-v"])),
  );
  if (required.some((status) => !status.available)) {
    context.skip("Poppler tools are not installed.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-pdf-"));
  try {
    const vector = join(directory, "vector.pdf");
    const scanned = join(directory, "scanned.pdf");
    await writeFile(vector, vectorPdf());
    const jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#eeeeee" },
    }).jpeg().toBuffer();
    await writeFile(scanned, scannedPdf(jpeg, 800, 600));
    const vectorEvidence = await inspectPdf(vector, join(directory, "vector-evidence"));
    const scannedEvidence = await inspectPdf(scanned, join(directory, "scanned-evidence"));
    assert.equal(vectorEvidence.pages[0].classification, "vector");
    assert.equal(scannedEvidence.pages[0].classification, "scanned");
    assert.ok(scannedEvidence.pages[0].raster?.normalized_path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual route validates panorama geometry, multiview registration, and video frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-visual-"));
  try {
    const views = [];
    for (let index = 0; index < 3; index += 1) {
      const file = join(directory, `view-${index + 1}.jpg`);
      await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 80 + index * 30, g: 100, b: 140 },
        },
      }).jpeg().toFile(file);
      views.push(await inspectImageMedia(file, "multiview"));
    }
    const evidence = buildVisualReconstructionEvidence(views, {
      registration: registrationFor(views),
    });
    assert.equal(evidence.blockers.length, 0, JSON.stringify(evidence.blockers));
    assert.equal(evidence.camera_registration.status, "validated");

    const panorama = join(directory, "panorama.jpg");
    await sharp({
      create: { width: 1024, height: 512, channels: 3, background: "#777777" },
    }).jpeg().toFile(panorama);
    assert.equal((await inspectImageMedia(panorama, "panorama")).blockers.length, 0);

    const video = join(directory, "video.mp4");
    await writeFile(video, "fixture video");
    const videoEvidence = await inspectVideoMedia(video, join(directory, "frames"), {
      run: async (command, args) => {
        if (args[0] === "-version") return { stdout: `${command} fixture 1.0\n`, stderr: "" };
        if (command === "ffprobe") {
          return {
            stdout: JSON.stringify({
              streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "30/1" }],
              format: { duration: "4.0" },
            }),
            stderr: "",
          };
        }
        const pattern = args.at(-1);
        await sharp({
          create: { width: 800, height: 600, channels: 3, background: "#999999" },
        }).png().toFile(pattern.replace("%04d", "0001"));
        await sharp({
          create: { width: 800, height: 600, channels: 3, background: "#aaaaaa" },
        }).png().toFile(pattern.replace("%04d", "0002"));
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(videoEvidence.extracted_frames.length, 2);
    assert.equal(videoEvidence.blockers.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFmpeg route extracts frames from an actual generated video when available", async (context) => {
  const required = await Promise.all([
    inspectTool("ffmpeg", ["-version"]),
    inspectTool("ffprobe", ["-version"]),
  ]);
  if (required.some((status) => !status.available)) {
    context.skip("FFmpeg tools are not installed.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-real-video-"));
  try {
    const video = join(directory, "generated.mp4");
    await runTool("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=gray:size=640x480:rate=5",
      "-t", "4",
      "-c:v", "mpeg4",
      "-pix_fmt", "yuv420p",
      "-y",
      video,
    ], { timeoutMs: 60000 });
    const evidence = await inspectVideoMedia(video, join(directory, "frames"), {
      frameIntervalSeconds: 1,
      maxFrames: 10,
    });
    assert.equal(evidence.blockers.length, 0, JSON.stringify(evidence.blockers));
    assert.ok(evidence.extracted_frames.length >= 2);
    assert.match(evidence.tools.ffmpeg, /ffmpeg/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("point-cloud and depth routes preserve metric evidence and quality blockers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-points-"));
  try {
    const xyz = join(directory, "room.xyz");
    await writeFile(xyz, pointCloudText(), "utf8");
    const pointEvidence = await extractPointCloudEvidence(xyz, {
      unitScale: 1,
      upAxis: "Y",
      voxelSize: 0,
      scaleConfirmed: true,
    });
    assert.equal(pointEvidence.quality.geometry_quality_passed, true, JSON.stringify(pointEvidence.quality.blockers));
    assert.equal(pointEvidence.quality.construction_ready, false);
    assert.ok(pointEvidence.planes.some((plane) => plane.kind === "floor"));
    assert.ok(pointEvidence.planes.filter((plane) => plane.kind === "wall").length >= 2);

    const depth = join(directory, "depth.png");
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#808080" },
    }).png().toFile(depth);
    const depthEvidence = await extractDepthEvidence(
      depth,
      { fx: 60, fy: 60, cx: 32, cy: 24 },
      { depthScaleMeters: 0.00001, sampleStep: 4, scaleConfirmed: true },
    );
    assert.equal(depthEvidence.route, "depth_image");
    assert.ok(depthEvidence.source_points > 4);
    assert.equal(depthEvidence.quality.construction_ready, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("binary point-cloud conversion is approval-gated and preserves converter evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-pdal-"));
  try {
    const input = join(directory, "scan.laz");
    const output = join(directory, "scan.ply");
    await writeFile(input, Buffer.from("fixture binary scan"));
    await assert.rejects(
      convertPointCloudToAscii(input, output, {
        command: "fixture-pdal",
        converterApproved: false,
      }),
      /explicit approval/u,
    );
    const result = await convertPointCloudToAscii(input, output, {
      command: "fixture-pdal",
      converterApproved: true,
      extractionOptions: {
        scaleConfirmed: true,
        voxelSize: 0,
      },
      run: async (_command, args) => {
        if (args[0] === "--version") {
          return { stdout: "PDAL fixture 1.0\n", stderr: "" };
        }
        const points = [
          "ply",
          "format ascii 1.0",
          "element vertex 4",
          "property float x",
          "property float y",
          "property float z",
          "end_header",
          "0 0 0",
          "1 0 0",
          "0 1 0",
          "0 0 1",
        ].join("\n");
        await writeFile(args[2], points, "utf8");
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(result.converter.version, "PDAL fixture 1.0");
    assert.match(result.output.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.evidence.source_points, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("point-cloud planes expose reviewable opening candidates and a pending Spatial draft", () => {
  const points = [];
  for (let xIndex = 0; xIndex <= 80; xIndex += 1) {
    for (let zIndex = 0; zIndex <= 60; zIndex += 1) {
      points.push([xIndex * 0.05, 0, zIndex * 0.05]);
    }
  }
  for (let horizontal = 0; horizontal <= 80; horizontal += 1) {
    for (let vertical = 0; vertical <= 56; vertical += 1) {
      const x = horizontal * 0.05;
      const y = vertical * 0.05;
      const doorGap = x >= 1.2 && x <= 2.1 && y <= 2.1;
      if (!doorGap) points.push([x, y, 0]);
      points.push([x, y, 3]);
    }
  }
  for (let horizontal = 0; horizontal <= 60; horizontal += 1) {
    for (let vertical = 0; vertical <= 56; vertical += 1) {
      const z = horizontal * 0.05;
      const y = vertical * 0.05;
      points.push([0, y, z], [4, y, z]);
    }
  }
  const evidence = analyzePointCloud(points, {
    scaleConfirmed: true,
    voxelSize: 0,
    planeTolerance: 0.05,
  });
  const directCandidates = detectOpeningCandidates(points, evidence.bounds);
  assert.ok(directCandidates.some((candidate) =>
    candidate.host_wall_candidate_id === "wall-z-min"
    && candidate.width_meters >= 0.8));
  assert.ok(evidence.opening_candidates.length > 0);
  const spatial = pointCloudEvidenceToSpatial(evidence, {
    projectId: "point-cloud-project",
  });
  const validation = validateSpatialJson(spatial);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(spatial.validation.status, "pending");
  assert.ok(spatial.unresolved_questions.length > 0);
});

test("existing 3D route imports named semantics and blocks unsafe external resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-scene-"));
  try {
    const safe = join(directory, "safe.gltf");
    await writeFile(safe, JSON.stringify({
      asset: { version: "2.0" },
      accessors: [{ type: "VEC3", min: [0, 0, 0], max: [4, 2.8, 3] }],
      nodes: [{ name: "Wall_Main", mesh: 0 }],
      meshes: [{ primitives: [{}] }],
      scenes: [{ nodes: [0] }],
    }), "utf8");
    const safeInspection = await inspectExistingScene(safe);
    const safeContract = buildSceneImportContract(safeInspection, { mode: "spatial_reference" });
    assert.equal(safeContract.blockers.length, 0, JSON.stringify(safeContract.blockers));
    assert.equal(safeContract.spatial_semantics[0].kind, "wall");

    const resource = join(directory, "mesh.bin");
    await writeFile(resource, Buffer.from([0, 1, 2, 3]));
    const packaged = join(directory, "packaged.gltf");
    await writeFile(packaged, JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin", byteLength: 4 }],
      accessors: [{ type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
      nodes: [{ name: "Wall", mesh: 0 }],
      meshes: [{ primitives: [{}] }],
    }), "utf8");
    const packagedInspection = await inspectExistingScene(packaged);
    assert.equal(packagedInspection.blockers.length, 0, JSON.stringify(packagedInspection.blockers));
    assert.match(packagedInspection.external_resources[0].sha256, /^[a-f0-9]{64}$/u);

    const unsafe = join(directory, "unsafe.gltf");
    await writeFile(unsafe, JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "https://example.com/model.bin", byteLength: 1 }],
      accessors: [{ type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
      nodes: [{ name: "Wall", mesh: 0 }],
      meshes: [{ primitives: [{}] }],
    }), "utf8");
    const unsafeContract = buildSceneImportContract(
      await inspectExistingScene(unsafe),
      { mode: "spatial_reference" },
    );
    assert.ok(unsafeContract.blockers.some((blocker) => blocker.includes("unsafe URI")));

    const traversal = join(directory, "traversal.gltf");
    await writeFile(traversal, JSON.stringify({
      asset: { version: "2.0" },
      images: [{ uri: "..\\private\\texture.png" }],
      accessors: [{ type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
      nodes: [{ name: "Wall", mesh: 0 }],
      meshes: [{ primitives: [{}] }],
    }), "utf8");
    const traversalInspection = await inspectExistingScene(traversal);
    assert.ok(traversalInspection.blockers.some((blocker) => blocker.includes("unsafe URI")));

    const obj = join(directory, "chair.obj");
    await writeFile(obj, "o Chair\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "utf8");
    const unknownAxes = await inspectExistingScene(obj, { unitScale: 1 });
    assert.ok(unknownAxes.blockers.some((blocker) => blocker.includes("up axis")));
    const approvedAxes = await inspectExistingScene(obj, {
      unitScale: 1,
      upAxis: "Y",
      forwardAxis: "-Z",
      handedness: "right",
    });
    assert.equal(approvedAxes.blockers.length, 0, JSON.stringify(approvedAxes.blockers));
    const missingAssetId = buildSceneImportContract(approvedAxes, {
      mode: "asset",
      license: "commercial",
      pivot: "bottom_center",
      collisionProxy: true,
    });
    assert.ok(missingAssetId.blockers.some((blocker) => blocker.includes("asset ID")));
    const approvedAsset = buildSceneImportContract(approvedAxes, {
      mode: "asset",
      assetId: "chair-001",
      license: "commercial",
      pivot: "bottom_center",
      collisionProxy: true,
    });
    assert.equal(approvedAsset.blockers.length, 0, JSON.stringify(approvedAsset.blockers));
    assert.equal(approvedAsset.asset.collision_proxy, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job preparation validates direct Spatial JSON and executes an approved FBX converter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-job-"));
  try {
    const fixtureSuite = JSON.parse(
      await readFile(new URL("../../examples/p8-acceptance/fixtures.json", import.meta.url), "utf8"),
    );
    const spatial = fixtureSuite.fixtures[0].spatial;
    const spatialFile = join(directory, "spatial.json");
    await writeFile(spatialFile, `${JSON.stringify(spatial)}\n`, "utf8");
    const spatialJob = await prepareInteriorJob([spatialFile], {
      outputDirectory: join(directory, "spatial-job"),
    });
    assert.equal(spatialJob.stage, "prepared", JSON.stringify(spatialJob.blockers));
    assert.equal(spatialJob.routes[0].evidence[0].valid, true);

    const invalidFile = join(directory, "invalid.json");
    await writeFile(invalidFile, "{}\n", "utf8");
    const invalidJob = await prepareInteriorJob([invalidFile], {
      outputDirectory: join(directory, "invalid-job"),
    });
    assert.equal(invalidJob.stage, "blocked");
    assert.ok(invalidJob.blockers.some((blocker) => blocker.route === "spatial_json"));

    const fbx = join(directory, "room.fbx");
    await writeFile(fbx, Buffer.from("Kaydara FBX Binary  \u0000\u001a\u0000 fixture", "binary"));
    const glb = buildGlb(spatial, compileScenePrimitives(spatial));
    const fbxJob = await prepareInteriorJob([fbx], {
      outputDirectory: join(directory, "fbx-job"),
      sceneImport: {
        mode: "spatial_reference",
        converter: {
          command: "fixture-scene-converter",
          argumentsTemplate: ["convert", "{input}", "{output}"],
          converterApproved: true,
          run: async (_command, args) => {
            if (args.includes("--version")) {
              return { stdout: "Fixture scene converter 1.0\n", stderr: "" };
            }
            await writeFile(args.at(-1), glb);
            return { stdout: "", stderr: "" };
          },
        },
      },
    });
    assert.equal(fbxJob.stage, "prepared", JSON.stringify(fbxJob.blockers));
    const sceneContract = JSON.parse(
      await readFile(fbxJob.routes[0].evidence[0].path, "utf8"),
    );
    assert.equal(sceneContract.inspection.conversion.converter.version, "Fixture scene converter 1.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual reconstruction contract keeps observed and inferred geometry unapproved", async () => {
  const fixtureSuite = JSON.parse(
    await readFile(new URL("../../examples/p8-acceptance/fixtures.json", import.meta.url), "utf8"),
  );
  const spatial = structuredClone(fixtureSuite.fixtures[0].spatial);
  spatial.extraction = {
    ...spatial.extraction,
    source_kind: "visual",
    method: "registered_multiview_visual_reconstruction",
    recommended_scope: "visualization_only",
    topology_confidence: 0.75,
  };
  spatial.validation = { status: "pending", approved_scope: null, checks: [] };
  const evidence = {
    views: [{
      id: "view-001",
      path: "/private/customer/room.jpg",
      sha256: "a".repeat(64),
      role: "interior_photo",
      blockers: [],
    }],
    videos: [{
      id: "video-private",
      stored_path: "/private/customer/video.mp4",
      extracted_frames: [{ normalized_path: "/private/customer/frame.png" }],
    }],
    blockers: [],
  };
  const result = {
    camera_estimates: [{
      view_id: "view-001",
      projection: "perspective",
      intrinsics: { fx: 900, fy: 900, cx: 400, cy: 300 },
      confidence: 0.8,
    }],
    visible_surfaces: [{
      id: "surface-observed-001",
      kind: "wall",
      view_ids: ["view-001"],
      confidence: 0.8,
    }],
    fixed_objects: [],
    inferred_geometry: [{
      id: "inference-hidden-wall",
      reason: "not visible",
      confidence: 0.3,
    }],
    spatial_json: spatial,
  };
  const validation = validateVisualReconstructionResult(result, evidence);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const prompt = buildVisualReconstructionPrompt(evidence, "project-visual");
  assert.doesNotMatch(prompt, /private\/customer/u);
  assert.match(prompt, /visualization_only/u);

  result.spatial_json.validation = {
    status: "approved",
    approved_scope: "construction_ready",
    checks: [],
  };
  assert.equal(validateVisualReconstructionResult(result, evidence).valid, false);
});

test("visual reconstruction verifies evidence image count and content hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vr-3d-p9-visual-hash-"));
  try {
    const image = join(directory, "view.png");
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#777777" },
    }).png().toFile(image);
    const view = await inspectImageMedia(image, "interior_photo");
    const evidence = {
      views: [view],
      blockers: [],
    };
    await assert.rejects(
      extractVisualSpatial(evidence, [], "visual-hash", {
        generate: async () => ({}),
      }),
      /exactly one image path/u,
    );
    const different = join(directory, "different.png");
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#888888" },
    }).png().toFile(different);
    await assert.rejects(
      extractVisualSpatial(evidence, [different], "visual-hash", {
        generate: async () => ({}),
      }),
      /does not match visual evidence SHA-256/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

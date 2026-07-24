#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonSha256,
  parseArgs,
  printJson,
  writeJson,
} from "../lib/cli.mjs";
import { inspectDwgHeader } from "../ingest/convert-dwg-to-dxf.mjs";
import { detectInput } from "../ingest/detect-input.mjs";
import {
  extractIfcEvidence,
  ifcEvidenceToSpatial,
} from "../ingest/extract-ifc-evidence.mjs";
import { catalogFromRows } from "../ingest/import-product-catalog.mjs";
import { analyzePointCloud } from "../ingest/extract-point-cloud-evidence.mjs";
import {
  buildSceneImportContract,
  inspectGltfDocument,
  inspectObjText,
} from "../ingest/inspect-existing-scene.mjs";
import { classifyPdfPage } from "../ingest/inspect-pdf.mjs";
import {
  buildVisualReconstructionEvidence,
} from "../ingest/inspect-visual-media.mjs";
import { validateSpatialJson } from "./validate-spatial-json.mjs";

const DEFAULT_FIXTURES = new URL("../../examples/p9-acceptance/fixtures.json", import.meta.url);

function closedIfc({ unit = true, closed = true } = {}) {
  const points = closed
    ? [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]
    : [[0, 0], [4, 0], [4, 3], [0, 3], [1, 1]];
  const entities = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('fixture.ifc','2026-07-24T00:00:00',(),(),'', '', '');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...(unit ? ["#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);"] : []),
    "#2=IFCCARTESIANPOINT((0.,0.,0.));",
    "#3=IFCAXIS2PLACEMENT3D(#2,$,$);",
    "#4=IFCLOCALPLACEMENT($,#3);",
    "#5=IFCBUILDINGSTOREY('storey-1',$,'Level 1',$,$,#4,$,'Ground floor',.ELEMENT.,0.);",
    "#6=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60min'),$);",
    "#7=IFCPROPERTYSET('pset-wall',$,'Pset_WallCommon',$,(#6));",
  ];
  let nextId = 10;
  const wallReferences = [];
  for (let index = 0; index < 4; index += 1) {
    const pointA = nextId++;
    const pointB = nextId++;
    const polyline = nextId++;
    const shape = nextId++;
    const productShape = nextId++;
    const wall = nextId++;
    wallReferences.push(`#${wall}`);
    entities.push(
      `#${pointA}=IFCCARTESIANPOINT((${points[index][0]},${points[index][1]},0.));`,
      `#${pointB}=IFCCARTESIANPOINT((${points[index + 1][0]},${points[index + 1][1]},0.));`,
      `#${polyline}=IFCPOLYLINE((#${pointA},#${pointB}));`,
      `#${shape}=IFCSHAPEREPRESENTATION($,$,$,(#${polyline}));`,
      `#${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}));`,
      `#${wall}=IFCWALL('wall-${index + 1}',$,'Wall ${index + 1}',$,$,#4,#${productShape},$,$);`,
    );
  }
  entities.push(
    `#200=IFCRELCONTAINEDINSPATIALSTRUCTURE('containment',$,$,$,(${wallReferences.join(",")}),#5);`,
    `#201=IFCRELDEFINESBYPROPERTIES('properties',$,$,$,(${wallReferences[0]}),#7);`,
  );
  entities.push("ENDSEC;", "END-ISO-10303-21;");
  return entities.join("\n");
}

function syntheticViews(count, { panorama = false, duplicate = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `view-${index + 1}`,
    sha256: duplicate ? "a".repeat(64) : String(index + 1).repeat(64).slice(0, 64),
    role: panorama ? "panorama" : count > 1 ? "multiview" : "interior_photo",
    width: panorama ? 2048 : 1280,
    height: panorama ? 1024 : 720,
    blockers: [],
    warnings: [],
  }));
}

function registrationFor(views, error = 1) {
  return {
    views: views.map((view, index) => ({
      source_sha256: view.sha256,
      intrinsics: { fx: 1000, fy: 1000, cx: 640, cy: 360 },
      camera_to_world: [
        1, 0, 0, index,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
    })),
    rms_reprojection_error_px: error,
    scale: { anchor_id: "scale-wall-01", meters_per_unit: 1 },
  };
}

function roomSurfacePoints(count = 6000) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const u = (index % 100) / 99;
    const v = (Math.floor(index / 100) % 60) / 59;
    const face = index % 5;
    if (face === 0) points.push([u * 4, 0, v * 3]);
    else if (face === 1) points.push([0, v * 2.8, u * 3]);
    else if (face === 2) points.push([4, v * 2.8, u * 3]);
    else if (face === 3) points.push([u * 4, v * 2.8, 0]);
    else points.push([u * 4, v * 2.8, 3]);
  }
  return points;
}

function gltfFixture(classified = true) {
  return {
    asset: { version: "2.0" },
    accessors: [{ type: "VEC3", min: [0, 0, 0], max: [4, 2.8, 3] }],
    nodes: [{ name: classified ? "Wall_Main" : "Object001", mesh: 0 }],
    meshes: [{ primitives: [{}] }],
    scenes: [{ nodes: [0] }],
  };
}

function evaluateFixture(fixture) {
  if (fixture.category === "dwg") {
    const signature = fixture.case === "normal" ? "AC1032" : fixture.case === "boundary" ? "AC1009" : "NOTDW";
    return inspectDwgHeader(Buffer.from(`${signature} fixture`)).valid;
  }
  if (fixture.category === "vector_pdf") {
    const classification = classifyPdfPage(
      fixture.case === "normal"
        ? { vectorElements: 20, embeddedImages: 0, textWords: 10 }
        : fixture.case === "boundary"
          ? { vectorElements: 1, embeddedImages: 0, textWords: 0 }
          : { vectorElements: 0, embeddedImages: 0, textWords: 0 },
    );
    return classification === "vector";
  }
  if (fixture.category === "scanned_pdf") {
    const classification = classifyPdfPage(
      fixture.case === "normal"
        ? { vectorElements: 0, embeddedImages: 1, textWords: 0 }
        : fixture.case === "boundary"
          ? { vectorElements: 3, embeddedImages: 1, textWords: 1 }
          : { vectorElements: 0, embeddedImages: 0, textWords: 0 },
    );
    return ["scanned", "mixed"].includes(classification);
  }
  if (fixture.category === "ifc") {
    try {
      const evidence = extractIfcEvidence(
        closedIfc({
          unit: fixture.case !== "failure",
          closed: fixture.case !== "failure",
        }),
      );
      if (fixture.case === "failure") return evidence.blockers.length === 0;
      const spatial = ifcEvidenceToSpatial(evidence, { projectId: "p9-ifc-fixture" });
      const firstWall = evidence.semantic_elements.find((element) => element.ifc_type === "IFCWALL");
      return (
        validateSpatialJson(spatial).valid
        && evidence.storeys.length === 1
        && firstWall?.storey_id === "ifc-storey-1"
        && firstWall?.properties?.Pset_WallCommon?.FireRating === "60min"
      );
    } catch {
      return false;
    }
  }
  if (fixture.category === "single_photo") {
    const views = syntheticViews(1);
    const evidence = buildVisualReconstructionEvidence(views, {
      scaleAnchor: fixture.case === "failure" ? null : { id: "scale-1", meters: fixture.case === "boundary" ? 0.1 : 4 },
    });
    return evidence.blockers.length === 0;
  }
  if (fixture.category === "multiview_video") {
    const views = syntheticViews(fixture.case === "failure" ? 2 : 3);
    const evidence = buildVisualReconstructionEvidence(views, {
      registration: fixture.case === "failure"
        ? null
        : registrationFor(views, fixture.case === "boundary" ? 3 : 1),
    });
    return evidence.blockers.length === 0;
  }
  if (fixture.category === "panorama") {
    const views = syntheticViews(fixture.case === "failure" ? 2 : 1, { panorama: true });
    const evidence = buildVisualReconstructionEvidence(views, {
      scaleAnchor: { id: "scale-1", meters: 4 },
    });
    return evidence.blockers.length === 0;
  }
  if (fixture.category === "point_cloud") {
    const evidence = analyzePointCloud(
      fixture.case === "failure" ? roomSurfacePoints(100) : roomSurfacePoints(fixture.case === "boundary" ? 5000 : 6000),
      { scaleConfirmed: fixture.case !== "failure", voxelSize: 0 },
    );
    return evidence.quality.geometry_quality_passed;
  }
  if (fixture.category === "depth") {
    const route = detectInput("depth.png", {
      role: fixture.case === "failure" ? "unknown-depth-role" : "depth",
    });
    return route.route === "depth_image" && route.supported_now;
  }
  if (fixture.category === "existing_3d") {
    if (fixture.case === "boundary") {
      const inspection = inspectObjText(
        "o Wall_A\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        { unitScale: 1, upAxis: "Y", forwardAxis: "-Z", handedness: "right" },
      );
      return buildSceneImportContract(inspection, { mode: "spatial_reference" }).blockers.length === 0;
    }
    const inspection = inspectGltfDocument(gltfFixture(fixture.case !== "failure"));
    return buildSceneImportContract(inspection, { mode: "spatial_reference" }).blockers.length === 0;
  }
  if (fixture.category === "catalog") {
    const header = [
      "id", "kind", "uri", "format", "source", "license", "units",
      "pivot", "forward_axis", "optimized", "collision_proxy",
      "dimension_x", "dimension_y", "dimension_z",
    ];
    const row = [
      fixture.case === "boundary" ? "chair.quoted" : "chair-001",
      "chair",
      fixture.case === "boundary" ? "assets/chair,quoted.glb" : "assets/chair.glb",
      "glb",
      "licensed_catalog",
      fixture.case === "failure" ? "forbidden" : "commercial",
      "meters",
      "bottom_center",
      "-Z",
      "true",
      "true",
      "0.6",
      "0.8",
      "0.6",
    ];
    return catalogFromRows([header, row]).report.valid;
  }
  return false;
}

export async function runP9Acceptance(fixturesFile = DEFAULT_FIXTURES) {
  const url = fixturesFile instanceof URL ? fixturesFile : new URL(`file://${fixturesFile}`);
  const suite = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 33) {
    throw new Error("P9 acceptance requires at least 33 fixtures.");
  }
  const samples = suite.fixtures.map((fixture) => {
    let actualValid = false;
    let error = null;
    try {
      actualValid = evaluateFixture(fixture);
    } catch (caught) {
      error = caught.message;
    }
    return {
      id: fixture.id,
      category: fixture.category,
      case: fixture.case,
      expected_valid: fixture.expected_valid,
      actual_valid: actualValid,
      passed: actualValid === fixture.expected_valid,
      error,
    };
  });
  const categoryCounts = Object.fromEntries(
    [...new Set(samples.map((sample) => sample.category))].map((category) => [
      category,
      samples.filter((sample) => sample.category === category).length,
    ]),
  );
  const aggregate = {
    fixture_count: samples.length,
    categories: Object.keys(categoryCounts).length,
    category_counts: categoryCounts,
    route_errors: samples.filter((sample) => !sample.passed).length,
  };
  const passed =
    aggregate.fixture_count >= 33
    && aggregate.categories >= 11
    && Object.values(categoryCounts).every((count) => count >= 3)
    && aggregate.route_errors === 0;
  const report = {
    schema_version: "1.0",
    stage: "P9",
    passed,
    aggregate,
    samples,
  };
  return { ...report, report_sha256: canonicalJsonSha256(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    fixtures: { type: "string" },
    output: { type: "string", default: "examples/p9-acceptance/automated-evidence.json" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage: node scripts/validation/run-p9-acceptance.mjs [--fixtures file] [--output file]\n");
    return;
  }
  const report = await runP9Acceptance(options.fixtures || DEFAULT_FIXTURES);
  await writeJson(options.output, report);
  printJson({ outputFile: options.output, passed: report.passed, aggregate: report.aggregate });
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

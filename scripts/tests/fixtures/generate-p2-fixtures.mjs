#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createSpatialApprovalRecord } from "../../approval/spatial-approval.mjs";
import { buildSourceManifest } from "../../ingest/build-source-manifest.mjs";
import { readJson, writeJson } from "../../lib/cli.mjs";
import { validateSpatialJson } from "../../validation/validate-spatial-json.mjs";

const ROOT = fileURLToPath(
  new URL("../../../examples/p2-acceptance/", import.meta.url),
);

const RASTER_SPECS = [
  {
    id: "raster-01-meter-anchor",
    size: [500, 400],
    boundary: [50, 50, 450, 350],
    metersPerPixel: 0.01,
    gap: { wall: "top", start: 120, end: 210, kind: "hinged_door" },
  },
  {
    id: "raster-02-right-door",
    size: [640, 480],
    boundary: [70, 60, 570, 420],
    metersPerPixel: 0.01,
    gap: { wall: "right", start: 150, end: 250, kind: "hinged_door" },
  },
  {
    id: "raster-03-bottom-window",
    size: [720, 520],
    boundary: [80, 70, 640, 450],
    metersPerPixel: 0.0125,
    gap: {
      wall: "bottom",
      start: 300,
      end: 396,
      kind: "window",
      height_meters: 1.2,
      sill_meters: 0.9,
    },
  },
  {
    id: "raster-04-left-passage",
    size: [600, 600],
    boundary: [75, 75, 525, 525],
    boundaryPoints: [
      [75, 75],
      [525, 75],
      [525, 300],
      [300, 300],
      [300, 525],
      [75, 525],
    ],
    metersPerPixel: 0.008,
    gap: { wall: "top", start: 180, end: 280, kind: "open_passage" },
  },
  {
    id: "raster-05-estimated-scale",
    size: [540, 420],
    boundary: [60, 60, 480, 360],
    metersPerPixel: 0.01,
    trusted: false,
    gap: null,
  },
];

const DXF_SPECS = [
  {
    id: "dxf-01-meters",
    unitsCode: 6,
    scale: 1,
    width: 4,
    height: 3,
    opening: { layer: "DOOR", start: [0.8, 0], end: [1.7, 0] },
  },
  {
    id: "dxf-02-millimeters",
    unitsCode: 4,
    scale: 0.001,
    width: 5000,
    height: 3500,
    opening: {
      layer: "WINDOW",
      start: [1600, 3500],
      end: [2800, 3500],
    },
  },
  {
    id: "dxf-03-centimeters",
    unitsCode: 5,
    scale: 0.01,
    width: 450,
    height: 400,
    opening: { layer: "DOOR", start: [450, 100], end: [450, 190] },
  },
  {
    id: "dxf-04-feet",
    unitsCode: 2,
    scale: 0.3048,
    width: 16,
    height: 12,
    rooms: [
      [[0, 0], [8, 0], [8, 12], [0, 12]],
      [[8, 0], [16, 0], [16, 12], [8, 12]],
    ],
    opening: { layer: "DOOR", start: [4, 12], end: [7, 12] },
  },
  {
    id: "dxf-05-inches",
    unitsCode: 1,
    scale: 0.0254,
    width: 180,
    height: 144,
    opening: {
      layer: "WINDOW",
      start: [0, 48],
      end: [0, 96],
    },
  },
];

function rasterSvg(spec) {
  const [width, height] = spec.size;
  const [left, top, right, bottom] = spec.boundary;
  const stroke = 10;
  const gap = spec.gap;
  const erase = (() => {
    if (!gap) return "";
    if (gap.wall === "top" || gap.wall === "bottom") {
      const y = gap.wall === "top" ? top : bottom;
      return `<line x1="${gap.start}" y1="${y}" x2="${gap.end}" y2="${y}" stroke="#fff" stroke-width="${stroke + 2}" stroke-linecap="butt"/>`;
    }
    const x = gap.wall === "left" ? left : right;
    return `<line x1="${x}" y1="${gap.start}" x2="${x}" y2="${gap.end}" stroke="#fff" stroke-width="${stroke + 2}" stroke-linecap="butt"/>`;
  })();
  const points =
    spec.boundaryPoints ||
    [[left, top], [right, top], [right, bottom], [left, bottom]];
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${point[1]}`)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#fff"/>
<path d="${path} Z" fill="none" stroke="#111" stroke-width="${stroke}" stroke-linecap="butt" stroke-linejoin="miter"/>
${erase}
</svg>`;
}

function dxf(spec) {
  const { width, height } = spec;
  const rooms =
    spec.rooms ||
    [[[0, 0], [width, 0], [width, height], [0, height]]];
  const [openingStart, openingEnd] = [
    spec.opening.start,
    spec.opening.end,
  ];
  const entities = [];
  rooms.forEach((points, roomIndex) => {
    entities.push(
      "0", "LWPOLYLINE",
      "5", String(10 + roomIndex),
      "8", "ROOM",
      "90", String(points.length),
      "70", "1",
    );
    for (const point of points) {
      entities.push("10", String(point[0]), "20", String(point[1]));
    }
    const center = [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ];
    entities.push(
      "0", "TEXT",
      "5", String(30 + roomIndex),
      "8", "ROOM_TEXT",
      "10", String(center[0]),
      "20", String(center[1]),
      "30", "0",
      "40", String(Math.max(width, height) / 30),
      "1", `Room ${roomIndex + 1}`,
    );
  });
  entities.push(
    "0", "LINE",
    "5", "20",
    "8", spec.opening.layer,
    "10", String(openingStart[0]),
    "20", String(openingStart[1]),
    "30", "0",
    "11", String(openingEnd[0]),
    "21", String(openingEnd[1]),
    "31", "0",
  );
  return [
    "0", "SECTION",
    "2", "HEADER",
    "9", "$INSUNITS",
    "70", String(spec.unitsCode),
    "0", "ENDSEC",
    "0", "SECTION",
    "2", "ENTITIES",
    ...entities,
    "0", "ENDSEC",
    "0", "EOF",
  ].join("\n");
}

async function generateRasterFixtures() {
  const directory = join(ROOT, "raster");
  await mkdir(directory, { recursive: true });
  const index = [];
  for (const spec of RASTER_SPECS) {
    const imagePath = join(directory, `${spec.id}.png`);
    await sharp(Buffer.from(rasterSvg(spec)))
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(imagePath);
    const manifest = await buildSourceManifest([imagePath], {
      containsPersonalData: "false",
    });
    const manifestPath = join(directory, `${spec.id}.source-manifest.json`);
    await writeJson(manifestPath, manifest);
    const [left, top, right, bottom] = spec.boundary;
    const anchor = {
      pixel_start: [left, top],
      pixel_end: [right, top],
      distance_meters: (right - left) * spec.metersPerPixel,
      label: "known outer wall centerline",
    };
    const anchorPath = join(directory, `${spec.id}.scale-anchor.json`);
    if (spec.trusted !== false) await writeJson(anchorPath, anchor);
    const correction = spec.gap
      ? {
          ...(spec.boundaryPoints
            ? { outer_boundary_pixels: spec.boundaryPoints }
            : {}),
          openings: [
            {
              wall_index:
                { top: 0, right: 1, bottom: 2, left: 3 }[spec.gap.wall],
              start_pixel: spec.gap.start,
              end_pixel: spec.gap.end,
              kind: spec.gap.kind,
              ...(spec.gap.height_meters
                ? { height_meters: spec.gap.height_meters }
                : {}),
              ...(Number.isFinite(spec.gap.sill_meters)
                ? { sill_meters: spec.gap.sill_meters }
                : {}),
            },
          ],
        }
      : null;
    const correctionPath = join(directory, `${spec.id}.correction.json`);
    if (correction) await writeJson(correctionPath, correction);
    index.push({
      id: spec.id,
      image: `raster/${spec.id}.png`,
      source_manifest: `raster/${spec.id}.source-manifest.json`,
      ...(spec.trusted !== false
        ? { scale_anchor: `raster/${spec.id}.scale-anchor.json` }
        : {}),
      ...(correction
        ? { correction: `raster/${spec.id}.correction.json` }
        : {}),
      estimated_meters_per_pixel: spec.metersPerPixel,
      expected: {
        width_meters: (right - left) * spec.metersPerPixel,
        height_meters: (bottom - top) * spec.metersPerPixel,
        opening_count: spec.gap ? 1 : 0,
        automatic_opening_check: !spec.boundaryPoints,
        trusted_scale: spec.trusted !== false,
      },
    });
  }
  await writeJson(join(ROOT, "raster-index.json"), {
    schema_version: "1.0",
    fixtures: index,
  });
}

async function generateDxfFixtures() {
  const directory = join(ROOT, "dxf");
  await mkdir(directory, { recursive: true });
  const index = [];
  for (const spec of DXF_SPECS) {
    const dxfPath = join(directory, `${spec.id}.dxf`);
    await writeFile(dxfPath, `${dxf(spec)}\n`, "utf8");
    const manifest = await buildSourceManifest([dxfPath], {
      containsPersonalData: "false",
    });
    await writeJson(
      join(directory, `${spec.id}.source-manifest.json`),
      manifest,
    );
    index.push({
      id: spec.id,
      dxf: `dxf/${spec.id}.dxf`,
      source_manifest: `dxf/${spec.id}.source-manifest.json`,
      expected: {
        width_meters: spec.width * spec.scale,
        height_meters: spec.height * spec.scale,
        opening_width_meters:
          Math.hypot(
            spec.opening.end[0] - spec.opening.start[0],
            spec.opening.end[1] - spec.opening.start[1],
          ) * spec.scale,
        room_count: spec.rooms?.length || 1,
        endpoint_tolerance_meters: 0.001,
      },
    });
  }
  await writeJson(join(ROOT, "dxf-index.json"), {
    schema_version: "1.0",
    fixtures: index,
  });
}

async function generateBundledExampleApproval() {
  const exampleDirectory = fileURLToPath(
    new URL("../../../examples/one-room/", import.meta.url),
  );
  const spatial = await readJson(
    join(exampleDirectory, "spatial.json"),
    "bundled example Spatial JSON",
  );
  const sourceManifest = {
    manifest_version: "1.0",
    sources: spatial.sources,
  };
  const validation = validateSpatialJson(spatial);
  if (!validation.valid) {
    throw new Error(
      `Bundled example is invalid: ${JSON.stringify(validation.errors)}`,
    );
  }
  const approval = createSpatialApprovalRecord({
    sourceManifest,
    spatialJson: spatial,
    validationReport: validation,
    approver: "Bundled example fixture",
    scope: spatial.validation.approved_scope,
    notes:
      "This test fixture is only for npm run example and is rejected by production approval gates.",
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvalKind: "test_fixture",
  });
  await Promise.all([
    writeJson(join(exampleDirectory, "source-manifest.json"), sourceManifest),
    writeJson(join(exampleDirectory, "spatial-validation.json"), validation),
    writeJson(join(exampleDirectory, "spatial-approval.json"), approval),
  ]);
}

await mkdir(dirname(ROOT), { recursive: true });
await Promise.all([
  generateRasterFixtures(),
  generateDxfFixtures(),
  generateBundledExampleApproval(),
]);
const files = [
  ...(await readFile(join(ROOT, "raster-index.json"), "utf8").then(JSON.parse))
    .fixtures,
  ...(await readFile(join(ROOT, "dxf-index.json"), "utf8").then(JSON.parse))
    .fixtures,
];
process.stdout.write(`Generated ${files.length} deterministic P2 fixtures.\n`);

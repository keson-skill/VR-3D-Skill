import {
  canonicalJsonSha256,
  sha256,
} from "../../lib/cli.mjs";
import { buildRuntimeContract } from "../../runtime/build-runtime-contract.mjs";

function fileToken(value, fallback) {
  const text = String(value || fallback);
  const normalized = text
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 64);
  if (!normalized) {
    throw new Error(`${fallback} cannot be converted to a safe file token.`);
  }
  if (normalized === text && text.length <= 64) return normalized;
  return `${normalized.slice(0, 55)}-${sha256(Buffer.from(text, "utf8")).slice(0, 8)}`;
}

function validateCamera(camera, index) {
  for (const field of ["position", "target"]) {
    if (
      !Array.isArray(camera[field])
      || camera[field].length !== 3
      || camera[field].some((value) => !Number.isFinite(value))
    ) {
      throw new Error(`Blender camera ${index + 1} has an invalid ${field}.`);
    }
  }
}

export function buildBlenderRenderPlan(
  spatialJson,
  {
    scene = "scene.glb",
    outputDirectory = "render",
    walkthrough = false,
  } = {},
) {
  const runtime = buildRuntimeContract(spatialJson);
  const bounds = spatialJson.envelope.walls.flatMap((wall) => [wall.start, wall.end]);
  const minX = Math.min(...bounds.map((point) => point[0]));
  const maxX = Math.max(...bounds.map((point) => point[0]));
  const minZ = Math.min(...bounds.map((point) => point[1]));
  const maxZ = Math.max(...bounds.map((point) => point[1]));
  const center = [(minX + maxX) / 2, 1.2, (minZ + maxZ) / 2];
  const span = Math.max(maxX - minX, maxZ - minZ, 4);
  const rawCameras = [
    { id: "overview", kind: "perspective", position: [center[0] + span, span * 0.8 + 2, center[2] + span], target: center },
    ...runtime.rooms.map((room) => ({
      id: `room-${room.id}`,
      kind: "perspective",
      position: [room.navigation_point[0], room.floor_elevation + 1.55, room.navigation_point[1]],
      target: [center[0], 1.2, center[2]],
    })),
    ...((spatialJson.render_profiles?.blender?.cameras || []).map((camera) => ({ ...camera, kind: camera.kind || "perspective" }))),
  ];
  if (rawCameras.length > 64) {
    throw new Error("A Blender render plan supports at most 64 cameras.");
  }
  const cameras = rawCameras.map((camera, index) => {
    validateCamera(camera, index);
    return {
      ...camera,
      id: fileToken(camera.id, `camera-${index + 1}`),
    };
  });
  if (new Set(cameras.map((camera) => camera.id)).size !== cameras.length) {
    throw new Error("Blender camera IDs must be unique after file-name normalization.");
  }
  const projectToken = fileToken(spatialJson.project.id, "project");
  const revisionToken = fileToken(spatialJson.project.revision, "revision");
  const plan = {
    schema_version: "1.0",
    stage: "P7",
    project_id: spatialJson.project.id,
    revision: spatialJson.project.revision,
    source_scene: scene,
    output_directory: outputDirectory,
    engine: "BLENDER_EEVEE_NEXT",
    color_management: { view_transform: "AgX", look: "AgX - Medium High Contrast", exposure: 0, gamma: 1 },
    cameras,
    stills: cameras.map((camera) => ({ camera_id: camera.id, width: 1920, height: 1080, format: "PNG", file: `stills/${camera.id}.png` })),
    panorama: {
      camera_id: runtime.rooms[0] ? cameras[1].id : cameras[0].id,
      projection: "EQUIRECTANGULAR",
      width: 4096,
      height: 2048,
      format: "PNG",
      file: "panorama/panorama-360.png",
    },
    blend_file: `${projectToken}-${revisionToken}.blend`,
    optional_walkthrough: {
      enabled: walkthrough,
      format: "MPEG4",
      codec: "H264",
      fps: 30,
      width: 1920,
      height: 1080,
      frames_per_view: 60,
      file: "walkthrough/walkthrough.mp4",
    },
    checkpoint_file: "render-checkpoint.json",
  };
  return { ...plan, plan_sha256: canonicalJsonSha256(plan) };
}

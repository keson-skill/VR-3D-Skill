import { canonicalJsonSha256 } from "../../lib/cli.mjs";
import { buildRuntimeContract } from "../../runtime/build-runtime-contract.mjs";

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
  const cameras = [
    { id: "overview", kind: "perspective", position: [center[0] + span, span * 0.8 + 2, center[2] + span], target: center },
    ...runtime.rooms.map((room) => ({
      id: `room-${room.id}`,
      kind: "perspective",
      position: [room.navigation_point[0], room.floor_elevation + 1.55, room.navigation_point[1]],
      target: [center[0], 1.2, center[2]],
    })),
    ...((spatialJson.render_profiles?.blender?.cameras || []).map((camera) => ({ ...camera, kind: camera.kind || "perspective" }))),
  ];
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
      camera_id: runtime.rooms[0] ? `room-${runtime.rooms[0].id}` : "overview",
      projection: "EQUIRECTANGULAR",
      width: 4096,
      height: 2048,
      format: "PNG",
      file: "panorama/panorama-360.png",
    },
    blend_file: `${spatialJson.project.id}-${spatialJson.project.revision}.blend`,
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

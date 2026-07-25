import { designObjectFootprint, orderRoomPolygon, pointInPolygon } from "../geometry/spatial-geometry.mjs";

function navigationPoint(polygon, blockedFootprints = []) {
  const xs = polygon.map((point) => point[0]);
  const zs = polygon.map((point) => point[1]);
  for (let z = Math.min(...zs) + 0.35; z <= Math.max(...zs) - 0.35; z += 0.25) {
    for (let x = Math.min(...xs) + 0.35; x <= Math.max(...xs) - 0.35; x += 0.25) {
      if (pointInPolygon([x, z], polygon) && blockedFootprints.every((footprint) => !pointInPolygon([x, z], footprint))) return [x, z];
    }
  }
  return polygon[0] || [0, 0];
}

export function buildRuntimeContract(spatialJson) {
  const errors = [];
  const wallMap = new Map((spatialJson.envelope?.walls || []).map((wall) => [wall.id, wall]));
  const rooms = (spatialJson.rooms || []).map((room) => {
    const ordered = orderRoomPolygon(room.boundary_wall_ids.map((id) => wallMap.get(id)).filter(Boolean));
    if (!ordered.valid) errors.push({ code: "runtime.room_polygon", path: `/rooms/${room.id}`, message: "Room does not resolve to a navigation polygon." });
    const polygon = ordered.polygon || [];
    return { id: room.id, name: room.name || room.id, polygon, floor_elevation: room.floor_elevation ?? spatialJson.envelope.floor_elevation ?? 0 };
  });
  const obstacles = (spatialJson.design_objects || []).map((object) => ({
    id: object.id,
    room_id: object.room_id,
    footprint: designObjectFootprint(object),
    height: object.dimensions[1],
    editable: object.fixed !== true,
  }));
  rooms.forEach((room) => {
    room.navigation_point = navigationPoint(
      room.polygon,
      obstacles.filter((obstacle) => obstacle.room_id === room.id).map((obstacle) => obstacle.footprint),
    );
  });
  const spawn = spatialJson.xr?.spawn || [
    rooms[0]?.navigation_point?.[0] ?? 0,
    rooms[0]?.floor_elevation ?? 0,
    rooms[0]?.navigation_point?.[1] ?? 0,
  ];
  if (!rooms.some((room) => pointInPolygon([spawn[0], spawn[2]], room.polygon))) {
    errors.push({ code: "runtime.spawn_outside_rooms", path: "/xr/spawn", message: "Runtime spawn must be inside a navigable room." });
  }
  if (obstacles.some((obstacle) => pointInPolygon([spawn[0], spawn[2]], obstacle.footprint))) {
    errors.push({ code: "runtime.spawn_inside_obstacle", path: "/xr/spawn", message: "Runtime spawn must not intersect a design object." });
  }
  return {
    schema_version: "1.0",
    valid: errors.length === 0,
    errors,
    spawn,
    eye_height: 1.65,
    rooms,
    obstacles,
    interaction: {
      selectable_ids: obstacles.map((item) => item.id),
      operations: ["select", "move", "rotate", "replace", "undo", "annotate", "measure"],
      invalid_placement_feedback: true,
    },
    locomotion: {
      desktop: ["orbit", "top", "first_person", "room_jump"],
      xr: spatialJson.xr?.navigation || "teleport",
      snap_turn_degrees: spatialJson.xr?.snap_turn_degrees || 30,
      collision: "room_polygons_and_object_footprints",
    },
    lifecycle: ["idle", "entering", "presenting", "paused", "hidden", "reconnecting", "exiting", "error"],
    accessibility: {
      keyboard: true,
      reduced_motion: true,
      live_status: true,
      minimum_touch_target_css_pixels: 44,
    },
    performance: spatialJson.render_profiles?.webxr || {
      quality_tier: "balanced",
      target_fps: 72,
      max_pixel_ratio: 1.5,
    },
  };
}

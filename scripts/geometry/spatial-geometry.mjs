const DEFAULT_TOLERANCE = 1e-5;

export function distance2d(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

export function pointKey(point, tolerance = DEFAULT_TOLERANCE) {
  return `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, point, tolerance = DEFAULT_TOLERANCE) {
  return (
    Math.abs(orientation(a, b, point)) <= tolerance &&
    point[0] >= Math.min(a[0], b[0]) - tolerance &&
    point[0] <= Math.max(a[0], b[0]) + tolerance &&
    point[1] >= Math.min(a[1], b[1]) - tolerance &&
    point[1] <= Math.max(a[1], b[1]) + tolerance
  );
}

export function segmentsIntersect(
  firstStart,
  firstEnd,
  secondStart,
  secondEnd,
  tolerance = DEFAULT_TOLERANCE,
) {
  const o1 = orientation(firstStart, firstEnd, secondStart);
  const o2 = orientation(firstStart, firstEnd, secondEnd);
  const o3 = orientation(secondStart, secondEnd, firstStart);
  const o4 = orientation(secondStart, secondEnd, firstEnd);
  if (
    ((o1 > tolerance && o2 < -tolerance) ||
      (o1 < -tolerance && o2 > tolerance)) &&
    ((o3 > tolerance && o4 < -tolerance) ||
      (o3 < -tolerance && o4 > tolerance))
  ) {
    return true;
  }
  return (
    onSegment(firstStart, firstEnd, secondStart, tolerance) ||
    onSegment(firstStart, firstEnd, secondEnd, tolerance) ||
    onSegment(secondStart, secondEnd, firstStart, tolerance) ||
    onSegment(secondStart, secondEnd, firstEnd, tolerance)
  );
}

export function polygonSignedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

export function orderRoomPolygon(
  walls,
  { tolerance = DEFAULT_TOLERANCE } = {},
) {
  if (!Array.isArray(walls) || walls.length < 3) {
    return { valid: false, code: "room.boundary", polygon: [] };
  }
  const nodes = new Map();
  const edges = walls.map((wall, index) => {
    const startKey = pointKey(wall.start, tolerance);
    const endKey = pointKey(wall.end, tolerance);
    for (const [key, point] of [
      [startKey, wall.start],
      [endKey, wall.end],
    ]) {
      if (!nodes.has(key)) nodes.set(key, { point: [...point], edges: [] });
      nodes.get(key).edges.push(index);
    }
    return { index, startKey, endKey, wall };
  });
  if ([...nodes.values()].some((node) => node.edges.length !== 2)) {
    return { valid: false, code: "room.not_closed", polygon: [] };
  }

  const visitedEdges = new Set();
  const polygon = [];
  let edge = edges[0];
  let currentKey = edge.startKey;
  const startKey = currentKey;
  for (let step = 0; step <= edges.length; step += 1) {
    polygon.push(nodes.get(currentKey).point);
    visitedEdges.add(edge.index);
    const nextKey = edge.startKey === currentKey ? edge.endKey : edge.startKey;
    if (nextKey === startKey) {
      if (visitedEdges.size !== edges.length) {
        return { valid: false, code: "room.disconnected_loops", polygon };
      }
      break;
    }
    const nextEdgeIndex = nodes
      .get(nextKey)
      .edges.find((candidate) => !visitedEdges.has(candidate));
    if (nextEdgeIndex === undefined) {
      return { valid: false, code: "room.not_closed", polygon };
    }
    currentKey = nextKey;
    edge = edges[nextEdgeIndex];
  }
  if (visitedEdges.size !== edges.length || polygon.length < 3) {
    return { valid: false, code: "room.not_closed", polygon };
  }

  for (let left = 0; left < polygon.length; left += 1) {
    const leftNext = (left + 1) % polygon.length;
    for (let right = left + 1; right < polygon.length; right += 1) {
      const rightNext = (right + 1) % polygon.length;
      const adjacent =
        left === right ||
        leftNext === right ||
        rightNext === left ||
        (left === 0 && rightNext === 0);
      if (
        !adjacent &&
        segmentsIntersect(
          polygon[left],
          polygon[leftNext],
          polygon[right],
          polygon[rightNext],
          tolerance,
        )
      ) {
        return { valid: false, code: "room.self_intersection", polygon };
      }
    }
  }
  const signedArea = polygonSignedArea(polygon);
  if (Math.abs(signedArea) <= tolerance) {
    return { valid: false, code: "room.zero_area", polygon };
  }
  return {
    valid: true,
    polygon: signedArea < 0 ? [...polygon].reverse() : polygon,
    area: Math.abs(signedArea),
  };
}

export function pointInPolygon(point, polygon, tolerance = DEFAULT_TOLERANCE) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (onSegment(previousPoint, currentPoint, point, tolerance)) return true;
    const crosses =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) *
          (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export function designObjectFootprint(object) {
  const [width, , depth] = object.dimensions;
  const [x, , z] = object.transform.position;
  const angle =
    ((object.transform.rotation_euler_degrees?.[1] || 0) * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([localX, localZ]) => [
    x + localX * cosine - localZ * sine,
    z + localX * sine + localZ * cosine,
  ]);
}

function projectPolygon(polygon, axis) {
  const values = polygon.map((point) => point[0] * axis[0] + point[1] * axis[1]);
  return [Math.min(...values), Math.max(...values)];
}

export function convexPolygonsOverlap(left, right, tolerance = DEFAULT_TOLERANCE) {
  for (const polygon of [left, right]) {
    for (let index = 0; index < polygon.length; index += 1) {
      const current = polygon[index];
      const next = polygon[(index + 1) % polygon.length];
      const edge = [next[0] - current[0], next[1] - current[1]];
      const axis = [-edge[1], edge[0]];
      const length = Math.hypot(axis[0], axis[1]) || 1;
      axis[0] /= length;
      axis[1] /= length;
      const leftProjection = projectPolygon(left, axis);
      const rightProjection = projectPolygon(right, axis);
      if (
        leftProjection[1] <= rightProjection[0] + tolerance ||
        rightProjection[1] <= leftProjection[0] + tolerance
      ) {
        return false;
      }
    }
  }
  return true;
}

function interpolate(start, end, distance) {
  const length = distance2d(start, end);
  const ratio = length === 0 ? 0 : distance / length;
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

function wallBox(wall, startOffset, endOffset, bottom, top, floorElevation) {
  const start = interpolate(wall.start, wall.end, startOffset);
  const end = interpolate(wall.start, wall.end, endOffset);
  const center = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  return {
    shape: "box",
    name: `${wall.id}-${startOffset.toFixed(3)}-${bottom.toFixed(3)}`,
    category: "shell",
    kind: "wall",
    source_id: wall.id,
    translation: [
      center[0],
      floorElevation + bottom + (top - bottom) / 2,
      center[1],
    ],
    rotation_y_radians: -angle,
    scale: [endOffset - startOffset, top - bottom, wall.thickness],
    material_id: wall.material_id || "wall_default",
  };
}

export function buildWallPrimitives(wall, openings, floorElevation = 0) {
  const length = distance2d(wall.start, wall.end);
  const wallOpenings = openings
    .filter((opening) => opening.host_wall_id === wall.id)
    .sort((left, right) => left.offset - right.offset);
  const boundaries = new Set([0, length]);
  for (const opening of wallOpenings) {
    boundaries.add(Math.max(0, opening.offset));
    boundaries.add(Math.min(length, opening.offset + opening.width));
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  const primitives = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const startOffset = sorted[index];
    const endOffset = sorted[index + 1];
    if (endOffset - startOffset <= DEFAULT_TOLERANCE) continue;
    const midpoint = (startOffset + endOffset) / 2;
    const opening = wallOpenings.find(
      (candidate) =>
        midpoint > candidate.offset + DEFAULT_TOLERANCE &&
        midpoint < candidate.offset + candidate.width - DEFAULT_TOLERANCE,
    );
    if (!opening) {
      primitives.push(
        wallBox(wall, startOffset, endOffset, 0, wall.height, floorElevation),
      );
      continue;
    }
    const sill = opening.sill_height || 0;
    const openingTop = Math.min(wall.height, sill + opening.height);
    if (sill > DEFAULT_TOLERANCE) {
      primitives.push(
        wallBox(wall, startOffset, endOffset, 0, sill, floorElevation),
      );
    }
    if (openingTop < wall.height - DEFAULT_TOLERANCE) {
      primitives.push(
        wallBox(
          wall,
          startOffset,
          endOffset,
          openingTop,
          wall.height,
          floorElevation,
        ),
      );
    }
  }

  for (const opening of wallOpenings) {
    const openingKind = String(opening.kind || "");
    const isDoor = openingKind.includes("door");
    const isWindow = openingKind.includes("window");
    if (!isDoor && !isWindow) continue;
    const midpoint = opening.offset + opening.width / 2;
    const center = interpolate(wall.start, wall.end, midpoint);
    const angle = Math.atan2(
      wall.end[1] - wall.start[1],
      wall.end[0] - wall.start[0],
    );
    const sill = opening.sill_height || 0;
    primitives.push({
      shape: "box",
      name: opening.id,
      category: "opening",
      kind: isDoor ? "door" : "window",
      source_id: opening.id,
      translation: [
        center[0],
        floorElevation + sill + opening.height / 2,
        center[1],
      ],
      rotation_y_radians: -angle,
      scale: [opening.width, opening.height, isDoor ? 0.04 : 0.02],
      material_id: isDoor ? "door_default" : "glass_default",
    });
  }
  return primitives;
}

function roomElevations(document, room) {
  const floor = room.floor_elevation ?? document.envelope?.floor_elevation ?? 0;
  const ceiling =
    room.ceiling_elevation ??
    floor + (document.envelope?.ceiling_height ?? 2.8);
  return { floor, ceiling };
}

function rotateLocalXZ([x, z], radians) {
  return [
    x * Math.cos(radians) + z * Math.sin(radians),
    -x * Math.sin(radians) + z * Math.cos(radians),
  ];
}

export function buildArchitecturalPrimitives(elements = []) {
  const primitives = [];
  for (const element of elements) {
    const rotation =
      -((element.transform?.rotation_euler_degrees?.[1] || 0) * Math.PI) /
      180;
    const position = element.transform?.position || [0, 0, 0];
    const materialId = element.material_id || "wall_default";
    if (element.kind !== "stair") {
      primitives.push({
        shape: "box",
        name: element.id,
        category: "shell",
        kind: element.kind,
        source_id: element.id,
        translation: position,
        rotation_y_radians: rotation,
        scale: element.dimensions,
        material_id: materialId,
      });
      continue;
    }

    const [width, totalHeight, totalRun] = element.dimensions;
    const stepCount = element.step_count;
    const tread = totalRun / stepCount;
    const rise = totalHeight / stepCount;
    for (let index = 0; index < stepCount; index += 1) {
      const stepHeight = rise * (index + 1);
      const local = [0, -totalRun / 2 + tread * (index + 0.5)];
      const [offsetX, offsetZ] = rotateLocalXZ(local, rotation);
      primitives.push({
        shape: "box",
        name: `${element.id}-step-${index + 1}`,
        category: "shell",
        kind: "stair_tread",
        source_id: element.id,
        translation: [
          position[0] + offsetX,
          position[1] + stepHeight / 2,
          position[2] + offsetZ,
        ],
        rotation_y_radians: rotation,
        scale: [width, stepHeight, tread],
        material_id: materialId,
      });
    }
  }
  return primitives;
}

export function compileScenePrimitives(document) {
  const floorElevation = document.envelope?.floor_elevation || 0;
  const wallMap = new Map(
    (document.envelope?.walls || []).map((wall) => [wall.id, wall]),
  );
  const primitives = [];
  for (const wall of wallMap.values()) {
    primitives.push(
      ...buildWallPrimitives(
        wall,
        document.envelope?.openings || [],
        floorElevation,
      ),
    );
  }
  for (const room of document.rooms || []) {
    const ordered = orderRoomPolygon(
      room.boundary_wall_ids.map((id) => wallMap.get(id)).filter(Boolean),
    );
    if (ordered.valid) {
      const elevations = roomElevations(document, room);
      primitives.push({
        shape: "polygon",
        name: `${room.id}-floor`,
        category: "shell",
        kind: "floor",
        source_id: room.id,
        polygon: ordered.polygon,
        elevation: elevations.floor + 0.002,
        normal_y: 1,
        material_id: room.floor_material_id || "floor_default",
      });
      primitives.push({
        shape: "polygon",
        name: `${room.id}-ceiling`,
        category: "shell",
        kind: "ceiling",
        source_id: room.id,
        polygon: ordered.polygon,
        elevation: elevations.ceiling - 0.002,
        normal_y: -1,
        material_id: room.ceiling_material_id || "wall_default",
      });
    }
  }
  primitives.push(
    ...buildArchitecturalPrimitives(document.envelope?.architectural_elements),
  );
  for (const object of document.design_objects || []) {
    const position = object.transform.position;
    primitives.push({
      shape: "box",
      name: object.id,
      category: "furniture",
      kind: object.kind || "object",
      source_id: object.id,
      proxy: true,
      fixed:
        object.fixed === true ||
        object.installation_type === "fixed" ||
        ["kitchen_cabinet", "vanity", "built_in_storage"].includes(object.kind),
      translation: [
        position[0],
        position[1] + object.dimensions[1] / 2,
        position[2],
      ],
      rotation_y_radians:
        -((object.transform.rotation_euler_degrees?.[1] || 0) * Math.PI) / 180,
      scale: object.dimensions,
      material_id: object.material_id || "furniture_proxy",
    });
  }
  return primitives;
}

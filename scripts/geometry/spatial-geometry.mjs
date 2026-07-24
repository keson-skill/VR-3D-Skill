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

function clipLineIntersection(start, end, clipStart, clipEnd) {
  const direction = subtract2d(end, start);
  const clipDirection = subtract2d(clipEnd, clipStart);
  const denominator = cross2d(direction, clipDirection);
  if (Math.abs(denominator) <= DEFAULT_TOLERANCE) return [...end];
  const ratio = cross2d(subtract2d(clipStart, start), clipDirection) / denominator;
  return addScaled(start, direction, ratio);
}

export function convexPolygonIntersectionArea(subject, clip) {
  let output = subject.map((point) => [...point]);
  const clipOrientation = polygonSignedArea(clip) >= 0 ? 1 : -1;
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const clipStart = clip[index];
    const clipEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];
    const inside = (point) =>
      clipOrientation * orientation(clipStart, clipEnd, point) >= -DEFAULT_TOLERANCE;
    for (let cursor = 0; cursor < input.length; cursor += 1) {
      const current = input[cursor];
      const previous = input[(cursor - 1 + input.length) % input.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside !== previousInside) {
        output.push(clipLineIntersection(previous, current, clipStart, clipEnd));
      }
      if (currentInside) output.push(current);
    }
  }
  return output.length >= 3 ? Math.abs(polygonSignedArea(output)) : 0;
}

function interpolate(start, end, distance) {
  const length = distance2d(start, end);
  const ratio = length === 0 ? 0 : distance / length;
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

function cross2d(left, right) {
  return left[0] * right[1] - left[1] * right[0];
}

function subtract2d(left, right) {
  return [left[0] - right[0], left[1] - right[1]];
}

function addScaled(point, vector, scalar) {
  return [point[0] + vector[0] * scalar, point[1] + vector[1] * scalar];
}

function normalize2d(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  return length > DEFAULT_TOLERANCE
    ? [vector[0] / length, vector[1] / length]
    : [0, 0];
}

function dot2d(left, right) {
  return left[0] * right[0] + left[1] * right[1];
}

function perpendicular(vector) {
  return [-vector[1], vector[0]];
}

function lineIntersection(pointA, directionA, pointB, directionB) {
  const denominator = cross2d(directionA, directionB);
  if (Math.abs(denominator) <= DEFAULT_TOLERANCE) return null;
  const delta = subtract2d(pointB, pointA);
  const ratio = cross2d(delta, directionB) / denominator;
  return addScaled(pointA, directionA, ratio);
}

function wallJunctions(walls) {
  const junctions = new Map();
  for (const wall of walls) {
    for (const [point, atStart] of [[wall.start, true], [wall.end, false]]) {
      const key = pointKey(point);
      if (!junctions.has(key)) junctions.set(key, []);
      junctions.get(key).push({ wall, atStart });
    }
  }
  return junctions;
}

function hasHostedOpening(wall, openings) {
  return openings.some(
    (opening) => opening.host_wall_id === (wall.source_wall_id || wall.id),
  );
}

function splitWallAtEndpointJunctions(wall, allWalls) {
  const length = distance2d(wall.start, wall.end);
  const offsets = [0, length];
  for (const other of allWalls) {
    for (const point of [other.start, other.end]) {
      if (
        distance2d(point, wall.start) <= DEFAULT_TOLERANCE ||
        distance2d(point, wall.end) <= DEFAULT_TOLERANCE ||
        !onSegment(wall.start, wall.end, point)
      ) {
        continue;
      }
      offsets.push(distance2d(wall.start, point));
    }
  }
  const sortedOffsets = offsets
    .sort((left, right) => left - right)
    .filter((offset, index, values) =>
      index === 0 || offset - values[index - 1] > DEFAULT_TOLERANCE,
    );
  if (sortedOffsets.length === 2) return [wall];
  const direction = normalize2d(subtract2d(wall.end, wall.start));
  return sortedOffsets.slice(0, -1).map((startOffset, index) => {
    const endOffset = sortedOffsets[index + 1];
    return {
      ...wall,
      id: `${wall.id}@${startOffset.toFixed(5)}-${endOffset.toFixed(5)}`,
      source_wall_id: wall.source_wall_id || wall.id,
      opening_offset_origin: (wall.opening_offset_origin || 0) + startOffset,
      start: addScaled(wall.start, direction, startOffset),
      end: addScaled(wall.start, direction, endOffset),
    };
  });
}

function splitWallsAtEndpointJunctions(walls, allWalls) {
  return walls.flatMap((wall) => splitWallAtEndpointJunctions(wall, allWalls));
}

function wallSegmentKey(wall) {
  const start = pointKey(wall.start);
  const end = pointKey(wall.end);
  return start < end ? `${start}|${end}` : `${end}|${start}`;
}

function deduplicateWallSegments(walls, openings) {
  const deduplicated = new Map();
  for (const wall of walls) {
    const key = wallSegmentKey(wall);
    const current = deduplicated.get(key);
    if (
      !current ||
      (hasHostedOpening(wall, openings) && !hasHostedOpening(current, openings)) ||
      (hasHostedOpening(wall, openings) === hasHostedOpening(current, openings) &&
        wall.id.localeCompare(current.id) < 0)
    ) {
      deduplicated.set(key, wall);
    }
  }
  return [...deduplicated.values()];
}

function outgoingWallDirection(entry) {
  return normalize2d(
    entry.atStart
      ? subtract2d(entry.wall.end, entry.wall.start)
      : subtract2d(entry.wall.start, entry.wall.end),
  );
}

function squareSection(wall, atStart, center, jointType = "cap") {
  const direction = outgoingWallDirection({ wall, atStart });
  const normal = perpendicular(direction);
  const half = wall.thickness / 2;
  return {
    positive: addScaled(center, atStart ? normal : [-normal[0], -normal[1]], half),
    negative: addScaled(center, atStart ? normal : [-normal[0], -normal[1]], -half),
    mitered: false,
    joint_type: jointType,
  };
}

function throughPair(entries) {
  const candidates = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const leftDirection = outgoingWallDirection(entries[left]);
      const rightDirection = outgoingWallDirection(entries[right]);
      if (
        Math.abs(cross2d(leftDirection, rightDirection)) <= DEFAULT_TOLERANCE &&
        dot2d(leftDirection, rightDirection) < -1 + DEFAULT_TOLERANCE
      ) {
        candidates.push([entries[left], entries[right]]);
      }
    }
  }
  return candidates.sort((left, right) => {
    const leftKey = left.map((entry) => entry.wall.id).sort().join("|");
    const rightKey = right.map((entry) => entry.wall.id).sort().join("|");
    return leftKey.localeCompare(rightKey);
  })[0] || null;
}

function endpointSection(wall, atStart, junctions) {
  const anchor = atStart ? wall.start : wall.end;
  const direction = outgoingWallDirection({ wall, atStart });
  const normal = perpendicular(direction);
  const half = wall.thickness / 2;
  const entries = junctions.get(pointKey(anchor)) || [];
  const fallback = squareSection(wall, atStart, anchor);
  if (entries.length < 2) return fallback;
  if (entries.length > 2) {
    const pair = throughPair(entries);
    if (!pair) return squareSection(wall, atStart, anchor, "unresolved");
    if (pair.some((entry) => entry.wall.id === wall.id)) {
      return squareSection(wall, atStart, anchor, "through");
    }
    const hostThickness = Math.max(pair[0].wall.thickness, pair[1].wall.thickness);
    return squareSection(
      wall,
      atStart,
      addScaled(anchor, direction, hostThickness / 2),
      "butt",
    );
  }
  const neighborEntry = entries.find((entry) => entry.wall.id !== wall.id);
  if (!neighborEntry) return fallback;
  const neighbor = neighborEntry.wall;
  const neighborDirection = outgoingWallDirection(neighborEntry);
  const turn = cross2d(direction, neighborDirection);
  if (Math.abs(turn) <= DEFAULT_TOLERANCE) return fallback;
  const neighborNormal = perpendicular(neighborDirection);
  const intersections = [];
  for (const sign of [1, -1]) {
    const point = lineIntersection(
      addScaled(anchor, normal, sign * half),
      direction,
      addScaled(anchor, neighborNormal, -sign * neighbor.thickness / 2),
      neighborDirection,
    );
    if (!point || distance2d(anchor, point) > Math.max(wall.thickness, neighbor.thickness) * 4) {
      return fallback;
    }
    intersections.push({ sign, point });
  }
  const outwardPositive = intersections.find((item) => item.sign === 1).point;
  const outwardNegative = intersections.find((item) => item.sign === -1).point;
  return atStart
    ? { positive: outwardPositive, negative: outwardNegative, mitered: true, joint_type: "miter" }
    : { positive: outwardNegative, negative: outwardPositive, mitered: true, joint_type: "miter" };
}

function offsetSection(wall, offset, junctions) {
  const length = distance2d(wall.start, wall.end);
  if (offset <= DEFAULT_TOLERANCE) return endpointSection(wall, true, junctions);
  if (offset >= length - DEFAULT_TOLERANCE) return endpointSection(wall, false, junctions);
  const center = interpolate(wall.start, wall.end, offset);
  const normal = perpendicular(normalize2d(subtract2d(wall.end, wall.start)));
  return {
    positive: addScaled(center, normal, wall.thickness / 2),
    negative: addScaled(center, normal, -wall.thickness / 2),
    mitered: false,
    joint_type: "segment",
  };
}

function wallPrism(
  wall,
  startOffset,
  endOffset,
  bottom,
  top,
  floorElevation,
  junctions,
) {
  const start = offsetSection(wall, startOffset, junctions);
  const end = offsetSection(wall, endOffset, junctions);
  return {
    shape: "extruded_polygon",
    name: `${wall.id}-${startOffset.toFixed(3)}-${bottom.toFixed(3)}`,
    category: "shell",
    kind: "wall",
    source_id: wall.source_wall_id || wall.id,
    footprint: [
      start.negative,
      end.negative,
      end.positive,
      start.positive,
    ],
    bottom_elevation: floorElevation + bottom,
    top_elevation: floorElevation + top,
    mitered_start: start.mitered,
    mitered_end: end.mitered,
    junction_start: start.joint_type,
    junction_end: end.joint_type,
    material_id: wall.material_id || "wall_default",
  };
}

export function buildWallPrimitives(
  wall,
  openings,
  floorElevation = 0,
  junctions = new Map(),
) {
  const length = distance2d(wall.start, wall.end);
  const wallOpenings = openings
    .filter((opening) => opening.host_wall_id === (wall.source_wall_id || wall.id))
    .map((opening) => {
      const openingOffsetOrigin = wall.opening_offset_origin || 0;
      const start = Math.max(0, opening.offset - openingOffsetOrigin);
      const end = Math.min(
        length,
        opening.offset + opening.width - openingOffsetOrigin,
      );
      return { ...opening, offset: start, width: Math.max(0, end - start) };
    })
    .filter((opening) => opening.width > DEFAULT_TOLERANCE)
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
        wallPrism(
          wall,
          startOffset,
          endOffset,
          0,
          wall.height,
          floorElevation,
          junctions,
        ),
      );
      continue;
    }
    const sill = opening.sill_height || 0;
    const openingTop = Math.min(wall.height, sill + opening.height);
    if (sill > DEFAULT_TOLERANCE) {
      primitives.push(
        wallPrism(
          wall,
          startOffset,
          endOffset,
          0,
          sill,
          floorElevation,
          junctions,
        ),
      );
    }
    if (openingTop < wall.height - DEFAULT_TOLERANCE) {
      primitives.push(
        wallPrism(
          wall,
          startOffset,
          endOffset,
          openingTop,
          wall.height,
          floorElevation,
          junctions,
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
  const openings = document.envelope?.openings || [];
  const wallMap = new Map(
    (document.envelope?.walls || []).map((wall) => [wall.id, wall]),
  );
  const primitives = [];
  const renderableWalls = deduplicateWallSegments(
    splitWallsAtEndpointJunctions(
      [...wallMap.values()],
      [...wallMap.values()],
    ),
    openings,
  );
  const junctions = wallJunctions(renderableWalls);
  for (const wall of renderableWalls) {
    primitives.push(
      ...buildWallPrimitives(
        wall,
        openings,
        floorElevation,
        junctions,
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

export function validateWallPrimitiveTopology(primitives) {
  const walls = primitives.filter(
    (primitive) =>
      primitive.shape === "extruded_polygon" &&
      primitive.category === "shell" &&
      primitive.kind === "wall",
  );
  const errors = [];
  for (const wall of walls) {
    if (wall.junction_start === "unresolved" || wall.junction_end === "unresolved") {
      errors.push({
        code: "wall.junction_unresolved",
        wall: wall.name,
        junction_start: wall.junction_start,
        junction_end: wall.junction_end,
      });
    }
  }
  for (let left = 0; left < walls.length; left += 1) {
    for (let right = left + 1; right < walls.length; right += 1) {
      const first = walls[left];
      const second = walls[right];
      const verticalOverlap =
        Math.min(first.top_elevation, second.top_elevation) -
        Math.max(first.bottom_elevation, second.bottom_elevation);
      if (verticalOverlap <= DEFAULT_TOLERANCE) continue;
      const footprintOverlap = convexPolygonIntersectionArea(
        first.footprint,
        second.footprint,
      );
      if (footprintOverlap > DEFAULT_TOLERANCE) {
        errors.push({
          code: "wall.volume_overlap",
          first: first.name,
          second: second.name,
          footprint_overlap_area: Number(footprintOverlap.toFixed(9)),
          vertical_overlap: Number(verticalOverlap.toFixed(9)),
        });
      }
    }
  }
  return {
    valid: errors.length === 0,
    wall_count: walls.length,
    errors,
  };
}

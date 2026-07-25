const elements = Object.fromEntries(
  [
    "image-file",
    "json-file",
    "export",
    "canvas",
    "meters-per-pixel",
    "scale-status",
    "independent-verification",
    "room-name",
    "room-type",
    "opening-select",
    "opening-kind",
    "opening-offset",
    "opening-width",
    "opening-height",
    "opening-sill",
    "questions",
    "approval-scope",
    "mark-reviewed",
    "status",
  ].map((id) => [id, document.getElementById(id)]),
);

const context = elements.canvas.getContext("2d");
let image = null;
let spatial = null;
let drag = null;

function inverseAffine(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * e - b * d;
  return [
    e / determinant,
    -b / determinant,
    (b * f - e * c) / determinant,
    -d / determinant,
    a / determinant,
    (d * c - a * f) / determinant,
    0,
    0,
    1,
  ];
}

function transform(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5],
  ];
}

function pixelToMeter() {
  return spatial?.extraction?.coordinate_transform?.matrix_3x3;
}

function meterToPixel() {
  const matrix = pixelToMeter();
  return matrix ? inverseAffine(matrix) : null;
}

function wallPointAt(wall, offset) {
  const length = Math.hypot(
    wall.end[0] - wall.start[0],
    wall.end[1] - wall.start[1],
  );
  const ratio = length ? offset / length : 0;
  return [
    wall.start[0] + (wall.end[0] - wall.start[0]) * ratio,
    wall.start[1] + (wall.end[1] - wall.start[1]) * ratio,
  ];
}

function draw() {
  if (!image) return;
  elements.canvas.width = image.naturalWidth;
  elements.canvas.height = image.naturalHeight;
  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  context.drawImage(image, 0, 0);
  if (!spatial || !meterToPixel()) return;
  const matrix = meterToPixel();
  context.lineCap = "round";
  for (const wall of spatial.envelope.walls) {
    const start = transform(matrix, wall.start);
    const end = transform(matrix, wall.end);
    context.strokeStyle = "#24a7ffdd";
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
    for (const point of [start, end]) {
      context.fillStyle = "#e8f7ff";
      context.strokeStyle = "#087ebd";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point[0], point[1], 7, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }
  const walls = new Map(
    spatial.envelope.walls.map((wall) => [wall.id, wall]),
  );
  for (const opening of spatial.envelope.openings || []) {
    const wall = walls.get(opening.host_wall_id);
    if (!wall) continue;
    const start = transform(matrix, wallPointAt(wall, opening.offset));
    const end = transform(
      matrix,
      wallPointAt(wall, opening.offset + opening.width),
    );
    context.strokeStyle = "#ff9b31";
    context.lineWidth = 8;
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(...end);
    context.stroke();
  }
}

function markEdited(fact) {
  if (!fact.provenance) return;
  fact.provenance.method = "user_edited";
  fact.provenance.confidence = 1;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.style.color = error ? "#ff9e9e" : "#9be5bc";
}

function populateForm() {
  if (!spatial) return;
  const scale = spatial.extraction?.scale || {};
  elements["meters-per-pixel"].value =
    scale.meters_per_source_unit || "";
  elements["scale-status"].value = scale.status || "unknown";
  elements["independent-verification"].checked =
    spatial.extraction?.construction_ready_eligible === true;
  elements["room-name"].value = spatial.rooms?.[0]?.name || "";
  elements["room-type"].value = spatial.rooms?.[0]?.type || "";
  elements.questions.value = (spatial.unresolved_questions || [])
    .map((item) => (typeof item === "string" ? item : item.message))
    .join("\n");
  elements["approval-scope"].value =
    spatial.validation?.approved_scope || "";
  elements["mark-reviewed"].checked =
    spatial.validation?.status === "approved";
  elements["opening-select"].innerHTML = "";
  for (const opening of spatial.envelope?.openings || []) {
    const option = document.createElement("option");
    option.value = opening.id;
    option.textContent = `${opening.id} · ${opening.kind}`;
    elements["opening-select"].append(option);
  }
  populateOpening();
  elements.export.disabled = false;
}

function selectedOpening() {
  return (spatial?.envelope?.openings || []).find(
    (opening) => opening.id === elements["opening-select"].value,
  );
}

function populateOpening() {
  const opening = selectedOpening();
  for (const id of [
    "opening-kind",
    "opening-offset",
    "opening-width",
    "opening-height",
    "opening-sill",
  ]) {
    elements[id].disabled = !opening;
  }
  if (!opening) return;
  elements["opening-kind"].value = opening.kind;
  elements["opening-offset"].value = opening.offset;
  elements["opening-width"].value = opening.width;
  elements["opening-height"].value = opening.height;
  elements["opening-sill"].value = opening.sill_height || 0;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const next = new Image();
  await new Promise((resolve, reject) => {
    next.onload = resolve;
    next.onerror = reject;
    next.src = url;
  });
  image = next;
  draw();
  setStatus(`源图已载入：${file.name}（${next.naturalWidth}×${next.naturalHeight}）`);
}

async function loadSpatial(file) {
  spatial = JSON.parse(await file.text());
  if (!Array.isArray(spatial?.envelope?.walls) || !pixelToMeter()) {
    throw new Error("Spatial JSON 缺少墙体或像素到米的 coordinate_transform。");
  }
  spatial.extraction.source_conflicts ||= [];
  populateForm();
  draw();
  setStatus(
    `Spatial JSON 已载入：${spatial.project.id} / ${spatial.project.revision}\n拖动端点或修改右侧字段后导出。`,
  );
}

function canvasPoint(event) {
  const bounds = elements.canvas.getBoundingClientRect();
  return [
    (event.clientX - bounds.left) * (elements.canvas.width / bounds.width),
    (event.clientY - bounds.top) * (elements.canvas.height / bounds.height),
  ];
}

elements.canvas.addEventListener("pointerdown", (event) => {
  if (!spatial || !meterToPixel()) return;
  const pointer = canvasPoint(event);
  const matrix = meterToPixel();
  let best = null;
  for (const wall of spatial.envelope.walls) {
    for (const field of ["start", "end"]) {
      const pixel = transform(matrix, wall[field]);
      const distance = Math.hypot(pixel[0] - pointer[0], pixel[1] - pointer[1]);
      if (distance <= 14 && (!best || distance < best.distance)) {
        best = { wall, field, distance, original: [...wall[field]] };
      }
    }
  }
  if (!best) return;
  const linked = [];
  for (const wall of spatial.envelope.walls) {
    for (const field of ["start", "end"]) {
      if (
        Math.hypot(
          wall[field][0] - best.original[0],
          wall[field][1] - best.original[1],
        ) < 1e-6
      ) {
        linked.push({ wall, field });
      }
    }
  }
  drag = { linked };
  elements.canvas.setPointerCapture(event.pointerId);
});

elements.canvas.addEventListener("pointermove", (event) => {
  if (!drag || !pixelToMeter()) return;
  const point = transform(pixelToMeter(), canvasPoint(event));
  for (const target of drag.linked) {
    target.wall[target.field] = point.map((value) =>
      Number(value.toFixed(6)),
    );
    markEdited(target.wall);
  }
  spatial.extraction.topology_confidence = 1;
  draw();
});

for (const eventName of ["pointerup", "pointercancel"]) {
  elements.canvas.addEventListener(eventName, () => {
    if (drag) setStatus("墙角已人工修正；导出后请重新运行 Schema、几何与对齐验证。");
    drag = null;
  });
}

elements["image-file"].addEventListener("change", async (event) => {
  try {
    await loadImage(event.target.files[0]);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements["json-file"].addEventListener("change", async (event) => {
  try {
    await loadSpatial(event.target.files[0]);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements["opening-select"].addEventListener("change", populateOpening);

for (const [id, field] of [
  ["opening-kind", "kind"],
  ["opening-offset", "offset"],
  ["opening-width", "width"],
  ["opening-height", "height"],
  ["opening-sill", "sill_height"],
]) {
  elements[id].addEventListener("change", () => {
    const opening = selectedOpening();
    if (!opening) return;
    opening[field] =
      field === "kind" ? elements[id].value : Number(elements[id].value);
    markEdited(opening);
    populateForm();
    draw();
  });
}

elements["meters-per-pixel"].addEventListener("change", () => {
  if (!spatial) return;
  const previous = spatial.extraction.scale.meters_per_source_unit;
  const next = Number(elements["meters-per-pixel"].value);
  if (!(previous > 0) || !(next > 0)) {
    setStatus("米 / 像素必须为正数。", true);
    return;
  }
  const ratio = next / previous;
  for (const wall of spatial.envelope.walls) {
    wall.start = wall.start.map((value) => Number((value * ratio).toFixed(6)));
    wall.end = wall.end.map((value) => Number((value * ratio).toFixed(6)));
    wall.thickness = Number((wall.thickness * ratio).toFixed(6));
    markEdited(wall);
  }
  for (const opening of spatial.envelope.openings || []) {
    opening.offset = Number((opening.offset * ratio).toFixed(6));
    opening.width = Number((opening.width * ratio).toFixed(6));
    markEdited(opening);
  }
  for (const room of spatial.rooms || []) {
    if (Number.isFinite(room.area)) room.area *= ratio ** 2;
    markEdited(room);
  }
  spatial.extraction.scale.meters_per_source_unit = next;
  const matrix = spatial.extraction.coordinate_transform.matrix_3x3;
  for (const index of [0, 1, 2, 3, 4, 5]) matrix[index] *= ratio;
  draw();
});

elements["scale-status"].addEventListener("change", () => {
  spatial.extraction.scale.status = elements["scale-status"].value;
  if (elements["scale-status"].value !== "trusted") {
    elements["independent-verification"].checked = false;
    spatial.extraction.construction_ready_eligible = false;
  }
});
elements["independent-verification"].addEventListener("change", () => {
  if (
    elements["independent-verification"].checked &&
    spatial.extraction.scale.status !== "trusted"
  ) {
    elements["independent-verification"].checked = false;
    setStatus("独立尺寸核验必须建立在 trusted 尺度上。", true);
    return;
  }
  spatial.extraction.construction_ready_eligible =
    elements["independent-verification"].checked;
});
elements["room-name"].addEventListener("change", () => {
  spatial.rooms[0].name = elements["room-name"].value;
  markEdited(spatial.rooms[0]);
});
elements["room-type"].addEventListener("change", () => {
  spatial.rooms[0].type = elements["room-type"].value;
  markEdited(spatial.rooms[0]);
});

elements.export.addEventListener("click", () => {
  if (!spatial) return;
  spatial.unresolved_questions = elements.questions.value
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const reviewed = elements["mark-reviewed"].checked;
  const scope = elements["approval-scope"].value || null;
  if (reviewed && !scope) {
    setStatus("勾选人工核对前必须选择批准范围。", true);
    return;
  }
  if (
    reviewed &&
    (spatial.extraction.scale.status !== "trusted" ||
      spatial.extraction.construction_ready_eligible !== true) &&
    scope !== "visualization_only"
  ) {
    setStatus(
      "没有 trusted 尺度与独立尺寸核验记录时只能选择 visualization_only。",
      true,
    );
    return;
  }
  if (reviewed && spatial.unresolved_questions.length > 0) {
    setStatus("仍有未解决问题，不能标记为已人工核对。", true);
    return;
  }
  spatial.validation.status = reviewed ? "approved" : "pending";
  spatial.validation.approved_scope = reviewed ? scope : null;
  spatial.validation.checks = [];
  spatial.project.revision = `${spatial.project.revision}-reviewed`;
  const blob = new Blob([`${JSON.stringify(spatial, null, 2)}\n`], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${spatial.project.id}-${spatial.project.revision}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(
    "修正版已导出。下一步：运行 validate-spatial-json、重新生成顶视图和对齐报告；全部通过后由人运行 approve-spatial-json。",
  );
});

#!/usr/bin/env node

import { mkdir, readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  parseArgs,
  printJson,
  readJson,
  sha256,
  writeJson,
} from "../lib/cli.mjs";
import { inspectTool, runTool } from "./tool-runner.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const ROLES = new Set(["interior_photo", "multiview", "panorama", "material_reference"]);

export async function inspectImageMedia(filePath, role = "interior_photo") {
  if (!ROLES.has(role)) throw new Error(`Unsupported visual role ${role}.`);
  const bytes = await readFile(filePath);
  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const aspectRatio = height > 0 ? width / height : null;
  const blockers = [];
  const warnings = [];
  if (width < 640 || height < 480) blockers.push("Image is below the 640×480 evidence minimum.");
  if (role === "panorama" && (aspectRatio < 1.95 || aspectRatio > 2.05)) {
    blockers.push("Panorama must use a 2:1 equirectangular image.");
  }
  if (metadata.orientation && metadata.orientation !== 1) {
    warnings.push(`EXIF orientation ${metadata.orientation} must be normalized before pixel-coordinate annotations.`);
  }
  return {
    id: `view-${sha256(bytes).slice(0, 12)}`,
    path: resolve(filePath),
    sha256: sha256(bytes),
    bytes: bytes.length,
    role,
    media_type: role === "panorama" ? "equirectangular_image" : "perspective_image",
    width,
    height,
    aspect_ratio: aspectRatio,
    format: metadata.format || extname(filePath).slice(1),
    orientation: metadata.orientation || 1,
    color_space: metadata.space || null,
    has_alpha: metadata.hasAlpha || false,
    camera_model: role === "panorama" ? "equirectangular" : "perspective_unknown_intrinsics",
    blockers,
    warnings,
  };
}

export function validateCameraRegistration(registration, views) {
  const errors = [];
  if (!registration || !Array.isArray(registration.views)) {
    return { valid: false, errors: ["Registration sidecar must contain a views array."] };
  }
  const expected = new Set(views.map((view) => view.sha256));
  for (const view of registration.views) {
    if (!expected.delete(view.source_sha256)) {
      errors.push(`Registration contains an unknown or duplicate view ${view.source_sha256}.`);
    }
    const intrinsics = view.intrinsics;
    if (
      !intrinsics
      || !["fx", "fy", "cx", "cy"].every((key) => Number.isFinite(intrinsics[key]))
      || intrinsics.fx <= 0
      || intrinsics.fy <= 0
    ) {
      errors.push(`View ${view.source_sha256} has invalid pinhole intrinsics.`);
    }
    if (
      !Array.isArray(view.camera_to_world)
      || view.camera_to_world.length !== 16
      || !view.camera_to_world.every(Number.isFinite)
    ) {
      errors.push(`View ${view.source_sha256} has an invalid 4×4 camera transform.`);
    }
  }
  if (expected.size > 0) errors.push(`Registration is missing ${expected.size} input view(s).`);
  if (
    !Number.isFinite(registration.rms_reprojection_error_px)
    || registration.rms_reprojection_error_px > 3
  ) {
    errors.push("Registration RMS reprojection error must be at most 3 px.");
  }
  if (
    !registration.scale
    || !Number.isFinite(registration.scale.meters_per_unit)
    || registration.scale.meters_per_unit <= 0
    || typeof registration.scale.anchor_id !== "string"
  ) {
    errors.push("Registration requires a positive metric scale and stable anchor ID.");
  }
  return { valid: errors.length === 0, errors };
}

export async function inspectVideoMedia(
  filePath,
  outputDirectory,
  {
    frameIntervalSeconds = 2,
    maxFrames = 60,
    run = runTool,
  } = {},
) {
  const input = resolve(filePath);
  const output = resolve(outputDirectory);
  const bytes = await readFile(input);
  const [ffprobe, ffmpeg] = await Promise.all([
    inspectTool("ffprobe", ["-version"], { run }),
    inspectTool("ffmpeg", ["-version"], { run }),
  ]);
  if (!ffprobe.available || !ffmpeg.available) {
    throw new Error(`Video route requires FFprobe and FFmpeg (${ffprobe.error || ffmpeg.error}).`);
  }
  const probeResult = await run(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", input],
    { timeoutMs: 30000 },
  );
  const probe = JSON.parse(probeResult.stdout);
  const stream = probe.streams?.find((candidate) => candidate.codec_type === "video");
  if (!stream) throw new Error("Input contains no video stream.");
  const durationSeconds = Number(probe.format?.duration || stream.duration);
  const blockers = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) blockers.push("Video duration is missing.");
  if ((stream.width || 0) < 640 || (stream.height || 0) < 480) blockers.push("Video is below 640×480.");
  await mkdir(output, { recursive: true });
  const pattern = join(output, "frame-%04d.png");
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", input,
      "-vf", `fps=1/${frameIntervalSeconds}`,
      "-frames:v", String(maxFrames),
      pattern,
    ],
    { timeoutMs: 180000 },
  );
  const frameFiles = (await readdir(output))
    .filter((name) => /^frame-\d+\.png$/u.test(name))
    .sort()
    .map((name) => join(output, name));
  if (frameFiles.length < 2) blockers.push("Video produced fewer than two usable keyframes.");
  const frames = [];
  for (const frame of frameFiles) {
    frames.push(await inspectImageMedia(frame, "multiview"));
  }
  return {
    id: `video-${sha256(bytes).slice(0, 12)}`,
    path: input,
    sha256: sha256(bytes),
    bytes: bytes.length,
    media_type: "video",
    codec: stream.codec_name || null,
    width: stream.width || null,
    height: stream.height || null,
    duration_seconds: durationSeconds,
    average_frame_rate: stream.avg_frame_rate || null,
    rotation_degrees: Number(stream.tags?.rotate || 0),
    extracted_frames: frames,
    tools: { ffprobe: ffprobe.version, ffmpeg: ffmpeg.version },
    blockers,
  };
}

export function buildVisualReconstructionEvidence(
  views,
  {
    registration = null,
    scaleAnchor = null,
  } = {},
) {
  const blockers = views.flatMap((view) => view.blockers.map((message) => ({
    view_id: view.id,
    message,
  })));
  const multiviews = views.filter((view) => view.role === "multiview");
  const panoramas = views.filter((view) => view.role === "panorama");
  let registrationReport = null;
  if (multiviews.length > 0) {
    if (multiviews.length < 3) {
      blockers.push({ message: "Multiview reconstruction requires at least three distinct views." });
    } else if (new Set(multiviews.map((view) => view.sha256)).size !== multiviews.length) {
      blockers.push({ message: "Multiview reconstruction contains duplicate images." });
    }
    registrationReport = validateCameraRegistration(registration, multiviews);
    if (!registrationReport.valid) {
      blockers.push(...registrationReport.errors.map((message) => ({ message })));
    }
  }
  if (panoramas.length > 1) {
    blockers.push({ message: "Multiple panoramas require an explicit pose/alignment sidecar." });
  }
  const metricScale =
    registrationReport?.valid
      ? registration.scale
      : (
          scaleAnchor
          && Number.isFinite(scaleAnchor.meters)
          && scaleAnchor.meters > 0
          && typeof scaleAnchor.id === "string"
            ? { anchor_id: scaleAnchor.id, meters: scaleAnchor.meters }
            : null
        );
  if (!metricScale) {
    blockers.push({ message: "Visual reconstruction requires a user-confirmed metric scale anchor." });
  }
  return {
    schema_version: "1.0",
    route: "visual_reconstruction",
    views,
    camera_registration: registrationReport
      ? {
          status: registrationReport.valid ? "validated" : "blocked",
          errors: registrationReport.errors,
          sidecar: registration,
        }
      : { status: "not_applicable", errors: [] },
    metric_scale: metricScale,
    geometry_policy: {
      visible_surfaces: "evidence",
      occluded_or_missing_geometry: "explicit_inference_only",
      construction_ready: false,
    },
    contains_possible_personal_data: true,
    blockers,
    recommended_scope: blockers.length === 0 ? "visualization_only" : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    input: { type: "array", required: true },
    role: { type: "array" },
    output: { type: "string", required: true },
    "frame-directory": { type: "string", default: "visual-frames" },
    registration: { type: "string" },
    "scale-anchor": { type: "string" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write("Usage:\n  node scripts/ingest/inspect-visual-media.mjs --input room-a.jpg --role multiview --input room-b.jpg --role multiview --input room-c.jpg --role multiview --registration cameras.json --scale-anchor scale.json --output visual-evidence.json\n");
    return;
  }
  if (options.role.length && options.role.length !== options.input.length) {
    throw new Error("When --role is used, provide exactly one role for each input.");
  }
  const views = [];
  const videos = [];
  for (let index = 0; index < options.input.length; index += 1) {
    const input = options.input[index];
    const extension = extname(input).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      views.push(await inspectImageMedia(input, options.role[index] || "interior_photo"));
    } else if (VIDEO_EXTENSIONS.has(extension)) {
      const video = await inspectVideoMedia(
        input,
        join(options["frame-directory"], `video-${index + 1}`),
      );
      videos.push(video);
      views.push(...video.extracted_frames);
    } else {
      throw new Error(`Unsupported visual-media extension: ${extension || "(none)"}.`);
    }
  }
  const [registration, scaleAnchor] = await Promise.all([
    options.registration ? readJson(options.registration, "camera registration") : null,
    options["scale-anchor"] ? readJson(options["scale-anchor"], "scale anchor") : null,
  ]);
  const evidence = buildVisualReconstructionEvidence(views, {
    registration,
    scaleAnchor,
  });
  evidence.videos = videos;
  await writeJson(options.output, evidence);
  printJson({
    outputFile: options.output,
    views: views.length,
    videos: videos.length,
    registration: evidence.camera_registration.status,
    blockers: evidence.blockers.length,
  });
  if (evidence.blockers.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

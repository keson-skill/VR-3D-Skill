---
name: vr-3d-skill
description: Turn CAD, DXF, floor-plan images, PDFs, room photos, scans, and renovation requirements into validated Spatial JSON and directly viewable interior results, including parametric shell, hard-furnished, or furnished GLB scenes, Three.js desktop walkthroughs, WebXR viewing, panorama renders, and editable Blender outputs. Use when Codex must extract room geometry, design an interior, generate or review a 3D/VR workflow, build a viewable property scene, or implement WebXR interaction, asset, comfort, and performance behavior.
---

# AI VR Interior Design

Turn architectural inputs into a traceable spatial model, then derive design, assets, code, and immersive experiences from that model.

## Obey the product requirements and development gate

Read [需求文档.md](需求文档.md) before planning, implementing, or reviewing a project change. Treat it as authoritative for final product scope, current progress, and development-stage status. Do not confuse its project-development stages with the per-job workflow stages below.

- Identify the single stage marked `IN_PROGRESS` or `ACCEPTANCE` before changing code.
- Work only on that active stage and its acceptance evidence.
- Do not start, extend, or claim completion of a later stage until every mandatory item in the active stage passes and the requirements document records it as `COMPLETED`.
- Treat code that already exists for a blocked later stage as a frozen research prototype. Use it only when needed to verify or unblock the active stage.
- Require tests, traceable evidence, zero open blockers, human acceptance, and a status update in the same change before opening the next stage.
- If a request targets a blocked later stage, report the active-stage blockers and continue only with work that closes the current gate.
- Permit only minimal cross-stage repairs for security, data loss, test infrastructure, or a defect that directly blocks the active stage. Do not count the repair as stage advancement.

## Keep one source of spatial truth

- Treat `Spatial JSON` as the authoritative contract between understanding, planning, asset generation, engineering, and rendering.
- Never let a mesh or image generator decide room topology, circulation, furniture clearances, or construction dimensions.
- Preserve source dimensions. Use meters internally unless an existing project requires another unit, and record every conversion.
- Record confidence, assumptions, unresolved questions, and provenance instead of inventing missing measurements.
- For raster-only plans, mark approvals as `visualization_only` unless dimensions, topology, openings, and scale have independently passed the stricter construction-ready gate. Never present a visualization-only approval as construction, procurement, or exact-layout approval.
- Apply later style or furniture requests as patches to the approved `Spatial JSON`; do not silently rebuild the room.
- Never send floor plans, room photos, client addresses, or project metadata to an external provider without user authorization.
- Never write API keys into source files, logs, generated scenes, or committed configuration.

## Inspect the project and inputs

1. Inspect the existing framework, build scripts, scene graph, asset pipeline, input model, and data contracts.
2. Identify each input: CAD, measured floor plan, concept plan, room photo, scan, or text requirement.
3. Confirm available scale anchors, target rooms, intended occupants, budget or product constraints, required output fidelity, and target devices.
4. Preserve the project's engine and conventions unless the user requests a migration.
5. Define the smallest observable vertical slice, such as one validated room that can be explored in desktop and WebXR modes.
6. Read [engine-routing.md](references/engine-routing.md) before selecting or entering an unfamiliar rendering stack.

## Route model responsibilities

Read [model-routing.md](references/model-routing.md) before adding provider calls and [script-architecture.md](references/script-architecture.md) before invoking bundled scripts. When routing GPT-5.5 and GPT Image 2 through RealmRouter, read [realmrouter-integration.md](references/realmrouter-integration.md) and use the task entrypoints under `scripts/tasks/`; keep the raw provider protocol in `scripts/adapters/realmrouter-openai.mjs`. When using a Kimi Code membership for engineering assistance, also read [kimi-code-integration.md](references/kimi-code-integration.md). Keep deployment values in an ignored `.env`, based on `.env-example`.

| Role | Responsibility | Must not own |
|---|---|---|
| Spatial reasoning model | Interpret drawings, photos, scale cues, room semantics, constraints, and user intent; produce structured spatial facts | Final code, unvalidated construction dimensions, or decorative mesh generation |
| Visual preview model | Generate and edit customer-facing images from an approved design revision | Spatial JSON, construction geometry, collision, circulation, or dimensional truth |
| Engineering model | Extend or repair the fixed scene compiler, Blender path, viewer, interactions, and tests | Regenerating the whole viewer for every job or changing approved room geometry |
| 3D asset model | Generate furniture and decor assets with requested dimensions and style | Walls, openings, circulation planning, or whole-room design decisions |
| Runtime or renderer | Display, interact with, profile, export, or render the approved scene | Reinterpreting design intent |

## Execute the interior-design pipeline

Read [interior-design-workflow.md](references/interior-design-workflow.md) for stage inputs, outputs, and failure handling.

1. **Route and normalize input.** Run `scripts/ingest/detect-input.mjs` or the unified `prepare-interior-job.mjs`. Preserve originals and fingerprints. Keep DXF and vector PDF evidence structured; convert DWG, binary scans, FBX, and XLSX only through the configured local tool route. For raster/scan pages, use local normalization and optional Tesseract OCR. For IFC, visual media, point clouds, depth, existing 3D, and product catalogs, use their dedicated ingest adapters and preserve their blockers. Treat OCR, semantic node names, planes, and camera estimates as evidence, never as geometry truth.
2. **Understand space.** Run a deterministic converter first when one exists. Preserve source coordinates, page transforms, units, axes, explicit measurements, resource hashes, camera registration, and a trusted or estimated scale. Simple closed IFC wall axes and qualified point-cloud bounds may produce a pending visualization draft; complex BIM, occluded photo geometry, and scan opening candidates remain explicit review items. Use the configured spatial model (`gpt-5.5` by default) only for ambiguous semantics that deterministic evidence cannot classify. Emit draft `Spatial JSON` with provenance, confidence, assumptions, conflicts, and unresolved questions.
3. **Validate and obtain independent approval before designing.** Run Draft 2020-12 JSON Schema and business-geometry validation, generate a source-aligned top view, and review the overlay in the local correction UI. A human must then create a separate approval artifact that binds the source manifest, exact Spatial JSON, and exact validation report and signs them with an externally trusted Ed25519 reviewer key. The in-document `validation.status` never replaces this sidecar. Unknown scale, conflicts, unresolved questions, low-confidence topology, an untrusted signature, or a mismatched hash must block downstream work.
4. **Propose design.** Add functional zoning, furniture footprints, ergonomic clearances, materials, lighting, and style intent without overwriting measured geometry.
5. **Preview visually.** After design approval, use GPT Image 2 for generation or the reference-edit task for approved source images. Bind every image to a design revision and never feed inferred image geometry back into the spatial contract.
6. **Generate assets.** Reuse catalog assets first. Generate only missing furniture or decor, request real dimensions, normalize pivots and scale, and export GLB when targeting the web.
7. **Compile the viewable scene.** Run the fixed `build-viewable-scene.mjs` task against approved Spatial JSON. Generate a deterministic GLB and static Three.js viewer. Represent unresolved furniture assets with dimensionally correct proxies. Do not ask a model to rewrite the viewer per job.
8. **Render and interact.** Serve the viewer over HTTP and verify orbit, top, first-person, furniture visibility, desktop fallback, and WebXR. Add Blender panorama or high-fidelity rendering only after the deterministic scene passes. Compare a normalized top-view render against the source plan before delivery.
9. **Apply revisions incrementally.** Let the revision-planning task translate natural language into a scoped stable-ID contract, but never apply raw model output. Validate and apply it with the deterministic revision engine, persist the version/diff/inverse/hash-chain audit, invalidate stale approvals, obtain reapproval, and regenerate only the dependency plan.
10. **Run and deliver through production gates.** Use the production job runtime for idempotency, retries, checkpoints, pause/resume, cancellation, and tamper-evident redacted events. Build an explicit delivery manifest that binds the exact approval chain and artifacts. Never promote a candidate package until the same commit has Linux/macOS/Windows CI evidence, actual desktop/mobile/XR/Blender qualification, and an interactively accepted anonymized real project.

Use the contract in [spatial-json-contract.md](references/spatial-json-contract.md). Validate the contract before any downstream generation. If geometry conflicts with source measurements, stop and surface the conflict rather than choosing silently.

Run bundled model-task entrypoints only after their deterministic preconditions pass. External-provider task scripts require the explicit `--allow-provider` flag; use it only after the user approves the provider and the exact project data being sent. Do not bypass this boundary by calling an adapter directly for normal workflow execution.

## Produce the first viewable result

Install and check local dependencies:

```bash
npm install
npm run doctor
```

Route the input. For a raster plan:

```bash
node scripts/orchestration/prepare-interior-job.mjs \
  --input plan.png --output runs/job-001

node scripts/ingest/extract-ocr-evidence.mjs \
  --input runs/job-001/evidence/01-plan-normalized.png \
  --output runs/job-001/ocr-evidence.json

node scripts/spatial/raster-to-spatial.mjs \
  --input runs/job-001/evidence/01-plan-normalized.png \
  --source-manifest runs/job-001/source-manifest.json \
  --preprocess-metadata runs/job-001/evidence/01-plan-preprocess.json \
  --scale-anchor scale-anchor.json \
  --project-id job-001 \
  --output runs/job-001/spatial-draft.json
```

For DXF, preserve its vectors:

```bash
node scripts/ingest/extract-dxf-evidence.mjs \
  --input plan.dxf --output runs/job-001/dxf-evidence.json

node scripts/spatial/dxf-to-spatial.mjs \
  --evidence runs/job-001/dxf-evidence.json \
  --source-manifest runs/job-001/source-manifest.json \
  --project-id job-001 \
  --output runs/job-001/spatial-draft.json
```

For mixed inputs, let the unified preparation route create per-source evidence and structured blockers:

```bash
node scripts/orchestration/prepare-interior-job.mjs \
  --input model.ifc \
  --input room-a.jpg --role multiview \
  --input room-b.jpg --role multiview \
  --input room-c.jpg --role multiview \
  --registration camera-registration.json \
  --scale-anchor scale-anchor.json \
  --output runs/job-001
```

DWG, LAS/LAZ/E57, FBX, PDF, video, and XLSX depend on local converters or tools reported by `npm run doctor`. Approval flags authorize only the configured local conversion process; they do not approve the resulting space. OBJ additionally requires explicit units, up/forward axes, and handedness. Visual, IFC, scan, point-cloud, and imported-scene drafts remain `pending` and normally `visualization_only` until their own evidence and the independent Spatial approval gate pass.

Review and correct the source overlay locally, then rerun validation and alignment:

```bash
npm run review:spatial

node scripts/validation/validate-spatial-json.mjs \
  --input runs/job-001/spatial-approved.json \
  --output runs/job-001/spatial-validation.json

node scripts/validation/render-spatial-top-view.mjs \
  --spatial-json runs/job-001/spatial-approved.json \
  --output runs/job-001/top-view.png

node scripts/validation/compare-plan-render.mjs \
  --source runs/job-001/evidence/01-plan-normalized.png \
  --render runs/job-001/top-view.png \
  --output runs/job-001/alignment.json \
  --diff runs/job-001/alignment-diff.png
```

Set up a reviewer trust root once. Keep the private key outside the repository:

```bash
node scripts/approval/create-approval-key.mjs \
  --key-id reviewer-001 \
  --owner "Reviewer name" \
  --private-key /secure/outside/repo/reviewer-ed25519.pem \
  --trust-store config/spatial-approval-trust.json
```

Only the human reviewer runs the interactive approval command:

```bash
node scripts/approval/approve-spatial-json.mjs \
  --source-manifest runs/job-001/source-manifest.json \
  --spatial-json runs/job-001/spatial-approved.json \
  --validation-report runs/job-001/spatial-validation.json \
  --signing-key /secure/outside/repo/reviewer-ed25519.pem \
  --key-id reviewer-001 \
  --output runs/job-001/spatial-approval.json
```

After the independent approval passes, generate a viewable compatibility result:

```bash
node scripts/tasks/scene-generation/build-viewable-scene.mjs \
  --spatial-json runs/job-001/spatial-approved.json \
  --source-manifest runs/job-001/source-manifest.json \
  --validation-report runs/job-001/spatial-validation.json \
  --approval runs/job-001/spatial-approval.json \
  --approval-trust config/spatial-approval-trust.json \
  --output runs/job-001/viewer \
  --mode furnished

node scripts/serve-viewer.mjs \
  --directory runs/job-001/viewer --port 4173
```

Use `--mode shell` for a bare shell, `hard-furnishing` for fixed finishes, and `furnished` for furniture proxies or resolved assets. A single raster plan defaults to `visualization_only`; surface that warning in the viewer.

For recoverable production execution, copy and edit [production-job-definition.example.json](examples/production-job-definition.example.json), then run:

```bash
npm run job -- \
  --action run \
  --definition production-job-definition.json \
  --store runs/runtime \
  --workspace runs

npm run job -- \
  --action verify \
  --job-id job-project-001 \
  --store runs/runtime
```

Definitions may use only the bundled handler registry and must satisfy both the production-job Schema and per-handler parameter contracts. Every declared output must stay below `--workspace`, including existing directory contents; there is no arbitrary shell handler.

## Build the immersive experience

### Establish spatial conventions

- Keep one authoritative player or XR origin and document its relationship to the camera, floor, and teleport targets.
- Separate world-space content, head-locked UI, and hand or controller attachments.
- Avoid scaling the player rig to compensate for incorrectly sized assets.
- Make design variants switchable without duplicating the entire scene graph.

### Design input as actions

- Model actions such as inspect, compare, select, grab, move, rotate, replace, undo, teleport, menu, and cancel independently of a device.
- Map controllers, hands, gaze, mouse, keyboard, and touch onto those actions as appropriate.
- When a user moves furniture, snap and constrain against walls, bounds, door swings, and minimum clearances.
- Show visible hover, focus, grab, collision, invalid-placement, and unavailable states.

### Protect comfort

- Prefer teleportation and snap turning by default; make smooth motion optional.
- Never move or rotate the camera independently of explicit user input.
- Avoid forced acceleration, head bob, camera shake, rapidly moving horizon lines, and scale changes around the viewer.
- Provide a stable reference frame during artificial locomotion when practical.

### Keep the frame loop lean

- Reuse materials, geometries, buffers, and temporary math objects.
- Instance repeated assets, compress textures and meshes, load progressively, and release unused GPU resources.
- Use level of detail, occlusion or room-based visibility, baked lighting, and lightweight collision where they materially reduce frame time.
- Pause or reduce work when the XR session ends or the page is hidden.

### Provide a non-XR path

- Preserve keyboard, mouse, touch, and screen-reader access for the primary review task.
- Keep design comparison, inspection, and revision usable when WebXR is unavailable.
- Start immersive sessions only from an explicit user gesture and show a recoverable error when startup fails.

## Verify before delivery

Read [quality-gates.md](references/quality-gates.md), then verify the relevant rows.

- Trace measured geometry back to source inputs and distinguish measured, inferred, generated, and user-edited values.
- Validate topology, scale, door swings, furniture collision, circulation, asset pivots, and material assignments.
- Test session enter, exit, pause, resume, focus loss, controller reconnection, and at least one desktop fallback.
- Measure frame time on representative target hardware; do not infer headset performance from a desktop alone.
- Exercise missing-provider, timeout, rejected-input, invalid-asset, and unsupported-XR fallbacks.
- Report what was tested, what could not be tested, unresolved assumptions, and remaining device or construction risk.
- Run `npm run p10:code-acceptance` for code readiness. Treat its expected `release_qualified: false` as a real blocker, not a warning to suppress.
- Read [docs/QUALIFICATION.md](docs/QUALIFICATION.md) before any release claim. Desktop simulation cannot qualify mobile or XR, mock Blender cannot qualify rendering, and configured CI cannot qualify a commit until the workflow actually runs.

## Deliver reproducible artifacts

Deliver the artifacts relevant to the request:

- normalized `spatial.json` plus its schema version, provenance, assumptions, validation report, source manifest, source-alignment report, and independent approval artifact;
- design constraints, layout alternatives, and an incremental revision or patch log;
- asset manifest with source or generation provenance, dimensions, license, format, and optimization status;
- deterministic `scene.glb`, `scene-primitives.json`, GLB structural report, compiled-scene top-view alignment report, the static Three.js viewer, source Spatial JSON, validation report, and run command;
- desktop review path, WebXR build or native scene, and required HTTPS, device, browser, or permission notes;
- customer-facing renders, walkthrough, bill of materials, or proposal only when requested.
- an explicit delivery manifest containing the exact source, Spatial JSON, validation, approval, trust-root and artifact hashes, resolved asset-license status, limitations, and `delivery_ready` result;
- for software distribution, a candidate or qualified package, CycloneDX SBOM and release manifest. Keep `release_ready: false` candidates visibly unqualified.

Prefer a verified one-room vertical slice over a large unvalidated model.

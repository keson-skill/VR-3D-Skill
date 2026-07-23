---
name: vr-3d-skill
description: Design, build, review, and optimize AI-assisted VR interior-design systems and immersive real-time 3D experiences. Use when Codex works from CAD or floor plans, room photos, existing design drawings, or renovation requirements to produce a validated Spatial JSON, furniture layouts, generated GLB assets, Three.js or Blender scene code, WebXR walkthroughs, or high-fidelity Unreal and Twinmotion outputs; also use for WebXR interaction, locomotion, comfort, device input, asset pipelines, and headset performance.
---

# AI VR Interior Design

Turn architectural inputs into a traceable spatial model, then derive design, assets, code, and immersive experiences from that model.

## Keep one source of spatial truth

- Treat `Spatial JSON` as the authoritative contract between understanding, planning, asset generation, engineering, and rendering.
- Never let a mesh or image generator decide room topology, circulation, furniture clearances, or construction dimensions.
- Preserve source dimensions. Use meters internally unless an existing project requires another unit, and record every conversion.
- Record confidence, assumptions, unresolved questions, and provenance instead of inventing missing measurements.
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

Read [model-routing.md](references/model-routing.md) before adding provider calls. Keep deployment values in `.env`, based on `.env-example`.

| Role | Responsibility | Must not own |
|---|---|---|
| Spatial reasoning model | Interpret drawings, photos, scale cues, room semantics, constraints, and user intent; produce structured spatial facts | Final code, unvalidated construction dimensions, or decorative mesh generation |
| Engineering model | Convert approved scene data into Three.js, Blender Python, scene configuration, interactions, and tests | Changing room topology or design constraints without an explicit patch |
| 3D asset model | Generate furniture and decor assets with requested dimensions and style | Walls, openings, circulation planning, or whole-room design decisions |
| Runtime or renderer | Display, interact with, profile, export, or render the approved scene | Reinterpreting design intent |

## Execute the interior-design pipeline

Read [interior-design-workflow.md](references/interior-design-workflow.md) for stage inputs, outputs, and failure handling.

1. **Ingest and normalize.** Preserve originals, fingerprint inputs, extract explicit measurements, set units and axes, and mark inferred values.
2. **Understand space.** Detect walls, openings, rooms, fixed equipment, usable zones, circulation, and scale anchors. Emit `Spatial JSON`.
3. **Validate before designing.** Check wall topology, opening placement, room closure, dimensional consistency, accessible paths, and unresolved low-confidence facts.
4. **Propose design.** Add functional zoning, furniture footprints, ergonomic clearances, materials, lighting, and style intent without overwriting measured geometry.
5. **Generate assets.** Reuse catalog assets first. Generate only missing furniture or decor, request real dimensions, normalize pivots and scale, and export GLB when targeting the web.
6. **Generate engineering artifacts.** Produce deterministic scene code or Blender scripts from the approved `Spatial JSON` and asset manifest. Keep generated code reviewable and reproducible.
7. **Render and interact.** Provide desktop inspection first, then WebXR or native VR. Use Unreal or Twinmotion when high-fidelity offline output is required.
8. **Apply revisions incrementally.** Convert user changes into explicit JSON Patch-like operations, re-run affected validations, and preserve revision history.

Use the contract in [spatial-json-contract.md](references/spatial-json-contract.md). Validate the contract before any downstream generation. If geometry conflicts with source measurements, stop and surface the conflict rather than choosing silently.

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

## Deliver reproducible artifacts

Deliver the artifacts relevant to the request:

- normalized `spatial.json` plus its schema version, provenance, assumptions, and validation report;
- design constraints, layout alternatives, and an incremental revision or patch log;
- asset manifest with source or generation provenance, dimensions, license, format, and optimization status;
- deterministic scene configuration, Three.js project or Blender script, and run or build commands;
- desktop review path, WebXR build or native scene, and required HTTPS, device, browser, or permission notes;
- customer-facing renders, walkthrough, bill of materials, or proposal only when requested.

Prefer a verified one-room vertical slice over a large unvalidated model.

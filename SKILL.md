---
name: vr-3d-skill
description: Build, extend, review, and optimize interactive real-time 3D and immersive VR/XR experiences. Use when Codex works on WebXR, Three.js, React Three Fiber, Babylon.js, A-Frame, Unity XR, Unreal OpenXR, spatial interaction, locomotion, controller or hand input, 3D asset pipelines, headset performance, or desktop and mobile fallbacks for an immersive scene.
---

# VR 3D

Create immersive experiences that remain comfortable, responsive, and usable outside a headset.

## Start with the project

1. Inspect the existing framework, build scripts, scene graph, asset pipeline, and input model.
2. Preserve the project's engine and conventions unless the user requests a migration.
3. Identify the target devices, browsers, controllers, hand-tracking support, and non-XR fallback.
4. Define the smallest observable success case before adding visual polish.
5. Read [engine-routing.md](references/engine-routing.md) when choosing or entering an unfamiliar engine.

## Build the experience

### Establish spatial conventions

- Use meters as world units unless the engine or existing project defines another scale.
- Keep one authoritative player or XR origin and document its relationship to the camera, floor, and teleport targets.
- Separate world-space content, head-locked UI, and hand or controller attachments.
- Avoid scaling the player rig to compensate for incorrectly sized assets.

### Design input as actions

- Model actions such as select, grab, move, turn, teleport, menu, and cancel independently of a specific device.
- Map controllers, hands, gaze, mouse, keyboard, and touch onto those actions as appropriate.
- Show visible hover, focus, grab, and unavailable states.
- Keep critical actions reachable without precise pointing.

### Protect comfort

- Prefer teleportation and snap turning by default; make smooth motion optional.
- Never move or rotate the camera independently of explicit user input.
- Avoid forced acceleration, head bob, camera shake, and rapidly moving horizon lines.
- Provide a stable reference frame during artificial locomotion when practical.
- Place frequent UI and interaction targets at comfortable distances and heights.

### Keep the frame loop lean

- Reuse materials, geometries, buffers, and temporary math objects.
- Batch or instance repeated objects and minimize transparent overdraw.
- Compress textures and meshes, load progressively, and release unused GPU resources.
- Keep simulation, rendering, and UI state synchronized without allocating on every frame.
- Pause or reduce work when the XR session ends or the page is hidden.

### Provide a non-XR path

- Preserve meaningful keyboard, mouse, touch, and screen-reader access when the experience runs on a flat screen.
- Keep the primary task usable if immersive-session startup fails or WebXR is unavailable.
- Present a clear entry action for XR; do not start an immersive session without a user gesture.

## Verify before delivery

Read [quality-gates.md](references/quality-gates.md), then verify the relevant rows of its test matrix.

- Test session enter, exit, pause, resume, focus loss, and controller reconnection.
- Test at least one desktop fallback and each available target XR device class.
- Inspect scale, floor alignment, reach distance, handedness, and interaction feedback.
- Measure frame time on representative hardware; do not infer headset performance from a desktop alone.
- Check asset loading failures and unsupported-feature fallbacks.
- Report what was tested, what could not be tested, and the remaining device-specific risk.

## Deliver changes

- Keep changes scoped to the requested experience.
- Explain new controls and comfort options in the project's existing user-facing documentation.
- Include reproducible run and test commands.
- Call out any required HTTPS, permissions policy, secure-context, device, or browser requirement.
- Prefer a working vertical slice over a large unverified scene.

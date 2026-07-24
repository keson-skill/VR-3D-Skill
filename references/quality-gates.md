# Quality gates

Use the gates that apply to the requested output. Record evidence, exclusions, and every gate that cannot be verified.

## Input and provenance

- Every source file has an identifier, type, revision, and coordinate or image orientation.
- Explicit dimensions remain distinct from inferred dimensions.
- Unit conversions, scale anchors, confidence scores, and assumptions are recorded.
- Local DWG, binary scan, FBX, PDF/video, and spreadsheet tool routes record the executable version, bounded arguments, input/output hashes, and failures without invoking a shell.
- PDF pages retain vector/text evidence when present; scan pages retain page transforms and never gain authority merely because they were rasterized or OCR-processed.
- Multi-view and video evidence has distinct image hashes, matching camera intrinsics/poses, acceptable reprojection error, and a metric scale; 360° evidence has a valid equirectangular projection and explicit alignment when multiple panoramas are used.
- IFC evidence retains units, storeys, containment, semantic types, property sets, classifications, and stable source entity IDs; cross-storey or unsupported geometry requires selection or a verified geometry engine.
- Point-cloud/depth evidence records source axis, unit scale, filtering, bounds, planes, point counts, limitations, and review-only opening candidates. It never claims hidden construction geometry.
- Existing 3D references reject remote/absolute/traversing resources, hash packaged dependencies, require explicit OBJ axes/units, and require asset ID and license in asset mode.
- Private plans, photos, addresses, and client metadata are sent only to approved providers.
- The output can identify which source, user edit, model, or asset produced each important fact.

## Spatial contract

- The `Spatial JSON` matches the declared schema version, units, axes, and coordinate frame.
- Wall segments connect consistently; intended rooms close; duplicate or zero-length geometry is rejected.
- Openings lie on their host walls and include width, height, sill or threshold, and swing or slide behavior when known.
- Room boundaries, area, ceiling height, fixed services, columns, and unusable zones agree with available measurements.
- Structural roles are source-backed; load-bearing or otherwise protected elements have explicit locked edit policies.
- Low-confidence topology or dimension conflicts block downstream generation until accepted or resolved.
- Production approval is an independent human-created sidecar bound to the exact source manifest, Spatial JSON, and zero-error validation report and signed by an active externally trusted Ed25519 reviewer key; in-document status and test fixtures are insufficient.
- User requirements, design intent, primary circulation rules, surface-material bindings, and asset material-slot bindings use stable IDs.
- Every revision uses stable IDs or exact JSON Pointers, contains no durable array indexes or wildcards, and revalidates affected geometry.

## Design and ergonomics

- Furniture fits its room, respects walls, openings, door swings, fixed equipment, and access zones.
- Primary circulation paths remain continuous and meet the project’s declared minimum clearances.
- Seating, tables, storage, beds, work surfaces, switches, and reachable interactions use project-appropriate ergonomic constraints.
- Accessibility requirements are explicit; no generic clearance is claimed as code compliance.
- Layout scoring reports the constraints and tradeoffs used rather than presenting one unexplained answer.

## Assets and appearance

- Asset dimensions, origin, pivot, forward axis, material slots, collision proxy, and license or generation provenance are recorded.
- Generated assets are normalized to scene units and checked for implausible scale, non-manifold geometry, flipped normals, excess materials, and avoidable texture cost.
- Walls and structural openings come from the spatial contract, not from decorative asset generation.
- Missing assets have placeholders and recoverable errors; they do not silently disappear.
- Material color space, texture resolution, UVs, lighting intent, and physically based values are credible for the target renderer.

## Functional VR and 3D

- Desktop mode launches and completes the primary review task.
- Immersive mode enters and exits cleanly when supported.
- Select, inspect, compare, revise, undo, teleport, and cancel work with each required input method.
- Invalid furniture placements are prevented or clearly signaled.
- Lost tracking, missing controllers, denied session startup, and provider failure fail safely.
- Re-entering a session does not duplicate listeners, objects, or update loops.

## Spatial presence and comfort

- World scale, floor height, eye height, reach, and initial spawn are credible and consistent.
- The viewer never spawns inside geometry, behind a blocked door, or outside the navigable boundary.
- Teleport targets distinguish valid areas and avoid furniture, wall thickness, stairs, and unsafe edges.
- Teleport and snap turn are available when artificial locomotion is required.
- The application does not force camera motion, roll the horizon, apply head bob, or unexpectedly rescale the world.
- UI remains legible without extreme neck rotation or arm extension.

## Performance

- Frame time is measured on representative target hardware and the target quality tier is recorded.
- No steady per-frame memory growth is observed during normal interaction.
- Draw calls, visible triangles, shader cost, texture memory, transparency, shadow cost, and generated asset complexity are reviewed.
- Loading is progressive, shows status, and includes recoverable provider and asset errors.
- Repeated assets are instanced or batched where appropriate; unused GPU and event resources are released.

## Accessibility and fallback

- Important state is communicated by more than color alone.
- Controls provide visible focus, activation, collision, and unavailable feedback.
- Audio-dependent actions have visual or haptic equivalents when practical.
- Flat-screen mode supports keyboard and pointer input for the primary task.
- Safety, boundary, undo, reset, and exit controls remain easy to reach.

## Test matrix

| Area | Minimum evidence |
|---|---|
| Source traceability | One measured and one inferred fact traced to source, confidence, and revision |
| Spatial JSON | Schema validation plus wall, room, opening, unit, and conflict checks |
| Layout | Door swing, circulation, furniture bounds, ergonomic rule, and accessibility assumption checks |
| Asset pipeline | Import one catalog asset and one generated asset; verify scale, pivot, material, license/provenance, and fallback |
| Desktop fallback | Launch, navigate, compare a design, apply a revision, undo, and recover from XR unavailability |
| Immersive lifecycle | Enter, exit, re-enter, pause, resume, and lose focus |
| Input | Inspect, select, revise, cancel, manipulate, locomote, and reconnect |
| Spatial setup | Spawn, floor height, standing or seated origin, handedness, reach, and boundaries |
| Performance | Representative-device frame-time and memory capture during the busiest scene |
| Failure handling | Missing dimension, provider timeout, invalid asset, denied permission, unsupported feature, and disconnected input |

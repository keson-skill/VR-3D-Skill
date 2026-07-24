# Interior-design workflow

Use this workflow for CAD, floor-plan, room-photo, or text-to-interior requests. Skip a stage only when its output already exists and has been validated.

## Contents

- [Architecture](#architecture)
- [Stage 1: ingest and normalize](#stage-1-ingest-and-normalize)
- [Stage 2: spatial understanding](#stage-2-spatial-understanding)
- [Stage 3: validation](#stage-3-validation)
- [Stage 4: design generation](#stage-4-design-generation)
- [Stage 5: visual preview](#stage-5-visual-preview)
- [Stage 6: assets](#stage-6-assets)
- [Stage 7: engineering generation](#stage-7-engineering-generation)
- [Stage 8: rendering and VR](#stage-8-rendering-and-vr)
- [Stage 9: incremental revision](#stage-9-incremental-revision)
- [Failure handling](#failure-handling)

## Architecture

```text
CAD / plan / photos / requirements
              |
              v
     ingest + normalization
              |
              v
  spatial reasoning and semantics
              |
              v
     validated Spatial JSON
        /           |          \
       v            v           v
 design rules   asset manifest  revision patches
       \            |           /
        v           v          v
 deterministic scene compilation
              |
      +-------+--------+
      |                |
      v                v
Three.js/WebXR    Blender/Unreal/Twinmotion
```

The validated `Spatial JSON` is the handoff boundary. Do not pass unstructured model prose directly into scene generation.

## Stage 1: ingest and normalize

Inputs:

- CAD or BIM exports, dimensioned drawings, concept plans, panoramic or perspective photos, scans, and written requirements;
- existing product catalogs, room schedules, material palettes, budgets, and device targets.

Actions:

- preserve originals and revisions;
- detect the source route before processing;
- parse DXF vector entities, layers, units, blocks, text, and dimensions without rasterizing them;
- preprocess raster plans locally and run optional local Tesseract OCR; keep OCR boxes, confidence, and source hashes as evidence;
- detect file coordinate systems and drawing scales;
- extract explicit dimensions, orientation, room labels, and scale anchors;
- distinguish observed facts, user-provided facts, and inferences;
- redact or obtain approval before sending sensitive project data externally.

Output: normalized sources, OCR and/or CAD vector evidence, and a source manifest. DWG must be converted through an approved local converter before DXF parsing. If no reliable scale anchor exists, ask for one or keep the scene explicitly unscaled.

## Stage 2: spatial understanding

Run deterministic conversion first. `dxf-to-spatial.mjs` maps known layers, closed polylines, line openings, blocks, units, and labels without changing vector coordinates. `raster-to-spatial.mjs` extracts the supported orthogonal shell, wall gaps, room outline, and trusted or estimated scale while retaining the pixel-to-meter transform. Ambiguous or unsupported topology must become a blocking question for the correction UI rather than an invented room.

The spatial reasoning model may then classify evidence that deterministic rules cannot resolve:

- exterior and interior walls, thicknesses, columns, openings, stairs, ceiling changes, and fixed equipment;
- room boundaries, labels, connections, usable regions, and likely functions;
- dimensions and confidence based on measurements or perspective cues;
- circulation, door swings, daylight cues, and immovable constraints;
- user intent, occupants, style, storage, accessibility, budget, and retained objects.

Output: a source-bound draft `Spatial JSON` plus unresolved questions. Never convert low-confidence image interpretation into asserted construction dimensions.

## Stage 3: validation

Run deterministic checks before design:

- Draft 2020-12 schema, units, axes, stable IDs, references, and transforms;
- wall connectivity, intersections, room closure, openings on host walls, and plausible dimensions;
- agreement between duplicated measurements and source annotations;
- explicit handling of conflicting inputs;
- privacy and provider routing approval;
- source-aligned top-view comparison and human overlay correction;
- independent approval-sidecar hashes, human attestation, and signature against an active externally managed reviewer trust key.

Output: the exact approved contract, its source manifest, validation report, alignment report, and independent human approval sidecar—or a blocking issue list. A render and the in-document `validation.status` are not substitutes for geometry validation or independent approval.

## Stage 4: design generation

Generate at least one feasible layout before aesthetic variants. For every proposal:

- preserve measured structure and fixed services;
- state zoning and circulation intent;
- use bounding footprints and clearance zones before selecting detailed assets;
- apply project-specific ergonomics, accessibility requirements, budget, and product availability;
- score or compare function, circulation, storage, daylight, style fit, cost, and unresolved risk.

Output: design objects and constraints added to the spatial contract. Keep recommendations explainable and editable.

## Stage 5: visual preview

After the spatial contract and design proposal pass validation, generate optional customer-facing preview images from the approved revision. Use generation for text-directed previews and the guarded reference-edit task when an approved source image or mask must be preserved. Pass locked geometry, furniture placement, circulation, materials, lighting intent, camera intent, and only approved reference images. Record the design revision, model, request ID, prompt provenance, and output hash.

Use the preview to compare visual direction and collect human feedback. Never treat it as a geometry, dimension, collision, or construction source. Apply accepted feedback as an explicit design patch, revalidate it, and generate a new preview from the new revision.

## Stage 6: assets

Resolve each design object in this order:

1. approved client or catalog asset;
2. licensed library asset;
3. parametric primitive or proxy;
4. generated furniture or decor.

Provide requested dimensions, style, material zones, target polygon budget, and views to the asset model. Validate output, normalize units and pivots, generate collision proxies, optimize textures and meshes, and record provenance. Do not use an asset model for walls, room topology, or circulation.

Output: an asset manifest and optimized runtime assets, normally GLB for the web.

## Stage 7: deterministic scene compilation

Use the bundled scene compiler as the default path:

- split walls around approved door and window openings;
- generate floors, wall solids, door/window panels, and dimensionally correct furniture proxies;
- export one deterministic GLB;
- copy the fixed Three.js/WebXR viewer and local runtime dependencies;
- record the scene hash, approval scope, limitations, and source Spatial JSON.

Use the engineering model only to extend the compiler, viewer, Blender path, or tests when the fixed implementation lacks a requested feature. Never regenerate the whole viewer per project and never accept hidden geometry edits introduced by generated code.

## Stage 8: rendering and VR

Use desktop mode to inspect scale, clipping, materials, navigation, and changes before immersive testing. Then validate WebXR or native VR lifecycle, comfort, reach, teleportation, interaction, and target-device performance. Choose Blender, Unreal, or Twinmotion for high-fidelity presentation when requested, while retaining the same validated source data.

Output: runnable GLB scene and static Web viewer first; optional Blender, panorama, Unreal, or Twinmotion artifacts second. Record device notes, performance evidence, and known limitations.

## Stage 9: incremental revision

Translate requests such as “change to warm cream,” “replace the sofa,” or “widen the route to the balcony” into explicit operations:

```json
{
  "revision_id": "rev-004",
  "base_revision": "rev-003",
  "intent": "Create a warmer cream palette and preserve the approved layout.",
  "scope": {
    "target_ids": [],
    "paths": ["/materials/wall_main"]
  },
  "operations": [
    {
      "op": "replace",
      "path": "/materials/wall_main/base_color",
      "value": "#E8DDCD"
    }
  ],
  "must_preserve_ids": ["wall-01", "door-01", "path-entry-living"],
  "must_preserve_paths": [
    "/envelope",
    "/rooms",
    "/circulation",
    "/design_objects"
  ],
  "revalidate": ["materials", "lighting", "performance"],
  "provenance": {
    "actor_type": "human",
    "actor_id": "reviewer-001",
    "created_at": "2026-07-24T00:00:00.000Z"
  },
  "rollback_reference": "rev-003"
}
```

Use RFC 6901 JSON Pointer paths for ID-keyed objects. For an item stored in an array, target its stable ID and use a relative field path; never persist array indexes or wildcards as durable revision targets. Treat natural-language planning as an untrusted proposal. `validate-revision.mjs` and `apply-revision.mjs` enforce the scope and preservation rules, while `revision-store.mjs` persists immutable snapshots, inverse operations, rollback lineage and a hash-chained audit. Every applied change resets approval to pending. Rerun validation and independent human approval before `regenerate-affected.mjs` executes the affected downstream handlers; unaffected artifact hashes are reused.

## Failure handling

- Missing or conflicting dimensions: block exact-layout claims and request a measurement.
- OCR unavailable or low-confidence: preserve the image, continue only as `visualization_only`, and ask for a scale anchor or manual dimension confirmation.
- Provider unavailable: retain the approved contract and use proxies or a configured fallback.
- Asset invalid or oversized: keep a placeholder, log validation failure, and retry without losing design IDs.
- Unsupported WebXR: preserve desktop review and explain device or secure-context requirements.
- Performance miss: downgrade shadows, texture or mesh tiers, reflection cost, and visible-room scope in a documented order.

# Script architecture

Use this reference when selecting or extending executable code under `scripts/`. Model responsibilities remain canonical in [model-routing.md](model-routing.md); pipeline order remains canonical in [interior-design-workflow.md](interior-design-workflow.md).

## Layers

```text
scripts/
├── adapters/       provider-specific HTTP and authentication
├── approval/       interactive human approval and hash verification
├── tasks/          model-role entrypoints and typed handoffs
├── ingest/         local source normalization and fingerprinting
├── spatial/        deterministic DXF/raster to Spatial JSON conversion
├── geometry/       room topology, footprints, collision, scene primitives
├── builders/       deterministic GLB and Web viewer generation
├── validation/     deterministic Spatial JSON and revision gates
├── processing/     deterministic asset metadata processing
├── orchestration/  stage-readiness gates
├── runtime/        deterministic XR configuration checks
├── revisions/      scoped patch application, dependencies, versions, undo, rollback, and audit
├── lib/            shared implementation utilities
└── tests/          offline smoke and contract tests
```

Keep provider names inside `adapters/`; name task directories after stable roles. Do not put generated project code, customer inputs, preview images, downloaded meshes, logs, or secrets inside `scripts/`.

## Model task entrypoints

| Task | Entrypoint | Required input | Output |
|---|---|---|---|
| Input routing | `scripts/ingest/detect-input.mjs` | source paths | deterministic input routes |
| Job preparation | `scripts/orchestration/prepare-interior-job.mjs` | one or more source files | preserved inputs, normalized raster/DXF evidence, source and job manifests |
| DXF evidence | `scripts/ingest/extract-dxf-evidence.mjs` | DXF | vector entities, layers, units, bounds |
| DXF semantic conversion | `scripts/spatial/dxf-to-spatial.mjs` | DXF evidence, source manifest, optional layer/block mapping | source-bound draft Spatial JSON |
| Raster semantic conversion | `scripts/spatial/raster-to-spatial.mjs` | normalized plan, source manifest, optional scale anchor/correction | source-bound draft Spatial JSON |
| Spatial extraction | `scripts/tasks/spatial-extraction/extract-spatial-json.mjs` | prompt, source manifest, approved images and/or DXF evidence | draft Spatial JSON, provider metadata, structural validation |
| Local OCR evidence | `scripts/ingest/extract-ocr-evidence.mjs` | normalized image | local Tesseract TSV evidence with boxes and confidence |
| Design planning | `scripts/tasks/design-planning/propose-design.mjs` | approved Spatial JSON, requirements | design alternatives and proposed revision patch |
| Revision planning | `scripts/tasks/revision-planning/plan-revision.mjs` | approved Spatial JSON and natural-language change request | validated, scoped stable-ID revision proposal |
| Visual preview | `scripts/tasks/visual-preview/generate-preview.mjs` | approved Spatial JSON, visual direction | image plus revision-bound metadata |
| Reference image edit | `scripts/tasks/visual-preview/edit-reference.mjs` | approved reference image, visual direction, design revision ID | edited image plus revision-bound metadata |
| Engineering generation | `scripts/tasks/engineering-generation/generate-engineering.mjs` | approved Spatial JSON, task, optional asset manifest | reviewable generated text/code plus metadata |
| Asset generation preparation | `scripts/tasks/asset-generation/create-asset-brief.mjs` | approved Spatial JSON and design-object ID | provider-neutral asset brief |
| Human spatial approval | `scripts/approval/approve-spatial-json.mjs` | exact source manifest, approved Spatial JSON, passing validation report, reviewer private key/key ID | hash-bound and Ed25519-signed approval sidecar |
| Viewable scene | `scripts/tasks/scene-generation/build-viewable-scene.mjs` | approved Spatial JSON, source manifest, validation report, approval sidecar, and reviewer trust store | deterministic GLB, primitive sidecar, static Three.js/WebXR viewer, approval verification, GLB structural report |
| Compiled-scene top view | `scripts/validation/render-scene-top-view.mjs` | Spatial JSON or compiled primitives | deterministic wall-only top view for source alignment |
| P3 regression gate | `scripts/validation/run-p3-acceptance.mjs` | 20 fixed Spatial JSON fixtures | Spatial, primitive, GLB, scene hash, and top-view alignment evidence |

External-provider tasks require `--allow-provider`. Treat the flag as confirmation that the user approved the named provider and the exact data selected for that command. Do not add it automatically or call the adapter directly to avoid the check.

The asset task prepares a typed brief only. Add a Hunyuan3D submission adapter only after its exact API, signing, retention, polling, download, and license behavior are verified. Until then, submit manually or use catalog assets and dimensionally correct proxies.

The scene-generation task is the default production path. Do not use Kimi or another model to regenerate Three.js boilerplate for each user job. Extend the fixed compiler or viewer only when a requested capability is missing. Keep generated job files under `runs/`, never under `scripts/` or `assets/`.

## Deterministic gates

Run these before downstream generation:

```bash
node scripts/ingest/build-source-manifest.mjs \
  --input plan.png \
  --output source-manifest.json

node scripts/ingest/detect-input.mjs --input plan.dxf

node scripts/ingest/extract-dxf-evidence.mjs \
  --input plan.dxf --output dxf-evidence.json

node scripts/spatial/dxf-to-spatial.mjs \
  --evidence dxf-evidence.json \
  --source-manifest source-manifest.json \
  --project-id project-001 \
  --output spatial-draft.json

node scripts/processing/preprocess-plan-image.mjs \
  --input plan.png --output normalized-plan.png

node scripts/spatial/raster-to-spatial.mjs \
  --input normalized-plan.png \
  --source-manifest source-manifest.json \
  --scale-anchor scale-anchor.json \
  --project-id project-001 \
  --output spatial-draft.json

node scripts/ingest/extract-ocr-evidence.mjs \
  --input normalized-plan.png --output ocr-evidence.json

node scripts/validation/validate-spatial-json.mjs \
  --input spatial-approved.json \
  --output spatial-validation.json

node scripts/validation/render-spatial-top-view.mjs \
  --spatial-json spatial-approved.json \
  --output top-view.png

node scripts/validation/compare-plan-render.mjs \
  --source normalized-plan.png \
  --render top-view.png \
  --output alignment.json \
  --diff alignment-diff.png

node scripts/approval/approve-spatial-json.mjs \
  --source-manifest source-manifest.json \
  --spatial-json spatial-approved.json \
  --validation-report spatial-validation.json \
  --signing-key /secure/reviewer-ed25519.pem \
  --key-id reviewer-001 \
  --output spatial-approval.json

node scripts/validation/validate-spatial-json.mjs \
  --input spatial-approved.json \
  --source-manifest source-manifest.json \
  --validation-report spatial-validation.json \
  --approval spatial-approval.json \
  --approval-trust spatial-approval-trust.json \
  --require-approved

node scripts/validation/validate-revision.mjs \
  --base spatial.json \
  --revision revision.json \
  --output revision-validation.json

node scripts/revisions/apply-revision.mjs \
  --base spatial.json \
  --revision revision.json \
  --output spatial-revised.json \
  --diff revision-diff.json \
  --inverse inverse-revision.json \
  --audit revision-audit.json

node scripts/revisions/revision-store.mjs \
  --action apply \
  --store runs/project-001/revisions \
  --base spatial.json \
  --revision revision.json

# After the revised Spatial JSON is independently reapproved:
node scripts/revisions/regenerate-affected.mjs \
  --plan dependency-plan.json \
  --config regeneration-config.json \
  --output artifact-manifest.json \
  --approval-verified

node scripts/orchestration/check-stage-readiness.mjs \
  --stage engineering \
  --spatial-json spatial-approved.json \
  --source-manifest source-manifest.json \
  --validation-report spatial-validation.json \
  --approval spatial-approval.json \
  --approval-trust spatial-approval-trust.json \
  --asset-manifest asset-manifest.json

node scripts/runtime/verify-xr-config.mjs \
  --spatial-json spatial-approved.json \
  --source-manifest source-manifest.json \
  --validation-report spatial-validation.json \
  --approval spatial-approval.json \
  --approval-trust spatial-approval-trust.json \
  --output xr-validation.json

node scripts/tasks/scene-generation/build-viewable-scene.mjs \
  --spatial-json spatial-approved.json \
  --source-manifest source-manifest.json \
  --validation-report spatial-validation.json \
  --approval spatial-approval.json \
  --approval-trust spatial-approval-trust.json \
  --output runs/project-001 \
  --mode furnished

npm run p3:fixtures
npm run p3:acceptance

node scripts/serve-viewer.mjs \
  --directory runs/project-001
```

`validate-spatial-json.mjs` first executes the Draft 2020-12 schema, then checks connected non-self-intersecting room loops, opening bounds, furniture room containment, proxy collisions, room elevation validity, and P3 column/beam/stair descriptors. With `--require-approved`, it additionally requires the three bound sidecars and rejects stale hashes, test fixtures, unknown scale, conflicts, unresolved questions, low-confidence topology, or missing provenance. The scene compiler validates every emitted GLB header, chunks, buffer views, accessors, normals, UVs, materials, node transforms, and coordinate-system metadata before it writes the deliverable. Neither check claims structural engineering, building-code compliance, a production navmesh, exact door-swing clearance, or headset performance. Preserve those limitations in reports.

For a single raster plan, write `validation.approved_scope: "visualization_only"` and carry that warning into the renderer. Require an independent source-alignment review before using `construction_ready`; model catalog visibility, a concept preview, or a successful scene render do not prove source-image fidelity.

## Development checks

Run syntax checks and the offline test suite after changing a script:

```bash
node --check scripts/path/to/changed-script.mjs
npm run check
```

Tests must not call external providers or require real credentials.

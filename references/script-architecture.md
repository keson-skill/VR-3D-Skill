# Script architecture

Use this reference when selecting or extending executable code under `scripts/`. Model responsibilities remain canonical in [model-routing.md](model-routing.md); pipeline order remains canonical in [interior-design-workflow.md](interior-design-workflow.md).

## Layers

```text
scripts/
├── adapters/       provider-specific HTTP and authentication
├── tasks/          model-role entrypoints and typed handoffs
├── ingest/         local source normalization and fingerprinting
├── validation/     deterministic Spatial JSON and revision gates
├── processing/     deterministic asset metadata processing
├── orchestration/  stage-readiness gates
├── runtime/        deterministic XR configuration checks
├── lib/            shared implementation utilities
└── tests/          offline smoke and contract tests
```

Keep provider names inside `adapters/`; name task directories after stable roles. Do not put generated project code, customer inputs, preview images, downloaded meshes, logs, or secrets inside `scripts/`.

## Model task entrypoints

| Task | Entrypoint | Required input | Output |
|---|---|---|---|
| Spatial extraction | `scripts/tasks/spatial-extraction/extract-spatial-json.mjs` | prompt, source manifest, approved images | draft Spatial JSON, provider metadata, structural validation |
| Local OCR evidence | `scripts/ingest/extract-ocr-evidence.mjs` | normalized image | local Tesseract TSV evidence with boxes and confidence |
| Design planning | `scripts/tasks/design-planning/propose-design.mjs` | approved Spatial JSON, requirements | design alternatives and proposed revision patch |
| Visual preview | `scripts/tasks/visual-preview/generate-preview.mjs` | approved Spatial JSON, visual direction | image plus revision-bound metadata |
| Reference image edit | `scripts/tasks/visual-preview/edit-reference.mjs` | approved reference image, visual direction, design revision ID | edited image plus revision-bound metadata |
| Engineering generation | `scripts/tasks/engineering-generation/generate-engineering.mjs` | approved Spatial JSON, task, optional asset manifest | reviewable generated text/code plus metadata |
| Asset generation preparation | `scripts/tasks/asset-generation/create-asset-brief.mjs` | approved Spatial JSON and design-object ID | provider-neutral asset brief |

External-provider tasks require `--allow-provider`. Treat the flag as confirmation that the user approved the named provider and the exact data selected for that command. Do not add it automatically or call the adapter directly to avoid the check.

The asset task prepares a typed brief only. Add a Hunyuan3D submission adapter only after its exact API, signing, retention, polling, download, and license behavior are verified. Until then, submit manually or use catalog assets and dimensionally correct proxies.

## Deterministic gates

Run these before downstream generation:

```bash
node scripts/ingest/build-source-manifest.mjs \
  --input plan.png \
  --output source-manifest.json

node scripts/processing/preprocess-plan-image.mjs \
  --input plan.png --output normalized-plan.png

node scripts/ingest/extract-ocr-evidence.mjs \
  --input normalized-plan.png --output ocr-evidence.json

node scripts/validation/validate-spatial-json.mjs \
  --input spatial.json \
  --output spatial-validation.json \
  --require-approved

node scripts/validation/compare-plan-render.mjs \
  --source plan.png --render top-view.png --output alignment.json

node scripts/validation/validate-revision.mjs \
  --base spatial.json \
  --revision revision.json \
  --output revision-validation.json

node scripts/orchestration/check-stage-readiness.mjs \
  --stage engineering \
  --spatial-json spatial.json \
  --asset-manifest asset-manifest.json

node scripts/runtime/verify-xr-config.mjs \
  --spatial-json spatial.json \
  --output xr-validation.json
```

`validate-spatial-json.mjs` performs structural and reference checks; it does not claim structural engineering, building-code compliance, full polygon collision, navmesh validity, or headset performance. Preserve those limitations in reports.

For a single raster plan, write `validation.approved_scope: "visualization_only"` and carry that warning into the renderer. Require an independent source-alignment review before using `construction_ready`; model catalog visibility, a concept preview, or a successful scene render do not prove source-image fidelity.

## Development checks

Run syntax checks and the offline test suite after changing a script:

```bash
node --check scripts/path/to/changed-script.mjs
node --test "scripts/tests/*.test.mjs"
```

Tests must not call external providers or require real credentials.

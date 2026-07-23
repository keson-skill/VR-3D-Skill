# Model routing

Use models as replaceable specialists behind typed interfaces. Keep exact deployment identifiers in environment variables because provider availability and account entitlements change.

## Recommended responsibilities

| Pipeline role | Default configuration | Input | Structured output |
|---|---|---|---|
| Spatial understanding and design reasoning | `OPENAI_SPATIAL_MODEL` | Approved plan or room images, normalized measurements, source manifest, and user constraints | Draft `Spatial JSON`, confidence, assumptions, questions, and design alternatives |
| Engineering generation | `KIMI_ENGINEERING_MODEL` | Approved `Spatial JSON`, engine conventions, asset manifest, and acceptance criteria | Three.js code, Blender Python, scene configuration, interactions, and tests |
| Furniture and decor generation | `HUNYUAN3D_MODEL` | Asset brief, dimensions, style, materials, views, and polygon budget | Job ID, generated model, preview, and metadata to normalize into the asset manifest |

The solution document calls these roles GPT-5, Kimi K3, and Hunyuan3D. The environment example maps them to current deployment identifiers. Verify the provider's model list for the target account before production deployment.

## Spatial reasoning adapter

Requirements:

- accept text and image inputs needed for floor plans, design drawings, and room photos;
- request strict JSON matching the host project's schema;
- include source IDs and confidence for inferred facts;
- separate extraction from design suggestions;
- return unresolved measurement conflicts instead of guessing;
- support deterministic validation and retry from validator errors.

Use the OpenAI Responses API for a current OpenAI reasoning model. Do not embed images or client data in logs. If CAD cannot be consumed natively, preprocess it into dimensioned vector data and approved raster views while retaining the source manifest.

Fallback: preserve extracted measurements and use a manual or deterministic drafting path. A fallback model must pass the same schema and geometry validation; model substitution never lowers the gates.

## Engineering adapter

Requirements:

- consume only approved structured scene data and repository context;
- preserve stable IDs and transforms;
- generate code in small, reviewable units;
- write deterministic Blender scripts and reproducible build commands;
- produce tests for import, validation, scene assembly, revision patches, and fallbacks;
- never reinterpret measured geometry in order to make code simpler.

Before calling the configured Kimi model, inspect the provider's model list and confirm that `KIMI_ENGINEERING_MODEL` is available. Keep provider-specific tool calling and long-context options inside the adapter.

Fallback: use the active coding agent or local templates against the same contract. Record the generator used.

## Hunyuan3D adapter

Requirements:

- submit furniture or decor briefs only after layout footprints are approved;
- send exact target dimensions and enough visual views when available;
- poll jobs with bounded retries and persist provider job IDs;
- download into a quarantine or staging path before scene import;
- validate topology, normals, scale, pivot, materials, textures, license, and polygon cost;
- convert or optimize to GLB for web targets and retain provenance.

Hunyuan3D is an asset generator, not the interior planner. Never ask it to determine walls, openings, circulation, or the full room layout.

Fallback: use catalog assets or dimensionally correct proxies. A placeholder is preferable to an unvalidated mesh.

## Runtime components are not models

Three.js, React Three Fiber, Blender, Unreal, Twinmotion, Unity, WebGPU, WebXR, and OpenXR are engineering or rendering components. Do not add fake model environment variables for them. Configure their versions in the host project and verify them from installed dependencies.

## Secrets and data handling

- Copy `.env-example` to an ignored `.env` only in the consuming project.
- Keep all example secrets empty.
- Route provider calls through server-side adapters; never expose long-lived credentials in browser code.
- Log request IDs, model IDs, latency, cost metadata, and validation results without storing sensitive source payloads.
- Add retention, region, and provider approval controls before processing real customer projects.

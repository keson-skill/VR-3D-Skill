# RealmRouter integration

Use RealmRouter as an OpenAI-compatible gateway only after the user approves that provider for the project data being sent.

## Route the two OpenAI roles

| Role | Environment model | Endpoint |
|---|---|---|
| Spatial reasoning and `Spatial JSON` | `REALMROUTER_SPATIAL_MODEL=gpt-5.5` | `POST /v1/chat/completions` |
| Visual preview generation | `REALMROUTER_IMAGE_MODEL=gpt-image-2` | `POST /v1/images/generations` |

RealmRouter documents `https://realmrouter.cn` as the client-facing OpenAI-compatible Base URL. The current model details expose the raw API endpoints under `/v1`. Keep the configured Base URL at the documented root; the bundled raw HTTP adapter adds `/v1` before the endpoint.

The adapter retries retryable network failures and `408`, `409`, `425`, `429`, and `5xx` responses with bounded exponential backoff. Configure `REALMROUTER_MAX_RETRIES` from `0` to `8` (default `3`); terminal diagnostics include the safe network error category but never the API key.

Use the Chat Completions endpoint for the token-visible spatial model; do not assume `/responses` support. Model catalog visibility is token-specific, so use the preflight check instead of hard-coding a gateway-wide availability claim.

References:

- [RealmRouter OpenAI-compatible API](https://docs.realmrouter.cn/api/openai-compatible)
- [RealmRouter Images examples](https://docs.realmrouter.cn/examples/images)
- [RealmRouter token groups and billing](https://docs.realmrouter.cn/guides/token-billing)
- [RealmRouter model marketplace](https://realmrouter.cn/pricing)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)

## Configure without leaking the token

1. Revoke any token pasted into chat, logs, screenshots, shell history, or an issue.
2. Create a replacement RealmRouter token.
3. Create separate least-privilege tokens because the current model details place the two models in disjoint groups:
   - `gpt-5.5`: the token-visible `GPT-plus` group used by this Skill;
   - `gpt-image-2`: `GPT-image`.
4. Add the replacements only to the ignored local `.env`:

```dotenv
REALMROUTER_SPATIAL_API_KEY=
REALMROUTER_IMAGE_API_KEY=
REALMROUTER_BASE_URL=https://realmrouter.cn
REALMROUTER_SPATIAL_MODEL=gpt-5.5
REALMROUTER_IMAGE_MODEL=gpt-image-2
REALMROUTER_SPATIAL_REASONING_EFFORT=xhigh
REALMROUTER_IMAGE_QUALITY=high
```

5. Never reuse these gateway tokens in browser code or commit them to Git.

Check local configuration without a network request:

```bash
node --env-file=.env scripts/adapters/realmrouter-openai.mjs check
```

Query the token-visible model catalog:

```bash
node --env-file=.env scripts/adapters/realmrouter-openai.mjs models
```

The command queries each token separately and prints only the two requested model IDs and booleans. It never prints either token. A model-list match is necessary but not sufficient: the token group, balance, endpoint support, and provider routing must also permit the actual request.

## Call the spatial route

Build a local source manifest first, then invoke the guarded spatial-extraction task. Provide a prompt that includes the active Spatial JSON schema, validation rules, confidence requirements, and locked facts. Do not send unapproved client plans or photos.

```bash
node scripts/ingest/build-source-manifest.mjs \
  --input approved-plan.png \
  --output source-manifest.json

node scripts/processing/preprocess-plan-image.mjs \
  --input approved-plan.png --output normalized-plan.png

node scripts/ingest/extract-ocr-evidence.mjs \
  --input normalized-plan.png --output ocr-evidence.json

node --env-file=.env scripts/tasks/spatial-extraction/extract-spatial-json.mjs \
  --prompt-file SPATIAL_TASK.md \
  --source-manifest source-manifest.json \
  --input-image normalized-plan.png \
  --ocr-evidence ocr-evidence.json \
  --output spatial-draft.json \
  --validation-report spatial-validation.json \
  --allow-provider
```

Repeat `--input-image` for multiple approved PNG, JPEG, or WebP views. The task uses Chat Completions, preflights the configured model against the token-visible catalog, rejects non-JSON model output, preserves the draft, and emits deterministic validation results before approval.

## Call the image route

Generate visual previews only from an approved design revision:

```bash
node --env-file=.env scripts/tasks/visual-preview/generate-preview.mjs \
  --spatial-json approved-spatial.json \
  --prompt-file VISUAL_PROMPT.md \
  --output preview.png \
  --metadata preview-metadata.json \
  --allow-provider
```

Use low quality for disposable drafts and medium or high only after the design direction is approved. Record the design revision, model ID, request ID, prompt provenance, and output hash. Never use the image as a source of dimensions, topology, collision, or construction facts.

The high-level task refuses unapproved Spatial JSON and records the required metadata automatically. Reference edits use the guarded `scripts/tasks/visual-preview/edit-reference.mjs` task, which sends an approved image and optional mask through `/v1/images/edits` and requires the approved design revision ID. Keep image-edit approval separate from geometry approval.

## Interpret failures

- `401`: invalid, expired, or revoked token.
- group or `No available channel` error: the token group does not route the requested model.
- model absent from `models`: use the exact catalog ID or change the token group.
- `429`: rate or quota limit; use bounded backoff.
- `5xx`: transient upstream or gateway failure; preserve approved artifacts and retry safely.
- Images succeeds but Chat Completions fails, or the reverse: treat them as separate capabilities and keep the working stage isolated.

Do not silently substitute another model. A fallback must preserve the same typed contract and pass the same validation gates.

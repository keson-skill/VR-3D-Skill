# RealmRouter integration

Use RealmRouter as an OpenAI-compatible gateway only after the user approves that provider for the project data being sent.

## Route the two OpenAI roles

| Role | Environment model | Endpoint |
|---|---|---|
| Spatial reasoning and `Spatial JSON` | `REALMROUTER_SPATIAL_MODEL=gpt-5.6-sol` | `POST /v1/chat/completions` |
| Visual preview generation | `REALMROUTER_IMAGE_MODEL=gpt-image-2` | `POST /v1/images/generations` |

RealmRouter documents `https://realmrouter.cn` as the client-facing OpenAI-compatible Base URL. The current model details expose the raw API endpoints under `/v1`. Keep the configured Base URL at the documented root; the bundled raw HTTP adapter adds `/v1` before the endpoint.

The current public model details expose `gpt-5.6-sol` through Chat Completions, not Responses. Do not route this gateway deployment through `/responses`. RealmRouter lists `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; it does not list a generic `gpt-5.6` deployment ID.

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
   - `gpt-5.6-sol`: `GPT-plus`, `GPT-plus 特惠`, `GPT-pro`, or `default`;
   - `gpt-image-2`: `GPT-image`.
4. Add the replacements only to the ignored local `.env`:

```dotenv
REALMROUTER_SPATIAL_API_KEY=
REALMROUTER_IMAGE_API_KEY=
REALMROUTER_BASE_URL=https://realmrouter.cn
REALMROUTER_SPATIAL_MODEL=gpt-5.6-sol
REALMROUTER_IMAGE_MODEL=gpt-image-2
```

5. Never reuse these gateway tokens in browser code or commit them to Git.

Check local configuration without a network request:

```bash
node --env-file=.env scripts/realmrouter-openai.mjs check
```

Query the token-visible model catalog:

```bash
node --env-file=.env scripts/realmrouter-openai.mjs models
```

The command queries each token separately and prints only the two requested model IDs and booleans. It never prints either token. A model-list match is necessary but not sufficient: the token group, balance, endpoint support, and provider routing must also permit the actual request.

## Call the spatial route

Provide a prompt that requires JSON only and includes the active Spatial JSON schema, source manifest, validation rules, confidence requirements, and locked facts. Do not send unapproved client plans or photos.

```bash
node --env-file=.env scripts/realmrouter-openai.mjs spatial \
  --prompt-file SPATIAL_TASK.md \
  --input-image approved-plan.png \
  --output spatial-draft.json
```

Repeat `--input-image` for multiple approved PNG, JPEG, or WebP views. The adapter uses Chat Completions because that is the endpoint shown for `gpt-5.6-sol` in the current RealmRouter model details. It rejects non-JSON model output. Run the normal schema and geometry validators before approving or consuming the result.

## Call the image route

Generate visual previews only from an approved design revision:

```bash
node --env-file=.env scripts/realmrouter-openai.mjs image \
  --prompt-file VISUAL_PROMPT.md \
  --output preview.png
```

Use low quality for disposable drafts and medium or high only after the design direction is approved. Record the design revision, model ID, request ID, prompt provenance, and output hash. Never use the image as a source of dimensions, topology, collision, or construction facts.

RealmRouter documents edits and variations as multipart uploads. The bundled adapter intentionally implements generation only; add edits as a separate reviewed path when reference-image handling, masking, privacy approval, and retention controls are defined.

## Interpret failures

- `401`: invalid, expired, or revoked token.
- group or `No available channel` error: the token group does not route the requested model.
- model absent from `models`: use the exact catalog ID or change the token group.
- `429`: rate or quota limit; use bounded backoff.
- `5xx`: transient upstream or gateway failure; preserve approved artifacts and retry safely.
- Images succeeds but Chat Completions fails, or the reverse: treat them as separate capabilities and keep the working stage isolated.

Do not silently substitute another model. A fallback must preserve the same typed contract and pass the same validation gates.

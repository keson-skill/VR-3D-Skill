# Kimi Code integration

Use this adapter only for optional engineering work such as extending or reviewing the fixed scene compiler, Three.js viewer, Blender Python path, tests, and repository changes from an approved `Spatial JSON`. Do not use it to regenerate the whole viewer for each interior job; `build-viewable-scene.mjs` is the default production path.

## Keep the two Kimi services separate

Kimi Code membership and the Kimi Open Platform use different credentials and endpoints.

| Service | Credential | OpenAI-compatible base URL | Intended use |
|---|---|---|---|
| Kimi Code membership | Key created in the Kimi Code Console | `https://api.kimi.com/coding/v1` | Coding agents and engineering tasks |
| Kimi Open Platform | Key created at platform.kimi.com | `https://api.moonshot.cn/v1` | Product and application API integration |

Do not mix a Kimi Code key with a Moonshot base URL. Do not use the Kimi Code membership endpoint as a customer-facing product runtime.

Official references:

- [Kimi Code overview and endpoints](https://www.kimi.com/code/docs/)
- [Kimi Code model IDs and membership requirements](https://www.kimi.com/code/docs/kimi-code/models.html)
- [Kimi Code error reference](https://www.kimi.com/code/docs/kimi-code/error-reference.html)

## Configure locally

1. Revoke any key pasted into chat, logs, screenshots, shell history, or an issue.
2. Create a new key in the Kimi Code Console.
3. Copy `.env-example` to `.env`. The repository `.gitignore` excludes `.env` and `.env.*` except `.env-example`.
4. Put the new key only in `KIMI_CODE_API_KEY`.
5. Keep `KIMI_CODE_BASE_URL=https://api.kimi.com/coding/v1`.
6. Use `KIMI_CODE_ENGINEERING_MODEL=k3`.
7. Use `max` reasoning for the highest-quality engineering generation. Supported values are `low`, `high`, and `max`.

K3 requires a Moderato or higher membership. Moderato supports up to 256K context; Allegretto or higher can unlock up to 1M. The adapter does not request or enforce a context window; keep task payloads within the account entitlement.

Check configuration without making a network request:

```bash
node --env-file=.env scripts/adapters/kimi-code-engineer.mjs --check
```

The output must show the Kimi Code endpoint, model `k3`, an allowed reasoning effort, `apiKeyPresent: true`, and `apiKeyLooksLikeKimiCode: true`. It never prints the key.

## Call the engineering adapter

Prepare a task file containing only the approved engineering inputs:

- implementation request and acceptance criteria;
- validation status and locked IDs;
- target engine and installed versions;
- renderer and repository conventions.

Do not include raw client photos, addresses, unapproved plans, or unrelated repository secrets.

Pass the actual approved JSON files explicitly so the adapter validates and embeds their contents. A remote model cannot read a local filesystem path mentioned only in prose.

```bash
node --env-file=.env scripts/tasks/engineering-generation/generate-engineering.mjs \
  --task TASK.md \
  --spatial-json spatial.json \
  --asset-manifest asset-manifest.json \
  --output KIMI_RESULT.md \
  --metadata KIMI_RESULT.json \
  --allow-provider
```

The task blocks unapproved Spatial JSON, strips local source URIs, and requires explicit provider approval. Review the result before applying it. The adapter does not edit the project by itself. Feed approved output through the normal repository editing, testing, and review workflow.

For a one-off prompt through standard input:

```bash
printf '%s\n' 'Review the supplied scene adapter and list required tests.' |
  node --env-file=.env scripts/adapters/kimi-code-engineer.mjs
```

Use this low-level stdin route only for provider diagnostics or tasks that contain no project data. Use the guarded engineering task for normal pipeline work.

## Preserve the coding-agent boundary

- Pass approved structured scene data, not unvalidated multimodal source material.
- Keep spatial reasoning, structural interpretation, and layout decisions in the spatial model stage.
- Reject generated code that changes measured geometry, locked structure, stable IDs, or required circulation.
- Keep the adapter's honest `User-Agent`; do not impersonate another client.
- Do not send unsupported sampling overrides such as forced `temperature`, `top_p`, or `n`.
- Never log authorization headers or full provider requests containing private project data.

## Interpret common errors

- `401 invalid authentication`: key and endpoint belong to different Kimi services, or the key was revoked.
- `401 no K3 access`: the membership tier does not include `k3`; upgrade or explicitly switch to `kimi-for-coding`.
- `401 context entitlement`: reduce the configured context to 256K unless the account includes 1M.
- `402`: membership status could not be verified.
- `403`: permission, quota, or account policy issue; do not retry blindly.
- `404`: verify the endpoint and exact model ID `k3`.

## Do not confuse this with replacing Codex

This script calls Kimi K3 as a specialist from the skill. It does not replace the model running Codex. Codex uses the Responses API while Kimi Code exposes Chat Completions; replacing Codex's model requires a separate compatible local routing layer. Keep that configuration outside this skill.

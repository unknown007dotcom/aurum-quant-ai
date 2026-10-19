# AI diagnostics and repair — 2026-10-19

## Observed production failures

The audit was run from an isolated Vercel **preview build**, because the coding sandbox cannot connect directly to NVIDIA. No bot, order, or trading-control endpoint was called. The temporary diagnostic credential was supplied as a sensitive preview-only environment variable, never written to the repository, and removed afterwards. The diagnostic deployment was also deleted.

| Check before repair | Observed result |
| --- | --- |
| Production `/api/chat` completion | HTTP 502; no assistant reply |
| Production `/api/ai-health` | `meta/llama-3.1-70b-instruct` returned HTTP 410 |
| Production `/api/ai-decision` | HTTP 200 **local fallback**, no actual AI analysis |
| Existing Worker's `/chat` | Route not found |
| Existing Worker's analysis | HTTP 200 **local fallback** after its GPT-OSS validation request timed out |
| Worker CORS preflight from the production origin | HTTP 204; correct production origin allowed |
| NVIDIA catalog with the temporary key | HTTP 200; 81 catalog records |
| GPT-OSS 20B with the temporary key | Real visible completion, HTTP 200 |
| GPT-OSS 20B with the existing Vercel-stored key | Real visible completion, HTTP 200, approximately 0.96 seconds |

The saved Vercel settings contained one primary model and 132 debate entries, including embeddings, safety classifiers, vision/task-specific models, and obsolete IDs. The audit exercised the distinct configured IDs across the saved/repository/edge configurations. Many returned HTTP 410; some IDs listed in the catalog still returned HTTP 404 from chat completions. **A catalog record does not establish chat capability or a successful completion.** This document summarizes confirmed findings rather than claiming every catalog model is operational.

## Causes repaired

1. The browser rewrote `openai/gpt-oss-120b` to the retired Llama 3.1 70B ID while keeping the old model key.
2. Chat and terminal analysis selected models from different deployments and configuration stores.
3. Short, 32-token validation completions could fail on reasoning models and reject an otherwise valid key before the real request was attempted.
4. Catalog import/debate selection included unsupported tasks and stale models.
5. Analysis could present a generated local fallback in an HTTP-200 response instead of clearly reporting provider failure.
6. Nested retries could exceed the browser's fixed 60-second timeout.
7. The exported `window.syncAiBackendSettings` assignment was after a `return`, so model-manager updates could miss the backend save function.
8. Blank/redacted model metadata could overwrite stored credentials when settings were saved.

## Current behavior

- Chat, terminal analysis, model import, and health share the NVIDIA runtime and same-origin Vercel AI routes.
- Market data and trading controls remain on their existing backend. The production Worker is **not** automatically redeployed by a Vercel release.
- Active candidates come from the current NVIDIA catalog, with non-chat task models excluded. Saved/default selections that disappeared are not blindly retried.
- Explicit server `NVIDIA_API_KEY` overrides stale saved model keys. Browser requests do not supply provider credentials or endpoints.
- Reasoning models receive an adequate token budget; GPT-OSS requests use low reasoning effort.
- Health requires real visible output. HTTP 200 with empty/reasoning-only content is not healthy.
- Model failures are bounded by an overall deadline. Actual fallback model IDs are disclosed; provider errors do not become fictional assistant responses.
- AI analysis requires a valid structured model response. A neutral/missing-data narrative cannot retain contradictory trade levels.
- Scheduled analysis and learning use the shared provider code too. Their trading/history side effects are **not** invoked by the diagnostic or release verification.

## Credential action required

Pre-existing private credentials were found in the tracked settings template, including a key that could still complete requests. Their values have been removed from the current source, and browser preferences no longer persist model keys. Server settings and environment variables were not erased.

**Rotate previously exposed credentials, including any still present in Git history.** Removing them from the current file does not revoke them or erase old commits or other branches. Local settings writes now use ignored `data/settings.local.json` rather than the tracked template; production writes must reach the configured database. Put replacement NVIDIA credentials in Vercel's sensitive/encrypted `NVIDIA_API_KEY` environment variable, then redeploy. Configure `ADMIN_PASSWORD` before using the protected AI-settings editor. The one-off key shared for this audit should also be revoked.

## Verification commands

```sh
npm test
npm run check-build
npm run build:vercel
npx playwright install chromium
npm run test:chat-layout
npm run test:ai-ui
```

Unit/browser tests inject provider/market responses and make no trades. For a genuine release check, set **`AURUM_VERIFY_LIVE_AI=1` in the build process environment**. The build invokes the packaged API with synthetic, no-market-data prompts and fails unless both chat and structured analysis receive genuine replies. Successful releases expose a non-secret `/ai-release-check.json` receipt with the responding model IDs and verification timestamp.

`tools/diagnose-ai.cjs` is an explicit one-off diagnostic tool. It requires a secret `AURUM_DIAGNOSTIC_NVIDIA_KEY` environment variable and never runs as part of normal page loading or regular unit tests. A sanitized report can be written to `AURUM_DIAGNOSTIC_REPORT_PATH` when invoked manually. Never put the key in command-line arguments, source files, or URLs.

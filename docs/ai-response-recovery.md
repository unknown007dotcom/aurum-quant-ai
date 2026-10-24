# AI response recovery — 24 October 2026

## Reproduced against the public production HTTP endpoints

The NVIDIA health probe was healthy, so a successful health check alone was not enough to diagnose this report. An isolated verification build called the **actual production HTTP endpoints**, without a temporary API key or any trading commands.

| Before this repair | Observed result |
| --- | --- |
| Chat with the current default | HTTP 200; a real Mira reply in about 2–3 seconds |
| Chat with the historic saved key `gpt-oss-default` | HTTP 400, `invalid_model`, no answer |
| Analysis with a no-market-data test | HTTP 200, but `researcher.summary` echoed “Explain the institutional narrative…” from the example template instead of answering |

The previous release check accepted nonempty JSON and a neutral direction, which did not catch the template echo. The browser also repaired only the active chat and only keys still represented in the server's removed-model list. Old conversations or keys deleted from the configuration could stay broken indefinitely.

## Repairs

- Resolve all model requests against the server's active catalog. Unknown saved selections use the current default, with `modelFallbackUsed` and the actual responding model disclosed. No browser-supplied model ID, key, URL, or provider credential is sent unchecked to NVIDIA.
- Reconcile model preferences across the active conversation, all saved conversations, and new-chat defaults. Preserve messages, valid selections, and preferences when catalog loading fails.
- Use the working GPT-OSS 20B as the frontend's initial default instead of the now-unlisted 120B entry.
- Replace the analysis template's instruction-valued strings with an empty output shape and separate field requirements. Request JSON output for analysis only.
- Reject empty findings, copied template instructions, invalid JSON, and directional plans missing required levels **before** accepting a model result.
- Allow one bounded correction or larger-token retry for invalid analysis or reasoning that exhausted its output budget. Keep the existing overall deadline and stop immediately on authentication/rate-limit failures. Never turn a failed request into fabricated AI output.
- Exclude document-parsing Nemotron models from conversational discovery.
- Bump frontend asset versions so refreshed pages load the recovery code.

## Verification

Local checks: **66 passing unit/analysis tests**, both browser suites, Vercel packaging, and Worker dry-run. Browser coverage includes recovering old chats without deleting messages, retrying their saved question, and preserving Mira's light layout and responsive settings panel.

A release built with `AURUM_VERIFY_LIVE_AI=1` must now receive a real reply with a historic model selection and a meaningful, non-template analysis about the supplied no-data prompt before it can deploy.

For explicit post-deployment checks:

```sh
npm run verify:live-ai
# Also exercise the deployed Chat Mode in a real browser:
npx playwright install chromium
npm run verify:live-ai -- --browser
```

These opt-in checks make genuine, small provider requests. They verify fresh replies, conversation context, stale-model recovery, meaningful analysis, and an actual browser-visible Mira reply. They do not invoke orders, bot controls, history writes, or settings updates. The optional `AURUM_VERIFY_ORIGIN` selects the deployment; `AURUM_VERIFY_REPORT` writes a non-secret JSON receipt.

## Verified production result

Application commit: `e11302a19091fa01bb70b7082ac4ebd139264b63`.
Production deployment: `dpl_AsPhtqJJeVbie5a9mG2BHLcaFJf2`, **READY / PROMOTED**.
The public release receipt is timestamped **24 October 2026, 16:35:21 UTC**.

The post-deployment verifier (`c810070`) exercised the real public API and a real Chromium browser against `https://aurum-quant-ai.vercel.app`, without mocked AI responses. Its completed run at approximately **16:39:30 UTC** reported:

| Live check | Result | Observed time |
| --- | --- | ---: |
| Default chat | Real GPT-OSS 20B completion | 1.013 s |
| Historic saved model key + conversation context | Real answer containing the fresh conversation marker; fallback disclosed | 1.773 s |
| Structured analysis | Real, non-template findings; `aiUsed: true`, `fallbackUsed: false`, Stay Flat and N/A price fields | 5.135 s |
| Chat Mode browser retry | Mira's actual reply appeared; both stale history selections recovered; zero page errors | 1.361 s |
| Public AI health | Healthy; visible completion verified | — |

The analysis answered: “No market data provided; cannot assess HTF alignment, FVGs, liquidity pools, session levels, or sweeps.” This is a response to the test input, not a market prediction.

One earlier verification run received a reply but failed the exact-string conversation-marker assertion; that reply's text was not captured. The verifier was changed to report failures independently and include diagnostic text. The same assertion then passed with a fresh marker against the **unchanged application deployment**. These checks demonstrate working requests and visible replies, not guaranteed correctness or exact-token reproduction for every model response. Timings are observations, not latency guarantees.

The temporary diagnostic/verification deployments are removed after results are recorded. No temporary key was reused, no environment variables or server settings were changed, and no trading/order/history-write endpoints were invoked. The existing Worker was not redeployed; the web app's chat and analysis use the same-origin Vercel API.

[Open Mira](https://aurum-quant-ai.vercel.app/chat.html) · [Release receipt](https://aurum-quant-ai.vercel.app/ai-release-check.json)

# Debate Council recovery — 24 October 2026

## Confirmed failure before this change

A real Fast request to the production `/api/ai-decision` returned a genuine final analysis in **7.514 seconds**, but **0 of 4 debate participants** completed. Yi Large, Jamba 1.5 Large, SEA-LION 7B and DBRX all returned HTTP 404 despite appearing in the provider catalog. A catalog entry is not proof of a usable completion endpoint.

Separate, small provider probes with the existing server credential received real replies from GPT-OSS 20B (837 ms) and Nemotron 3.5 Bolt E4B (406 ms). Four other candidates timed out at the six-second probe limit. These observations informed the initial Fast preferences; they do not guarantee availability or speed.

The browser also had two `showDebateCouncilModal` declarations: the later, success-only implementation overrode the failure-aware one. Success/Failed tabs had no handlers, the debate-mode selector was never initialized or saved, and the consensus panel stayed hidden with an unused canvas.

## Narrow repair

- A debate-only scheduler uses server-discovered models and credentials. Browser metadata may select IDs/roles, never provider keys or endpoints. Explicit participant opt-outs win across duplicate entries.
- Fast uses three short bullish, bearish and red-team perspectives, normally across the two quick responders. It is **not represented as three independent models**. Recent sub-1.5-second successful candidates can join the Fast pool; merely completing a slow Deep request does not make a model fast.
- Deep and Full use configured participants with bounded concurrency, not an unbounded imported catalog. Each role has at most one distinct alternate. Failed/skipped attempts and actual fallback model IDs remain visible.
- A bounded, credential/transport-scoped warm-process cache temporarily deprioritizes failures: 30 seconds for transient errors, ten minutes for removed models, five minutes for successful observations. Credentials changing, expiration or a cold process naturally permit another attempt. Authentication/rate-limit errors stop queued debate work.
- Concise debate instructions separate evidence from missing inputs and ask for an explicit verdict. Ambiguous/missing votes remain unclassified instead of being inferred from words such as “bullish.” Obvious prompt echoes and one-word connectivity replies do not count as reviews.
- The original final-answer validator, system prompt, model fallback and bounded output repair remain intact. If every debate fails, final analysis still proceeds. If final synthesis fails, genuine reviews remain in the error response without inventing an AI trade plan.
- One modal renderer supports Success and Failed/skipped tabs, partial/all-failed/empty states, per-attempt timing, model identity and backup disclosure. Provider text uses `textContent`. The visible council panel shows explicit verdicts and distinct-model counts; keyboard and phone layouts work.
- Mode choice is initialized and saved in this browser, without changing server settings. Waiting shows elapsed time and clears its timer on both success and error. The existing local rule-engine fallback is explicitly labeled **AI UNAVAILABLE / RULE ENGINE**, not a completed AI answer.

| Mode | Perspectives (maximum) | Parallel requests (maximum) | Debate phase budget | Final-summary attempt budget |
| --- | ---: | ---: | ---: | ---: |
| Fast (default) | 3 | 3 | 8 seconds | 35 seconds |
| Deep | 4 | 3 | 14 seconds | 40 seconds |
| Full | 6 | 3 | 20 seconds | 45 seconds |
| Summary only | 0 | 0 | None | 35 seconds |

These are request budgets, **not a promise of total end-to-end latency**. Discovery, final synthesis, network scheduling and the existing bounded summary fallback also take time. Overall analysis-service deadlines are 65/85/105 seconds (Fast/Deep/Full); browser timeouts include additional headroom. “Failed/skipped” counts attempts, including failures followed by a successful backup, whereas the main completed count measures perspectives.

## Preserved components

Byte-for-byte checks against the pre-repair source confirmed no change to `chat.js`, `chat.html`, `chat.css`, chat service/handler, shared NVIDIA runtime, credential persistence, Firebase adapter, API dispatcher, trading bot, OANDA client or learning module. The summary system prompt's generated text is also unchanged. No provider keys, environment variables, server settings, orders or bot state were modified for this repair.

Mira keeps its light responsive layout and saved-history recovery. **Chat Mode still has no live market feed**; this repair does not add one. The remote Worker is not redeployed.

## Verification and release safeguards

Local checks:

- **84 passing tests**: seven analysis-engine cases plus 77 Node tests, including 18 debate regressions.
- Terminal browser suite: real controller/request path with mocked market/AI responses; mode persistence, both tabs, partial/all-failed/empty states, final-summary failure/recovery, timer cleanup, escaped content, keyboard focus and mobile bounds.
- Mira browser suite: portrait, light layout at 18 desktop/tablet widths, mobile drawer, saved conversations, retry and stale-model recovery.
- Vercel traced-function build and Worker dry-run; no actual Worker deployment.

```sh
npm test
npm run test:ai-ui
npm run test:chat-layout
npm run build:vercel
npm run check-build
```

`AURUM_VERIFY_LIVE_AI=1` now refuses a release that only has a working final summary: it also requires actual substantive debate completions, accurate model counts, neutral no-data verdicts and a bounded Fast debate phase. The public release receipt includes source revision, debate models and timings.

Explicit post-release verification:

```sh
npm run verify:live-ai -- --browser
```

This makes real small AI requests through the public HTTP API and deployed Mira/terminal browsers. The terminal check uses synthetic chart fixtures for layout but **replaces the outgoing market prompt with a no-data connectivity request**; it is not a live-market accuracy test. Its history writes are intercepted locally, and all trading commands, settings writes and other unapproved API calls are blocked. It verifies actual displayed debate text and tab behavior as well as visible Mira replies. `AURUM_VERIFY_REPORT` records a sanitized receipt.

Live release outcomes will be recorded below after the staged gate and post-deployment checks complete. Earlier live results above describe the pre-repair baseline, not a new deployment.

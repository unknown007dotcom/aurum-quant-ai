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

## Gated release

Application revision: `fdde143371b1a6080fdec6b6f48b246cff142509`.
Production deployment: `dpl_8MRLQnfErxv6amsAvHJ4rDHPJU19`, **READY / PROMOTED**, with both existing cron schedules preserved.
The canonical public release receipt confirms this revision at **2026-10-24 17:33:03.705 UTC**.

| Genuine packaged-handler gate | Chat | Debate | Whole analysis-handler request |
| --- | ---: | --- | ---: |
| Staged build | 0.751 s | 3/3 perspectives, 2 models, 1.567 s | 7.847 s |
| Production build | 2.217 s | 3/3 perspectives, 2 models, 2.650 s | 8.999 s |

Both used GPT-OSS 20B and Nemotron 3.5 Bolt E4B for reviews and GPT-OSS 20B for the meaningful final analysis. Both final results were genuine AI output, Stay Flat, with N/A price fields. Production final synthesis took 5.572 s; the debate budget is not the complete response time. These are isolated timing observations, not guarantees or proof that every run is faster than the earlier request that produced no working debate.

Staged checks invoked the packaged handlers with real provider requests; they are not public-HTTP/browser checks. The project's preview deployments retain their existing access protection. No protection settings were changed. The post-deployment public HTTP/browser results are recorded separately below.

[Open the terminal](https://aurum-quant-ai.vercel.app/) · [Release receipt](https://aurum-quant-ai.vercel.app/ai-release-check.json)


## Verified after deployment

The completed public-HTTP and real-Chromium verifier checked the canonical production origin at approximately **17:34:59 UTC**. AI responses were genuine, not mocked.

| Public production check | Result | Observed time |
| --- | --- | ---: |
| Default chat | Real GPT-OSS 20B answer | 3.983 s |
| Historic saved model + conversation context | Recovered selection and correct fresh conversation marker | 1.157 s |
| Fast analysis HTTP | Meaningful final answer; 3/3 reviews from 2 distinct models; no failed attempts | 7.498 s total, 1.689 s debate |
| Mira browser | Actual visible reply; stale-history recovery; no page errors | 1.357 s |
| Terminal browser | Actual displayed reviews, Success/Failed tabs, mobile bounds, Escape close; no page errors | 9.655 s including page load/UI checks; 2.672 s debate |

Both terminal checks used GPT-OSS 20B and Nemotron 3.5 Bolt E4B for the council. Final analysis safely explained the absence of current market evidence, rather than returning formatting instructions or fictional price levels. The browser's chart fixture was synthetic and never submitted as live market evidence. One attempted history write was intercepted and not sent to the server. No orders, bot commands, settings updates or credential changes were performed.

The 7.498-second HTTP result includes a working council, whereas the 7.514-second baseline had zero working reviews. These isolated samples are not a statistical speed comparison. The reliable performance improvement is bounded debate work, smaller fanout and avoiding recently failed participants; final-model latency still varies.

The baseline-probe, staged-release and post-release-verification preview deployments were deleted after their results were recorded. The new production deployment and earlier production rollback deployments remain intact. No temporary credential was created or installed.

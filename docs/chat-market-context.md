# Mira: read-only OANDA market context

## What this fixes

Mira previously received only conversation text and an explicit system instruction that it had no live-market access. A healthy AI endpoint or a working terminal market feed did not change that. This integration supplies actual server-fetched OANDA evidence for XAU/USD questions instead of merely changing the assistant's wording.

The existing production `/api/live-price?symbol=XAU_USD` was checked before this change. It returned OANDA data timestamped **23 October 2026, 20:59:05 UTC**. A successful fetch does **not** make that old quote a live price.

## Data path and limits

1. The browser sends the usual same-origin `/api/chat` request. Its new `settings.marketContext` boolean defaults to true and is saved per conversation; old conversations retain their messages and gain the default.
2. The server detects explicit gold/XAU/OANDA questions and relevant follow-ups. Ordinary conversation does not incur a broker request. Explicit opt-out prevents all market requests.
3. `lib/chat-market-context.mjs` reads the existing server `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, and `OANDA_ENVIRONMENT`, falling back to protected server settings. No credentials/settings are created or changed by this integration.
4. At most three parallel **GET** requests retrieve pricing and up to 32 M15/H1 candles. The only permitted hosts are OANDA's practice and live REST hosts. Instrument and endpoints are fixed in server code. There are no account-discovery, balance, position, order, transaction, or bot-control requests.
5. Completed candles are checked, sorted, deduplicated and reduced to eight recent bars per timeframe plus simple sample range/change statistics. This is not the terminal's full multi-timeframe indicator dataset. Missing candle data is explicitly noted.
6. The safe snapshot is attached to the model's system context. The provider receives market evidence, never OANDA credentials or the account ID. Current server evidence takes precedence over older chat statements about access or prices.
7. The reply includes compact `market` provenance: source, instrument, environment, quote/time, lookup time, freshness and candle availability. An independently rendered source card shows those facts even if the model's prose is brief. History/export retain the source timestamp, not full candle arrays or private broker metadata.

The capability is **read-only snapshots per relevant request**, not continuous streaming, web browsing, other-instrument pricing, or trade execution. The light Mira layout, portrait, history, model selection and response controls remain intact. The existing terminal/analysis/debate, broker-order code and Worker deployment are not changed.

## Freshness and failures

- A quote is `live` only when OANDA marks it tradeable and its own timestamp is no more than 90 seconds old.
- `market_closed` means OANDA marked it non-tradeable at lookup. It is displayed as a last-known quote, with its time.
- Old or unverified-status quotes are `stale`, never relabeled live merely because the HTTP request succeeded.
- Invalid/missing/future timestamps, wrong instruments, invalid prices or inverted bid/ask are rejected. The envelope/request time is never substituted for the quote time.
- A 3.5-second overall deadline aborts broker reads. A quote already received survives a candle timeout. An unavailable broker produces a clear unavailable-data context and **does not turn ordinary AI chat into an error or invent a replacement price**.
- A small warm-process cache coalesces concurrent reads for the same credential/account/environment. Successful snapshots last ten seconds, failures three seconds. Quote age is recalculated on every cache hit, while the original lookup timestamp is retained. Credential changes and new transports do not inherit another credential's cache.
- Reopened history labels old snapshots as historical; the card always shows exact quote/lookup times and says it is not streaming.

## Verification

```sh
npm test
npm run test:chat-market
npm run test:chat-layout
npm run test:ai-ui
npm run build:vercel
npm run check-build
```

Use a compatible Playwright Chromium (`npx playwright install chromium`) for browser tests. The sandbox's older Chromium 138 fixture stopped accepting native text input during repeated turns; the same tests pass with Chromium 153, without modifying application input behavior to work around the obsolete test binary.

Local verification passed **112 tests** (105 Node cases plus seven analysis-engine cases), all three browser suites, the Vercel package build and the Worker dry-run. The 28 new market unit tests inject broker/model responses. They cover fixed GET-only routes, no credential exposure, intent and opt-out, closed/stale/invalid data, deadline/partial success, cache isolation and expiration, ordinary-chat continuity, saved provenance/export, safe rendering and mobile interaction. The shared NVIDIA runtime, analysis/debate services, trading bot, OANDA order client, API decision/cron handlers, Firebase adapter and terminal controller are hash-checked against the pre-change files.

A release built with **`AURUM_VERIFY_LIVE_MARKET=1`** requires a genuine broker quote and both candle timeframes, plus an actual model reply that attributes OANDA and uses the supplied prices. It also runs the existing real chat/debate/analysis gate. The public `ai-release-check.json` receipt records safe market evidence and source revision, not credentials.

For post-deployment verification:

```sh
npm run verify:live-market -- --browser
npm run verify:live-ai -- --browser
```

The market verifier sends an actual gold question through the deployed API and UI without substituting a smaller no-data prompt. It checks the visible source card, closed/stale disclosures, mobile layout and persisted provenance. Browser/API traffic is limited to chat and static assets; it never issues an order, settings write, bot command or history write. `AURUM_VERIFY_ORIGIN` and `AURUM_VERIFY_REPORT` select the origin and sanitized report path.

## Gated production release

- Feature implementation: `9fda74df19d6f4ab448fccc6306e90caaed85bf2`.
- Released source, including verifier corrections: `64b568d3081a62824b344dfd8e87b2743b4ce28c`.
- Production deployment: `dpl_8bm3ecuknVm7FvBrzbwWD82Ffj8H`, **READY / PROMOTED** on the existing project.
- Canonical public receipt: **2026-10-25 14:06:15.247 UTC**, with market evidence in `ai-release-check.json`.

The release gate used the existing **OANDA practice** connection and retrieved a genuine quote plus **32 completed M15 candles and 32 H1 candles**. OANDA marked the instrument non-tradeable. The last quote was bid **3995.18**, ask **3996.44**, midpoint **3995.81 USD/troy oz**, timestamped **2026-10-23 20:59:05.113 UTC**. These are last-known values, **not a current live price**.

The actual GPT-OSS 20B reply included:

> The market is **not tradeable** (closed), so this quote is not live.

The market-chat request took **3.754 seconds** in that packaged-handler check. Ordinary chat also returned a real answer (0.898 s), and the unchanged analysis/debate gate passed (3/3 reviews across two models; 9.257 s total for its no-data analysis). Timings are observations, not guarantees; the full terminal market-analysis workload differs from that no-data test.

A first candidate was blocked before promotion by the freshness-text assertion. Its reply text was not captured, so that exact wording remains unknown. A focused regression then showed that the assertion incorrectly rejected legitimate “not tradeable”/“non-tradable” variants. The verifier was corrected, now captures the actual reply, and continues to reject missing freshness disclosures, explicit stale-as-live claims and invented prices. The application code itself is unchanged between the first candidate and the successful release.

## Public HTTP and browser verification

The final verifier completed at approximately **2026-10-25 14:13:25 UTC** against `https://aurum-quant-ai.vercel.app`, without replacing the gold question or mocking the AI/OANDA response.

| Check | Result | Observed duration |
| --- | --- | ---: |
| OANDA-backed chat HTTP | Genuine quote, M15/H1 candles and model answer; closed-market disclosure | 4.717 s |
| OANDA-backed Mira browser | Actual answer/source card visible; exact quote timestamp; mobile layout and saved provenance passed | 3.753 s including reply/UI checks |
| Ordinary chat HTTP | Genuine reply | 2.043 s |
| Saved-model/context recovery | Genuine reply using the current fallback model and conversation marker | 1.433 s |
| Existing structured-analysis HTTP gate | Genuine neutral no-data analysis; 3/3 debate perspectives across 2 models | 5.646 s |
| Existing Mira browser recovery | Visible reply; stale history recovered; no page errors | 1.363 s |
| Existing terminal browser gate | Genuine no-data AI response and debate UI; mobile/tab checks passed | 8.059 s including UI checks |

The market browser answer used **3995.18 / 3996.44 / 3995.81** and explicitly said the market was **not tradeable (closed)**. Its provenance identified OANDA practice and the original **23 October 20:59:05.113 UTC** quote time. The lookup time was **25 October 14:12:55.610 UTC**; those two timestamps are not interchangeable. No current/live quote was fabricated during closure.

Two preliminary verification builds had browser-runner setup/launch failures (not application failures). The public HTTP checks already passed; the complete deployed-browser run then succeeded with the build environment's compatible Chromium 138 binary. The broader local repeated-turn regression suite used Chromium 153. The production application was unchanged during these verifier setup corrections.

No API keys, environment variables, server settings, account environment, bot controls or order-execution logic were modified. Browser verification sent no orders; the terminal smoke test intercepted its attempted history write. The existing Worker was not redeployed, and both existing cron schedules were retained.

After recording results, the staged build, blocked production candidate and all temporary diagnostic/verification builds (including the two earlier response-investigation previews) were deleted. The verified production deployment and prior production rollback deployments remain intact.

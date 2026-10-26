# Main analysis: selected trading-skill adaptations

## Scope

This integration is for the **main terminal (`index.html`)**, not Mira. It adds an **Analysis skills** panel after the existing AI/equations panels and a small calculated research supplement to the terminal's existing `/api/ai-decision` request. It is not an installation of all 68 upstream skills and does not execute their Python scripts.

Reference: [`agiprolabs/claude-trading-skills`](https://github.com/agiprolabs/claude-trading-skills/tree/981e1d736cdc02bdc1c55c74ec9224e956414706), pinned to `981e1d736cdc02bdc1c55c74ec9224e956414706`. The MIT copyright/license notice is retained in [`assets/licenses/claude-trading-skills-MIT.txt`](../assets/licenses/claude-trading-skills-MIT.txt).

| Selected workflow | What runs in this application | What is deliberately not claimed/imported |
| --- | --- | --- |
| `ohlcv-processing` | Bounded OHLC checks: geometry, explicit timezone timestamps, future/forming candles, duplicates, ordering, spacing, gaps, and candle recency | No fabricated gap fills; no assumption that gold trades 24/7; provider identity is not independently authenticated by these checks |
| `volatility-modeling` | Wilder ATR(14), ATR as a percentage of the last close, and recent-versus-preceding average true-range ratio | No fitted GARCH model, forecast direction, or crypto-style 365-day annualization |
| `risk-management` | Directional stop/target validity and gross reward/risk of the **rule-engine reference plan** | No trade approval, portfolio monitoring, automatic circuit breaker, spread/slippage/financing model or new bot limits |
| `position-sizing` | Optional hypothetical ounces from a manually supplied USD risk budget and valid reference stop distance | No default/demo account balance, recommended risk percentage, account-equity lookup, margin check or executable broker order size |
| `walk-forward-validation` | A visible readiness/limitations notice: **backtest/walk-forward NOT RUN** | No invented backtest, win rate, Sharpe ratio, trained model or profitability estimate |

The application implementations are bounded JavaScript adaptations and selected guidance, not a direct port of the full Python packages. Crypto/Solana, wallet/exchange execution, copy trading, DeFi and tax/compliance workflows are not enabled.

## Flow and safety boundaries

1. The terminal fetches its existing market data and computes its existing rule-engine analysis as before.
2. When enabled, the optional module copies at most **256 recent entry-timeframe candles** into a compact, bounded research packet. It accepts ascending or descending feeds without modifying the original data. No new broker call is added.
3. The browser displays local calculations while AI is pending. The server independently recalculates them from the submitted packet; it does not trust a browser-supplied ATR, verdict, skill list, code, URL or instruction.
4. A fixed, maximum **2,200-character** digest is appended to the existing market prompt for debate/final synthesis. Raw candle arrays and full upstream skill documents are **not** copied into the model prompt. No extra model requests, Python processes, provider fanout or changed token/deadline profiles are introduced. If the original prompt already fills its size limit, the optional digest is omitted rather than exceeding that limit.
5. The API returns a research receipt. The panel distinguishes calculations actually included in the AI request from local-only checks and AI-failure cases.
6. The original AI response shape, system prompt, validation/repair and fallback remain intact. Absent/disabled research preserves the original request path. Malformed optional context or a failed module load cannot block the normal AI analysis. Module loading has a 500 ms upper wait, with a visible fallback notice.

The new controls are local browser preferences and apply to the **next preview**. The hypothetical risk-budget field starts blank. Changing it does not change account risk, bot units, orders, server settings or the current AI result. Turning research off removes the packet and restores the original prompt path.

Calculations concern the bounded **submitted snapshot**, not the full price history or an independently verified live quote. Candle times are opening timestamps; inferred close/recency checks are approximate. A spacing mismatch is flagged rather than silently claiming the selected timeframe. Session/weekend gaps may be legitimate, so the overlay reports them without filling prices or automatically declaring an outage. Gross R/R concerns the rule-engine reference prices, not a validation of the subsequently generated AI plan.

## Preserved components

Pre-change hashes protect Mira's JS/HTML/CSS, chat service and market context, chat storage/provenance, shared NVIDIA transport, debate scheduler, analysis system prompts, OANDA/order code, trading bot, Firebase adapter, chat/decision/cron handlers and Worker source. These remain byte-for-byte unchanged. The shared analysis service opts into the supplement **only** when a caller explicitly supplies `terminalSkills.enabled: true`; existing scheduled callers do not do so.

No credential, environment, account, bot state, order-execution control or Worker deployment is changed by this integration. The existing daily cron schedules must be preserved during release.

## Verification

Local regression coverage: **139 tests** (132 Node cases + seven analysis-engine cases), including 27 new terminal-research tests. The main browser suite checks controls, bounded requests, persisted opt-out/manual budget, safe text rendering, mobile bounds, AI-failure disclosure and optional-module failure/recovery. Mira's existing layout and market-context browser suites are also run unchanged.

```sh
npm test
npm run test:ai-ui
npm run test:chat-layout
npm run test:chat-market
npm run build:vercel
npm run check-build
```

For release gates, set `AURUM_VERIFY_LIVE_TERMINAL_SKILLS=1` in the build process. The check retrieves a real bounded sample from the terminal's existing market endpoint, invokes the packaged analysis handler, and requires a genuine structured AI answer plus computed ATR/quality evidence and an explicit `not_run` validation status. The existing chat/debate and optional OANDA-Mira gates remain available.

Post-deployment:

```sh
npm run verify:live-terminal-skills
npm run verify:live-ai -- --browser
npm run verify:live-market -- --browser
```

The new terminal browser check uses the **actual browser-built market prompt and feed**, not a replacement no-data prompt. It permits real market reads and the AI request but intercepts history writes, mocks bot status as disabled, and blocks trading/settings commands. The older no-data debate diagnostic explicitly disables research input so synthetic chart candles are never submitted as live evidence.

Live release results will be recorded after staged and canonical public verification. Passing synthetic local tests alone is not proof of a deployed response.

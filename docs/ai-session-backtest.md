# Opt-in historical AI session replay

This research harness evaluates the **current main analysis page**, not the different automated-bot strategy and not a substituted EMA-only strategy. It does not change or deploy production application code.

## Approved experiment

- XAU/USD; 23 October 2026, 08:00–16:30 America/New_York (12:00–20:30 UTC).
- 34 checkpoints, every 15 minutes, starting 08:00 and ending 16:15 New York.
- Current Fast council and final analyst, temperature 0.2, default server model selection, main-page research calculations enabled; hypothetical risk budget left blank.
- One real AI evaluation per checkpoint. Valid answers are never rerolled after seeing outcomes. Evaluations run serially, with the existing bounded provider retry/fallback logic.
- At most 272 completion requests and 35 minutes per run; authentication/rate-limit failures stop the run rather than hammer normal AI service. Coverage and failed/skipped evaluations are reported separately.

## Data and look-ahead controls

The data source is the terminal's existing OANDA-labelled read-only candle endpoint. Its cached history contains midpoint OHLC, not historical bid/ask depth. All input data, source hashes and visible AI replies are retained with the run.

The exact `AnalysisEngine`, `LiquidityEngine`, `buildAiPrompt` and `inferEntryRange` code blocks are read from the current `app.js`, without loading its DOM/network/trading handlers. An isolated computation subprocess has a historical clock, no broker/model credentials, blocked network/DOM entry points and a 30-second timeout. Trusted strategy source is executed in a native JavaScript realm; VM parity is tested. Observational diagnostic-log formatting is disabled without changing calculations or the AI prompt. The shared math module and analysis/debate services are reused unchanged. Runtime/source files are not edited.

At each cutoff, entry candles must already be complete. Unclosed H1/H4/daily/weekly/monthly candles are **reconstructed from past completed M5 bars**, not from their eventual full-period highs/lows/closes. Sufficient lower-timeframe coverage is mandatory. Only boundary timestamps—not later prices—are used to identify calendar-aligned higher-timeframe periods. No synthetic price gaps are filled. Unit tests mutate future OHLC values and require unchanged earlier snapshots.

The live cache can hold up to 5,000 bars. The replay uses the available historical prefix under that cap, not an invented record of what the cache contained in the past. Older evicted warmup bars cannot be recovered. These and close-based snapshots are declared fidelity limitations.

Current global learning/outcome memory is **omitted**, because it is not versioned by historical cutoff and could contain later outcomes. The historical instruction and manually time-adjusted research digest are added before calling the unchanged AI service; real provider deadlines still use the real clock. This is therefore a **retrospective current-model replay**, not recovered original historical decisions or guaranteed out-of-sample performance. LLM training-time/hindsight knowledge cannot be excluded.

## Paper execution model

- Apply the main page's rule-versus-AI conflict guard. AI Stay Flat and conflict-flat decisions create no position.
- Parse explicit price zones, stops and targets. Ignore label digits such as `TP1`, percentages and ratios. Reject ambiguous prices, contradictory stop/target geometry, unordered targets, vague entry descriptions or additional non-price entry confirmation that is not machine-defined.
- One hypothetical ounce-equivalent, one open position, five-minute execution delay. An unfilled plan expires at the next decision. No account balance, leverage, margin or compounding is assumed.
- Full exit at the first/nearest supplied target, stop, or 16:30 New York session close. Last-target sensitivity is also shown. No partial exits, trailing stops or prose structural-invalidation management is inferred.
- Base assumption: **$1.00 spread and $0.10 slippage per fill per ounce**. Low-cost: $0.50 / $0; stress: $2.00 / $0.20. These are assumptions, not observed historical execution costs. Spread can alter both fills and trade counts.
- Long entries use assumed ask and exits bid; shorts use bid and ask respectively. Stop gaps fill at the worse opening quote. Where M5 ordering is unknown, stop first; an intrabar entry uses an adverse overlap price and never receives same-bar target credit.
- Positions are forcibly closed before the NY 17:00 financing rollover. Separate commissions and actual broker charges are not verified.

Results are USD per hypothetical ounce-equivalent and per-trade R, not account returns. Drawdown is marked at M5 closes. No annualized Sharpe or profitability claim is warranted from one session. No-trade outcomes have N/A win rate/profit factor, rather than invented performance.

## Running

```sh
npm run test:backtest
npm run backtest:ai-session -- --confirm-ai-usage --output scratch/backtest/session-2026-10-23
```

The opt-in flag is required. The runner uses existing server-side NVIDIA configuration; never put credentials in arguments, output artifacts, or chat. In this sandbox, real requests run in an isolated protected Vercel **preview build** because direct provider networking is restricted. This does not replace the live site or invoke bot/order/history/learning-write endpoints. Normal data-fetch cache refreshes may occur within the existing market endpoint.

Artifacts: HTML/Markdown report, signals/trades CSV, full decisions, provider-usage counts (not hidden reasoning), input manifest, prepared point-in-time prompts/audits, and the original market dataset. Large generated inputs/results remain outside Git. A protected results deployment may be retained for download; the live application deployment is left unchanged.

Results will be recorded after the real run finishes. Synthetic mechanics tests are not a completed AI backtest.

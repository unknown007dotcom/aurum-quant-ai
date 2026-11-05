# Chat timeout recovery — November 2026

## Cause and evidence

The report was real: after PR #3, production Chat Mode opened an SSE connection
but sent no answer text and failed after approximately 110 seconds. A successful
build, HTTP 200, or a model-catalog entry was not proof of a working completion.

The existing **Aurum settings key was already being used**. A read-only comparison
confirmed the backend loaded the saved Firestore settings, not the bundled fallback
file, and there was no `NVIDIA_API_KEY` environment override. No new key, credential
migration, or provider-account change was required.

There were several distinct problems:

- The saved default, `meta/llama-3.1-70b-instruct`, returned **HTTP 410 Gone** when
  called directly with the saved application key.
- GPT-OSS 20B, selected as an automatic replacement, stalled. The other historical
  fallback IDs were no longer in the catalog, leaving only that stalled candidate.
- Some other catalog-listed models returned completion 404s or stalled too.
  The catalog alone was therefore insufficient for choosing a replacement.
- Streaming startup and inter-token idle limits were conflated, healthy output
  could be cut off by a startup timer, and a terminal choice could still wait for
  transport closure.
- Newer reasoning models could spend a concise 700-token allowance on internal
  reasoning, leaving no visible answer or only a prefix. A nonempty, token-limited
  fragment previously counted as a completed answer.

## Saved-key configuration

Real completion probes found two responding models using the **same saved key**:

| Model | First visible text | Completion | Streamed deltas |
| --- | ---: | ---: | ---: |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 4.478 s | 4.871 s | 42 |
| `minimaxai/minimax-m3.1-flash` | 11.503 s | 12.267 s | 34 |

Both returned fresh request markers and meaningful reading-list tips. Evidence:
`dpl_6BeSr9JZP4qJ7LrSSWoDMHSRtNZ9` (`a6c6a84`). These are observations, not latency
guarantees.

After an additional full Chat-service preflight (including a Markdown-table reply),
a transaction updated **only** these fields in Aurum's protected settings:

```json
{
  "chatModelIds": [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "minimaxai/minimax-m3.1-flash"
  ],
  "chatDefaultModelKey": "nvidia/nemotron-3.5-lightning-30b-a3b"
}
```

Configuration receipt: `dpl_CiT7WAGvKd6VEYweTMgQq9F4wn1m` (`9d4e273`). The receipt
records the two written fields, with `credentialsWritten`, `analysisSettingsWritten`
and `tradingSettingsWritten` all **false**. The one-off configuration script and
its build flag were subsequently removed; ordinary deployments do not reset settings.

The Chat policy intersects these enabled IDs with the current server-side catalog.
It never takes credentials, provider URLs or policy overrides from a chat request.
If an enabled model disappears, the remaining enabled model is used; if none is
available, Chat reports an error rather than silently enabling a different model.
Without an explicit Chat policy, previous catalog/default behavior is unchanged.

Existing saved selections outside the enabled Chat models recover to the configured
default, with the actual model/fallback disclosed. The browser reconciles model
preferences without deleting conversation content. Global analysis model settings
and broker/trading controls are separate and unchanged.

## Transport and generation repairs

- Separate first-visible-answer startup, inter-answer-token idle and overall
  generation deadlines. Earlier candidates have a 45-second startup allowance;
  the final candidate may use the remaining budget. Healthy output can outlive its
  startup allowance, but never the existing 110-second generation deadline.
- Apply the 20-second idle limit only after visible answer text starts. Headers,
  heartbeat comments and private reasoning do not count as visible progress.
- Complete immediately on a terminal `finish_reason`, after its final delta,
  rather than waiting for `[DONE]` or socket closure.
- Share the startup budget across stream negotiation and buffered compatibility.
- Prefer Aurum's configured active Chat default before generic fallback hints.
  Keep the three-candidate cap, de-duplication, and immediate stop on auth/rate limits.
- Give current Nemotron/MiniMax reasoning models at least 2,048 output tokens.
  Chat rejects a `length`-terminated fragment, even if nonempty, and uses the existing
  bounded larger-token retry instead of saving it as a complete answer. Other
  callers retain their content-validation policy.
- Preserve safe timeout phases (`first_token`, `idle`, `deadline`) and server-only
  model/code/status/duration diagnostics. Never log keys, prompts, provider error
  bodies, private reasoning or user answer text.

Markdown tables, incremental output, Stop, incomplete-message persistence and
retry/regenerate behavior are retained. Browser asset versions are bumped.

## Successful release-candidate verification

The initial configuration run exposed the token-budget problem: one live answer
contained only its marker. That run was correctly rejected, despite an earlier
successful reply. It was not treated as a passing release check.

After the reasoning-budget/truncation repair, the **actual packaged HTTP handler**
completed both checks using genuine provider responses:

| Check | First text | Completion | Deltas | Result |
| --- | ---: | ---: | ---: | --- |
| Default Chat request | 7.419 s | 7.919 s | 78 | Complete three-tip answer, fresh marker |
| Historic `gpt-oss-default` selection | 20.103 s | 21.144 s | 105 | Complete answer, fresh marker, fallback disclosed |

Receipt: `dpl_AbqR7zAoGZsBAAfyFjzMF5E4bZgL`, application revision `ae87b5b`.
This verifies real generation through the packaged API; it is not by itself a
claim about the public CDN route. Post-deployment public checks are recorded in
[PR #4](https://github.com/unknown007dotcom/aurum-quant-ai/pull/4).

## Repeatable checks

```sh
npm test
npm run test:chat-stream
npm run test:chat-layout
npm run test:ai-ui
npm run test:chat-market
npm run test:backtest
npm run check-build
npm run build:vercel

# Opt-in genuine public API checks (not mocks):
AURUM_VERIFY_ORIGIN=https://aurum-quant-ai.vercel.app npm run verify:live-chat-stream -- --require-incremental

# Opt-in genuine provider gate through the packaged Node HTTP handler:
AURUM_VERIFY_LIVE_CHAT_STREAM=1 npm run build:vercel
```

The live verifier only calls `/api/chat`, uses synthetic prompts with market
lookup disabled, and requires visible deltas plus an authoritative complete
answer. It exercises both default routing and a historic saved selection. Its
small answer excerpts are from its own synthetic requests, never user history.
No order, broker-control, history-write or settings-write endpoints are invoked.

Final local checks: **192/193** Node unit tests, analysis **7/7**, OANDA guards
**8/8**, backtests **20/20**, all four browser suites, Vercel packaging and Worker
dry-run. The strict public verifier additionally requires text deltas delivered
across time, rather than accepting a whole buffered SSE answer as live typing.

A fresh same-code verification on 5 November (`dpl_Fu3EHtZC1jYbPYfXTPyWgfkHJ4MT`)
also completed both genuine requests: 7.959 seconds for default Chat and 14.095
seconds for saved-selection recovery.

Normal unit/browser suites use controlled providers. The pre-existing
tracked-credential safety guard still fails because fallback settings contain
provider credentials; their values are not printed and settings were not rewritten
to make that test green. Credential cleanup/rotation is a separate operational task.

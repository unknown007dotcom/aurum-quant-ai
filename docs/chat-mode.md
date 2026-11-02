# Chat Mode

## Open the workspace

Run `node server.js` and open `/chat.html`, or choose **Chat Mode** beside **Settings** in the terminal header. Chat Mode always uses a light appearance, including when the device prefers dark mode. The existing terminal theme and trading settings are unchanged.

The page is a standalone, light-and-gold, three-column chat workspace inspired by the requested FlowGPT layout:

- **Left:** new conversation, search, date-grouped saved chats, and clearly labeled example conversations. Examples are not saved as user history until continued.
- **Center:** conversation starters, Markdown/text replies, a growing composer, copy, regenerate, retry, and stop controls. The conversation menu supports rename, Markdown export, and confirmed deletion.
- **Right:** model selection, response length, creativity, read-only XAU/USD market context, conversation context, Enter-to-send, reset, and a custom image area. Settings are saved per conversation and are used as defaults for new chats.
- **Responsive layout:** both sidebars stay docked at 900px and wider. From 641–899px, history becomes a drawer while settings stays visible on the right. At 640px and below, a labeled **Settings** button opens the right-hand drawer. Drawers support independent scrolling, backdrop dismissal, Escape, focus containment, and restored focus. Reduced-motion preferences are respected.

## Image area

The assistant is named **Mira**, with a user-selected, AI-generated anime portrait shown by default in the right panel and matching small avatars in the conversation. Her name is used consistently in chat labels, exports, and the server-controlled AI prompt; she remains clearly identified as an AI assistant. Optional uploads support PNG, JPEG, and WebP up to 5 MB. Images are resized to at most 1,000 pixels on their longest edge, converted to WebP, and saved in browser storage. The image is decorative and is **not** attached to messages or sent to the AI provider. Uploading an image overrides the portrait only in this browser; **Restore Mira's portrait** returns to the bundled default. Invalid or unreadable saved images fall back to Mira.

Fonts and icons are served locally; the chat interface does not need a third-party asset CDN. Font licenses are in `assets/fonts/`.

## Conversations and privacy

- Chats/settings: `aurum-chat-workspace-v1` in `localStorage`.
- Custom image: `aurum-chat-image-v1` in `localStorage`.
- Trading settings and analysis history use their original, separate keys.
- Up to 50 saved chats and 100 messages per chat. The UI asks the user to start a new chat or delete an old one instead of silently removing saved content.
- User messages are limited to 8,000 characters. Context includes up to 40 recent messages within a 48,000-character budget; turning context off sends only the latest user message.
- Conversations are local to this browser, not synced to an account. Clearing site data removes them. Export important chats to keep a copy.
- Text and the enabled conversation context are sent to the configured AI provider for a response. No API credentials are copied into chat storage, chat requests from the browser, exports, or the public model list.
- Provider failures are displayed as errors, not fabricated assistant replies. Sending another request, retrying, or regenerating uses the configured provider. Stopping aborts the browser request and prevents late results from modifying the chat; an upstream provider may already have started processing it.

## API wiring

The browser only calls same-origin `/api/chat`:

- `GET`: `{ models: [{ key, id, label }], defaultModelKey, configured, marketData }`. “Configured” indicates a key is present, not a verified live connection.
- `POST`: `{ modelKey, settings: { style, temperature, marketContext }, messages: [{ role, content }] }`.
- Successful reply: `{ content, model, market? }`. `market` is safe quote provenance, not credentials or the full candle dataset.
- Failure: a suitable HTTP status with `{ message }`.

`api-handlers/chat.js`, `/api/ai-decision`, and `/api/ai-health` now use the same server-side configuration and `lib/nvidia-runtime.mjs`. They no longer depend on a separately deployed edge chat route. A permanent `NVIDIA_API_KEY` takes precedence over saved keys; otherwise protected server settings provide the credentials.

Model discovery checks NVIDIA's current catalog, filters non-chat tasks, and stops selecting missing models. Catalog membership is not proof of a working completion: `/api/ai-health` must receive visible response text. Retired or failing models can fall back to an active model, with the actual responding model exposed in the response and chat UI. Empty responses and provider failures are errors, never invented AI answers. Reasoning models receive an appropriate completion budget.

The Cloudflare source uses the shared AI services too, but changing the Vercel deployment does not automatically update an existing Worker. Browser AI requests stay on the verified Vercel path; market-data and trading endpoints remain separate.

The conversational system prompt is separate from the trade-decision engine. Read-only OANDA context is now available for gold questions and relevant follow-ups; it is not a streaming feed. Hypothetical examples must still be labeled. Chat Mode never starts, stops, modifies, closes or places trades, and it cannot access balances or account history. See [the market-context integration](chat-market-context.md) for freshness, permissions and verification details.

## Verification

```sh
npm test                 # Existing analysis tests + chat state/service/adapter tests
npm run check-build      # Cloudflare bundle validation, no deployment
npx playwright install chromium # One-time setup for browser regression tests
npm run test:chat-layout # Docking, mobile drawers, resize, and interaction checks
npm run test:ai-ui       # Real terminal controller, mocked HTTP, no trading
npm run test:chat-market # Market provenance, failure recovery, persistence and mobile UI
node server.js           # Manual/browser verification at /chat.html
```

The chat tests use injected provider responses and never call a real AI provider. Live responses require a valid configured key, an accessible provider endpoint, and the deployed chat route. Browser interaction checks should cover history persistence, both successful and failed requests, retry/regenerate/stop, settings in outgoing requests, rename/export/delete, image upload/removal, and responsive drawer behavior.

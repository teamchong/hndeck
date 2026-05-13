# promptapi — On-Device Tour Guide

Click a city. Chrome's on-device Gemini Nano writes a walking tour using a
4-line TypeScript SDK. The SDK validates the model's calls and renders
them on a MapLibre map. **No server. No API keys. No textbox.**

```
[city button]  ──▶  Nano (in browser)  ──▶  tour.goto("eiffel-tower", "...")
                                              │
                                              ▼
                                    SDK validates + executes
                                              │
                                              ▼
                                  pin + popup + route line
                                       streams onto map
```

This is a **Code Mode** demo, in the same family as
[`drawmode`](../drawmode), [`gomode`](../gomode), [`pymode`](../pymode), and
[`querymode`](../querymode) — a tiny TypeScript SDK is exposed to the LLM,
the LLM emits a few SDK calls, and the runtime turns them into something
the user sees. The novelty here: the model is **Gemini Nano running on
the user's device**, not a cloud API.

## What's interesting

- **Closed-enum location keys.** The SDK's `goto(loc, msg)` parameter is
  typed as a string union of pre-baked landmark names (e.g. `"eiffel-tower"`,
  `"cloudflare-london"`, `"big-ben"`). The model can't hallucinate a place
  name and can't emit raw coordinates. Every key has hardcoded `[lng, lat]`
  in `src/lib/locations.ts` so we **never need geocoding**.
- **Per-city enum narrowing.** When the user picks Tokyo, the system prompt
  only shows ~6 valid Tokyo locations. Nano never sees Paris landmarks
  in a Tokyo tour.
- **Streaming partial executor.** As tokens arrive from `promptStreaming()`,
  a regex peels off complete `tour.goto(...)` calls and executes them
  immediately. Pins drop on the map *while* the model is still typing.
- **Cloudflare offices baked in.** Every supported city has its local
  Cloudflare office in the enum, so tours naturally end at "the Cloudflare
  Lisbon office".

## Browser requirements

- Chrome 138+ on a desktop OS (macOS 13+, Windows 10/11, Linux,
  Chromebook Plus).
- Gemini Nano downloaded on-device. Visit `chrome://on-device-internals`
  to verify; the model is downloaded automatically on first use.
- 22 GB free disk on the Chrome profile volume (per Chrome's docs).

If the API isn't available, the page shows a status banner explaining
why; nothing else breaks.

## Local development

```bash
pnpm install
pnpm dev               # http://localhost:4321 — Astro 6 + workerd
pnpm check             # astro check (TS errors)
pnpm build             # output to ./dist
pnpm preview           # local preview using workerd
```

Optional environment (in `.dev.vars` for local, `wrangler secret put` for
production):

```bash
# Origin Trial token for the Prompt API "sampling parameters" trial.
# Unlocks `temperature` and `topK` on the open web. Empty is fine.
OT_TOKEN=

# Optional MapTiler key for prettier vector tiles. Leave empty to fall
# back to the free `demotiles.maplibre.org` style.
MAPTILER_KEY=
```

Get an OT token at <https://developer.chrome.com/origintrials/> →
"Prompt API sampling parameters" → register your origin.

## Deploying to Cloudflare Workers

```bash
pnpm deploy
```

That runs `astro build && wrangler deploy`. The Astro adapter generates
the worker bundle at `dist/server/` and wires up the static assets at
`dist/client/`. The default worker name is `promptapi` — change it in
`wrangler.jsonc` before deploying.

## File map

```
src/
├── pages/
│   └── index.astro            ← page shell, OT meta tag, layout, styles
├── lib/
│   ├── locations.ts           ← static city + landmark dictionary
│   ├── prompt.ts              ← system-prompt builder (per-city enum)
│   ├── prompt-api.ts          ← Chrome LanguageModel wrapper
│   ├── tour-sdk.ts            ← Tour class + goto() primitive
│   ├── streaming-executor.ts  ← regex parser for partial tour.goto() calls
│   ├── map-renderer.ts        ← MapLibre TourRenderer impl
│   └── app.ts                 ← DOM glue + lifecycle
└── env.d.ts                   ← ambient types (cloudflare:workers, env)

wrangler.jsonc                 ← minimal: name + compat date + flags
astro.config.mjs               ← @astrojs/cloudflare adapter, output:server
```

## Adding a new city

1. Add a `City` entry to `CITIES` in `src/lib/locations.ts` with `center`
   and `zoom`.
2. Add 4–5 `Location` entries with hardcoded `coords` for the city's
   landmarks. Pick well-known ones — Nano's recall is best on famous
   places.
3. Add the local Cloudflare office (if any) with `cloudflare: true`.
4. The system prompt + map UI pick up the new city automatically.

## Why this is *not* another diagram demo

Code Mode patterns work for any output target. [`drawmode`](../drawmode)
emits Excalidraw, [`gomode`](../gomode) emits Go programs,
[`querymode`](../querymode) emits SQL. This demo emits **animated map
tours**. The same pattern, a different rendering target, with the
smallest possible LLM (Nano, on the user's device).

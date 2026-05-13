# HNDeck

TweetDeck for Hacker News, routed by Chrome's on-device Gemini Nano.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/hndeck)

## What It Is

- Define Hacker News columns in plain English.
- Raw columns use HN feeds like Top, New, Ask, Show, user submissions, or best stories this month.
- Raw/source columns can also have a local text filter.
- Custom columns use Gemini Nano in Chrome to route stories locally on your device.
- Stories can appear in multiple columns.
- Columns refresh independently and default to reloading every minute.
- Your routing instructions, layout, and customization stay in your browser.

## Why

Chrome may already have Gemini Nano on disk. HNDeck tries to make that useful: local AI reads small HN batches, applies your preferences, and presents the stories in columns you actually want to scan.

## Customization

HNDeck is intentionally editable from DevTools.

- Edit DOM or CSS directly in the browser.
- HNDeck saves a page snapshot to OPFS.
- On reload, it restores your snapshot, then rerenders app-owned regions like deck columns, column order, routing instructions, and live story cards.
- Reset with `await hnDeck.resetLayout()` or the Customize dialog's Reset layout button.

## Browser Requirements

- Chrome 138+ on desktop.
- Gemini Nano / Prompt API available in that Chrome profile.
- Enough free disk for Chrome's one-time on-device model download.
- If Nano is not available, HNDeck still shows raw HN columns and displays setup guidance.

Useful Chrome pages:

- `chrome://on-device-internals`
- `chrome://flags/#optimization-guide-on-device-model`
- `chrome://flags/#prompt-api-for-gemini-nano`
- `chrome://flags/#internal-debugging-page-urls` if internal debug URLs are hidden

## Local Development

```bash
pnpm install
pnpm dev      # http://localhost:4330
pnpm check
pnpm build
pnpm preview
```

## Deploy

Use the deploy button above, or deploy manually:

```bash
pnpm deploy
```

That runs `astro build && wrangler deploy`. The Worker name is `hndeck` in `wrangler.jsonc`.

## How Nano Routing Works

HNDeck does not `eval` model output.

1. The app fetches an HN story batch.
2. The prompt lists custom columns and candidate stories.
3. Nano emits small DSL calls like `deck.place("columnId", storyId)` or `deck.place("", storyId)` for no matching custom column.
4. The streaming executor parses those calls from text.
5. The SDK validates story IDs and column IDs.
6. Valid placements render story cards in matching columns.

Nano writes explicit placement decisions; the app validates and applies them. Empty-column decisions are accepted but do not render a card.

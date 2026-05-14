# HNDeck

TweetDeck-style Hacker News reader, built to experiment with Chrome's Prompt API.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/hndeck)

## What It Is

- Columns for Top, New, Ask, Show, Jobs, user submissions, best this month, and search.
- Custom columns scan all of HN and use Gemini Nano to filter each story against your instruction.
- Nano evaluates each story one at a time, on-device. No data is sent to any server.
- Your instructions, layout, and customization stay in your browser (OPFS).

## Why

This is a personal learning project for Chrome's Prompt API. Chrome may already have Gemini Nano on disk. This project turns that into something useful.

Nano is a small on-device model so the filtering is not perfect. I tried many other ideas for what to build with the Prompt API and this is the closest I got to something that kind of works. Hoping Chrome upgrades the on-device model over time, like [Prompt to Diagram](https://teamchong.github.io/turboquant-wasm/) which already works well with Gemini 2.5.

## Customization

HNDeck is intentionally editable from DevTools.

- Edit DOM or CSS directly in the browser.
- HNDeck saves a page snapshot to OPFS.
- On reload, it restores your snapshot, then rerenders app-owned regions like deck columns, column order, instructions, and live story cards.
- Reset with `await hnDeck.resetLayout()`, the Customize dialog's Reset layout button, or visit `?reset`.

## Browser Requirements

- Chrome 138+ on desktop.
- Gemini Nano / Prompt API available in that Chrome profile.
- Enough free disk for Chrome's one-time on-device model download.
- If Nano is not available, HNDeck still shows standard HN columns and displays setup guidance.

Useful Chrome pages:

- `chrome://on-device-internals`
- `chrome://flags/#optimization-guide-on-device-model`
- `chrome://flags/#prompt-api-for-gemini-nano`

## Local Development

```bash
pnpm install
pnpm dev      # http://localhost:4330
pnpm check
pnpm build
```

## Deploy

Use the deploy button above, or deploy manually:

```bash
pnpm build
npx wrangler deploy --config dist/server/wrangler.json
```

## How Filtering Works

1. Each column fetches stories from its source (Top, New, all HN, search, etc.).
2. If the column has a custom instruction, Nano evaluates each story individually.
3. The prompt is structured XML with escaped content to prevent injection.
4. Nano outputs YES or NO. Three attempts, then default reject.
5. Decisions are cached in OPFS so they survive reloads.
6. Nano runs entirely in the browser. No story data is sent to any server.

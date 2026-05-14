# HNDeck

TweetDeck-style Hacker News reader with on-device AI filtering via Chrome's Gemini Nano, personal learning project.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/hndeck)

## What It Is

- Define Hacker News columns in plain English.
- Standard columns pull from HN feeds: Top, New, Ask, Show, user submissions, best this month, or search.
- Custom columns scan all of HN and use Gemini Nano to filter each story against your instruction. On-device, private, free.
- Any column can have a custom instruction. Nano evaluates each story one at a time: keep or reject.
- Your instructions, layout, and customization never leave your browser.

## Why

Write a short instruction like "AI News" or "no AI" and Nano filters stories locally on your device. No server, no account, no tracking.

This is a personal learning project for Chrome's Prompt API. Chrome may already have Gemini Nano on disk. This project turns that into something useful.

Nano is a small on-device model so the filtering is not perfect. I tried many other ideas for what to build with the Prompt API and this is the closest I got to something that kind of works.

## Customization

HNDeck is intentionally editable from DevTools.

- Edit DOM or CSS directly in the browser.
- HNDeck saves a page snapshot to OPFS.
- On reload, it restores your snapshot, then rerenders app-owned regions like deck columns, column order, instructions, and live story cards.
- Reset with `await hnDeck.resetLayout()` or the Customize dialog's Reset layout button.

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
pnpm preview
```

## Deploy

Use the deploy button above, or deploy manually:

```bash
pnpm deploy
```

That runs `astro build && wrangler deploy`. The Worker name is `hndeck` in `wrangler.jsonc`.

## How Filtering Works

1. Each column fetches stories from its source (Top, New, all HN, search, etc.).
2. If the column has a custom instruction, Nano evaluates each story individually.
3. The prompt is structured XML with escaped content to prevent injection.
4. Nano outputs YES or NO. Three attempts, then default reject.
5. Decisions are cached in memory: same column + same instruction + same story = reuse.
6. No story data is sent to any server. Nano runs entirely in the browser.

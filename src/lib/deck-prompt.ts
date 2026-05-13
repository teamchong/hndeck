/** Prompt builder for Nano's deck-routing pass. */

import type { Column } from "./deck";
import type { HNFeedItem } from "./hn-client";
import { hostOf, stripHtml } from "./hn-client";

export interface DeckPromptOptions {
  routingInstructions: string;
  columns: Column[];
  stories: HNFeedItem[];
  batchStart: number;
}

export interface SourceFilterPromptOptions {
  column: Column;
  stories: HNFeedItem[];
  batchStart: number;
}

export function buildDeckSystemPrompt(opts: DeckPromptOptions): string {
  const curated = opts.columns.filter((c) => c.kind === "curated");
  const instructions = opts.routingInstructions.trim()
    ? opts.routingInstructions.trim()
    : "No explicit routing instructions. Assume a technical HN reader; prefer useful details and avoid low-signal drama.";

  return [
    "You are a private news editor. You route Hacker News stories into the reader's columns.",
    "Output ONLY deck.* function calls, one per line. No markdown. No prose.",
    "",
    "SDK:",
    "  deck.place(\"columnId\", storyId)",
    "  deck.place(\"\", storyId) // story belongs in no custom column",
    "",
    "Rules:",
    "  - Use only listed column ids, story ids, or the empty column id \"\" for no custom column.",
    "  - Only emit deck.place calls. Do not emit explanations, markdown, JSON, notes, drops, or clusters.",
    "  - Emit an explicit decision for EVERY story in the batch.",
    "  - If a story matches no custom column, emit exactly deck.place(\"\", storyId).",
    "  - A story may belong to MULTIPLE columns. If it fits AI and Tools, place it in both.",
    "  - If a story fits one or more columns, do not also emit deck.place(\"\", storyId).",
    "  - Do not repeat the same story twice inside one column.",
    "  - Emit calls in priority order within each column: most important first.",
    "  - Place useful stories generously. Do not output only 1-2 stories; a deck needs a backlog.",
    "  - Aim to route most useful stories in the batch.",
    "  - If a column is plausible for a story, place it there.",
    "  - Try to use every curated column that has a plausible match in this batch.",
    "  - Do not rewrite headlines or explain why a story was placed.",
    "  - If a story matches no column at all, mark it with the empty column id. Do not force-fit pure junk.",
    "  - If the same story fits multiple columns, place it in every useful column.",
    "  - Raw/front-page columns are not listed because they are filled without you.",
    "",
    "ROUTING INSTRUCTIONS:",
    instructions,
    "",
    "CURATED COLUMNS:",
    ...curated.map((c) => `  ${c.id}: ${c.title} — ${c.description ?? "No description"}`),
    "",
    `STORIES BATCH starting at index ${opts.batchStart}:`,
    ...opts.stories.map(formatStory),
    "",
    "Now route this batch. Output only deck.* function calls.",
  ].join("\n");
}

export function buildSourceFilterSystemPrompt(opts: SourceFilterPromptOptions): string {
  const predicate = opts.column.description?.trim() || "Show all stories.";
  return [
    "You are a strict private news filter. You decide which Hacker News source stories match ONE column predicate.",
    "Output ONLY deck.* function calls, one per line. No markdown. No prose.",
    "",
    "SDK:",
    `  deck.place("${opts.column.id}", storyId) // story matches the predicate`,
    "  deck.place(\"\", storyId) // story does NOT match the predicate",
    "",
    "Rules:",
    `  - The only non-empty column id you may use is ${JSON.stringify(opts.column.id)}.`,
    "  - Emit exactly one decision for EVERY story in the batch.",
    "  - Be strict. Do not fill for backlog. It is normal for most source stories not to match.",
    "  - Place a story only when the title/domain/text clearly satisfies the predicate.",
    "  - If the predicate is a keyword or phrase, require that exact concept to appear in the title, domain, URL, author, or text.",
    "  - When uncertain, use deck.place(\"\", storyId).",
    "  - Do not explain why a story was placed.",
    "",
    `COLUMN: ${opts.column.title}`,
    "PREDICATE:",
    predicate,
    "",
    `SOURCE STORIES BATCH starting at index ${opts.batchStart}:`,
    ...opts.stories.map(formatStory),
    "",
    "Now filter this source batch. Output only deck.* function calls.",
  ].join("\n");
}

export function buildDeckUserPrompt(retry = false): string {
  return retry
    ? "Retry. Your previous response produced no valid decisions. Output one or more lines per story like deck.place(\"columnId\", 123), or deck.place(\"\", 123) for no column."
    : "Route the stories now.";
}

export function buildSourceFilterUserPrompt(retry = false): string {
  return retry
    ? "Retry. Output exactly one deck.place call per story: non-empty column id only for clear matches, empty column id for non-matches."
    : "Filter the source stories now.";
}

function formatStory(s: HNFeedItem): string {
  if (s.type === "comment") {
    return `  ${s.id} [news.ycombinator.com] Comment by ${s.by} :: ${stripHtml(s.text).slice(0, 160)}`;
  }
  const text = s.text ? ` :: ${stripHtml(s.text).slice(0, 120)}` : "";
  return `  ${s.id} [${hostOf(s.url)}] ${s.title} (${s.score} pts, ${s.descendants ?? 0} comments)${text}`;
}

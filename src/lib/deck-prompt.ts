/** Prompt builder for Nano's deck-routing pass. */

import type { Column } from "./deck";
import type { HNStory } from "./hn-client";
import { hostOf, stripHtml } from "./hn-client";

export interface DeckPromptOptions {
  routingInstructions: string;
  columns: Column[];
  stories: HNStory[];
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

export function buildDeckUserPrompt(retry = false): string {
  return retry
    ? "Retry. Your previous response produced no valid decisions. Output one or more lines per story like deck.place(\"columnId\", 123), or deck.place(\"\", 123) for no column."
    : "Route the stories now.";
}

function formatStory(s: HNStory): string {
  const text = s.text ? ` :: ${stripHtml(s.text).slice(0, 120)}` : "";
  return `  ${s.id} [${hostOf(s.url)}] ${s.title} (${s.score} pts, ${s.descendants ?? 0} comments)${text}`;
}

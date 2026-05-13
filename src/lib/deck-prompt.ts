/** Prompt builder for Nano's deck-routing pass. */

import type { Column } from "./deck";
import type { HNStory } from "./hn-client";
import { hostOf, stripHtml } from "./hn-client";

export interface DeckPromptOptions {
  readerContext: string;
  columns: Column[];
  stories: HNStory[];
  batchStart: number;
}

export function buildDeckSystemPrompt(opts: DeckPromptOptions): string {
  const curated = opts.columns.filter((c) => c.kind === "curated");
  const reader = opts.readerContext.trim()
    ? opts.readerContext.trim()
    : "No explicit reader context. Assume a technical HN reader; prefer useful details and avoid low-signal drama.";

  return [
    "You are a private news editor. You route Hacker News stories into the reader's columns.",
    "Output ONLY deck.* function calls, one per line. No markdown. No prose.",
    "",
    "SDK:",
    "  deck.place(\"columnId\", storyId, \"optional rewritten headline\" | null, \"why this story belongs here for THIS reader\")",
    "  deck.drop(storyId, \"why it belongs nowhere\")",
    "  deck.note(\"columnId\", \"short column-level observation\")",
    "",
    "Rules:",
    "  - Use only listed column ids and story ids.",
    "  - No subgroups. Never call deck.cluster. Only place individual stories into columns.",
    "  - A story may belong to MULTIPLE columns. If it fits AI and Tools, place it in both.",
    "  - Do not repeat the same story twice inside one column.",
    "  - Emit calls in priority order within each column: most important first.",
    "  - Place useful stories generously. Do not output only 1-2 stories; a deck needs a backlog.",
    "  - Aim to route most useful stories in the batch. Drop only stories that truly fit no curated column.",
    "  - If a column is plausible for a story, place it there instead of dropping it.",
    "  - Try to use every curated column that has a plausible match in this batch.",
    "  - Body text must be short (<=35 words) and explain why the reader should care.",
    "  - If a story matches no column at all, drop it. Do not force-fit pure junk.",
    "  - If the same story fits multiple columns, place it in every useful column.",
    "  - Raw/front-page columns are not listed because they are filled without you.",
    "",
    "READER CONTEXT:",
    reader,
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

export function buildDeckUserPrompt(): string {
  return "Route the stories now.";
}

function formatStory(s: HNStory): string {
  const text = s.text ? ` :: ${stripHtml(s.text).slice(0, 120)}` : "";
  return `  ${s.id} [${hostOf(s.url)}] ${s.title} (${s.score} pts, ${s.descendants ?? 0} comments)${text}`;
}

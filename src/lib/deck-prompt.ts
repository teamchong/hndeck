/** Prompt builder for Nano's one-story source filter. */

import type { Column } from "./deck";
import type { HNStory } from "./hn-client";
import { stripHtml } from "./hn-client";

export interface SourceFilterPromptOptions {
  column: Column;
  story: HNStory;
  globalInstruction?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSourceFilterSystemPrompt(opts: SourceFilterPromptOptions): string {
  const instruction = opts.column.instruction?.trim() || "Show all stories.";
  const global = opts.globalInstruction?.trim();
  const s = opts.story;

  const aParts: string[] = [`  <title>${esc(s.title)}</title>`];
  if (s.url) aParts.push(`  <url>${esc(s.url)}</url>`);
  if (s.text) aParts.push(`  <body>${esc(stripHtml(s.text).slice(0, 200))}</body>`);

  return [
    "<A>",
    ...aParts,
    "</A>",
    "",
    "<B>",
    `  ${esc(instruction)}`,
    ...(global ? [`  <global>${esc(global)}</global>`] : []),
    "</B>",
    "",
    "Based on B, should A be included? One word: YES or NO.",
  ].join("\n");
}

export function buildSourceFilterUserPrompt(retry = false): string {
  return retry ? "YES or NO?" : "YES or NO?";
}

/** Prompt builder for Nano's one-story source filter. */

import type { Column } from "./deck";
import type { HNFeedItem } from "./hn-client";
import { stripHtml } from "./hn-client";

export interface SourceFilterPromptOptions {
  column: Column;
  item: HNFeedItem;
  globalInstruction?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSourceFilterSystemPrompt(opts: SourceFilterPromptOptions): string {
  const instruction = opts.column.instruction?.trim() || "Show all stories.";
  const global = opts.globalInstruction?.trim();
  const item = opts.item;

  const aParts: string[] = [];
  if (item.type !== "comment") aParts.push(`  <type>${item.type}</type>`);
  if ("title" in item && item.title) aParts.push(`  <title>${esc(item.title)}</title>`);
  if ("url" in item && item.url) aParts.push(`  <url>${esc(item.url)}</url>`);
  if ("text" in item && item.text) aParts.push(`  <body>${esc(stripHtml(item.text).slice(0, 200))}</body>`);

  return [
    "<example>",
    "<A><title>Show HN: GPT-5 benchmark results</title></A>",
    "<B>AI News</B>",
    "YES",
    "</example>",
    "<example>",
    "<A><title>Company lays off 500 employees</title></A>",
    "<B>AI News</B>",
    "NO",
    "</example>",
    "",
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

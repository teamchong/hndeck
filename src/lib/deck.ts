/**
 * Deck data model.
 *
 * Each column has a `source` that says where stories come from
 * (top / new / ask / show / user / best-month / search / custom).
 *
 * Any column can carry an optional `instruction` — a plain-English
 * Nano filter applied one story at a time (T / F).  For "custom"
 * columns the instruction is required; for everything else it's
 * an optional additional filter on the feed.
 *
 * Persistence is handled by deck-app.ts via OPFS.  This module is
 * pure data model + validation + immutable mutators.
 */

export type ColumnSource =
  | "top"
  | "new"
  | "ask"
  | "show"
  | "user"
  | "best-month"
  | "search"
  | "custom";

/** One column in the deck. */
export interface Column {
  /** Stable id used for DOM ids, persisted state, and filter cache. */
  id: string;
  /** Header label. */
  title: string;
  /** Where stories come from. */
  source: ColumnSource;
  /** HN username (source === "user"). */
  feedUser?: string;
  /** YYYY-MM (source === "best-month", empty = current month). */
  feedMonth?: string;
  /** Search query (source === "search"). */
  feedQuery?: string;
  /** Per-column auto-refresh. */
  autoReloadEnabled?: boolean;
  autoReloadMs?: number;
  /** Nano filter instruction. Each story is evaluated individually. */
  instruction?: string;
}

export interface Deck {
  columns: Column[];
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_DECK: Deck = {
  columns: [
    { id: "top", title: "Top", source: "top" },
    { id: "new", title: "New", source: "new" },
    { id: "ask", title: "Ask", source: "ask" },
    { id: "show", title: "Show", source: "show" },
    {
      id: "for-you",
      title: "AI News",
      source: "custom",
      instruction: "Artificial intelligence, machine learning, LLMs, GPT, Claude, Gemini, neural networks, AI research, AI products, AI startups.",
    },
  ],
};

const MAX_COLUMNS = 20;
const MAX_TITLE_LEN = 120;
const MAX_INSTRUCTION_LEN = 600;
const VALID_SOURCES = new Set<string>([
  "top", "new", "ask", "show", "user", "best-month", "search", "custom",
]);

// ─── Validation ──────────────────────────────────────────────────────

function isColumn(x: unknown): x is Column {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0 || c.id.length > 64) return false;
  if (typeof c.title !== "string" || c.title.length === 0 || c.title.length > MAX_TITLE_LEN) return false;
  if (!VALID_SOURCES.has(c.source as string)) return false;
  if (c.feedUser !== undefined && typeof c.feedUser !== "string") return false;
  if (c.feedMonth !== undefined && typeof c.feedMonth !== "string") return false;
  if (c.feedQuery !== undefined && typeof c.feedQuery !== "string") return false;
  if (c.autoReloadEnabled !== undefined && typeof c.autoReloadEnabled !== "boolean") return false;
  if (c.autoReloadMs !== undefined && typeof c.autoReloadMs !== "number") return false;
  if (c.instruction !== undefined) {
    if (typeof c.instruction !== "string" || c.instruction.length > MAX_INSTRUCTION_LEN) return false;
  }
  return true;
}

export function isDeck(x: unknown): x is Deck {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  if (!Array.isArray(d.columns)) return false;
  if (d.columns.length > MAX_COLUMNS) return false;
  return d.columns.every(isColumn);
}

export function defaultDeck(): Deck {
  return { columns: DEFAULT_DECK.columns.map((c) => ({ ...c })) };
}

export function coerceDeck(x: unknown): Deck {
  return isDeck(x) ? { columns: (x as Deck).columns.map((c) => ({ ...c })) } : defaultDeck();
}

// ─── Mutators ────────────────────────────────────────────────────────

export function newColumnId(): string {
  return `col-${Math.random().toString(36).slice(2, 10)}`;
}

export function addColumn(deck: Deck, col: Column): Deck {
  return { columns: [...deck.columns, col] };
}

export function removeColumn(deck: Deck, id: string): Deck {
  return { columns: deck.columns.filter((c) => c.id !== id) };
}

export function updateColumn(
  deck: Deck,
  id: string,
  patch: Partial<Omit<Column, "id">>,
): Deck {
  return {
    columns: deck.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

export function moveColumn(deck: Deck, id: string, direction: -1 | 1): Deck {
  const idx = deck.columns.findIndex((c) => c.id === id);
  if (idx < 0) return deck;
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= deck.columns.length) return deck;
  const columns = deck.columns.map((c) => ({ ...c }));
  const [col] = columns.splice(idx, 1);
  columns.splice(nextIdx, 0, col);
  return { columns };
}

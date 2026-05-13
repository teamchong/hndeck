/**
 * Deck of editor columns — TweetDeck-style layout.
 *
 * Two column kinds:
 *
 *   "raw"      — Hacker News top-story feed verbatim, paginated by
 *                 infinite scroll. No on-device model is invoked for
 *                 this column; instant, always available, the
 *                 fallback view when Nano is unsupported.
 *
 *   "curated"  — populated by Nano's single routing pass.
 *
 * Routing model: one Nano session per batch. Nano receives the
 * routing instructions, every curated column's `description`, and the
 * current batch of stories. It emits positive placement ops only.
 * Any story not placed in a curated column is ignored.
 *
 * The `description` is therefore not a literal prompt — it's the
 * job description Nano uses when deciding what belongs here.
 *
 * Persistence is handled by deck-app.ts via OPFS. This module is pure
 * data model + validation + immutable mutators.
 */

export type ColumnKind = "raw" | "curated";

/** One column in the deck. */
export interface Column {
  /** Stable per-column id used for DOM ids, persisted state, observers,
   *  and routing references (Nano emits this id when placing a story). */
  id: string;
  /** Header label shown above the column. */
  title: string;
  kind: ColumnKind;
  /** Raw HN feed for kind === "raw". */
  feed?: "top" | "new" | "ask" | "show" | "user" | "best-month";
  /** HN username for feed === "user". */
  feedUser?: string;
  /** Month in YYYY-MM for feed === "best-month". Empty = current month. */
  feedMonth?: string;
  /** Per-column auto-refresh. Defaults to enabled every 1 minute. */
  autoReloadEnabled?: boolean;
  autoReloadMs?: number;
  /**
   * Optional Nano prompt/predicate. For curated columns this defines the
   * column. For raw/source columns this filters that source before render.
   */
  description?: string;
}

export interface Deck {
  columns: Column[];
}

// ─── Defaults ────────────────────────────────────────────────────────

/**
 * Default deck: HN-native views plus one simple prompt-routed column.
 */
export const DEFAULT_DECK: Deck = {
  columns: [
    {
      id: "top",
      title: "Top",
      kind: "raw",
      feed: "top",
    },
    {
      id: "new",
      title: "New",
      kind: "raw",
      feed: "new",
    },
    {
      id: "ask",
      title: "Ask",
      kind: "raw",
      feed: "ask",
    },
    {
      id: "show",
      title: "Show",
      kind: "raw",
      feed: "show",
    },
    {
      id: "for-you",
      title: "Engineer bait",
      kind: "curated",
      description:
        "Deep technical posts a working software engineer would stop scrolling for: " +
        "debugging stories, infrastructure details, databases, compilers, browsers, " +
        "performance, reliability, and practical tools. Skip generic AI takes, funding, " +
        "hiring, politics, and drama.",
    },
  ],
};

const MAX_COLUMNS = 20;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 600;

function isColumn(x: unknown): x is Column {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0 || c.id.length > 64) return false;
  if (typeof c.title !== "string" || c.title.length === 0 || c.title.length > MAX_TITLE_LEN) {
    return false;
  }
  if (c.kind !== "raw" && c.kind !== "curated") return false;
  if (c.feed !== undefined && c.feed !== "top" && c.feed !== "new" && c.feed !== "ask" && c.feed !== "show" && c.feed !== "user" && c.feed !== "best-month") {
    return false;
  }
  if (c.feedUser !== undefined && typeof c.feedUser !== "string") return false;
  if (c.feedMonth !== undefined && typeof c.feedMonth !== "string") return false;
  if (c.autoReloadEnabled !== undefined && typeof c.autoReloadEnabled !== "boolean") return false;
  if (c.autoReloadMs !== undefined && typeof c.autoReloadMs !== "number") return false;
  if (c.description !== undefined) {
    if (typeof c.description !== "string" || c.description.length > MAX_DESCRIPTION_LEN) return false;
  }
  return true;
}

export function isDeck(x: unknown): x is Deck {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  if (!Array.isArray(d.columns)) return false;
  if (d.columns.length === 0 || d.columns.length > MAX_COLUMNS) return false;
  return d.columns.every(isColumn);
}

export function defaultDeck(): Deck {
  return cloneDeck(DEFAULT_DECK);
}

export function coerceDeck(x: unknown): Deck {
  return isDeck(x) ? normalizeDeck(migrateDeck(x)) : defaultDeck();
}

// ─── Mutators ────────────────────────────────────────────────────────

/**
 * Generate a column id that's unique within the deck. Random suffix
 * so a column can be added, removed, and re-added without colliding
 * with the previous incarnation in persisted DOM-id space.
 */
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

// ─── Helpers ─────────────────────────────────────────────────────────

function cloneDeck(d: Deck): Deck {
  return { columns: d.columns.map((c) => ({ ...c })) };
}

function normalizeDeck(d: Deck): Deck {
  const hasAnyRaw = d.columns.some((c) => c.kind === "raw");
  if (hasAnyRaw) return d;

  // Some intermediate builds persisted only empty custom columns.
  // Recover by restoring the HN base columns, then append the user's
  // custom columns after them.
  const baseRaw = DEFAULT_DECK.columns.filter((c) => c.kind === "raw");
  return { columns: [...baseRaw.map((c) => ({ ...c })), ...d.columns] };
}

function migrateDeck(d: Deck): Deck {
  const ids = d.columns.map((c) => c.id).join(",");
  if (
    ids === "raw,tools,research,startup,ai,showask" ||
    ids === "top,new,ask,show,past" ||
    ids === "top,new,ask,show"
  ) {
    return cloneDeck(DEFAULT_DECK);
  }
  return {
    columns: d.columns.map((c) => {
      if (c.id === "for-you") {
        return {
          ...c,
          title: "Engineer bait",
          description:
            "Deep technical posts a working software engineer would stop scrolling for: " +
            "debugging stories, infrastructure details, databases, compilers, browsers, " +
            "performance, reliability, and practical tools. Skip generic AI takes, funding, " +
            "hiring, politics, and drama.",
        };
      }
      if (c.id !== "showask") return c;
      // Earlier default was too narrow and often looked empty. Broaden
      // it so existing users get the improved default without needing
      // to wipe persisted state.
      return {
        ...c,
        title: "Community & projects",
        description:
          "Show HN projects, Ask HN discussions, personal projects, " +
          "launches, experiments, demos, and community threads. The " +
          "'what is this community building or wondering about' bucket.",
      };
    }),
  };
}

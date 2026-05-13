/**
 * Deck routing SDK — the calls Nano emits to populate TweetDeck-style
 * columns.
 *
 * Nano sees: reader context + curated column descriptions + one batch
 * of HN stories. It then decides which story belongs in which column,
 * what to drop, and what to cluster. Emission order inside a column is
 * the priority order.
 */

export interface PlaceAction {
  kind: "place";
  columnId: string;
  storyId: number;
  headline?: string;
  body: string;
}

export interface DropAction {
  kind: "drop";
  storyId: number;
  reason: string;
}

export interface ClusterAction {
  kind: "cluster";
  columnId: string;
  storyIds: number[];
  title: string;
  body: string;
}

export interface NoteAction {
  kind: "note";
  columnId: string;
  text: string;
}

export type DeckAction = PlaceAction | DropAction | ClusterAction | NoteAction;

export interface DeckSink {
  enqueue(action: DeckAction): void;
  onSkip(reason: string): void;
}

const MAX_TEXT = 360;
const MAX_HEADLINE = 140;
const MAX_REASON = 180;

/** Validates model-emitted routing calls for one batch. */
export class DeckRouter {
  private readonly columns: Set<string>;
  private readonly storyIds: Set<number>;
  /** Duplicate guard is per column. A story may belong to multiple
   *  curated columns; it just should not repeat inside one column. */
  private readonly placedPairs = new Set<string>();

  constructor(
    columns: ReadonlyArray<string>,
    storyIds: ReadonlyArray<number>,
    private readonly sink: DeckSink,
  ) {
    this.columns = new Set(columns);
    this.storyIds = new Set(storyIds);
  }

  place(columnId: string, storyId: number, headline: string | null | undefined, body: string): void {
    if (!this.columns.has(columnId)) {
      this.sink.onSkip(`place() unknown column: ${columnId}`);
      return;
    }
    if (!this.storyIds.has(storyId)) {
      this.sink.onSkip(`place() unknown story id: ${storyId}`);
      return;
    }
    const key = `${columnId}:${storyId}`;
    if (this.placedPairs.has(key)) {
      this.sink.onSkip(`place() duplicate story ${storyId} in column ${columnId}`);
      return;
    }
    const b = clean(body, MAX_TEXT);
    if (!b) throw new Error("place() requires non-empty body.");
    const h = headline ? clean(headline, MAX_HEADLINE) : undefined;
    this.placedPairs.add(key);
    this.sink.enqueue({ kind: "place", columnId, storyId, headline: h || undefined, body: b });
  }

  drop(storyId: number, reason: string): void {
    if (!this.storyIds.has(storyId)) return;
    const r = clean(reason, MAX_REASON);
    if (!r) throw new Error("drop() requires non-empty reason.");
    this.sink.enqueue({ kind: "drop", storyId, reason: r });
  }

  cluster(columnId: string, storyIds: number[], title: string, body: string): void {
    if (!this.columns.has(columnId)) {
      this.sink.onSkip(`cluster() unknown column: ${columnId}`);
      return;
    }
    const ids = storyIds.filter((id) =>
      this.storyIds.has(id) && !this.placedPairs.has(`${columnId}:${id}`),
    );
    if (ids.length < 2) {
      this.sink.onSkip("cluster() rejected: fewer than 2 valid unused ids.");
      return;
    }
    const t = clean(title, MAX_HEADLINE);
    const b = clean(body, MAX_TEXT);
    if (!t || !b) throw new Error("cluster() requires title and body.");
    for (const id of ids) this.placedPairs.add(`${columnId}:${id}`);
    this.sink.enqueue({ kind: "cluster", columnId, storyIds: ids, title: t, body: b });
  }

  note(columnId: string, text: string): void {
    if (!this.columns.has(columnId)) return;
    const t = clean(text, MAX_TEXT);
    if (!t) return;
    this.sink.enqueue({ kind: "note", columnId, text: t });
  }

  skip(reason: string): void {
    this.sink.onSkip(reason);
  }
}

function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/**
 * Deck routing SDK — the calls Nano emits to populate TweetDeck-style
 * columns.
 *
 * Nano sees: routing instructions + curated column descriptions + one
 * batch of HN stories. It emits explicit placement decisions. An empty
 * column id means the story belongs in no curated column.
 */

export interface PlaceAction {
  kind: "place";
  columnId: string;
  storyId: number;
}

export type DeckAction = PlaceAction;

export interface DeckSink {
  enqueue(action: DeckAction): void;
  onSkip(reason: string): void;
}

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

  place(columnId: string, storyId: number): void {
    if (columnId !== "" && !this.columns.has(columnId)) {
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
    this.placedPairs.add(key);
    this.sink.enqueue({ kind: "place", columnId, storyId });
  }

  skip(reason: string): void {
    this.sink.onSkip(reason);
  }
}

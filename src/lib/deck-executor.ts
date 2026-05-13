/** Streaming regex executor for the deck routing SDK. */

import type { DeckRouter } from "./deck-sdk";

const RX_PLACE = /deck\s*\.\s*place\s*\(\s*(['"`])([^'"`]*)\1\s*,\s*(\d+)\s*\)\s*;?/g;

interface NextCall {
  index: number;
  end: number;
  apply: () => void;
}

function findNext(buffer: string, cursor: number, router: DeckRouter): NextCall | null {
  RX_PLACE.lastIndex = cursor;
  const m = RX_PLACE.exec(buffer);
  if (!m) return null;
  return {
    index: m.index,
    end: m.index + m[0].length,
    apply: () => router.place(m[2], Number.parseInt(m[3], 10)),
  };
}

export interface DeckExecutor {
  push(chunk: string): void;
  end(): void;
  readonly buffer: string;
}

export function createDeckExecutor(router: DeckRouter): DeckExecutor {
  let buffer = "";
  let cursor = 0;
  let done = false;

  const consume = (): void => {
    let next: NextCall | null;
    while ((next = findNext(buffer, cursor, router)) !== null) {
      try {
        next.apply();
      } catch (err) {
        router.skip(err instanceof Error ? err.message : String(err));
      }
      cursor = next.end;
    }
  };

  return {
    push(chunk) {
      if (done) return;
      buffer += chunk;
      consume();
    },
    end() {
      if (done) return;
      consume();
      done = true;
    },
    get buffer() {
      return buffer;
    },
  };
}

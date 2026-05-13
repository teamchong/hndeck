/** Streaming regex executor for the deck routing SDK. */

import type { DeckRouter } from "./deck-sdk";

const STR = (qref: number): string => `(?:\\\\.|(?!\\${qref})[\\s\\S])*?`;

const RX_PLACE = new RegExp(
  `deck\\s*\\.\\s*place\\s*\\(` +
    `\\s*(['"\`])([^'"\`]+?)\\1` +
    `\\s*,\\s*(\\d+)` +
    `\\s*,\\s*(?:(null)|(['"\`])(${STR(5)})\\5)` +
    `\\s*,\\s*(['"\`])(${STR(7)})\\7` +
    `\\s*\\)\\s*;?`,
  "g",
);

const RX_DROP = new RegExp(
  `deck\\s*\\.\\s*drop\\s*\\(` +
    `\\s*(\\d+)` +
    `\\s*,\\s*(['"\`])(${STR(2)})\\2` +
    `\\s*\\)\\s*;?`,
  "g",
);

const RX_CLUSTER = new RegExp(
  `deck\\s*\\.\\s*cluster\\s*\\(` +
    `\\s*(['"\`])([^'"\`]+?)\\1` +
    `\\s*,\\s*\\[([^\\]]*)\\]` +
    `\\s*,\\s*(['"\`])(${STR(4)})\\4` +
    `\\s*,\\s*(['"\`])(${STR(6)})\\6` +
    `\\s*\\)\\s*;?`,
  "g",
);

const RX_NOTE = new RegExp(
  `deck\\s*\\.\\s*note\\s*\\(` +
    `\\s*(['"\`])([^'"\`]+?)\\1` +
    `\\s*,\\s*(['"\`])(${STR(3)})\\3` +
    `\\s*\\)\\s*;?`,
  "g",
);

function decodeEscapes(s: string): string {
  return s.replace(/\\([\\`'"])/g, "$1");
}

function parseIntArray(body: string): number[] {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number.parseInt(s, 10));
}

interface NextCall {
  index: number;
  end: number;
  apply: () => void;
}

function findNext(buffer: string, cursor: number, router: DeckRouter): NextCall | null {
  const candidates: NextCall[] = [];
  const tryRx = (rx: RegExp, build: (m: RegExpExecArray) => () => void): void => {
    rx.lastIndex = cursor;
    const m = rx.exec(buffer);
    if (m) candidates.push({ index: m.index, end: m.index + m[0].length, apply: build(m) });
  };

  tryRx(RX_PLACE, (m) => () => {
    const col = m[2];
    const id = Number.parseInt(m[3], 10);
    const headline = m[4] === "null" ? null : decodeEscapes(m[6]);
    const body = decodeEscapes(m[8]);
    router.place(col, id, headline, body);
  });
  tryRx(RX_DROP, (m) => () => router.drop(Number.parseInt(m[1], 10), decodeEscapes(m[3])));
  tryRx(RX_CLUSTER, (m) => () => {
    router.cluster(m[2], parseIntArray(m[3]), decodeEscapes(m[5]), decodeEscapes(m[7]));
  });
  tryRx(RX_NOTE, (m) => () => router.note(m[2], decodeEscapes(m[4])));

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
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

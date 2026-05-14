/**
 * Thin wrapper over Chrome's built-in `LanguageModel` (Prompt API).
 *
 * Responsibilities:
 *   - Detect availability and surface user-friendly status.
 *   - Trigger model download with progress reporting on first run.
 *   - Create sessions with the OT-gated sampling parameters when
 *     the origin trial token unlocks them.
 *   - Stream prompts and yield chunks.
 *
 * The OT token (sampling parameters) is wired in <head> via meta tag,
 * not here. By the time this runs, Chrome has already accepted or
 * rejected it. We just attempt to set temperature/topK and silently
 * fall back if the API rejects them.
 */

/** Status the UI uses to decide what to show. */
export type ModelStatus =
  | { kind: "unsupported"; reason: string }
  | { kind: "downloading"; progress: number }
  | { kind: "downloadable" }
  | { kind: "available" };

/**
 * Check if Chrome's Prompt API is exposed at all.
 */
function isLanguageModelDefined(): boolean {
  return typeof globalThis !== "undefined" && "LanguageModel" in globalThis;
}

/**
 * Ask Chrome whether the model is ready, downloadable, or unsupported.
 * Pass the same options you'll later pass to `create()`. The docs
 * stress this is critical for accurate availability reporting.
 */
export async function checkAvailability(): Promise<ModelStatus> {
  if (!isLanguageModelDefined()) {
    return {
      kind: "unsupported",
      reason:
        "window.LanguageModel is not available. You need Chrome 138+ on a desktop OS, with the Prompt API model enabled. Visit chrome://on-device-internals to confirm Gemini Nano is downloaded.",
    };
  }

  // Cast: TS lib types lag behind Chrome stable.
  const LM = (globalThis as unknown as { LanguageModel: ChromeLanguageModel }).LanguageModel;

  try {
    const availability = await LM.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });

    switch (availability) {
      case "available":      return { kind: "available" };
      case "downloadable":   return { kind: "downloadable" };
      case "downloading":    return { kind: "downloading", progress: 0 };
      case "unavailable":
      default:
        return {
          kind: "unsupported",
          reason:
            "The on-device model is not available on this device. Check chrome://on-device-internals for hardware/storage requirements.",
        };
    }
  } catch (err) {
    return {
      kind: "unsupported",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a session with optional sampling parameters. If the OT token
 * is missing/invalid, Chrome will reject `temperature`/`topK`. We
 * detect that and retry without them.
 *
 * @param onProgress fires during model download (0..1)
 */
export async function createSession(
  systemPrompt: string,
  onProgress?: (frac: number) => void,
): Promise<ChromeLanguageModelSession> {
  if (!isLanguageModelDefined()) {
    throw new Error("LanguageModel is not defined.");
  }
  const LM = (globalThis as unknown as { LanguageModel: ChromeLanguageModel }).LanguageModel;

  const baseOptions: ChromeLanguageModelCreateOptions = {
    initialPrompts: [{ role: "system", content: systemPrompt }],
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor(m) {
      m.addEventListener("downloadprogress", (e: Event) => {
        const ev = e as { loaded?: number };
        if (typeof ev.loaded === "number") onProgress?.(ev.loaded);
      });
    },
  };

  // Try with sampling parameters first (requires OT token or extension context).
  try {
    return await LM.create({
      ...baseOptions,
      temperature: 0,
      topK: 1,
    });
  } catch (err) {
    // Sampling parameters likely rejected. Retry without.
    if (err instanceof Error && /temperature|topK|sampling/i.test(err.message)) {
      return await LM.create(baseOptions);
    }
    throw err;
  }
}

/**
 * Stream the model's response to a user prompt. Yields chunks as
 * strings. Each chunk is whatever the model produced since the last
 * yield, not necessarily a token-aligned slice.
 */
export async function* streamPrompt(
  session: ChromeLanguageModelSession,
  userPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const stream = session.promptStreaming(userPrompt, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    yield chunk;
  }
}

// ─── Type shims ──────────────────────────────────────────────────────
// `@types/dom-chromium-ai` exists but its versioning lags behind stable.
// Define the shape we touch ourselves so we don't fight library updates.

interface ChromeLanguageModel {
  availability(opts: ChromeLanguageModelOptions): Promise<
    "available" | "downloadable" | "downloading" | "unavailable"
  >;
  create(opts: ChromeLanguageModelCreateOptions): Promise<ChromeLanguageModelSession>;
}

interface ChromeLanguageModelOptions {
  expectedInputs?: { type: "text" | "image" | "audio"; languages?: string[] }[];
  expectedOutputs?: { type: "text"; languages?: string[] }[];
}

interface ChromeLanguageModelCreateOptions extends ChromeLanguageModelOptions {
  initialPrompts?: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}

interface ChromeLanguageModelSession {
  prompt(input: string, opts?: { signal?: AbortSignal }): Promise<string>;
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): AsyncIterable<string>;
  destroy(): void;
  readonly contextUsage: number;
  readonly contextWindow: number;
}

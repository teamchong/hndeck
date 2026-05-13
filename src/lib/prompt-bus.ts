import { createSession, streamPrompt } from "./prompt-api";

export interface PromptBusJob {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly onChunk: (chunk: string) => void;
}

export interface PromptBus {
  run(job: PromptBusJob): Promise<void>;
  readonly pending: number;
  readonly active: boolean;
}

export function createPromptBus(): PromptBus {
  let tail = Promise.resolve();
  let pending = 0;
  let active = false;

  return {
    run(job) {
      pending++;
      const run = tail.then(async () => {
        pending--;
        active = true;
        const session = await createSession(job.systemPrompt);
        try {
          for await (const chunk of streamPrompt(session, job.userPrompt)) job.onChunk(chunk);
        } finally {
          active = false;
          session.destroy();
        }
      });
      tail = run.catch(() => {
        // Keep the bus alive after a failed job; callers still receive their rejection.
      });
      return run;
    },
    get pending() {
      return pending;
    },
    get active() {
      return active;
    },
  };
}

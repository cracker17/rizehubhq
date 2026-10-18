// Long polling that survives a 409 Conflict. Telegram lets only ONE app read a bot's updates; when another app
// polls the same token (RizeHub's uptime-alert linking once did), grammY's bot.start() rejects with 409 and the
// container used to crash and restart in a loop. Now we log it once per attempt, back off and try again.
import { GrammyError } from 'grammy';

/** getUpdates refused because someone else is reading this bot (another poller, or a webhook is set). */
export const isPollConflict = (e: unknown): boolean => e instanceof GrammyError && e.error_code === 409;

/** 30 s, 60 s, 120 s, 240 s, then every 5 minutes. */
export const conflictBackoffMs = (attempt: number): number => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 300_000);

/** A run that lasted this long counts as healthy: the next conflict starts the backoff from 30 s again. */
export const HEALTHY_RUN_MS = 10 * 60_000;

export interface PollDeps {
  start: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Stop retrying (tests, shutdown). */
  stopped?: () => boolean;
}

/** Runs start() until it ends normally (bot.stop()); retries after a 409 with backoff; rethrows anything else. */
export async function pollWithRetry(d: PollDeps): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.warn(m));
  let attempt = 0;
  for (;;) {
    const began = now();
    try {
      await d.start();
      return;
    } catch (e) {
      if (!isPollConflict(e)) throw e;
      if (d.stopped?.()) return;
      attempt = now() - began >= HEALTHY_RUN_MS ? 1 : attempt + 1;
      const wait = conflictBackoffMs(attempt);
      log(`[bot] another app is reading this bot's updates (409 Conflict: a second poller or a webhook). `
        + `Retrying in ${Math.round(wait / 1000)} s. Use a separate bot token for any other app.`);
      await sleep(wait);
      if (d.stopped?.()) return;
    }
  }
}

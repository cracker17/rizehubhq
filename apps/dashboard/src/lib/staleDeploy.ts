// A tab opened before a deploy still runs the old JavaScript: its Server Action ids and code chunks no longer exist on
// the new server ("Failed to find Server Action … older or newer deployment", ChunkLoadError). Reloading fixes it, so
// the error screens and the snapshot refresh reload once instead of showing a crash.

const PATTERNS = [
  /failed to find server action/i,
  /server action .*(was )?not found/i,
  /older or newer deployment/i,
  /ChunkLoadError/,
  /loading (css )?chunk [\w-]+ failed/i,
];

export function isStaleDeployError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? '');
  return PATTERNS.some((p) => p.test(text));
}

const KEY = 'hq:stale-reload-at';
/** Minimum gap between automatic reloads, so a real (non-deploy) failure can't loop. */
export const RELOAD_GAP_MS = 30_000;

/** Whether an automatic reload is allowed now (none in the last RELOAD_GAP_MS). */
export function mayReload(lastAt: number | null, now: number): boolean {
  return lastAt === null || !Number.isFinite(lastAt) || now - lastAt > RELOAD_GAP_MS;
}

/** Reloads the page once per RELOAD_GAP_MS; returns false when it just did (show the error screen instead). */
export function reloadOnce(): boolean {
  if (typeof window === 'undefined') return false;
  let last: number | null = null;
  try { last = Number(sessionStorage.getItem(KEY)) || null; } catch { /* storage blocked */ }
  if (!mayReload(last, Date.now())) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* storage blocked */ }
  window.location.reload();
  return true;
}

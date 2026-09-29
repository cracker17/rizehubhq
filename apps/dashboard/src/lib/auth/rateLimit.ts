// Small in-memory limiter (per server process) for password checks, vault reveals and public forms.
export type Tries = Map<string, { n: number; reset: number }>;

/** Counts one attempt for `key`; true when it is over `max` attempts in the current `windowMs` window. */
export function rateLimited(map: Tries, key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const h = map.get(key);
  if (!h || h.reset <= now) {
    if (map.size > 5000) for (const [k, v] of map) if (v.reset <= now) map.delete(k);
    map.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  h.n++;
  return h.n > max;
}

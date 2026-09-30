// GitHub push webhook of the memory vault → brain service (docs/16-BRAIN.md). The dashboard is the only public door
// (the reverse proxy sends all of hq.rizehub.ph here), so it passes the raw body through untouched: the brain checks
// GitHub's HMAC signature itself, and nothing else of the request goes along.

export const BRAIN_HOOK_MAX_BYTES = 1024 * 1024;

const PASS_HEADERS = ['content-type', 'x-github-event', 'x-github-delivery', 'x-hub-signature-256'] as const;

/** Only GitHub's own headers go to the brain (no cookies, no auth headers, no forwarded-for). */
export function githubHookHeaders(incoming: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASS_HEADERS) {
    const v = incoming.get(name);
    if (v && v.length <= 200) out[name] = v;
  }
  return out;
}

// Live check of a provider key (Admin → API & AI "Test", and before a new key is stored). One cheap authenticated call
// per provider: the free "list models" / "who am I" endpoints where they exist, a 1-result search for the search APIs
// (1 credit). The key only travels in the request itself; it is removed from every message this returns.
import { ANTHROPIC_WORKSPACE_ID, anthropicWorkspaceHeaders } from '@rizehubhq/shared';
import { MOONSHOT_BASE_URL } from '../models/router';
import { workerEnv } from '../config';

export type KeyTestResult = { ok: true; message: string } | { ok: false; error: string } | { ok: null; message: string };
export type KeyTester = (name: string, value: string) => Promise<KeyTestResult>;
type Fetch = typeof fetch;
/** The value a setting has now (dashboard overlay over .env): some tests need a companion value. */
type EnvLookup = (name: string) => string | undefined;

interface Probe {
  label: string;
  url: (key: string) => string;
  headers?: (key: string, env: EnvLookup) => Record<string, string>;
  body?: unknown;
  /** Some APIs answer 200 with an error text (Semrush): return an error message, or null when fine. */
  check?: (text: string) => string | null;
  /** A clearer error for a known failed answer, or null to show the provider's own text. */
  explain?: (status: number, text: string) => string | null;
  /** Shown after a good test (e.g. that it used a credit). */
  note?: string;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models?limit=1';
const anthropicHeaders = (key: string, workspaceId: string | undefined) =>
  ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', ...anthropicWorkspaceHeaders(workspaceId) });
/** A multi-workspace Anthropic key (personal or service account) must name its workspace on every request. */
const anthropicExplain = (status: number, text: string) => (status === 400 && /scoped to a workspace|anthropic-workspace-id/i.test(text)
  ? 'This Anthropic key works in several workspaces, so every request must name one. Add "Anthropic workspace" (wrkspc_…, from Console → Settings → Workspaces) first, then add the key again. Or create a key inside a single workspace.'
  : null);

export const KEY_PROBES: Readonly<Record<string, Probe | null>> = {
  GOOGLE_GENERATIVE_AI_API_KEY: { label: 'Google Gemini', url: () => 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: (k) => ({ 'x-goog-api-key': k }) },
  GROQ_API_KEY: { label: 'Groq', url: () => 'https://api.groq.com/openai/v1/models', headers: bearer },
  OPENROUTER_API_KEY: { label: 'OpenRouter', url: () => 'https://openrouter.ai/api/v1/key', headers: bearer },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic', url: () => ANTHROPIC_MODELS, headers: (k, env) => anthropicHeaders(k, env('ANTHROPIC_WORKSPACE_ID')), explain: anthropicExplain,
  },
  // Tested together with the Anthropic key in use (createKeyTester): the workspace exists and the key may act in it.
  ANTHROPIC_WORKSPACE_ID: { label: 'Anthropic', url: () => ANTHROPIC_MODELS },
  OPENAI_API_KEY: { label: 'OpenAI', url: () => 'https://api.openai.com/v1/models', headers: bearer },
  MOONSHOT_API_KEY: { label: 'Moonshot', url: () => `${MOONSHOT_BASE_URL}/models`, headers: bearer },
  TAVILY_API_KEY: {
    label: 'Tavily', url: () => 'https://api.tavily.com/search', headers: (k) => ({ ...bearer(k), 'content-type': 'application/json' }),
    body: { query: 'RizeHub', max_results: 1, search_depth: 'basic' }, note: 'The test used 1 search credit.',
  },
  BRAVE_SEARCH_API_KEY: {
    label: 'Brave Search', url: () => 'https://api.search.brave.com/res/v1/web/search?q=RizeHub&count=1',
    headers: (k) => ({ accept: 'application/json', 'x-subscription-token': k }), note: 'The test used 1 search query.',
  },
  SERPER_API_KEY: {
    label: 'Serper', url: () => 'https://google.serper.dev/search', headers: (k) => ({ 'x-api-key': k, 'content-type': 'application/json' }),
    body: { q: 'RizeHub', num: 1 }, note: 'The test used 1 search credit.',
  },
  // A PageSpeed test runs a full Lighthouse audit (30+ s): the key is stored untested and checked on first use.
  PAGESPEED_API_KEY: null,
  SEMRUSH_API_KEY: {
    label: 'Semrush', url: (k) => `https://www.semrush.com/users/countapiunits.html?key=${encodeURIComponent(k)}`,
    check: (t) => (/^\s*ERROR/i.test(t) ? t.trim().slice(0, 160) : null),
  },
  FIGMA_TOKEN: { label: 'Figma', url: () => 'https://api.figma.com/v1/me', headers: (k) => ({ 'x-figma-token': k }) },
};

/** Removes the key (and its URL-encoded form) from a message. */
export function redact(text: string, key: string): string {
  let out = text;
  for (const v of [key, encodeURIComponent(key)]) if (v.length >= 4) out = out.split(v).join('[key]');
  return out;
}

export function createKeyTester(f: Fetch = (...a) => fetch(...a), timeoutMs = 15_000, env: EnvLookup = (n) => workerEnv()[n]?.trim() || undefined): KeyTester {
  return async (name, value) => {
    const p = KEY_PROBES[name];
    if (p === undefined) return { ok: false, error: 'Unknown key name.' };
    if (p === null) return { ok: null, message: 'This key can\'t be tested cheaply; it is checked the first time an agent uses it.' };
    let headers = p.headers?.(value, env) ?? {};
    const isWorkspace = name === 'ANTHROPIC_WORKSPACE_ID';
    /** The secrets this request carries, removed from every message (a workspace ID is not one; its key is). */
    const secrets = isWorkspace ? [] : [value];
    if (isWorkspace) {
      if (!ANTHROPIC_WORKSPACE_ID.test(value)) return { ok: false, error: 'An Anthropic workspace ID looks like wrkspc_01Jw… (Console → Settings → Workspaces).' };
      const key = env('ANTHROPIC_API_KEY');
      if (!key) return { ok: null, message: 'Saved. It is checked together with the Anthropic key when you add that.' };
      headers = anthropicHeaders(key, value);
      secrets.push(key);
    }
    const clean = (t: string) => secrets.reduce((out, s) => redact(out, s), t);
    try {
      const res = await f(p.url(value), {
        method: p.body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        headers, body: p.body === undefined ? undefined : JSON.stringify(p.body),
      });
      const text = await res.text().catch(() => '');
      if (isWorkspace && !res.ok && res.status !== 429) {
        return { ok: false, error: clean(`The Anthropic key in use can't run in ${value} (HTTP ${res.status}): ${text.replace(/\s+/g, ' ').slice(0, 160)}`) };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, error: `${p.label} rejected the key (HTTP ${res.status}). Check that you copied all of it.` };
      if (res.status === 402) return { ok: true, message: `${p.label} accepted the key, but the account has no credit left.` };
      if (res.status === 429) return { ok: true, message: `${p.label} accepted the key (rate-limited right now).` };
      const explained = res.ok ? null : p.explain?.(res.status, text);
      if (explained) return { ok: false, error: explained };
      if (!res.ok) return { ok: false, error: clean(`${p.label} answered HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`) };
      const bad = p.check?.(text);
      if (bad) return { ok: false, error: clean(`${p.label}: ${bad}`) };
      if (isWorkspace) return { ok: true, message: `The Anthropic key in use works in ${value}.` };
      return { ok: true, message: `${p.label} accepted the key.${p.note ? ` ${p.note}` : ''}` };
    } catch (e) {
      const m = e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e);
      return { ok: false, error: clean(`Could not reach ${p.label}: ${m}`.slice(0, 200)) };
    }
  };
}

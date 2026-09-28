// Small typed client for one Hermes Agent API server (hermes gateway with API_SERVER_ENABLED=true):
//   GET  /health                  liveness
//   POST /v1/chat/completions     OpenAI-compatible; Hermes runs its own tools server-side and returns the final answer
// Auth: Authorization: Bearer <API_SERVER_KEY>. Session headers: X-Hermes-Session-Id (transcript) and
// X-Hermes-Session-Key (long-term memory scope). Errors are classified so the runner can decide on the fallback.

/** down = unreachable / 502-504; unauthorized = 401/403; timeout = our deadline; aborted = caller's signal; bad_response = anything else. */
export type HermesErrorKind = 'down' | 'unauthorized' | 'timeout' | 'aborted' | 'bad_response';

export class HermesError extends Error {
  constructor(public kind: HermesErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'HermesError';
  }
}

export interface HermesMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface HermesUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }

export interface HermesChatResult {
  text: string;
  /** `model` field of the response (may be a Hermes alias rather than the provider model id). */
  model: string | null;
  usage: HermesUsage | null;
}

export interface HermesClientOptions {
  url: string;
  key: string;
  /** Default deadline for chat(). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Value of the OpenAI `model` field; Hermes picks the model from its own config.yaml. */
export const HERMES_REQUEST_MODEL = 'hermes-agent';

export class HermesClient {
  private readonly base: string;
  constructor(private o: HermesClientOptions) {
    this.base = o.url.replace(/\/+$/, '');
  }

  private async request(path: string, init: RequestInit, opts: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> }): Promise<unknown> {
    const deadline = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    const classify = (e: unknown): HermesError => {
      if (e instanceof HermesError) return e;
      if (opts.signal?.aborted) return new HermesError('aborted', 'Hermes request aborted');
      if (deadline.aborted) return new HermesError('timeout', `Hermes did not answer within ${Math.round(opts.timeoutMs / 1000)}s`);
      const code = (e as { cause?: { code?: string } })?.cause?.code;
      return new HermesError('down', `Hermes unreachable at ${this.base}${code ? ` (${code})` : ''}`);
    };
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.base}${path}`, {
        ...init,
        signal,
        headers: { authorization: `Bearer ${this.o.key}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new HermesError('unauthorized', `Hermes rejected the API key (HTTP ${res.status})`, res.status);
      if (res.status === 502 || res.status === 503 || res.status === 504) throw new HermesError('down', `Hermes is unavailable (HTTP ${res.status})`, res.status);
      if (!res.ok) throw new HermesError('bad_response', `Hermes answered HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      if (!text.trim()) return {};
      try { return JSON.parse(text) as unknown; } catch { throw new HermesError('bad_response', 'Hermes answered with invalid JSON', res.status); }
    } catch (e) {
      throw classify(e);
    }
  }

  /** GET /health. Resolves with the body; throws HermesError when Hermes is not healthy. */
  async health(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const body = await this.request('/health', { method: 'GET' }, { timeoutMs: opts.timeoutMs ?? 5_000, signal: opts.signal });
    return (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  }

  /**
   * One Hermes turn. sessionId = the HQ task id (or `chat:<agent>`), sessionKey = the agent id (memory per employee).
   * Hermes runs its tool loop server-side; the result is its final answer.
   */
  async chat(p: { messages: HermesMessage[]; sessionId: string; sessionKey: string; signal?: AbortSignal; timeoutMs?: number }): Promise<HermesChatResult> {
    const body = await this.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: HERMES_REQUEST_MODEL, messages: p.messages, stream: false }),
    }, {
      timeoutMs: p.timeoutMs ?? this.o.timeoutMs ?? 30 * 60_000,
      signal: p.signal,
      headers: { 'x-hermes-session-id': p.sessionId, 'x-hermes-session-key': p.sessionKey },
    });
    return parseChatCompletion(body);
  }
}

/** OpenAI chat.completion → { text, model, usage }. Throws bad_response when there is no assistant message. */
export function parseChatCompletion(body: unknown): HermesChatResult {
  const b = body as {
    model?: unknown;
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  } | null;
  const content = b?.choices?.[0]?.message?.content;
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('');
  }
  if (text === null) throw new HermesError('bad_response', 'Hermes response has no choices[0].message.content');
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const usage = b?.usage ? {
    inputTokens: n(b.usage.prompt_tokens), outputTokens: n(b.usage.completion_tokens), cachedInputTokens: n(b.usage.prompt_tokens_details?.cached_tokens),
  } : null;
  return { text, model: typeof b?.model === 'string' ? b.model : null, usage };
}

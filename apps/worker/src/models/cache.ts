// Prompt caching (docs/14 "Cost controls"). Anthropic caches only what a request marks with cache_control:
// the AI SDK's Anthropic provider reads `providerOptions.anthropic.cacheControl` on a system message (caches the
// tools + system prefix, which repeats on every call of an agent loop) and on a message (caches the conversation up
// to it). OpenAI and Google cache long prompts automatically, so other providers get the plain system + prompt.
// Pricing of cache reads/writes lives in ./usage.ts.
import type { ModelMessage } from 'ai';

export const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;
/** providerOptions that put a cache breakpoint on a message / system block (Anthropic only; others ignore it). */
export const ANTHROPIC_CACHE = { anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } };

export const usesPromptCache = (provider: string) => provider === 'anthropic';

/**
 * System + first user prompt for generateText/generateObject. For Anthropic the system prompt becomes a system
 * message with a cache breakpoint (tools + system are cached across the calls of a run); elsewhere unchanged.
 */
export function cachedPrompt(provider: string, system: string, prompt: string): { system: string; prompt: string } | { messages: ModelMessage[] } {
  if (!usesPromptCache(provider)) return { system, prompt };
  return {
    messages: [
      { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE },
      { role: 'user', content: prompt },
    ],
  };
}

/**
 * For multi-step agent loops: marks the newest message with a cache breakpoint so the next step re-reads the
 * whole conversation so far from cache (Anthropic allows 4 breakpoints: system + this one = 2). Other providers:
 * messages are returned unchanged.
 */
export function withRollingCache(provider: string, messages: ModelMessage[]): ModelMessage[] {
  if (!usesPromptCache(provider) || messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (last.role === 'system') return messages;
  return [
    ...messages.slice(0, -1).map((m) => (m.role !== 'system' && m.providerOptions?.anthropic ? stripCache(m) : m)),
    { ...last, providerOptions: { ...last.providerOptions, ...ANTHROPIC_CACHE } } as ModelMessage,
  ];
}

/** Removes an earlier rolling breakpoint so the request never exceeds Anthropic's 4-breakpoint limit. */
function stripCache(m: ModelMessage): ModelMessage {
  const { anthropic, ...rest } = m.providerOptions ?? {};
  const { cacheControl: _drop, ...keep } = (anthropic ?? {}) as Record<string, unknown>;
  const providerOptions = Object.keys(keep).length ? { ...rest, anthropic: keep } : rest;
  return { ...m, providerOptions: Object.keys(providerOptions).length ? providerOptions : undefined } as ModelMessage;
}

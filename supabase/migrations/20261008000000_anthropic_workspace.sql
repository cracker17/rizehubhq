-- Admin → API & AI: ANTHROPIC_WORKSPACE_ID joins the provider_keys allowlist (packages/shared/src/aiSettings.ts
-- PROVIDER_KEYS). A multi-workspace Anthropic key (personal or service account) is refused with HTTP 400 unless every
-- request names its workspace in the anthropic-workspace-id header; the worker sends this value there.

alter table provider_keys drop constraint if exists provider_keys_name_check;
alter table provider_keys add constraint provider_keys_name_check check (name in (
  'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID',
  'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'PAGESPEED_API_KEY',
  'SEMRUSH_API_KEY', 'FIGMA_TOKEN'));

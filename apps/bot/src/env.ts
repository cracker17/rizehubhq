// Bot configuration from the environment (pure, so it is testable).
export interface BotConfig {
  token: string;
  allowed: Set<number>;
  /** Where notifications go: TELEGRAM_NOTIFY_CHAT_ID, else the first whitelisted user (private chat id = user id). */
  notifyChatId: number;
  dashboardUrl: string;
  supabaseUrl: string;
  serviceKey: string;
  monthlyBudgetUsd: number | null;
  /** DAILY_AI_BUDGET_USD; the dashboard value (settings.ai_daily_budget_usd) wins over it, like in the worker (budgetCaps). */
  dailyBudgetUsd: number | null;
  pollMs: number;
}

export function parseAllowed(v: string | undefined): number[] {
  return (v ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n !== 0);
}

export function loadBotConfig(env: Record<string, string | undefined>): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const allowedList = parseAllowed(env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowedList.length === 0) throw new Error('TELEGRAM_ALLOWED_USER_IDS is required (your numeric Telegram id)');
  const notify = Number(env.TELEGRAM_NOTIFY_CHAT_ID);
  const budget = env.MONTHLY_BUDGET_USD;
  const daily = env.DAILY_AI_BUDGET_USD;
  return {
    token,
    allowed: new Set(allowedList),
    notifyChatId: Number.isSafeInteger(notify) && notify !== 0 ? notify : allowedList[0]!,
    dashboardUrl: (env.DASHBOARD_URL ?? 'https://hq.rizehub.ph').replace(/\/+$/, ''),
    supabaseUrl: env.SUPABASE_URL ?? '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    monthlyBudgetUsd: budget === undefined || budget === '' || Number.isNaN(Number(budget)) ? null : Number(budget),
    dailyBudgetUsd: daily === undefined || daily === '' || Number.isNaN(Number(daily)) ? null : Number(daily),
    pollMs: Math.max(1000, Number(env.BOT_POLL_MS) || 5000),
  };
}

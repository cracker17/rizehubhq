'use client';
// /costs (docs/14 "Usage meter"): today's AI spend vs the daily cap, spend by day, agent, client, top tasks and model mix.
import Link from 'next/link';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, CircleDollarSign, OctagonX } from 'lucide-react';
import type { CostSummary } from '@/lib/data/costsModel';
import { AgentChip, HBars, prettyDate, Stat, useAgent, usd } from '../reports/ui';

const LEVEL = {
  none: { color: 'var(--color-primary-hover)', label: 'No daily cap', icon: CircleDollarSign },
  ok: { color: 'var(--color-teal)', label: 'Within budget', icon: CheckCircle2 },
  warn: { color: 'var(--color-warning)', label: 'Past 80% of the cap', icon: AlertTriangle },
  over: { color: 'var(--color-danger)', label: 'Cap reached: paid models stopped', icon: OctagonX },
} as const;

const money = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : usd(n));
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function Meter({ s }: { s: CostSummary }) {
  const lv = LEVEL[s.level];
  const Icon = lv.icon;
  const pct = s.pct ?? 0;
  return (
    <section className="card flex min-w-0 flex-col gap-3 p-4 sm:p-5" aria-labelledby="meter-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="meter-title" className="text-sm font-semibold text-[var(--color-muted)]">Today’s AI spend · Asia/Manila</h2>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-[var(--color-panel)] px-2.5 py-1 text-xs font-medium">
          <Icon size={14} style={{ color: lv.color }} aria-hidden />{lv.label}
        </span>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-4xl font-semibold tabular-nums">{usd(s.todayUsd)}</span>
        <span className="text-[15px] text-[var(--color-muted)]">
          {s.budgetUsd ? <>of {usd(s.budgetUsd)} daily cap · {pct}%</> : 'DAILY_AI_BUDGET_USD is 0 or unset'}
        </span>
      </p>
      {s.budgetUsd ? (
        <div className="relative pt-1">
          <div className="h-3 overflow-hidden rounded-full bg-[var(--color-line)]" role="meter" aria-valuemin={0} aria-valuemax={s.budgetUsd}
            aria-valuenow={s.todayUsd} aria-label={`Today ${usd(s.todayUsd)} of ${usd(s.budgetUsd)} daily cap`}>
            <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, Math.max(pct, s.todayUsd > 0 ? 2 : 0))}%`, background: lv.color }} />
          </div>
          <span className="absolute top-0 h-5 w-0.5 bg-[var(--color-warning)]" style={{ left: '80%' }} aria-hidden />
          <div className="relative mt-1.5 h-4 text-[11px] text-[var(--color-dim)]">
            <span className="absolute left-0">$0</span>
            <span className="absolute -translate-x-1/2" style={{ left: '80%' }}>80%</span>
            <span className="absolute right-0">{usd(s.budgetUsd)}</span>
          </div>
        </div>
      ) : null}
      <p className="text-[13px] leading-snug text-[var(--color-muted)]">
        {s.level === 'over'
          ? 'Paid models (Anthropic, OpenAI, Kimi, paid OpenRouter) are paused until midnight Manila time. New work runs on the free models if their keys are set, otherwise it waits.'
          : 'Telegram alert at 80%; at 100% paid models stop for the day and the free profile takes over.'}
      </p>
    </section>
  );
}

function DailyBars({ s }: { s: CostSummary }) {
  const max = Math.max(s.budgetUsd ?? 0, ...s.days.map((d) => d.usd), 0.01);
  const every = s.days.length > 10 ? 7 : 1;
  return (
    <section className="item min-w-0 p-4" aria-labelledby="days-title">
      <h3 id="days-title" className="mb-3 text-sm font-semibold">Spend by day · last {s.rangeDays} days</h3>
      <div className="relative flex h-40 items-end gap-[2px] sm:gap-1" role="img"
        aria-label={`Daily AI spend, last ${s.rangeDays} days: total ${usd(s.rangeUsd)}; highest ${usd(Math.max(...s.days.map((d) => d.usd)))}`}>
        {s.budgetUsd ? (
          <span className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--color-danger)] opacity-70" style={{ bottom: `${(s.budgetUsd / max) * 100}%` }} aria-hidden />
        ) : null}
        {s.days.map((d) => (
          <span key={d.date} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${prettyDate(d.date, { month: 'short', day: 'numeric' })}: ${usd(d.usd)} · ${d.runs} runs`}>
            <span className="w-full rounded-t-[4px]" style={{
              height: `${d.usd ? Math.max(3, (d.usd / max) * 100) : 1.5}%`,
              background: d.usd ? (d.date === s.today ? 'var(--color-primary-hover)' : 'var(--color-primary)') : 'var(--color-line)',
            }} />
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[2px] text-[10px] text-[var(--color-dim)] sm:gap-1" aria-hidden>
        {s.days.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {(s.days.length - 1 - i) % every === 0 ? prettyDate(d.date, s.days.length > 10 ? { month: 'short', day: 'numeric' } : { weekday: 'short' }) : ''}
          </span>
        ))}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[13px] text-[var(--color-muted)]">Show as table</summary>
        <table className="mt-2 w-full text-left text-[13px] tabular-nums">
          <thead><tr className="text-[var(--color-dim)]"><th className="py-1 font-medium">Day</th><th className="font-medium">Spend</th><th className="font-medium">Runs</th></tr></thead>
          <tbody>{[...s.days].reverse().map((d) => (
            <tr key={d.date} className="border-t border-[var(--color-line)]"><td className="py-1">{prettyDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>{usd(d.usd)}</td><td>{d.runs}</td></tr>
          ))}</tbody>
        </table>
      </details>
    </section>
  );
}

function TopTasks({ s }: { s: CostSummary }) {
  if (!s.topTasks.length) return <p className="text-sm text-[var(--color-dim)]">No task runs in this range.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {s.topTasks.map((t, i) => (
        <li key={t.task_id} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2">
          <span className="text-sm tabular-nums text-[var(--color-dim)]">{i + 1}</span>
          <div className="min-w-0">
            <p className="truncate text-[14px]" title={t.title}>{t.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <AgentChip id={t.agent_id} size={18} />
              {t.client && <span className="rounded-md bg-[var(--color-panel)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">{t.client}</span>}
              <span className="text-xs text-[var(--color-dim)]">{t.runs} run{t.runs === 1 ? '' : 's'} incl. QA</span>
            </div>
          </div>
          <span className="text-sm font-medium tabular-nums">{money(t.usd)}</span>
        </li>
      ))}
    </ol>
  );
}

function ModelMix({ s }: { s: CostSummary }) {
  if (!s.modelMix.length) return <p className="text-sm text-[var(--color-dim)]">No model runs in this range.</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[320px] text-left text-[13px] tabular-nums">
        <thead><tr className="text-[var(--color-dim)]">
          <th className="px-1 py-1 font-medium">Model</th><th className="px-1 font-medium">Runs</th><th className="px-1 font-medium">Tokens</th><th className="px-1 text-right font-medium">Spend</th>
        </tr></thead>
        <tbody>{s.modelMix.map((m) => (
          <tr key={`${m.provider}:${m.model}`} className="border-t border-[var(--color-line)] align-top">
            <td className="px-1 py-1.5">
              <span className="block max-w-[11rem] truncate sm:max-w-none" title={m.model}>{m.model}</span>
              <span className="text-[11px] text-[var(--color-dim)]">{m.provider} · {m.paid ? 'paid' : 'free'}</span>
            </td>
            <td className="px-1 py-1.5">{m.runs}</td>
            <td className="px-1 py-1.5">{tokens(m.tokens)}</td>
            <td className="px-1 py-1.5 text-right">{money(m.usd)}<span className="block text-[11px] text-[var(--color-dim)]">{m.sharePct}%</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function AgentLabelledBars({ s }: { s: CostSummary }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {s.byAgent.map((a) => <AgentRow key={a.agent_id} id={a.agent_id} usd={a.usd} runs={a.runs} max={Math.max(0.0001, s.byAgent[0]?.usd ?? 0)} />)}
    </ul>
  );
}
function AgentRow({ id, usd: v, runs, max }: { id: string; usd: number; runs: number; max: number }) {
  const a = useAgent(id);
  return (
    <li className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm" title={`${a.name}: ${usd(v)} · ${runs} runs`}>
      <span className="truncate text-[var(--color-muted)]">{a.name}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-[var(--color-line)]" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${Math.max(v ? 4 : 0, (v / max) * 100)}%`, background: 'var(--color-primary-hover)' }} />
      </span>
      <span className="tabular-nums">{money(v)}</span>
    </li>
  );
}

export function CostsView({ summary: s, mode, error }: { summary: CostSummary; mode: 'demo' | 'live'; error?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="text-sm text-[var(--color-muted)]">AI model spend · {prettyDate(s.today)} · Asia/Manila{mode === 'demo' ? ' · demo data' : ''}</p>
        </div>
        <nav className="flex gap-1 rounded-xl bg-[var(--color-panel)] p-1" aria-label="Range">
          {([7, 30] as const).map((r) => (
            <Link key={r} href={r === 30 ? '/costs' : '/costs?range=7'} scroll={false} aria-current={s.rangeDays === r ? 'page' : undefined}
              className={clsx('rounded-lg px-3 py-1.5 text-sm', s.rangeDays === r ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-muted)] hover:text-white')}>
              Last {r} days
            </Link>
          ))}
        </nav>
      </div>
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn’t load all usage rows: {error}</p>}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-5">
        <Meter s={s} />
        <div className="grid grid-cols-2 gap-2.5 self-start">
          <Stat label={`Last ${s.rangeDays} days`} value={usd(s.rangeUsd)} />
          <Stat label="This month" value={usd(s.monthUsd)} hint="Asia/Manila month to date" />
          <Stat label="Model runs" value={String(s.runs)} tone="var(--color-info)" hint="Each planning, task, QA, report or chat run" />
          <Stat label="Prompt cache reads" value={s.cacheReadPct === null ? '—' : `${s.cacheReadPct}%`} tone="var(--color-teal)" hint="Share of paid input tokens read from the prompt cache" />
        </div>
      </div>

      <DailyBars s={s} />

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">By agent</h3>
          {s.byAgent.length ? <AgentLabelledBars s={s} /> : <p className="text-sm text-[var(--color-dim)]">No spend in this range.</p>}</section>
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">By client</h3>
          <HBars rows={s.byClient.map((c) => ({ label: c.name, value: c.usd }))} color="var(--color-info)" format={money} /></section>
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">Top tasks by cost</h3><TopTasks s={s} /></section>
        <section className="item min-w-0 p-4"><h3 className="mb-3 text-sm font-semibold">Model mix</h3><ModelMix s={s} /></section>
      </div>
    </div>
  );
}

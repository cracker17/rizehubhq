'use client';
import { forwardRef } from 'react';
import { CheckCircle2, XCircle, ExternalLink, FileText, Link2, HelpCircle, AlertTriangle, Hand } from 'lucide-react';
import clsx from 'clsx';
import { useHq } from '@/lib/data/store';
import { asAction, asDeliverable, asPlan, money, relDay, timeHM } from '@/lib/data/derive';
import { actionExecution } from '@/lib/data/actions';
import type { ApprovalRow, QaVerdictJson, TaskOutput } from '@/lib/data/types';
import { Avatar } from '../Avatar';
import { KIND } from '../approvalKinds';

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx('item p-4', className)}>
      <h3 className="mb-2.5 text-sm font-semibold text-[var(--color-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items, empty }: { items?: string[]; empty: string }) {
  if (!items?.length) return <p className="text-sm text-[var(--color-dim)]">{empty}</p>;
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-snug">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

// ---------- plan ----------
function PlanDetail({ ap }: { ap: ApprovalRow }) {
  const { idx } = useHq();
  const plan = asPlan(ap);
  const tasks = plan.tasks ?? [];
  const titleOf = (key: string) => tasks.find((t) => t.key === key)?.title ?? key;
  return (
    <>
      {plan.summary && <Section title="Summary"><p className="text-[15px] leading-relaxed">{plan.summary}</p></Section>}
      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Assumptions"><Bullets items={plan.assumptions} empty="None." /></Section>
        <Section title="Questions for you">
          <Bullets items={plan.questions_for_ceo} empty="No questions." />
          {!!plan.questions_for_ceo?.length && <p className="mt-2.5 text-xs text-[var(--color-dim)]">Answer in the note below; it goes back to the COO.</p>}
        </Section>
      </div>
      <Section title={`Tasks (${tasks.length})${plan.estimated_cost_usd !== undefined ? ` · est. ${money(plan.estimated_cost_usd)}` : ''}`}>
        {/* table on wide screens, stacked cards on phones (no horizontal scroll) */}
        <table className="hidden w-full table-fixed text-left text-sm md:table">
          <thead className="text-xs text-[var(--color-dim)]">
            <tr><th className="w-[22%] pb-2 pr-3 font-medium">Agent</th><th className="w-[24%] pb-2 pr-3 font-medium">Task · work type</th><th className="w-[18%] pb-2 pr-3 font-medium">Depends on</th><th className="pb-2 font-medium">Acceptance criteria</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const a = idx.agentById.get(t.agent_id);
              return (
                <tr key={t.key} className="border-t border-[var(--color-line)] align-top">
                  <td className="py-3 pr-3">
                    <span className="flex items-center gap-2"><Avatar id={t.agent_id} name={a?.name ?? t.agent_id} color={a?.avatar?.color ?? '#6D4AFF'} size={28} /><span className="min-w-0 leading-snug">{a?.name ?? t.agent_id}</span></span>
                  </td>
                  <td className="py-3 pr-3"><p className="font-medium">{t.title}</p><p className="text-xs text-[var(--color-muted)]">{t.work_type}</p></td>
                  <td className="py-3 pr-3 text-[var(--color-muted)]">{t.depends_on?.length ? t.depends_on.map(titleOf).join(', ') : '—'}</td>
                  <td className="py-3"><ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] text-[var(--color-muted)]">{t.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ol className="flex flex-col gap-2.5 md:hidden">
          {tasks.map((t) => {
            const a = idx.agentById.get(t.agent_id);
            return (
              <li key={t.key} className="rounded-xl border border-[var(--color-line)] p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar id={t.agent_id} name={a?.name ?? t.agent_id} color={a?.avatar?.color ?? '#6D4AFF'} size={30} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{t.title}</p>
                    <p className="text-xs text-[var(--color-muted)]">{a?.name ?? t.agent_id} · {t.work_type}</p>
                  </div>
                </div>
                {!!t.depends_on?.length && <p className="mt-2 text-xs text-[var(--color-muted)]">After: {t.depends_on.map(titleOf).join(', ')}</p>}
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[13px] text-[var(--color-muted)]">{t.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul>
              </li>
            );
          })}
        </ol>
      </Section>
    </>
  );
}

// ---------- deliverable ----------
function ScoreRing({ score, pass }: { score: number; pass: boolean }) {
  const r = 26, c = 2 * Math.PI * r;
  const color = pass ? 'var(--color-teal)' : 'var(--color-danger)';
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={`QA score ${score} of 100`}>
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--color-line)" strokeWidth="6" />
      <circle cx="34" cy="34" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, score)) / 100)} transform="rotate(-90 34 34)" />
      <text x="34" y="39" textAnchor="middle" fontSize="16" fontWeight="600" fill="var(--color-ink)">{score}</text>
    </svg>
  );
}

function QaReport({ qa }: { qa: QaVerdictJson }) {
  const pass = qa.verdict === 'pass';
  return (
    <Section title="QA report">
      <div className="flex items-center gap-4">
        <ScoreRing score={qa.score} pass={pass} />
        <div className="min-w-0">
          <p className="font-medium" style={{ color: pass ? 'var(--color-teal)' : 'var(--color-danger)' }}>{pass ? 'Passed' : 'Failed'} · {qa.checks.filter((c) => c.result === 'pass').length}/{qa.checks.length} checks</p>
          {qa.summary && <p className="mt-0.5 text-sm text-[var(--color-muted)]">{qa.summary}</p>}
        </div>
      </div>
      <ul className="mt-4 flex flex-col divide-y divide-[var(--color-line)]">
        {qa.checks.map((c, i) => (
          <li key={i} className="flex items-start gap-2.5 py-2.5 text-sm">
            {c.result === 'pass'
              ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-[var(--color-success)]" aria-label="Pass" />
              : <XCircle size={17} className="mt-0.5 shrink-0 text-[var(--color-danger)]" aria-label="Fail" />}
            <div className="min-w-0">
              <p>{c.criterion}</p>
              {c.note && <p className="text-[13px] text-[var(--color-muted)]">{c.note}</p>}
              {c.evidence && <a href={c.evidence} target="_blank" rel="noreferrer" className="text-[13px] text-[var(--color-primary-hover)] hover:underline">Evidence</a>}
            </div>
          </li>
        ))}
      </ul>
      {!!qa.fix_list?.length && <div className="mt-2"><p className="mb-1 text-xs text-[var(--color-dim)]">Fix list</p><Bullets items={qa.fix_list} empty="" /></div>}
    </Section>
  );
}

function linkOf(l: NonNullable<TaskOutput['links']>[number]) { return typeof l === 'string' ? { label: l, url: l } : { label: l.label ?? l.url, url: l.url }; }
function fileOf(f: NonNullable<TaskOutput['files']>[number]) { return typeof f === 'string' ? { name: f, url: undefined } : { name: f.name ?? f.path ?? f.url ?? 'file', url: f.url }; }
const safeUrl = (u: string) => /^https?:\/\//i.test(u);

function DeliverableDetail({ ap }: { ap: ApprovalRow }) {
  const { output, qa } = asDeliverable(ap);
  const preview = ap.preview_url ?? output?.preview_url;
  const links = (output?.links ?? []).map(linkOf).filter((l) => safeUrl(l.url));
  const files = (output?.files ?? []).map(fileOf);
  return (
    <>
      <Section title="Output">
        <p className="text-[15px] leading-relaxed">{output?.summary ?? ap.summary ?? 'No summary.'}</p>
        {output?.branch && <p className="mt-2 text-sm text-[var(--color-muted)]">Branch: <code className="text-[var(--color-ink)]">{output.branch}</code></p>}
        {(preview || links.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {preview && safeUrl(preview) && (
              <a href={preview} target="_blank" rel="noreferrer" className="flex h-9 items-center gap-1.5 rounded-[10px] bg-[var(--color-primary)] px-3 text-sm font-medium hover:bg-[var(--color-primary-hover)]">
                <ExternalLink size={15} aria-hidden /> Open preview
              </a>
            )}
            {links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="flex h-9 max-w-full items-center gap-1.5 rounded-[10px] border border-[var(--color-line)] px-3 text-sm text-[var(--color-muted)] hover:text-white">
                <Link2 size={15} aria-hidden className="shrink-0" /> <span className="truncate">{l.label}</span>
              </a>
            ))}
          </div>
        )}
      </Section>
      {files.length > 0 && (
        <Section title={`Files (${files.length})`}>
          <ul className="flex flex-col gap-1.5 text-sm">
            {files.map((f) => (
              <li key={f.name} className="flex min-w-0 items-center gap-2">
                <FileText size={15} className="shrink-0 text-[var(--color-muted)]" aria-hidden />
                {f.url && safeUrl(f.url) ? <a href={f.url} target="_blank" rel="noreferrer" className="truncate text-[var(--color-primary-hover)] hover:underline">{f.name}</a> : <span className="truncate">{f.name}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {qa ? <QaReport qa={qa} /> : <Section title="QA report"><p className="text-sm text-[var(--color-dim)]">No QA report attached.</p></Section>}
    </>
  );
}

// ---------- action ----------
function ActionDetail({ ap, onPickOption }: { ap: ApprovalRow; onPickOption?: (o: string) => void }) {
  const p = asAction(ap);
  const exec = actionExecution(ap);
  const isQuestion = p.type === 'question';
  const Icon = isQuestion ? HelpCircle : AlertTriangle;
  const text = p.question ?? p.action ?? p.reason ?? ap.summary ?? ap.title;
  return (
    <>
      {exec.executor === 'manual' && (
        <section className="item p-4" style={{ borderColor: 'color-mix(in oklab, var(--color-warning) 45%, transparent)' }} aria-label="Manual step">
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--color-warning)]">
            <Hand size={17} aria-hidden className="shrink-0" /> Manual step: you do this after approving
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            Nothing runs automatically for {exec.actionType ? <code className="text-[var(--color-ink)]">{exec.actionType}</code> : 'this action'}.
            Approving records your OK; then carry it out yourself exactly as specified:
          </p>
          {exec.spec && <p className="mt-2.5 whitespace-pre-wrap break-words rounded-[10px] border border-[var(--color-line)] p-3 text-sm leading-relaxed">{exec.spec}</p>}
        </section>
      )}
      <Section title={isQuestion ? 'Question' : p.type === 'qa_escalation' ? 'QA escalation' : p.type === 'qa_stuck' ? 'QA can\'t review this' : p.type === 'task_failed' ? 'Agent is stuck' : 'Action to approve'}>
        <div className="flex items-start gap-3">
          <Icon size={20} className="mt-0.5 shrink-0 text-[var(--color-warning)]" aria-hidden />
          <p className="text-[15px] leading-relaxed">{text}</p>
        </div>
        {p.reason && p.reason !== text && <p className="mt-2 text-sm text-[var(--color-muted)]">{p.reason}</p>}
        {(p.risk || p.on_approve) && (
          <dl className="mt-3 grid gap-1 text-sm">
            {p.risk && <div className="flex gap-2"><dt className="text-[var(--color-dim)]">Risk</dt><dd>{p.risk}</dd></div>}
            {p.on_approve && <div className="flex gap-2"><dt className="shrink-0 text-[var(--color-dim)]">On approve</dt><dd className="text-[var(--color-muted)]">{p.on_approve}</dd></div>}
          </dl>
        )}
      </Section>
      {!!p.options?.length && (
        <Section title="Options">
          <div className="flex flex-wrap gap-2">
            {p.options.map((o) => (
              <button key={o} type="button" disabled={!onPickOption} onClick={() => onPickOption?.(o)}
                className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-line-active)] disabled:cursor-default disabled:hover:border-[var(--color-line)]">
                {o}
              </button>
            ))}
          </div>
          {onPickOption && <p className="mt-2.5 text-xs text-[var(--color-dim)]">Pick one to fill in your answer. Your note is sent to the agent.</p>}
        </Section>
      )}
      {p.last_verdict && <QaReport qa={p.last_verdict} />}
    </>
  );
}

// ---------- header + history ----------
export function ApprovalHeader({ ap }: { ap: ApprovalRow }) {
  const { idx } = useHq();
  const k = KIND[ap.kind]; const Icon = k.icon;
  const agent = ap.agent_id ? idx.agentById.get(ap.agent_id) : undefined;
  const req = ap.request_id ? idx.requestById.get(ap.request_id) : undefined;
  const client = req?.client_id ? idx.clientById.get(req.client_id)?.name : undefined;
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in oklab, ${k.color} 18%, transparent)`, color: k.color }}><Icon size={20} aria-hidden /></span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-snug sm:text-xl">{ap.title}</h2>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]" suppressHydrationWarning>
          {k.label}{agent ? ` · ${agent.name}` : ''}{client ? ` · ${client}` : ''} · {relDay(ap.created_at)} {timeHM(ap.created_at)}
          {req?.due_date ? ` · due ${relDay(req.due_date)}` : ''}{req?.priority && req.priority !== 'normal' ? ` · ${req.priority}` : ''}
        </p>
      </div>
    </div>
  );
}

export function DecisionRecord({ ap }: { ap: ApprovalRow }) {
  const color = ap.status === 'approved' ? 'var(--color-success)' : ap.status === 'rejected' ? 'var(--color-danger)' : 'var(--color-warning)';
  return (
    <section className="item p-4" style={{ borderColor: `color-mix(in oklab, ${color} 45%, transparent)` }}>
      <p className="text-sm font-medium" style={{ color }} suppressHydrationWarning>
        {ap.status === 'approved' ? 'Approved' : ap.status === 'rejected' ? 'Rejected' : 'Changes requested'}
        {ap.decided_at ? ` · ${relDay(ap.decided_at)} ${timeHM(ap.decided_at)}` : ''}{ap.decided_via ? ` · via ${ap.decided_via}` : ''}
      </p>
      {ap.ceo_note && <p className="mt-1.5 text-sm text-[var(--color-muted)]">“{ap.ceo_note}”</p>}
    </section>
  );
}

export const ApprovalBody = forwardRef<HTMLDivElement, { ap: ApprovalRow; onPickOption?: (o: string) => void }>(function ApprovalBody({ ap, onPickOption }, ref) {
  return (
    <div ref={ref} className="flex flex-col gap-3">
      {ap.kind === 'plan' && <PlanDetail ap={ap} />}
      {ap.kind === 'deliverable' && <DeliverableDetail ap={ap} />}
      {ap.kind === 'external_action' && <ActionDetail ap={ap} onPickOption={ap.status === 'pending' ? onPickOption : undefined} />}
    </div>
  );
});

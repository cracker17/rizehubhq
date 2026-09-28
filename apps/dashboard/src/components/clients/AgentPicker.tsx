'use client';
// Grants multi-select: which agents may use a credential (docs/09 "Access control").
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useHq } from '@/lib/data/store';

const DEPT_ORDER = ['dev', 'qa', 'design', 'content', 'ops', 'growth', 'leadership', 'multimedia'];

export function AgentPicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { snap } = useHq();
  const agents = [...snap.agents].sort((a, b) => (DEPT_ORDER.indexOf(a.department) - DEPT_ORDER.indexOf(b.department)) || a.name.localeCompare(b.name));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id].sort());
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-[13px] text-[var(--color-muted)]">Agents who may use it <span className="text-[var(--color-dim)]">({value.length} selected · no grant, no access)</span></legend>
      <div className="scroll-thin flex max-h-44 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-2">
        {agents.map((a) => {
          const on = value.includes(a.id);
          return (
            <button type="button" key={a.id} onClick={() => toggle(a.id)} aria-pressed={on}
              className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                on ? 'border-[var(--color-line-active)] bg-[color-mix(in_oklab,var(--color-primary)_30%,transparent)] text-white' : 'border-[var(--color-line)] text-[var(--color-muted)] hover:text-white')}>
              <span className="h-2 w-2 rounded-full" style={{ background: a.avatar?.color ?? '#6D4AFF' }} aria-hidden />
              {a.name}
              {on && <Check size={12} aria-hidden />}
            </button>
          );
        })}
        {agents.length === 0 && <span className="p-1 text-xs text-[var(--color-dim)]">No agents loaded.</span>}
      </div>
    </fieldset>
  );
}

export function AgentChips({ ids }: { ids: string[] }) {
  const { idx } = useHq();
  if (!ids.length) return <span className="text-xs text-[var(--color-dim)]">No agents granted</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const a = idx.agentById.get(id);
        return (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-panel)] px-2 py-0.5 text-xs text-[var(--color-ink)]">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: a?.avatar?.color ?? '#6D4AFF' }} aria-hidden />{a?.name ?? id}
          </span>
        );
      })}
    </span>
  );
}

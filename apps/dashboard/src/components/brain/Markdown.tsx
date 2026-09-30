'use client';
// Vault markdown as React elements (lib/brainView parseMarkdown: a safe subset, never raw HTML).
import clsx from 'clsx';
import { parseMarkdown, type Block, type Inline } from '@/lib/brainView';

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === 'bold') return <strong key={i} className="font-semibold text-[var(--color-ink)]">{p.v}</strong>;
        if (p.t === 'em') return <em key={i}>{p.v}</em>;
        if (p.t === 'code') return <code key={i} className="rounded bg-[var(--color-panel-2)] px-1 py-0.5 font-mono text-[0.85em] text-[#99f6e4]">{p.v}</code>;
        if (p.t === 'link') return <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="break-all text-[#7dd3fc] underline decoration-[#7dd3fc]/40 underline-offset-2 hover:decoration-[#7dd3fc]">{p.v}</a>;
        return <span key={i}>{p.v}</span>;
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'h': {
      const cls = { 1: 'text-xl font-semibold mt-1', 2: 'mt-5 text-[15px] font-semibold text-[#99f6e4]', 3: 'mt-4 text-sm font-semibold', 4: 'mt-3 text-sm font-medium text-[var(--color-muted)]' }[b.level];
      const Tag = (`h${Math.min(6, b.level + 1)}`) as 'h2';
      return <Tag className={cls}><Inlines parts={b.text} /></Tag>;
    }
    case 'p': return <p className="leading-relaxed"><Inlines parts={b.text} /></p>;
    case 'list':
      return (
        <ul className="flex flex-col gap-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-2 leading-relaxed" style={{ paddingLeft: it.depth * 16 }}>
              {it.checked === null
                ? <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-teal)]/70" />
                : <span aria-label={it.checked ? 'done' : 'open'} className={clsx('mt-[0.3em] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px]', it.checked ? 'border-[var(--color-teal)] bg-[var(--color-teal)]/20 text-[#99f6e4]' : 'border-[var(--color-line)]')}>{it.checked ? '✓' : ''}</span>}
              <span className={clsx('min-w-0', it.checked && 'text-[var(--color-dim)] line-through')}><Inlines parts={it.text} /></span>
            </li>
          ))}
        </ul>
      );
    case 'code': return <pre className="scroll-thin overflow-x-auto rounded-xl bg-[#07061a] p-3 font-mono text-[12.5px] leading-relaxed text-[#cbd5e1]">{b.v}</pre>;
    case 'quote': return <blockquote className="border-l-2 border-[var(--color-teal)]/50 pl-3 text-[var(--color-muted)]"><Inlines parts={b.text} /></blockquote>;
    case 'table':
      return (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-b border-[var(--color-line)]">
                  {r.map((c, j) => { const Cell = i === 0 ? 'th' : 'td'; return <Cell key={j} className={clsx('px-2 py-1.5 text-left align-top', i === 0 && 'font-medium text-[var(--color-muted)]')}><Inlines parts={c} /></Cell>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr': return <hr className="border-[var(--color-line)]" />;
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={clsx('flex min-w-0 flex-col gap-2.5 break-words text-[14px] text-[#d9d7f5]', className)}>
      {blocks.map((b, i) => <BlockView key={i} b={b} />)}
    </div>
  );
}

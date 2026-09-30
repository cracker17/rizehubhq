'use client';
// New Project wizard (docs/16-BRAIN.md "UI" §4): name → details → keywords → preview → create. Creates the same files
// as /new-project (projects.json entry, memory.md from the template, sessions/LOG.md) in one vault commit.
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { Dialog, Field, btn, inputCls, textareaCls } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';
import { createBrainProjectAction } from '@/app/brain-actions';
import { slugPreview, suggestAliases, type BrainProject } from '@/lib/brainView';
import { Markdown } from './Markdown';

const PLATFORMS = ['Shopify', 'Webflow', 'WordPress', 'Custom app', 'Other'];
const STEPS = ['Name', 'Details', 'Keywords', 'Preview'] as const;

export function NewProjectDialog({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: BrainProject[] }) {
  const router = useRouter();
  const { toast } = useHq();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [platform, setPlatform] = useState('');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState('');
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const slug = slugPreview(name);
  const linkLines = links.split('\n').map((l) => l.trim()).filter(Boolean);
  const suggested = useMemo(() => suggestAliases(name, linkLines), [name, links]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = aliases ?? suggested;
  const clash = useMemo(() => {
    const keys = new Set([name.trim().toLowerCase(), slug, ...chosen]);
    return projects.find((p) => keys.has(p.slug) || keys.has(p.name.toLowerCase()) || p.aliases.some((a) => keys.has(a.toLowerCase())));
  }, [name, slug, chosen, projects]);

  const reset = () => { setStep(0); setName(''); setClient(''); setPlatform(''); setDescription(''); setLinks(''); setAliases(null); setExtra(''); setError(null); };
  const close = () => { if (!pending) { reset(); onClose(); } };

  const preview = [
    `# ${name || 'New project'}`, '', '## Overview',
    `- What it is: ${description}`, `- Client / owner: ${client}`, `- Platform / stack: ${platform}`, '',
    '## Links', ...(linkLines.length ? linkLines.map((l) => `- ${l}`) : ['- Site:']), '', '## Status', '-', '', '## Decisions log', '', '## Open next steps', '-',
  ].join('\n');

  const canNext = step === 0 ? slug.length > 0 && !clash : true;
  const create = () => start(async () => {
    setError(null);
    const r = await createBrainProjectAction({ name, aliases: chosen, description, client, platform, links: linkLines });
    if (!r.ok) { setError(r.error); return; }
    toast(`Created ${name}`, 'success');
    reset(); onClose();
    router.push(`/brain/${r.project ?? slug}`);
  });

  return (
    <Dialog open={open} onClose={close} title="New project" wide>
      <ol className="mb-5 flex gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={clsx('flex flex-1 items-center gap-2 text-xs', i <= step ? 'text-[#99f6e4]' : 'text-[var(--color-dim)]')}>
            <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]', i < step ? 'border-[#5eead4] bg-[#5eead4]/20' : i === step ? 'border-[#5eead4]' : 'border-[var(--color-line)]')}>{i < step ? <Check size={11} /> : i + 1}</span>
            <span className="hidden sm:inline">{s}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="flex flex-col gap-3">
          <Field label="Project name" hint={slug ? `Short name: ${slug}` : 'e.g. Spicy Voyage Shopify'}>
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setAliases(null); }} onKeyDown={(e) => e.key === 'Enter' && canNext && setStep(1)} className={inputCls} maxLength={100} />
          </Field>
          {clash && <p role="alert" className="text-sm text-[#fbbf24]">Already in the brain as <a className="underline" href={`/brain/${clash.slug}`}>{clash.name}</a>. Open that one instead.</p>}
        </div>
      )}
      {step === 1 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client / owner"><input value={client} onChange={(e) => setClient(e.target.value)} className={inputCls} maxLength={200} /></Field>
          <Field label="Platform">
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={inputCls}>
              <option value="">Not sure yet</option>
              {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="What it is" className="sm:col-span-2"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} maxLength={500} placeholder="One line" /></Field>
          <Field label="Links (one per line)" hint='e.g. "Site: https://…", "Repo: github.com/…"' className="sm:col-span-2">
            <textarea value={links} onChange={(e) => { setLinks(e.target.value); setAliases(null); }} rows={3} className={textareaCls} />
          </Field>
          <p className="text-xs text-[var(--color-dim)] sm:col-span-2">Never paste passwords or API keys here. The brain refuses them; keep them in the HQ Vault.</p>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-muted)]">Keywords that find this project (Claude files sessions by them). Avoid generic words like “website”.</p>
          <div className="flex flex-wrap gap-2">
            {chosen.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full border border-[#5eead4]/40 bg-[#5eead4]/10 px-2.5 py-1 text-[13px]">
                {a}
                <button aria-label={`Remove ${a}`} onClick={() => setAliases(chosen.filter((x) => x !== a))} className="text-[var(--color-muted)] hover:text-white"><X size={13} /></button>
              </span>
            ))}
            {!chosen.length && <span className="text-sm text-[var(--color-dim)]">No keywords yet.</span>}
          </div>
          <div className="flex gap-2">
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a keyword" className={inputCls} maxLength={80}
              onKeyDown={(e) => { if (e.key === 'Enter' && extra.trim()) { setAliases([...new Set([...chosen, extra.trim().toLowerCase()])]); setExtra(''); } }} />
            <button className={btn.ghost} disabled={!extra.trim()} onClick={() => { setAliases([...new Set([...chosen, extra.trim().toLowerCase()])]); setExtra(''); }}>Add</button>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-muted)]">This becomes <span className="font-mono text-[#99f6e4]">projects/{slug}/memory.md</span>, plus a session log and a projects.json entry, in one vault commit.</p>
          <div className="item scroll-thin max-h-72 overflow-y-auto p-4"><Markdown source={preview} /></div>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-[#ff8a8d]">{error}</p>}
      <div className="mt-5 flex justify-between gap-3">
        <button className={btn.ghost} onClick={() => (step ? setStep(step - 1) : close())} disabled={pending}>{step ? 'Back' : 'Cancel'}</button>
        {step < STEPS.length - 1
          ? <button className={btn.primary} onClick={() => setStep(step + 1)} disabled={!canNext}>Next</button>
          : <button className={btn.primary} onClick={create} disabled={pending || !!clash}>{pending ? 'Creating…' : 'Create project'}</button>}
      </div>
    </Dialog>
  );
}

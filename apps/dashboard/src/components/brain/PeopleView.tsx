'use client';
// Brain › People (HQ Brain P2): invite people, pick exactly which projects each one sees (None / Read / Edit), preview
// what they will see before saving, disable access at once. Enforcement lives server-side (SQL + apps/brain/access.ts).
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Lock, Plus, Search, ShieldCheck, UserX, X } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';
import { inviteBrainPersonAction, setBrainPersonDisabledAction, updateBrainPersonAction } from '@/app/brain-actions';
import { ago } from '@/lib/brainView';
import {
  draftOf, grantsPayload, inviteMessage, joinUrl, levelOf, OWNER_ONLY_AREAS, personStatus, ROLE_HELP, sameDraft, setLevel, setRole,
  type AccessLevel, type BrainPerson, type Draft, type PersonRole,
} from '@/lib/brainPeople';
import { HealthPill } from './HealthPill';
import { CopyLine } from './DevicesPanel';

type Project = { slug: string; name: string };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
const LEVELS: Array<[AccessLevel, string]> = [['none', 'None'], ['read', 'Read'], ['write', 'Edit']];

function Seg({ value, onChange, label, readOnly }: { value: AccessLevel; onChange: (v: AccessLevel) => void; label: string; readOnly: boolean }) {
  return (
    <span role="group" aria-label={label} className="inline-flex shrink-0 rounded-[9px] border border-[var(--color-line)] bg-[#07061a] p-0.5">
      {LEVELS.map(([v, l]) => {
        const on = value === v;
        const tone = on ? (v === 'write' ? 'text-[#b9a6ff]' : v === 'read' ? 'text-[#5eead4]' : 'text-[var(--color-ink)]') : 'text-[var(--color-muted)]';
        return (
          <button key={v} type="button" aria-pressed={on} disabled={readOnly && v === 'write'} title={readOnly && v === 'write' ? 'Viewers are read-only' : undefined}
            onClick={() => onChange(v)} className={`h-8 rounded-[7px] px-2.5 text-[12.5px] disabled:opacity-40 ${on ? `bg-[var(--color-panel-2)] shadow-[inset_0_0_0_1px_var(--color-line)] ${tone}` : tone}`}>{l}</button>
        );
      })}
    </span>
  );
}

export function PeopleView({ people, projects, demo, error }: { people: BrainPerson[]; projects: Project[]; demo: boolean; error?: string }) {
  const router = useRouter();
  const { toast } = useHq();
  const [sel, setSel] = useState<string | null>(people[0]?.id ?? null);
  const [filter, setFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [pending, start] = useTransition();
  const person = people.find((p) => p.id === sel) ?? null;
  const [draft, setDraft] = useState<Draft | null>(person ? draftOf(person) : null);
  useEffect(() => { setDraft(person ? draftOf(person) : null); }, [person?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = useMemo(() => new Map(projects.map((p) => [p.slug, p.name])), [projects]);
  const changed = !!person && !!draft && !sameDraft(draft, draftOf(person));
  const granted = draft ? Object.entries(draft.grants) : [];
  const shown = projects.filter((p) => `${p.name} ${p.slug}`.toLowerCase().includes(filter.trim().toLowerCase()));

  const save = () => start(async () => {
    if (!person || !draft) return;
    const r = await updateBrainPersonAction(person.id, { role: draft.role, grants: grantsPayload(draft) });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(`Access saved for ${person.name}. It applies to their Claude connection right away.`, 'success');
    router.refresh();
  });
  const toggleDisabled = () => start(async () => {
    if (!person) return;
    const r = await setBrainPersonDisabledAction(person.id, !person.disabled_at);
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(person.disabled_at ? `${person.name} can connect again.` : `${person.name} is disabled. Their connections stopped.`, 'success');
    router.refresh();
  });

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">{error}</p>}
      <div className="flex justify-end"><button type="button" className={btn.primary} onClick={() => setInviting(true)}><Plus size={16} aria-hidden />Invite someone</button></div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-start">
        <section className="card p-2" aria-label="People">
          <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-semibold text-white">J</span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">Julev</span><span className="block text-xs text-[var(--color-muted)]">Owner · sees everything</span></span>
          </div>
          {people.length === 0 && <p className="px-3 py-4 text-sm text-[var(--color-muted)]">Nobody else yet. Invite someone and pick the projects they may see.</p>}
          <ul className="flex flex-col gap-1">
            {people.map((p) => {
              const s = personStatus(p);
              return (
                <li key={p.id}>
                  <button type="button" aria-pressed={sel === p.id} onClick={() => setSel(p.id)}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-2.5 py-2.5 text-left ${sel === p.id ? 'border-[var(--color-line)] bg-[var(--color-panel-2)]' : 'border-transparent hover:bg-[var(--color-panel-2)]'}`}>
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2a2560] text-xs font-semibold">{initials(p.name)}</span>
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold">{p.name}</span><span className="block truncate text-xs text-[var(--color-muted)]">{p.role} · {p.role === 'admin' ? 'all projects' : `${p.grants.length} project${p.grants.length === 1 ? '' : 's'}`}</span></span>
                    <HealthPill level={s.level} label={s.label} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {person && draft ? (
          <div className="flex min-w-0 flex-col gap-4">
            <section className="card flex flex-wrap items-center gap-3 p-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#2a2560] text-sm font-semibold">{initials(person.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{person.name}</span>
                <span className="block break-words text-[13px] text-[var(--color-muted)]">{person.email}{person.title ? ` · ${person.title}` : ''} · {person.joined_at ? `joined ${ago(person.joined_at)}` : `invited ${ago(person.invited_at)}`}{person.last_active_at ? ` · active ${ago(person.last_active_at)}` : ''}</span>
              </span>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">Role
                <select id="person-role" value={draft.role} onChange={(e) => setDraft(setRole(draft, e.target.value as PersonRole))}
                  className="h-9 rounded-[9px] border border-[var(--color-line)] bg-[#07061a] px-2.5 text-sm text-[var(--color-ink)]">
                  <option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
                </select>
              </label>
              <p className="basis-full text-[13px] text-[var(--color-muted)]">{ROLE_HELP[draft.role]}</p>
            </section>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:items-start">
              <section className="card flex flex-col gap-3 p-4" aria-labelledby="pp-projects">
                <div className="flex items-center gap-2"><h2 id="pp-projects" className="font-semibold">Projects</h2><span className="ml-auto font-mono text-[11px] text-[var(--color-dim)]">{draft.role === 'admin' ? 'all' : `${granted.length} of ${projects.length} on`}</span></div>
                {draft.role === 'admin' ? (
                  <p className="rounded-xl bg-[var(--color-panel-2)] p-3 text-sm text-[var(--color-muted)]">Admins see every project. Switch the role to Member or Viewer to pick projects one by one.</p>
                ) : (
                  <>
                    <label className="relative">
                      <Search size={15} aria-hidden className="absolute left-3 top-3 text-[var(--color-dim)]" />
                      <input id="project-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects" aria-label="Filter projects"
                        className="h-10 w-full rounded-[10px] border border-[var(--color-line)] bg-[#07061a] pl-9 pr-3 text-sm outline-none focus:border-[var(--color-line-active)]" />
                    </label>
                    <ul className="flex flex-col">
                      {shown.map((p) => {
                        const level = levelOf(draft, p.slug);
                        const g = draft.grants[p.slug];
                        return (
                          <li key={p.slug} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[var(--color-line)] py-2.5 first:border-t-0">
                            <span className="min-w-0">
                              <span className="block break-words text-sm font-medium">{p.name}</span>
                              {g && (
                                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--color-muted)]">
                                  <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={g.transcripts} onChange={(e) => setDraft({ ...draft, grants: { ...draft.grants, [p.slug]: { ...g, transcripts: e.target.checked } } })} className="h-4 w-4 accent-[var(--color-primary)]" />Full transcripts</label>
                                  <label className="inline-flex items-center gap-1.5">Until<input type="date" value={g.expires_at ?? ''} onChange={(e) => setDraft({ ...draft, grants: { ...draft.grants, [p.slug]: { ...g, expires_at: e.target.value || null } } })} aria-label={`Access to ${p.name} ends`} className="h-7 rounded-md border border-[var(--color-line)] bg-[#07061a] px-1.5 text-[12px] text-[var(--color-ink)]" /></label>
                                </span>
                              )}
                            </span>
                            <Seg value={level} label={`Access to ${p.name}`} readOnly={draft.role === 'viewer'} onChange={(v) => setDraft(setLevel(draft, p.slug, v))} />
                          </li>
                        );
                      })}
                      {!shown.length && <li className="py-3 text-sm text-[var(--color-muted)]">No projects match.</li>}
                    </ul>
                  </>
                )}
              </section>

              <div className="flex flex-col gap-4">
                <section className="card flex flex-col gap-2.5 p-4" aria-labelledby="pp-preview">
                  <h2 id="pp-preview" className="flex items-center gap-2 font-semibold"><Eye size={16} aria-hidden />What {person.name.split(' ')[0]} will see</h2>
                  {draft.role === 'admin' ? <p className="text-sm text-[var(--color-muted)]">Every project.</p> : granted.length ? (
                    <ul className="flex flex-col gap-1.5">
                      {granted.map(([slug, g]) => (
                        <li key={slug} className="flex justify-between gap-3 rounded-lg bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[13px]">
                          <span className="min-w-0 truncate">{nameOf.get(slug) ?? slug}</span>
                          <span className={`shrink-0 font-mono ${g.access === 'write' ? 'text-[#b9a6ff]' : 'text-[#5eead4]'}`}>{g.access === 'write' ? 'edit' : 'read'}{g.expires_at ? ` · until ${g.expires_at}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-sm text-[var(--color-muted)]">Nothing yet. Switch on at least one project.</p>}
                  <p className="text-[12.5px] text-[var(--color-dim)]">Never shown: {OWNER_ONLY_AREAS.join(', ')}. Full transcripts stay hidden unless switched on per project.</p>
                </section>
                <section className="card flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-[var(--color-muted)]">{changed ? 'Unsaved changes' : 'No changes'}</span>
                    <span className="ml-auto flex gap-2">
                      <button type="button" className={btn.ghost} disabled={!changed || pending} onClick={() => setDraft(draftOf(person))}>Undo</button>
                      <button type="button" className={btn.primary} disabled={!changed || pending || demo} onClick={save}>Save access</button>
                    </span>
                  </div>
                  <p className="flex gap-2 text-[12.5px] text-[var(--color-muted)]"><ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden />Saving applies to {person.name.split(' ')[0]}&rsquo;s Claude connection on the next request.</p>
                  <button type="button" className={`${person.disabled_at ? btn.small : btn.danger} self-start`} onClick={toggleDisabled} disabled={pending || demo}>
                    <UserX size={14} aria-hidden />{person.disabled_at ? 'Enable again' : 'Disable access'}
                  </button>
                </section>
              </div>
            </div>
          </div>
        ) : (
          <section className="card flex flex-col items-start gap-3 p-6 text-sm text-[var(--color-muted)]">
            <Lock size={20} aria-hidden />
            <p>Nobody but you can see the Brain yet. Invite a team member, a VA or a client and choose exactly which projects they see.</p>
          </section>
        )}
      </div>

      {inviting && <InviteDrawer projects={projects} demo={demo} onClose={() => setInviting(false)} onDone={() => router.refresh()} />}
    </div>
  );
}

function InviteDrawer({ projects, demo, onClose, onDone }: { projects: Project[]; demo: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useHq();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRoleV] = useState<PersonRole>('member');
  const [picked, setPicked] = useState<Record<string, 'read' | 'write'>>({});
  const [result, setResult] = useState<{ url: string | null; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const grants = Object.entries(picked).map(([slug, access]) => ({ slug, access: role === 'viewer' ? 'read' : access, transcripts: false, expires_at: null }));
      const r = await inviteBrainPersonAction({ name, email, role, grants });
      if (!r.ok) { setError(r.error); return; }
      setResult({ url: r.code ? joinUrl(r.code) : null, name });
      toast(r.code ? 'Invite created. Send them the link.' : 'Access updated (they had already joined).', 'success');
      onDone();
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(5,4,16,.6)]" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-labelledby="invite-title" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)]">
        <header className="flex items-center gap-2 border-b border-[var(--color-line)] px-5 py-4">
          <h2 id="invite-title" className="font-semibold">{result ? 'Send the invite' : 'Invite someone'}</h2>
          <button type="button" className={`${btn.small} ml-auto`} onClick={onClose} aria-label="Close"><X size={14} aria-hidden /></button>
        </header>
        {result ? (
          <div className="flex flex-1 flex-col gap-4 overflow-auto p-5 text-sm">
            {result.url ? (
              <>
                <p>Send {result.name.split(' ')[0]} this link (it works once, for 7 days). They set a password and 2FA, then connect Claude.</p>
                <CopyLine value={result.url} label="join link" />
                <p className="text-[var(--color-muted)]">Or copy a ready message:</p>
                <CopyLine value={inviteMessage(result.name, result.url)} label="invite message" />
                {demo && <p className="text-xs text-[#fbbf24]">Demo mode: this link is an example and does not work.</p>}
              </>
            ) : <p>{result.name} already has an HQ login, so no new link is needed. Their access is updated.</p>}
            <button type="button" className={`${btn.primary} self-start`} onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col gap-4 overflow-auto p-5">
              <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">Name</span>
                <input ref={first} id="invite-name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Ana Cruz" className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3" /></label>
              <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">E-mail</span>
                <input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3" />
                <span className="text-xs text-[var(--color-muted)]">This becomes their HQ login. They must turn on 2FA before they can connect.</span></label>
              <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium">Role</span>
                <select id="invite-role" value={role} onChange={(e) => setRoleV(e.target.value as PersonRole)} className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-2.5">
                  <option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
                </select>
                <span className="text-xs text-[var(--color-muted)]">{ROLE_HELP[role]}</span></label>
              {role !== 'admin' && (
                <fieldset className="flex flex-col gap-1.5 text-sm">
                  <legend className="mb-1 font-medium">Start with these projects</legend>
                  <div className="flex max-h-64 flex-col gap-1 overflow-auto rounded-xl border border-[var(--color-line)] p-2">
                    {projects.map((p) => (
                      <div key={p.slug} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-[var(--color-panel-2)]">
                        <input id={`inv-${p.slug}`} type="checkbox" checked={!!picked[p.slug]} onChange={(e) => setPicked((x) => { const n = { ...x }; if (e.target.checked) n[p.slug] = 'read'; else delete n[p.slug]; return n; })} className="h-4 w-4 accent-[var(--color-primary)]" />
                        <label htmlFor={`inv-${p.slug}`} className="min-w-0 flex-1 truncate">{p.name}</label>
                        {picked[p.slug] && role === 'member' && (
                          <select aria-label={`Access to ${p.name}`} value={picked[p.slug]} onChange={(e) => setPicked((x) => ({ ...x, [p.slug]: e.target.value as 'read' | 'write' }))} className="h-7 rounded-md border border-[var(--color-line)] bg-[#07061a] px-1 text-xs">
                            <option value="read">Read</option><option value="write">Edit</option>
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                </fieldset>
              )}
              <p className="rounded-xl bg-[var(--color-panel-2)] p-3 text-[12.5px] text-[var(--color-muted)]"><Lock size={13} className="mr-1.5 inline" aria-hidden />Transcripts stay off and your owner-only areas stay hidden. You can change everything later.</p>
              {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
            </div>
            <footer className="flex items-center gap-2 border-t border-[var(--color-line)] px-5 py-4">
              <span className="text-xs text-[var(--color-muted)]">{role === 'admin' ? 'All projects' : `${Object.keys(picked).length} project${Object.keys(picked).length === 1 ? '' : 's'}`}</span>
              <button type="button" className={`${btn.ghost} ml-auto`} onClick={onClose}>Cancel</button>
              <button type="submit" className={btn.primary} disabled={pending}>Create invite</button>
            </footer>
          </form>
        )}
      </div>
    </>
  );
}

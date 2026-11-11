'use client';
// "Set up a computer" (HQ Brain P1, vault onboarding-and-access-plan.md "Process v2"): one setup link per device, a
// checklist that ticks itself from the installer's reports, one-time sign-ins, and a round-trip test. Polls the device
// every 3 s while open (the realtime publication also carries brain_devices; polling keeps it simple and robust).
import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, Link2, Loader2, MessageSquare, Monitor, RefreshCw, ShieldCheck, Terminal, X } from 'lucide-react';
import { btn } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';
import { brainDeviceStatusAction, createBrainDeviceAction, newBrainDeviceLinkAction } from '@/app/brain-actions';
import { installProgress, roundTripStages, setupCommand, stepsFor, stepState, type BrainDevice, type StepStatus } from '@/lib/brainDevices';
import { CopyLine } from './DevicesPanel';

type Step = 1 | 2 | 3 | 4;
const CONNECTOR_URL = 'https://hq.rizehub.ph/mcp/brain';

function fmtLeft(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function StepIcon({ s }: { s: StepStatus }) {
  if (s === 'done') return <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in_oklab,#34d399_16%,transparent)] text-[#34d399]"><Check size={15} aria-hidden /></span>;
  if (s === 'fail') return <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--color-danger)_18%,transparent)] text-[#ff8a8d]"><X size={15} aria-hidden /></span>;
  if (s === 'run') return <span className="flex h-7 w-7 items-center justify-center text-[#5eead4]"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /></span>;
  return <span className={`h-7 w-7 rounded-full border-[1.5px] ${s === 'skip' ? 'border-dashed' : ''} border-[var(--color-line)]`} aria-hidden />;
}

const STATUS_WORD: Record<StepStatus, string> = { wait: 'waiting', run: 'working', done: 'done', fail: 'failed', skip: 'skipped' };

/** DEMO: play the installer so the page can be tried without a PC. */
function demoAdvance(d: BrainDevice, tick: number): BrainDevice {
  if (tick < 5) return d; // show the setup line for a few seconds before the "installer" starts
  tick -= 5;
  const steps = [...stepsFor('owner').map((s) => s.id), 'github', 'roundtrip'];
  const checklist = { ...d.checklist };
  const i = Math.floor(tick / 2);
  steps.forEach((id, k) => {
    if (k < i) checklist[id] = { s: id === 'python' ? 'skip' : 'done', detail: id === 'git' ? 'Git 2.47, signature checked' : id === 'clone' ? '1,284 files' : '' };
    else if (k === i) checklist[id] = { s: 'run', detail: 'working' };
  });
  const t0 = Date.parse(d.created_at);
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const done = i >= steps.length;
  return {
    ...d, checklist, setup_used_at: d.setup_used_at ?? at(1),
    roundtrip: done ? { written_at: at(20), pushed_at: at(24), indexed_at: at(39), readable_at: at(41) } : d.roundtrip,
    ready_at: done ? at(41) : null, connected_at: tick > 4 ? at(10) : null, tested_at: tick > 8 ? at(14) : null,
  };
}

export function SetupWizard({ demo }: { demo: boolean }) {
  const { toast } = useHq();
  const [step, setStep] = useState<Step>(1);
  const [kind, setKind] = useState<'pc' | 'claude'>('pc');
  const [name, setName] = useState('');
  const [device, setDevice] = useState<BrainDevice | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());

  // live: poll the device; demo: play it
  useEffect(() => {
    if (!device) return;
    let tick = 0;
    const id = setInterval(async () => {
      setNow(Date.now());
      if (demo) { tick += 1; setDevice((d) => (d ? demoAdvance(d, tick) : d)); return; }
      const r = await brainDeviceStatusAction(device.id);
      if (r.ok && r.device) setDevice(r.device);
    }, demo ? 700 : 3000);
    return () => clearInterval(id);
  }, [device?.id, demo]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = device ? installProgress(device) : null;
  const stages = device ? roundTripStages(device) : [];
  const ready = !!device && (device.kind === 'pc' ? !!device.ready_at : !!device.tested_at);
  const expiresIn = device?.setup_expires_at ? Date.parse(device.setup_expires_at) - now : 0;
  const linkUsable = !!code && !device?.setup_used_at && expiresIn > 0;

  // move forward on their own when the signal arrives (the person can still go back)
  useEffect(() => {
    if (!device) return;
    if (step === 2 && progress?.allDone) setStep(3);
    if (step === 3 && device.kind === 'pc' && stepState(device, 'github').s === 'done' && stepState(device, 'roundtrip').s !== 'wait') setStep(4);
    if (step === 3 && device.kind === 'claude' && device.tested_at) setStep(4);
  }, [device, step, progress?.allDone]);

  const create = () => start(async () => {
    setError(null);
    const r = await createBrainDeviceAction({ name: name || (kind === 'pc' ? 'New PC' : 'Claude app'), kind });
    if (!r.ok) { setError(r.error); return; }
    setDevice(r.device);
    setCode(r.code);
    setStep(kind === 'pc' ? 2 : 3);
    toast(kind === 'pc' ? 'Setup link created. It works once, for 30 minutes.' : 'Waiting for the Claude app to connect.', 'success');
  });

  const relink = () => start(async () => {
    if (!device) return;
    const r = await newBrainDeviceLinkAction(device.id);
    if (!r.ok) { toast(r.error, 'error'); return; }
    setDevice(r.device); setCode(r.code); setStep(2);
    toast('New setup link created. The old one no longer works.', 'success');
  });

  const STEPS = useMemo(() => [
    ['Device', 'who · which kind'],
    [kind === 'pc' ? 'Install' : 'Nothing to install', kind === 'pc' ? 'live checklist' : 'skipped'],
    [kind === 'pc' ? 'Sign in' : 'Connect', 'one time'],
    ['Verify', 'round trip'],
  ] as const, [kind]);

  return (
    <div className="flex flex-col gap-4">
      <ol className="grid grid-cols-4 gap-2" aria-label="Setup progress">
        {STEPS.map(([title, sub], i) => {
          const n = (i + 1) as Step;
          const done = n < step || (n === 4 && ready);
          const current = n === step;
          return (
            <li key={title}>
              <button type="button" disabled={n > step || !device && n > 1} onClick={() => setStep(n)} aria-current={current ? 'step' : undefined}
                className={`flex h-full w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left disabled:cursor-default ${current ? 'border-[var(--color-line-active)] bg-[var(--color-panel-2)]' : 'border-[var(--color-line)] bg-[var(--color-panel)]'}`}>
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs ${done ? 'bg-[color-mix(in_oklab,#34d399_16%,transparent)] text-[#34d399]' : current ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-panel-2)] text-[var(--color-muted)]'}`}>
                  {done ? <Check size={13} aria-hidden /> : n}
                </span>
                <span className="min-w-0 text-[13px] font-medium leading-tight">{title}<span className="hidden font-mono text-[11px] font-normal text-[var(--color-dim)] sm:block">{sub}</span></span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <section className="card p-4 sm:p-5" aria-live="polite">
          {step === 1 && (
            <div className="flex flex-col gap-5">
              <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-1 text-sm font-semibold">What kind of device?</legend>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {([['pc', Monitor, 'Windows PC', 'Claude app, a local copy of the vault, sync every 15 min'], ['claude', MessageSquare, 'Phone, web or Mac', 'Claude app only, nothing to install']] as const).map(([k, Icon, title, sub]) => (
                    <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                      className={`flex flex-col gap-1 rounded-xl border p-3.5 text-left ${kind === k ? 'border-[var(--color-line-active)] bg-[color-mix(in_oklab,var(--color-primary)_14%,transparent)]' : 'border-[var(--color-line)] bg-[var(--color-panel-2)] hover:border-[var(--color-line-active)]'}`}>
                      <span className="flex items-center gap-2 text-sm font-semibold"><Icon size={16} aria-hidden />{title}</span>
                      <span className="text-[13px] text-[var(--color-muted)]">{sub}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-semibold">Device name</span>
                <input id="device-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={kind === 'pc' ? 'Office PC' : 'My phone'}
                  className="h-10 rounded-[10px] border border-[var(--color-line)] bg-[#07061a] px-3 text-sm outline-none focus:border-[var(--color-line-active)]" />
              </label>
              {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
              <div className="flex justify-end">
                <button type="button" className={btn.primary} onClick={create} disabled={pending}>
                  {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Link2 size={16} aria-hidden />}
                  {kind === 'pc' ? 'Create setup link' : 'Start'}
                </button>
              </div>
            </div>
          )}

          {step === 2 && device && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <h2 className="font-semibold">Run this in PowerShell on {device.name}</h2>
                <p className="text-sm text-[var(--color-muted)]">Open the Start menu, type <strong>PowerShell</strong>, press Enter, then paste this line. Keep the window open.</p>
                {code && linkUsable && <CopyLine value={setupCommand(code)} label="setup command" />}
                {!linkUsable && !device.setup_used_at && (
                  <div className="item flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                    <span className="flex-1">{code ? 'This link expired.' : 'The link is shown only once, when it is created.'}</span>
                    <button type="button" className={btn.small} onClick={relink} disabled={pending || demo}><RefreshCw size={14} aria-hidden />New link</button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] uppercase tracking-[.12em] text-[var(--color-dim)]">Checklist</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]" aria-hidden>
                  <span className="block h-full rounded-full bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-teal)] transition-[width] duration-500" style={{ width: `${progress ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                </span>
                <span className="font-mono text-xs text-[var(--color-muted)]">{progress?.done} of {progress?.total}</span>
              </div>
              <ul className="flex flex-col">
                {stepsFor(device.track).map((s) => {
                  const st = stepState(device, s.id);
                  return (
                    <li key={s.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-[var(--color-line)] py-3 first:border-t-0">
                      <StepIcon s={st.s} />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{s.label}{s.optional && <span className="rounded-md border border-[var(--color-line)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-muted)]">optional</span>}</span>
                        <span className={`block break-words text-[13px] ${st.s === 'fail' ? 'text-[#ff8a8d]' : 'text-[var(--color-muted)]'}`}>{st.detail || s.hint}</span>
                      </span>
                      <span className="font-mono text-xs text-[var(--color-dim)]"><span className="sr-only">{s.label}: </span>{STATUS_WORD[st.s]}</span>
                    </li>
                  );
                })}
              </ul>
              {progress?.failed && (
                <div role="alert" className="item flex flex-col gap-2 px-3.5 py-3 text-sm">
                  <span><strong>{progress.failed.label}</strong> stopped. {progress.failed.id === 'git'
                    ? <>Install Git by hand from <a className="text-[#5eead4] underline" href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">git-scm.com</a>, then create a new link and run it again.</>
                    : 'Fix it on the computer, then create a new link and run it again. Finished steps are skipped.'}</span>
                  <span><button type="button" className={btn.small} onClick={relink} disabled={pending || demo}><RefreshCw size={14} aria-hidden />New link</button></span>
                </div>
              )}
              <div className="flex justify-end"><button type="button" className={btn.primary} disabled={!progress?.allDone} onClick={() => setStep(3)}>Continue<ChevronRight size={16} aria-hidden /></button></div>
            </div>
          )}

          {step === 3 && device && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="font-semibold">{device.kind === 'pc' ? 'Sign in once' : 'Connect HQ Brain in Claude'}</h2>
                <p className="mt-1 text-sm text-[var(--color-muted)]">{device.kind === 'pc' ? 'These only happen on the first setup of this computer.' : 'Your Team plan already has HQ Brain. In Claude: Settings › Connectors › HQ Brain › Connect, then approve it on HQ with 2FA.'}</p>
              </div>
              <ul className="flex flex-col gap-2.5">
                {device.kind === 'pc' && (
                  <SignIn icon={<Terminal size={20} aria-hidden />} title="GitHub sign-in for the vault" sub="A browser window opened from the installer. Sign in once; the 15-minute sync uses it after that." s={stepState(device, 'github').s} />
                )}
                {device.kind === 'pc' && (
                  <SignIn icon={<Terminal size={20} aria-hidden />} title="HQ Brain in Claude Code" sub={<>In Claude Code type <code className="font-mono text-[#99f6e4]">/mcp</code> › hq-brain › Authenticate.</>} s={device.connected_at ? 'done' : 'run'} optional />
                )}
                {device.kind === 'claude' && <SignIn icon={<ShieldCheck size={20} aria-hidden />} title="Approve on HQ" sub="After sign-in and 2FA, allow read + save." s={device.connected_at ? 'done' : 'run'} />}
                {device.kind === 'claude' && <SignIn icon={<MessageSquare size={20} aria-hidden />} title='Test: say "load hq-brain"' sub="Any project works. This step ticks when the call reaches the Brain." s={device.tested_at ? 'done' : device.connected_at ? 'run' : 'wait'} />}
              </ul>
              {device.kind === 'claude' && <CopyLine value={CONNECTOR_URL} label="connector URL (only if your plan doesn't list HQ Brain)" />}
            </div>
          )}

          {step === 4 && device && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="font-semibold">Prove it works</h2>
                <p className="mt-1 text-sm text-[var(--color-muted)]">{device.kind === 'pc' ? 'The installer wrote a small test note. It has to reach GitHub, get indexed by HQ Brain and be readable again.' : 'One real request, end to end.'}</p>
              </div>
              {device.kind === 'pc' ? (
                <ol className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {stages.map((s, i) => {
                    const doneS = !!s.at; const runS = !doneS && (i === 0 || !!stages[i - 1].at);
                    return (
                      <li key={s.id} className={`flex flex-col gap-1 rounded-xl border p-3 ${doneS ? 'border-[color-mix(in_oklab,#34d399_45%,transparent)]' : runS ? 'border-[var(--color-teal)]' : 'border-[var(--color-line)]'} bg-[var(--color-panel-2)]`}>
                        <span className="font-mono text-[10.5px] uppercase tracking-[.08em] text-[var(--color-dim)]">{i + 1} · {s.label}</span>
                        <span className="text-sm font-semibold">{s.detail}</span>
                        <span className={`font-mono text-xs tabular-nums ${doneS ? 'text-[#34d399]' : 'text-[var(--color-muted)]'}`}>{doneS ? `${s.seconds ?? 0} s` : runS ? 'waiting…' : '–'}</span>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              {ready ? (
                <div className="flex items-center gap-3 rounded-xl border border-[color-mix(in_oklab,#34d399_40%,transparent)] bg-[color-mix(in_oklab,#34d399_12%,transparent)] p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#34d399] text-[#06281c]"><Check size={20} aria-hidden /></span>
                  <span className="text-sm"><strong>{device.name} is ready.</strong> <span className="text-[var(--color-muted)]">{device.kind === 'pc' ? 'Saves sync every 15 minutes, and the local copy keeps working if the online brain is down.' : 'Claude can load and save projects.'}</span></span>
                </div>
              ) : stepState(device, 'roundtrip').s === 'fail' ? (
                <p role="alert" className="item px-3.5 py-3 text-sm">The test note has not reached GitHub yet: {stepState(device, 'roundtrip').detail}. The 15-minute sync retries on its own; this page updates when it lands.</p>
              ) : (
                <p className="text-sm text-[var(--color-muted)]">This usually takes under a minute. You can leave this page; the device list shows the result.</p>
              )}
              <div className="flex justify-end gap-2"><Link href="/brain/devices" className={btn.ghost}>See all devices</Link></div>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          {device ? (
            <section className="card flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2"><h2 className="font-semibold">{device.name}</h2><span className="ml-auto font-mono text-xs text-[var(--color-muted)]">{device.kind === 'pc' ? 'Full PC' : 'Claude only'}</span></div>
              {device.kind === 'pc' && !device.setup_used_at && code && expiresIn > 0 && (
                <div><span className="font-mono text-[11px] uppercase tracking-[.12em] text-[var(--color-dim)]">Link expires in</span><div className="font-mono text-2xl font-semibold tabular-nums">{fmtLeft(expiresIn)}</div></div>
              )}
              {device.setup_used_at && device.kind === 'pc' && <p className="text-sm text-[var(--color-muted)]">The installer is running on the computer. Steps tick as it reports them.</p>}
              {device.info?.vault_path && <p className="break-words text-[13px]"><span className="text-[var(--color-dim)]">Folder </span>{device.info.vault_path}</p>}
            </section>
          ) : (
            <section className="card flex flex-col gap-2 p-4 text-sm">
              <h2 className="font-semibold">What the computer needs</h2>
              <ul className="flex flex-col gap-1.5 text-[var(--color-muted)]">
                <li><strong className="text-[var(--color-ink)]">Claude</strong>: the desktop app (the installer opens the download if it is missing)</li>
                {kind === 'pc' && <li><strong className="text-[var(--color-ink)]">Windows 10 or 11</strong>, no admin rights needed</li>}
                {kind === 'pc' && <li><strong className="text-[var(--color-ink)]">Git</strong>: installed for you if missing (signed download)</li>}
                {kind === 'pc' && <li><strong className="text-[var(--color-ink)]">GitHub</strong>: sign in once in the browser</li>}
                <li><strong className="text-[var(--color-ink)]">Time</strong>: {kind === 'pc' ? 'about 10 minutes' : 'about 3 minutes'}</li>
              </ul>
            </section>
          )}
          {kind === 'pc' && (
            <section className="card flex flex-col gap-1.5 p-4 text-[13px] text-[var(--color-muted)]">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Before you run it</h2>
              <p>The script is made for this one computer and only works once. It checks what is installed, installs only what is missing, and reports each step here. It never asks for passwords; GitHub and Claude sign-ins happen in their own windows.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function SignIn({ icon, title, sub, s, optional }: { icon: React.ReactNode; title: string; sub: React.ReactNode; s: StepStatus; optional?: boolean }) {
  const word = s === 'done' ? 'Done' : s === 'fail' ? 'Failed' : s === 'run' ? 'Waiting for you' : 'Next';
  const tone = s === 'done' ? 'text-[#34d399]' : s === 'fail' ? 'text-[#ff8a8d]' : s === 'run' ? 'text-[#5eead4]' : 'text-[var(--color-muted)]';
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3.5">
      <span className="text-[var(--color-muted)]">{icon}</span>
      <span className="min-w-0"><span className="block text-sm font-semibold">{title}{optional && <span className="ml-2 font-mono text-[10.5px] font-normal text-[var(--color-dim)]">optional</span>}</span><span className="block text-[13px] text-[var(--color-muted)]">{sub}</span></span>
      <span className={`font-mono text-xs ${tone}`}>{word}</span>
    </li>
  );
}

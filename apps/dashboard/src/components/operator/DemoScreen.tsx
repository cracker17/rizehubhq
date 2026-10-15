'use client';
// The demo's live screen (docs/17-OPERATOR.md "Demo"): a drawn browser window showing what the operator would have open
// in LvlUp's workspace browser (Google Chat, the GitHub PR, the Vercel deployment, the live site under QA), with the
// operator's cursor moving to what it works on and the composer typing. A drawing, not a real browser.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, CircleCheck, GitMerge, GitPullRequest, Lock, Triangle } from 'lucide-react';
import { DEMO_CHAT, type DemoScreen as Screen } from '@/lib/operatorDemo';

function useTyped(text: string | undefined) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!text) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setN(text.length); return; }
    const t = setInterval(() => setN((v) => (v >= text.length ? v : v + 2)), 28);
    return () => clearInterval(t);
  }, [text]);
  return text ? text.slice(0, n) : '';
}

export function DemoScreen({ screen }: { screen: Screen }) {
  const box = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const typed = useTyped(screen.typing);

  useLayoutEffect(() => {
    const root = box.current;
    const el = screen.target ? root?.querySelector<HTMLElement>(`[data-demo-target="${screen.target}"]`) : null;
    if (!root || !el) { setCursor(null); return; }
    const r = root.getBoundingClientRect(); const e = el.getBoundingClientRect();
    setCursor({ x: e.left - r.left, y: e.top - r.top, w: e.width, h: e.height });
  }, [screen.app, screen.target, screen.sent?.length, screen.merged, screen.deploy]);

  return (
    <div ref={box} className="relative aspect-[4/3] sm:aspect-[16/10] w-full max-w-full overflow-hidden bg-[#e9ebf0] text-[#1f2937]">
      <div className="flex h-8 items-center gap-2 border-b border-[#d4d7de] bg-[#f6f7f9] px-3">
        <span className="flex gap-1">{['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />)}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white px-2 py-0.5 text-[11px] text-[#4b5563]">
          <Lock size={10} aria-hidden /><span className="truncate">{screen.url.replace(/^https:\/\//, '')}</span>
        </span>
        <span className="hidden text-[10px] text-[#6b7280] sm:inline">LvlUp profile</span>
      </div>
      <div className="h-[calc(100%-2rem)] overflow-hidden">
        {screen.app === 'idle' && <div className="grid h-full place-items-center bg-[#0f0d22] text-sm text-[#9a96c8]">Press Play: the operator&apos;s browser shows here.</div>}
        {screen.app === 'chat' && <ChatScreen screen={screen} typed={typed} />}
        {screen.app === 'github' && <GithubScreen merged={!!screen.merged} />}
        {screen.app === 'vercel' && <VercelScreen ready={screen.deploy === 'ready'} />}
        {screen.app === 'site' && <SiteScreen screen={screen} />}
      </div>
      {cursor && (
        <>
          <div className="pointer-events-none absolute rounded-md ring-2 ring-[#7c5cff] transition-all duration-500 ease-out" style={{ left: cursor.x - 3, top: cursor.y - 3, width: cursor.w + 6, height: cursor.h + 6, boxShadow: '0 0 0 4px rgba(124,92,255,.18)' }} />
          <svg className="pointer-events-none absolute h-5 w-5 drop-shadow transition-all duration-700 ease-out" style={{ left: cursor.x + Math.min(cursor.w, 120) - 6, top: cursor.y + cursor.h - 6 }} viewBox="0 0 24 24" aria-hidden>
            <path d="M3 2l7 19 2.5-7.5L20 11z" fill="#7c5cff" stroke="#fff" strokeWidth="1.5" />
          </svg>
        </>
      )}
    </div>
  );
}

function Bubble({ who, text, me, target }: { who: string; text: string; me?: boolean; target?: string }) {
  return (
    <div className={clsx('flex gap-2', me && 'flex-row-reverse')} data-demo-target={target}>
      <span className={clsx('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white', me ? 'bg-[#7c5cff]' : who === 'Alex' ? 'bg-[#0ea5e9]' : 'bg-[#16a34a]')}>{who[0]}</span>
      <div className={clsx('max-w-[78%] rounded-2xl px-3 py-1.5 text-[12px] leading-snug shadow-sm', me ? 'bg-[#e8e2ff]' : 'bg-white')}>
        <p className="text-[10.5px] font-semibold text-[#4b5563]">{who}</p>
        <p>{text}</p>
      </div>
    </div>
  );
}

function ChatScreen({ screen, typed }: { screen: Screen; typed: string }) {
  return (
    <div className="flex h-full">
      <div className="hidden w-[26%] flex-col gap-1 border-r border-[#e5e7eb] bg-white p-2 text-[11px] sm:flex">
        <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">Chat</p>
        {['Alex, Riley', 'Sam, Riley', 'LvlUp team'].map((c, i) => <span key={c} className={clsx('truncate rounded-full px-2 py-1', i === 0 ? 'bg-[#e8f0fe] font-semibold text-[#1a56db]' : 'text-[#374151]')}>{c}</span>)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-[#f8f9fb]">
        <div className="border-b border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold">Alex, Riley</div>
        <div className="flex flex-1 flex-col justify-end gap-2 overflow-hidden p-3">
          {DEMO_CHAT.earlier.map(([w, t]) => <Bubble key={t} who={w} text={t} me={w === 'Julev'} />)}
          <Bubble who="Alex" text={DEMO_CHAT.request} target="last-message" />
          {(screen.sent ?? []).map((t, i, a) => <Bubble key={t} who="Julev" text={t} me target={i === a.length - 1 ? 'sent' : undefined} />)}
        </div>
        <div className="m-2 rounded-full border border-[#d1d5db] bg-white px-3 py-1.5 text-[12px]" data-demo-target="composer">
          {typed ? <>{typed}<span className="wall-caret">▍</span></> : <span className="text-[#9ca3af]">Reply…</span>}
        </div>
      </div>
    </div>
  );
}

function GithubScreen({ merged }: { merged: boolean }) {
  return (
    <div className="h-full overflow-hidden bg-white p-3 text-[12px]">
      <p className="text-[11px] text-[#57606a]">lvlup / site</p>
      <h3 className="mt-1 text-[15px] font-semibold">Fix careers link in footer <span className="font-normal text-[#57606a]">#42</span></h3>
      <span className={clsx('mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white', merged ? 'bg-[#8250df]' : 'bg-[#1f883d]')}>
        {merged ? <GitMerge size={12} aria-hidden /> : <GitPullRequest size={12} aria-hidden />}{merged ? 'Merged' : 'Open'}
      </span>
      <span className="ml-2 text-[11px] text-[#57606a]">riley wants to merge 1 commit into <code className="rounded bg-[#ddf4ff] px-1">main</code> from <code className="rounded bg-[#ddf4ff] px-1">fix/footer-careers</code></span>
      <div className="mt-2 rounded-md border border-[#d0d7de] p-2 font-mono text-[11px]">
        <p className="text-[#57606a]">components/Footer.tsx</p>
        <p className="bg-[#ffebe9]">- &lt;a href=&quot;/career&quot;&gt;Careers&lt;/a&gt;</p>
        <p className="bg-[#dafbe1]">+ &lt;a href=&quot;/careers&quot;&gt;Careers&lt;/a&gt;</p>
      </div>
      <div className="mt-2 flex flex-col gap-1 rounded-md border border-[#d0d7de] p-2" data-demo-target="checks">
        <p className="flex items-center gap-1.5 font-semibold text-[#1a7f37]"><CircleCheck size={14} aria-hidden />All checks have passed</p>
        <p className="text-[11px] text-[#57606a]">CI / build · Vercel preview: Ready</p>
      </div>
      <div className="mt-2">
        <span data-demo-target="merge" className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-white', merged ? 'bg-[#8250df]' : 'bg-[#1f883d]')}>
          {merged ? <><Check size={13} aria-hidden />Merged</> : 'Squash and merge'}
        </span>
      </div>
    </div>
  );
}

function VercelScreen({ ready }: { ready: boolean }) {
  return (
    <div className="h-full overflow-hidden bg-white p-3 text-[12px]">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Triangle size={13} fill="#000" aria-hidden />lvlup-site · Deployments</p>
      <div className="mt-3 flex flex-col divide-y divide-[#eaeaea] rounded-md border border-[#eaeaea]">
        {[['Production', 'main · Fix careers link in footer (#42)', ready ? 'Ready' : 'Building', 'deploy'], ['Preview', 'fix/footer-careers', 'Ready', ''], ['Production', 'main · Update fund page copy', 'Ready', '']].map(([env, src, st, tgt], i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2" data-demo-target={tgt || undefined}>
            <span className={clsx('h-2 w-2 rounded-full', st === 'Ready' ? 'bg-[#16a34a]' : 'bg-[#f5a623]')} />
            <span className="w-20 font-medium">{st}</span>
            <span className="w-20 text-[#666]">{env}</span>
            <span className="min-w-0 flex-1 truncate text-[#444]">{src}</span>
            <span className="text-[11px] text-[#888]">{i === 0 ? 'just now' : `${i * 3}h ago`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SiteScreen({ screen }: { screen: Screen }) {
  return (
    <div className="flex h-full gap-3 bg-[#0e1a2b] p-3">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-white">
        <div className="flex items-center justify-between bg-[#0e1a2b] px-3 py-2 text-[11px] font-semibold text-white"><span>LvlUp Ventures</span><span className="font-normal opacity-70">Fund · Team · Careers</span></div>
        <div className="flex-1 p-3">
          <p className="text-[15px] font-bold">Careers</p>
          <p className="mt-1 text-[11px] text-[#4b5563]">Join the team backing the next wave of founders.</p>
          <div className="mt-2 rounded border border-[#e5e7eb] p-2 text-[11px]">Associate, Investments · Remote</div>
        </div>
        <div className="border-t border-[#e5e7eb] px-3 py-2 text-[10.5px] text-[#4b5563]" data-demo-target="footer">© LvlUp Ventures · Privacy · <span className="font-semibold text-[#1a56db] underline">Careers ✓</span></div>
      </div>
      <div className="hidden w-[24%] flex-col gap-2 sm:flex">
        {(screen.qa ?? []).map((w) => (
          <div key={w} className="rounded-md bg-[#13233a] p-2 text-[10.5px] text-[#cbd5e1]">
            <p className="font-semibold text-white">QA {w} px</p>
            <p className="text-[#6ee7b7]">✓ no console errors</p><p className="text-[#6ee7b7]">✓ no failed requests</p><p className="text-[#6ee7b7]">✓ links OK</p>
            {w === 375 && <p className="text-[#6ee7b7]">✓ no overflow</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

import { Hammer } from 'lucide-react';

export function ComingSoon({ title, milestone, children }: { title: string; milestone: string; children?: React.ReactNode }) {
  return (
    <div className="card flex min-h-[50vh] flex-col items-center justify-center gap-3 p-10 text-center">
      <Hammer size={32} className="text-[var(--color-primary-hover)]" />
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="max-w-lg text-[15px] text-[var(--color-muted)]">{children}</p>
      <span className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-muted)]">Arrives in milestone {milestone}</span>
    </div>
  );
}

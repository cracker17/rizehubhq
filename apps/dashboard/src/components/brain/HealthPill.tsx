// Status pill for devices and the brain service: colour + word (never colour alone).
import type { HealthLevel } from '@/lib/brainDevices';

const TONE: Record<HealthLevel, string> = {
  ok: 'text-[#34d399] bg-[color-mix(in_oklab,#34d399_14%,transparent)]',
  warn: 'text-[#fbbf24] bg-[color-mix(in_oklab,#fbbf24_14%,transparent)]',
  bad: 'text-[#ff8a8d] bg-[color-mix(in_oklab,var(--color-danger)_16%,transparent)]',
  setup: 'text-[#5eead4] bg-[color-mix(in_oklab,var(--color-teal)_14%,transparent)]',
};

export function HealthPill({ level, label }: { level: HealthLevel; label: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[11.5px] font-medium ${TONE[level]}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{label}
    </span>
  );
}

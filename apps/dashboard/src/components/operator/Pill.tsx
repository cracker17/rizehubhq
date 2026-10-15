import clsx from 'clsx';
import { TONE_CLASS, type Tone } from '@/lib/operatorView';

/** Status pill: soft tone background + readable text (shared by the /operator panels). */
export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={clsx('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium', TONE_CLASS[tone], className)}>{children}</span>;
}

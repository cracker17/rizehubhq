'use client';
// Small building blocks shared by the Clients, Client Vault and Connections screens.
import { useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import type { CredentialStatus } from '@/lib/data/vault';
import { platformLabel } from '@/lib/vaultPlatforms';

export {
  CLIENT_PRESET, PLATFORM_LABEL, SUGGESTED_GRANTS, TOOL_PLATFORM_LABEL, TOOL_PRESET, platformLabel, type CredentialPreset,
} from '@/lib/vaultPlatforms';

export const inputCls = 'h-10 w-full min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-[14px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)] [color-scheme:dark]';
export const textareaCls = 'w-full min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2 text-[14px] outline-none placeholder:text-[var(--color-dim)] focus:border-[var(--color-line-active)]';
export const btn = {
  primary: 'inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[var(--color-primary)] px-4 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50',
  ghost: 'inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-[var(--color-line)] px-3.5 text-sm text-[var(--color-ink)] hover:border-[var(--color-line-active)] hover:bg-[var(--color-panel-2)] disabled:opacity-50',
  small: 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2.5 text-[13px] text-[var(--color-ink)] hover:border-[var(--color-line-active)] hover:bg-[var(--color-panel)] disabled:opacity-50',
  danger: 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[color-mix(in_oklab,var(--color-danger)_55%,transparent)] px-2.5 text-[13px] text-[#ff8a8d] hover:bg-[color-mix(in_oklab,var(--color-danger)_15%,transparent)] disabled:opacity-50',
};

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx('flex min-w-0 flex-col gap-1.5 text-[13px] text-[var(--color-muted)]', className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--color-dim)]">{hint}</span>}
    </label>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="glass-scrim fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}
        className={clsx('glass scroll-thin max-h-[92vh] w-full overflow-y-auto rounded-[20px] p-5 sm:p-6', wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-white"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const STATUS: Record<CredentialStatus | 'failed', { label: string; color: string }> = {
  active: { label: 'Active', color: 'var(--color-success)' },
  expiring: { label: 'Expiring', color: 'var(--color-warning)' },
  check_needed: { label: 'Check needed', color: 'var(--color-danger)' },
  failed: { label: 'Failed login', color: 'var(--color-danger)' },
  revoked: { label: 'Revoked', color: 'var(--color-dim)' },
};

export function StatusPill({ status, failedLogins = 0 }: { status: CredentialStatus; failedLogins?: number }) {
  const s = STATUS[status === 'check_needed' && failedLogins >= 2 ? 'failed' : status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ color: status === 'revoked' ? 'var(--color-muted)' : `color-mix(in oklab, ${s.color} 80%, white)`, borderColor: `color-mix(in oklab, ${s.color} 50%, transparent)`, background: `color-mix(in oklab, ${s.color} 12%, transparent)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />
      {s.label}
    </span>
  );
}

const PLATFORM_COLOR: Record<string, string> = {
  shopify: '#5FBF4A', webflow: '#4353FF', wordpress: '#21759B', github: '#A09CC9', figma: '#A259FF', ga4: '#F5A524',
  gmail: '#E5484D', hosting: '#3BA7FF', ftp: '#3BA7FF', halaxy: '#14B8A6', other: '#6E6A9E',
  semrush: '#FF642D', ahrefs: '#3B82F6', canva: '#00C4CC', 'shopify-partner': '#5FBF4A', google: '#F5A524', meta: '#3BA7FF', ai: '#A09CC9',
};
export function PlatformChip({ platform }: { platform: string }) {
  const c = PLATFORM_COLOR[platform] ?? PLATFORM_COLOR.other!;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-panel)] px-1.5 py-0.5 text-xs text-[var(--color-ink)]">
      <span className="h-2 w-2 rounded-sm" style={{ background: c }} aria-hidden />
      {platformLabel(platform)}
    </span>
  );
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = now - new Date(iso).getTime();
  const future = diff < 0;
  const m = Math.round(Math.abs(diff) / 60_000);
  const s = m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  if (s === 'just now') return s;
  return future ? `in ${s}` : `${s} ago`;
}

export function usd(n: number) {
  return `$${n.toFixed(2)}`;
}

export const SECRET_TYPE_LABEL: Record<string, string> = {
  password: 'Password', api_token: 'API token', app_password: 'App password', ssh_key: 'SSH key', other: 'Other secret',
};
export const TWOFA_LABEL: Record<string, string> = {
  none: 'No 2FA', sms: 'SMS code', email: 'Email code', app: 'Authenticator app', collaborator: 'Collaborator account (own 2FA)',
};

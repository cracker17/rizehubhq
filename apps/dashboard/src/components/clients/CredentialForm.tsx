'use client';
// Add / edit a credential (docs/06 §7a). The secret field exists only when adding; it is sent once to the
// server action (→ worker /vault/store) and cleared right after. Editing never touches the secret (use Rotate).
import { useState, useTransition } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import type { CredentialView, SecretType, TwofaMethod } from '@/lib/data/vault';
import { storeCredentialAction, updateCredentialAction } from '@/app/vault-actions';
import { AgentPicker } from './AgentPicker';
import { CLIENT_PRESET, Field, SECRET_TYPE_LABEL, TWOFA_LABEL, btn, inputCls, platformLabel, textareaCls, type CredentialPreset } from './ui';

const SECRET_HINT: Record<string, string> = {
  api_token: 'Least-privilege token (e.g. Shopify custom app, GitHub fine-grained PAT, Webflow site token).',
  app_password: 'WordPress Application Password for a dedicated Editor user (sent as Basic auth).',
  ssh_key: 'Private key for deploys (paste the whole key).',
  other: 'Anything else the team needs (FTP password, hosting panel…).',
};

/** preset: client logins (default) or the agency's tool logins (Admin → Tool logins); same fields, same actions. */
export function CredentialForm({ clientId, initial, onDone, onCancel, preset = CLIENT_PRESET }: {
  clientId: string; initial?: CredentialView; onDone: (message: string) => void; onCancel: () => void; preset?: CredentialPreset;
}) {
  const editing = Boolean(initial);
  const [pending, start] = useTransition();
  const firstPlatform = Object.keys(preset.platforms)[0] ?? 'other';
  // Keep an edited credential's platform selectable even if the preset doesn't list it.
  const platforms = initial && !preset.platforms[initial.platform]
    ? { [initial.platform]: platformLabel(initial.platform), ...preset.platforms } : preset.platforms;
  const [platform, setPlatform] = useState(initial?.platform ?? firstPlatform);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [loginUrl, setLoginUrl] = useState(initial?.login_url ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [secretType, setSecretType] = useState<SecretType>(initial?.secret_type ?? 'password');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [twofa, setTwofa] = useState<TwofaMethod>(initial?.twofa_method ?? 'none');
  const [scope, setScope] = useState(initial?.scope_notes ?? '');
  const [allow, setAllow] = useState((initial?.url_allowlist ?? []).join('\n'));
  const [writes, setWrites] = useState((initial?.write_allowlist ?? []).join('\n'));
  const [expires, setExpires] = useState(initial?.expires_at ? initial.expires_at.slice(0, 10) : '');
  const [grants, setGrants] = useState<string[]>(initial?.grants ?? preset.suggestedGrants[firstPlatform] ?? []);
  const [touchedGrants, setTouchedGrants] = useState(editing);
  const [error, setError] = useState<string | null>(null);
  const hint = secretType === 'password' ? preset.passwordHint : SECRET_HINT[secretType];

  const pickPlatform = (p: string) => {
    setPlatform(p);
    if (!touchedGrants) setGrants(preset.suggestedGrants[p] ?? []);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const meta = {
      clientId, platform, label, loginUrl, username, secretType, twofaMethod: twofa, scopeNotes: scope,
      urlAllowlist: allow, writeAllowlist: writes, expiresAt: expires || null, grants,
    };
    start(async () => {
      const r = initial ? await updateCredentialAction({ ...meta, id: initial.id }) : await storeCredentialAction({ ...meta, secret });
      setSecret(''); // never keep the secret around, whatever happened
      setShow(false);
      if (!r.ok) { setError(r.error); return; }
      onDone(initial ? 'Credential updated' : 'Saved and encrypted. The secret is now masked.');
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off" aria-label={editing ? 'Edit credential' : 'Add credential'}>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Platform">
          <select className={inputCls} value={platform} onChange={(e) => pickPlatform(e.target.value)}>
            {Object.entries(platforms).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Label">
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} placeholder={preset.placeholder.label} />
        </Field>
        <Field label="Login URL">
          <input className={inputCls} value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder={preset.placeholder.loginUrl} inputMode="url" />
        </Field>
        <Field label="Username / email">
          <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={preset.placeholder.username} autoComplete="off" />
        </Field>
        <Field label="Type">
          <select className={inputCls} value={secretType} onChange={(e) => setSecretType(e.target.value as SecretType)} disabled={editing}>
            {Object.entries(SECRET_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {!editing ? (
          <Field label={secretType === 'password' || secretType === 'app_password' ? 'Password' : 'Token / secret'} hint={hint}>
            <span className="relative">
              {secretType === 'ssh_key' ? (
                <textarea className={`${textareaCls} font-mono text-xs`} rows={3} value={secret} onChange={(e) => setSecret(e.target.value)} required spellCheck={false} autoComplete="off" />
              ) : (
                <input className={`${inputCls} pr-10 font-mono`} type={show ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)}
                  required maxLength={8000} autoComplete="new-password" spellCheck={false} data-1p-ignore data-lpignore="true" />
              )}
              {secretType !== 'ssh_key' && (
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide' : 'Show while typing'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-muted)] hover:text-white">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              )}
            </span>
          </Field>
        ) : (
          <Field label="Secret" hint="Change it with Rotate; reveal needs your password.">
            <span className="flex h-10 items-center gap-2 rounded-xl border border-dashed border-[var(--color-line)] px-3 font-mono text-sm text-[var(--color-muted)]"><Lock size={14} aria-hidden />••••••••••••</span>
          </Field>
        )}
        <Field label="2FA method">
          <select className={inputCls} value={twofa} onChange={(e) => setTwofa(e.target.value as TwofaMethod)}>
            {Object.entries(TWOFA_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Expiry reminder" hint="Shown as expiring 14 days before.">
          <input className={inputCls} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
      <Field label="Scope notes (shown to agents; what they may and may not do)">
        <textarea className={textareaCls} rows={2} value={scope} onChange={(e) => setScope(e.target.value)} maxLength={2000}
          placeholder={preset.placeholder.scope} />
      </Field>
      <Field label="Allowed URLs (one per line; enforced by the worker)" hint="vault_api only calls these; vault_login may also open the login site.">
        <textarea className={`${textareaCls} font-mono text-xs`} rows={2} value={allow} onChange={(e) => setAllow(e.target.value)}
          placeholder={preset.placeholder.allow} spellCheck={false} />
      </Field>
      <Field label="Allowed API writes (one per line; everything else is read-only)"
        hint="METHOD /path, e.g. PUT /admin/api/2025-07/themes/123/assets.json. Publishing (theme role, site publish, status=publish) always needs your approval.">
        <textarea className={`${textareaCls} font-mono text-xs`} rows={2} value={writes} onChange={(e) => setWrites(e.target.value)}
          placeholder={preset.placeholder.writes} spellCheck={false} />
      </Field>
      <AgentPicker value={grants} onChange={(v) => { setGrants(v); setTouchedGrants(true); }} />
      {error && <p role="alert" className="text-sm text-[#ff8a8d]">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!editing && <p className="mr-auto flex items-center gap-1.5 text-xs text-[var(--color-dim)]"><Lock size={12} aria-hidden />Encrypted by the worker (AES-256-GCM). The browser never reads it back.</p>}
        <button type="button" className={btn.ghost} onClick={onCancel}>Cancel</button>
        <button className={btn.primary} disabled={pending}>{pending ? 'Saving…' : editing ? 'Save changes' : 'Save to vault'}</button>
      </div>
    </form>
  );
}

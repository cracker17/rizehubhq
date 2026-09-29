'use client';
// Admin → Tool logins (docs/06 §11, docs/09 "Internal vault"): the agency's own accounts (Semrush, Canva, hosting,
// Shopify Partner…). The same Client Vault list and rules, stored on the internal client, usable by granted agents
// in any task. Nothing here is duplicated: CredentialVault + CredentialForm with the tool preset.
import { KeyRound, EyeOff, Smartphone, ScrollText } from 'lucide-react';
import type { Loaded, ToolLoginsData } from '@/lib/data/vault';
import { CredentialVault } from '@/components/clients/CredentialVault';
import { TOOL_PRESET } from '@/components/clients/ui';
import { useHq } from '@/lib/data/store';

const POINTS = [
  { icon: EyeOff, title: 'Agents never see passwords', text: 'The worker encrypts each login and fills it in or adds the key itself. Agents get the page or the API answer, never the secret.' },
  { icon: KeyRound, title: 'Only the agents you pick', text: 'No grant, no access. Allowed URLs and API writes limit what they can open or change; publishing still needs your approval.' },
  { icon: Smartphone, title: 'Sites that ask for a code', text: 'When a login wants a 2FA code, the agent calls vault_request_2fa: you get the question in Telegram, reply with the code, and the task waits.' },
  { icon: ScrollText, title: 'Every use is logged', text: 'Each login, API call and reveal is in the access log. Two failed logins stop the agents so the account does not lock.' },
];

export function ToolLoginsView({ page }: { page: Loaded<ToolLoginsData | null> }) {
  const { session } = useHq();
  const data = page.data;
  return (
    <>
      <section className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="tools-about">
        <div className="min-w-0">
          <h2 id="tools-about" className="text-lg font-semibold">RizeHub&apos;s own tool accounts</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Store the agency&apos;s logins (Semrush, Canva, hosting, Shopify Partner…) once and choose which agents may use them.
            Unlike a client&apos;s logins, these work in any task, with or without a client.
          </p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="item flex gap-3 p-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-panel-2)]"><Icon size={16} strokeWidth={1.75} aria-hidden /></span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-[13px] text-[var(--color-muted)]">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {page.error && <p role="alert" className="item px-4 py-3 text-sm text-[#ff8a8d]">Couldn&apos;t load tool logins: {page.error}</p>}
      {session.mode === 'demo' && <p className="item px-4 py-3 text-sm text-[var(--color-muted)]">Demo mode: sample logins, no real secrets are stored.</p>}

      {data && (
        <section className="card p-4 sm:p-5" aria-label="Tool logins">
          <CredentialVault
            clientId={data.client.id} credentials={data.credentials} log={data.log} preset={TOOL_PRESET}
            intro="Encrypted by the worker; granted agents use them in any task without seeing them."
            emptyText="No tool logins yet. Add the first one, e.g. the Semrush seat for the writer."
            newTitle="New tool login"
          />
        </section>
      )}
    </>
  );
}

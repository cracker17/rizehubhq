// Process-wide outreach wiring (like rizehub/config.ts getRizehub): SalesDb on the service-role client, the SMTP mailer
// and the IMAP inbox when configured. Tests replace it with setSalesForTests().
import { createServiceClient } from '../db';
import { outreachConfig, type OutreachConfig } from './config';
import { imapInbox, type InboxSource } from './inbox';
import { smtpMailer, type Mailer } from './mailer';
import { salesSupabaseDb, type SalesDb } from './store';

export interface SalesRuntime { db: SalesDb; mailer: Mailer | null; inbox: InboxSource | null; cfg: OutreachConfig }

let shared: SalesRuntime | null = null;

export function getSales(): SalesRuntime {
  if (shared) return shared;
  const cfg = outreachConfig();
  shared = {
    cfg, db: salesSupabaseDb(createServiceClient()),
    mailer: cfg.smtp ? smtpMailer(cfg.smtp) : null,
    inbox: cfg.imap ? imapInbox(cfg.imap) : null,
  };
  return shared;
}

export function setSalesForTests(v: SalesRuntime | null): void { shared = v; }

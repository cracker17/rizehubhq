// Outbound SMTP (nodemailer). The transport factory is injectable so tests never open a socket.
import nodemailer from 'nodemailer';
import type { MailServer } from './config';
import type { ComposedMessage } from './compose';

export interface SendInfo { messageId: string; accepted: string[]; rejected: string[]; response?: string }
export interface Mailer { send(m: ComposedMessage): Promise<SendInfo> }

/** What we use from a nodemailer transport (tests pass a fake). */
export interface TransportLike { sendMail(o: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }> }
export type TransportFactory = (o: Record<string, unknown>) => TransportLike;

const addr = (a: unknown) => (typeof a === 'string' ? a : (a as { address?: string })?.address ?? String(a));

export function smtpMailer(server: MailServer, factory: TransportFactory = (o) => nodemailer.createTransport(o) as unknown as TransportLike): Mailer {
  const transport = factory({
    host: server.host, port: server.port, secure: server.secure, requireTLS: !server.secure,
    auth: { user: server.user, pass: server.pass },
    pool: true, maxConnections: 1, maxMessages: 20,
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
  return {
    async send(m) {
      const info = await transport.sendMail({
        from: { name: m.from.name, address: m.from.address }, to: m.to, subject: m.subject, text: m.text,
        messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, headers: m.headers,
        disableFileAccess: true, disableUrlAccess: true,
      });
      return {
        messageId: info.messageId ?? m.messageId,
        accepted: (info.accepted ?? []).map(addr), rejected: (info.rejected ?? []).map(addr), response: info.response,
      };
    },
  };
}

/** SMTP reply codes 5xx (except 55x mailbox-busy style temporary ones some servers misuse) are permanent. */
export function isPermanentSmtpError(e: unknown): boolean {
  const code = Number((e as { responseCode?: number })?.responseCode);
  return Number.isFinite(code) && code >= 500 && code < 600 && code !== 552;
}

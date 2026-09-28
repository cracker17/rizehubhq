// One-click unsubscribe (RFC 8058 List-Unsubscribe-Post + the link in the footer). The link carries the address and an
// HMAC token (OUTREACH_UNSUBSCRIBE_SECRET), so no lookup is needed and nobody can opt out someone else by guessing.
// GET and POST both unsubscribe: an opt-out that a link scanner triggers by mistake is the safe failure.
import type http from 'node:http';
import type { Route } from '../routes/types';
import { verifyUnsubscribe } from './compose';
import type { SalesDb } from './store';

export function createUnsubscribeHandler(get: () => { db: SalesDb; secret: string | null }) {
  return async (req: http.IncomingMessage, raw: Buffer): Promise<[number, unknown]> => {
    const { db, secret } = get();
    if (!secret) return [503, { error: 'one-click unsubscribe is not configured; reply "unsubscribe" to the email instead' }];
    const url = new URL(req.url ?? '/', 'http://localhost');
    let e = url.searchParams.get('e') ?? '';
    let t = url.searchParams.get('t') ?? '';
    if ((!e || !t) && raw.length) {
      const form = new URLSearchParams(raw.toString('utf8'));
      e = e || (form.get('e') ?? ''); t = t || (form.get('t') ?? '');
    }
    const email = verifyUnsubscribe(e, t, secret);
    if (!email) return [400, { error: 'This unsubscribe link is invalid. Reply "unsubscribe" to the email and we will remove you.' }];
    await db.suppress(email, 'One-click unsubscribe link', 'link', null);
    return [200, { ok: true, message: `${email} is unsubscribed. RizeHub will not email this address again.` }];
  };
}

export function unsubscribeRoutes(get: () => { db: SalesDb; secret: string | null }): Route[] {
  const handle = createUnsubscribeHandler(get);
  return [
    { method: 'GET', path: '/hooks/unsubscribe', auth: 'self', handle },
    { method: 'POST', path: '/hooks/unsubscribe', auth: 'self', handle },
  ];
}

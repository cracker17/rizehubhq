'use server';
import { redirect } from 'next/navigation';
import { brainJson } from '@/lib/brainConnector';
import { checkAuthorize, readParams, withParams } from './request';

// Approve / deny on the Brain connector consent page. Everything is checked again here (the form's hidden fields are
// only the original request): client + redirect URI, PKCE, HQ session, 2FA, CEO. Server actions also reject
// cross-site posts (Next checks the Origin header).
export async function decideAction(form: FormData): Promise<void> {
  const p = readParams((n) => form.get(n));
  const check = await checkAuthorize(p);
  if (check.kind === 'client_error' || check.kind === 'login') redirect(check.kind === 'login' ? check.to : check.redirect);
  if (check.kind === 'fatal') redirect(`/oauth/authorize?error=${encodeURIComponent(check.message)}`);
  if (form.get('decision') !== 'approve') {
    redirect(withParams(p.redirect_uri, { error: 'access_denied', error_description: 'The request was declined in HQ', state: p.state, iss: check.origin }));
  }
  const scopes = ['brain:read', ...(form.get('write') === 'on' ? ['brain:write'] : [])];
  const r = await brainJson<{ code: string }>('/oauth/code', {
    method: 'POST',
    body: {
      client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method,
      scopes, resource: p.resource || null, user_id: check.userId,
    },
  });
  if (r.status !== 200 || !r.body.code) {
    redirect(withParams(p.redirect_uri, { error: 'server_error', error_description: r.body.error ?? 'could not issue a code', state: p.state, iss: check.origin }));
  }
  redirect(withParams(p.redirect_uri, { code: r.body.code, state: p.state, iss: check.origin }));
}

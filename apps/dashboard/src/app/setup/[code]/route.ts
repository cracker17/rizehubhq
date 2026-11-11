import { NextResponse } from 'next/server';
import { callBrain } from '@/lib/brainCall';

// HQ Brain one-line installer: `irm https://hq.rizehub.ph/setup/<code> | iex` (public, see middleware PUBLIC).
// The code is single-use and expires after 30 minutes; the brain service redeems it and renders the device's script.
// Always answers with PowerShell (even errors), because `iex` runs whatever comes back.
export const dynamic = 'force-dynamic';

const say = (msg: string) => `Write-Host ''\nWrite-Host 'HQ Brain setup: ${msg.replace(/'/g, "''")}' -ForegroundColor Yellow\n`;
const ps = (body: string, status = 200) => new NextResponse(body, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[0-9a-fA-F]{20}$/.test(code)) return ps(say('this setup link is not valid. Create a new one in HQ > Brain > Devices.'));
  const r = await callBrain<{ script?: string }>(`/setup/script?code=${code.toLowerCase()}`, { timeoutMs: 20_000 });
  if (r.status !== 200 || typeof r.body.script !== 'string') return ps(say('HQ could not prepare the installer right now. Try again in a minute.'));
  return ps(r.body.script);
}

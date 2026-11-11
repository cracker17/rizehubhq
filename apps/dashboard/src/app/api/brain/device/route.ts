import { NextResponse, type NextRequest } from 'next/server';
import { callBrain } from '@/lib/brainCall';

// Step reports from the HQ Brain installer and sync.ps1 (public, see middleware PUBLIC). The body carries the device
// token; the brain service checks it against the stored hash and ignores anything it doesn't know.
export const dynamic = 'force-dynamic';
const MAX = 16 * 1024;

export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw.replace(/^﻿/, '')); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const r = await callBrain<{ ok?: boolean }>('/device/report', { method: 'POST', body, timeoutMs: 10_000 });
  return NextResponse.json(r.body, { status: r.status || 502 });
}

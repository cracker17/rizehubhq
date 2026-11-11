import { NextResponse, type NextRequest } from 'next/server';
import { callBrain } from '@/lib/brainCall';

// HQ Sync for team members' PCs (HQ Brain P3; public, see middleware PUBLIC '/api/brain'): manifest / file / upload.
// The body carries the device token; the brain service checks it and the person's live grants for every file.
export const dynamic = 'force-dynamic';
const MAX = 700 * 1024; // a 512 KB file plus JSON overhead

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!['manifest', 'file', 'upload'].includes(action)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw.replace(/^﻿/, '')); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const r = await callBrain<Record<string, unknown>>(`/sync/${action}`, { method: 'POST', body, timeoutMs: action === 'upload' ? 90_000 : 30_000 });
  return NextResponse.json(r.body, { status: r.status || 502 });
}

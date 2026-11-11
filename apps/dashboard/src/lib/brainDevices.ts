// HQ Brain devices (P1): the setup checklist, device health in plain words, round-trip stages. Pure, so it is tested
// (brainDevices.test.ts) and shared by the Devices page, the setup wizard and the Brain home panel.
import { ago, type BrainConnection } from './brainView';

export type StepStatus = 'wait' | 'run' | 'done' | 'fail' | 'skip';
export interface StepState { s: StepStatus; detail?: string; at?: string }
export type Track = 'owner' | 'member';

export interface BrainDevice {
  id: string; name: string; kind: 'pc' | 'claude'; owner_label: string; track: Track;
  setup_expires_at: string | null; setup_used_at: string | null;
  checklist: Record<string, StepState>; info: Record<string, string>;
  roundtrip: { written_at?: string; pushed_at?: string; indexed_at?: string; readable_at?: string };
  created_at: string; last_seen_at: string | null; last_pull_at: string | null; last_push_at: string | null;
  last_sync_error: string | null; ready_at: string | null; revoked_at: string | null;
  connected_at: string | null; tested_at: string | null;
}

export interface StepDef { id: string; label: string; hint: string; optional?: boolean; ownerOnly?: boolean }

/** The installer's checklist, in the order it runs (apps/brain/src/setup/installer.ts). */
export const PC_STEPS: StepDef[] = [
  { id: 'claude', label: 'Claude desktop app', hint: 'Found on this computer' },
  { id: 'ps', label: 'PowerShell 5.1', hint: 'Built into Windows' },
  { id: 'git', label: 'Git for Windows', hint: 'Signed installer, signature checked', ownerOnly: true },
  { id: 'python', label: 'Python 3', hint: 'Only for the design skills', optional: true },
  { id: 'folder', label: 'Vault folder', hint: 'Picked and saved, no hard-coded drive' },
  { id: 'clone', label: 'Copy of the vault', hint: 'Downloaded from GitHub' },
  { id: 'cmds', label: 'Claude Code commands + session hook', hint: '/load /save /recall /projects /new-project' },
  { id: 'task', label: 'Background sync every 15 min', hint: 'Also at sign-in and after each session' },
  { id: 'mcp', label: 'HQ Brain in Claude Code', hint: 'Written to ~/.claude.json, no CLI needed' },
];

export const stepsFor = (track: Track): StepDef[] => PC_STEPS.filter((s) => track === 'owner' || !s.ownerOnly);
export const stepState = (d: Pick<BrainDevice, 'checklist'>, id: string): StepState => d.checklist?.[id] ?? { s: 'wait' };

export function installProgress(d: Pick<BrainDevice, 'checklist' | 'track'>): { done: number; total: number; failed: StepDef | null; allDone: boolean } {
  const steps = stepsFor(d.track);
  const done = steps.filter((s) => ['done', 'skip'].includes(stepState(d, s.id).s)).length;
  const failed = steps.find((s) => stepState(d, s.id).s === 'fail') ?? null;
  return { done, total: steps.length, failed, allDone: done === steps.length };
}

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'setup';
export interface DeviceHealth { level: HealthLevel; label: string; why: string }

const latest = (...xs: Array<string | null | undefined>) => xs.filter(Boolean).sort().at(-1) ?? null;
const MIN = 60_000;

/** One line a person can act on: green under 30 min since the last sync, amber under a day, red after that. */
export function deviceHealth(d: BrainDevice, now = Date.now()): DeviceHealth {
  if (d.kind === 'claude') {
    if (d.tested_at) return { level: 'ok', label: 'Connected', why: `Approved and tested ${ago(d.tested_at, now)}.` };
    if (d.connected_at) return { level: 'setup', label: 'Approved', why: 'Say "load <project>" in Claude to finish the test.' };
    return { level: 'setup', label: 'Waiting', why: 'Connect HQ Brain in the Claude app, then approve it on HQ.' };
  }
  if (!d.ready_at) {
    const failed = installProgress(d).failed ?? (stepState(d, 'roundtrip').s === 'fail' ? { label: 'Round-trip test' } as StepDef : null);
    if (failed) return { level: 'bad', label: 'Setup stopped', why: `${failed.label}: ${stepState(d, failed.id ?? 'roundtrip').detail || 'failed'}` };
    if (!d.setup_used_at && d.setup_expires_at && Date.parse(d.setup_expires_at) < now) return { level: 'bad', label: 'Link expired', why: 'Create a new setup link and run it on the computer.' };
    if (!d.setup_used_at) return { level: 'setup', label: 'Waiting', why: 'Run the setup line on the computer.' };
    return { level: 'setup', label: 'Setting up', why: `${installProgress(d).done} of ${installProgress(d).total} steps done.` };
  }
  const last = latest(d.last_pull_at, d.last_push_at);
  const age = last ? now - Date.parse(last) : Number.POSITIVE_INFINITY;
  if (age > 24 * 60 * MIN) return { level: 'bad', label: 'Not syncing', why: d.last_sync_error ? `Last error: ${d.last_sync_error}` : `No sync since ${ago(last, now)}. Is the computer on?` };
  if (d.last_sync_error && d.last_seen_at && now - Date.parse(d.last_seen_at) < 60 * MIN) return { level: 'warn', label: 'Sync problem', why: d.last_sync_error };
  if (age > 30 * MIN) return { level: 'warn', label: 'Behind', why: `Last sync ${ago(last, now)}. Usually every 15 minutes.` };
  return { level: 'ok', label: 'Healthy', why: `Synced ${ago(last, now)}.` };
}

/** An approval from more than a week ago that was never used: probably a leftover; offer to revoke it. */
export const staleConnection = (c: BrainConnection, now = Date.now()) => !c.last_used_at && now - Date.parse(c.approved_at) > 7 * 24 * 60 * MIN;

export interface RoundTripStage { id: 'written_at' | 'pushed_at' | 'indexed_at' | 'readable_at'; label: string; detail: string; at: string | null; seconds: number | null }

/** PC → GitHub → Brain → readable, with seconds since the note was written. */
export function roundTripStages(d: Pick<BrainDevice, 'roundtrip'>): RoundTripStage[] {
  const rt = d.roundtrip ?? {};
  const t0 = rt.written_at ? Date.parse(rt.written_at) : null;
  const sec = (at?: string) => (at && t0 !== null ? Math.max(0, Math.round((Date.parse(at) - t0) / 1000)) : null);
  return [
    { id: 'written_at', label: 'This PC', detail: 'Writes a test note', at: rt.written_at ?? null, seconds: rt.written_at ? 0 : null },
    { id: 'pushed_at', label: 'GitHub', detail: 'Receives it', at: rt.pushed_at ?? null, seconds: sec(rt.pushed_at) },
    { id: 'indexed_at', label: 'HQ Brain', detail: 'Indexes it', at: rt.indexed_at ?? null, seconds: sec(rt.indexed_at) },
    { id: 'readable_at', label: 'Claude', detail: 'Can read it back', at: rt.readable_at ?? null, seconds: sec(rt.readable_at) },
  ];
}

export const SETUP_ORIGIN = 'https://hq.rizehub.ph';
export const setupCommand = (code: string, origin = SETUP_ORIGIN) => `irm ${origin}/setup/${code} | iex`;

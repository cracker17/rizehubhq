// Test helpers for the dev tools: temp workspaces, fake fetch, fake process runner, fake vault. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import type { DevEnv, RunOptions, RunResult } from './env';
import { defaultSandboxPath } from './env';
import { createDevTools } from '../tools/dev';
import { loadKeyring, seal, type Keyring } from '../vault/crypto';
import { FakeVaultStore } from '../vault/fakeStore';
import type { NewCredential } from '../vault/store';
import type { ToolContext } from '../runner';
import { loadRole } from '../roles';
import { makeDeps, mockModel } from '../testing';

export interface FetchCall { url: string; method: string; headers: Headers; body: string }
export interface RunCall { file: string; args: string[]; opts: RunOptions }

export function tmpDir(prefix = 'rzh-dev-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function fakeEnv(o: {
  fetch?: (c: FetchCall) => Response | Promise<Response>;
  run?: (c: RunCall) => Partial<RunResult>;
  env?: Record<string, string>;
  vault?: DevEnv['vault'];
} = {}) {
  const fetchCalls: FetchCall[] = [];
  const runCalls: RunCall[] = [];
  const sleeps: number[] = [];
  const root = tmpDir();
  const helper = tmpDir('rzh-helper-');
  const env: DevEnv = {
    workspacesDir: path.join(root, 'workspaces'),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const c: FetchCall = {
        url: String(url), method: (init?.method ?? 'GET').toUpperCase(), headers: new Headers(init?.headers),
        body: init?.body === undefined ? '' : typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array).toString('utf8'),
      };
      fetchCalls.push(c);
      if (!o.fetch) throw new Error(`unexpected fetch ${c.method} ${c.url}`);
      return o.fetch(c);
    }) as typeof fetch,
    run: async (file, args, opts) => {
      const c = { file, args, opts };
      runCalls.push(c);
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...(o.run?.(c) ?? {}) };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    env: o.env ?? {},
    vault: o.vault ?? { store: () => { throw new Error('no vault in this test'); }, keyring: () => null },
    helperDir: () => helper,
    sandboxPath: defaultSandboxPath(),
  };
  return { env, fetchCalls, runCalls, sleeps, root, helper };
}

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

export const CLIENT = '0c000000-0000-4000-8000-0000000000aa';

/** Fake vault with one client and helpers to add sealed credentials granted to an agent. */
export function fakeVault() {
  const kr: Keyring = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
  const store = new FakeVaultStore();
  store.addClient(CLIENT, 'Madam Muse', 'madam-muse');
  const add = (c: Partial<NewCredential> & { secret: string; platform: string }) => {
    const id = randomUUID();
    void store.insertCredential({
      id, clientId: CLIENT, label: `${c.platform} access`, loginUrl: null, username: null, secretType: 'api_token', twofaMethod: 'none',
      scopeNotes: null, urlAllowlist: [], expiresAt: null, grants: ['shopify-dev', 'webflow-dev', 'wordpress-dev', 'fullstack-dev'],
      ...c, sealed: seal(c.secret, kr, id),
    });
    return id;
  };
  return { store, kr, add, vault: { store: () => store, keyring: () => kr } as DevEnv['vault'] };
}

/** Dev tools for a working task of `agent` on the Madam Muse client, with injected fakes. */
export function devSetup(env: DevEnv, agent = 'shopify-dev', website: string | null = 'https://madammuse.co') {
  const deps = makeDeps({ model: mockModel([]) });
  deps.db.clients.set(CLIENT, { id: CLIENT, name: 'Madam Muse', slug: 'madam-muse', platforms: ['shopify'], website, service_package: null, status: 'active', notes: null });
  const task = deps.db.addTask({ agent_id: agent, client_id: CLIENT, status: 'working', work_type: 'shopify-section' });
  const ctx: ToolContext = { task, role: loadRole(agent), deps, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 } };
  const tools = createDevTools(ctx, env);
  return { deps, task, ctx, tools, jailDir: path.join(env.workspacesDir, task.id) };
}

export async function run(tools: ToolSet, name: string, input: unknown): Promise<string> {
  return String(await tools[name]!.execute!(input as never, { toolCallId: 't', messages: [] }));
}

// pnpm --filter worker eval:roles [--role writer[,sales]] [--live] [--max-rounds 3] [--threshold 85] [--out reports/eval]
//                                  [--fixtures dir] [--quiet]
//   (root shortcut: pnpm eval:roles -- …)
//
// Offline (default): deterministic scripted model, no keys, no network: runs in CI.
// --live: the configured providers (config/models.yaml + MODEL_PROFILE + keys from the env or the repo's .env). Fails with
// exit code 2 and a clear message when a role has no usable model (missing key, budget 0 on a paid profile, …).
// Either way: in-memory HQ database (nothing reaches Supabase, no approval can execute), the mock RizeHub, and a scratch
// copy of brain/ + a temp workspaces dir, so a live run cannot change the repo.
// Output: scorecard JSON + markdown under reports/eval/ (gitignored). Exit 1 when any task did not pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVAL_ROLES, isEvalRole, type EvalRole } from './fixtures';

export interface CliArgs {
  roles: EvalRole[];
  live: boolean;
  maxRounds: number;
  threshold: number | null;
  out: string | null;
  fixturesDir: string | null;
  quiet: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.filter((a) => a !== '--');
  const out: CliArgs = { roles: [], live: false, maxRounds: 3, threshold: null, out: null, fixturesDir: null, quiet: false };
  const value = (i: number, name: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const take = () => inline ?? value(i++, flag);
    switch (flag) {
      case '--role': case '--roles':
        for (const r of take().split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!isEvalRole(r)) throw new UsageError(`unknown role "${r}" (one of ${EVAL_ROLES.join(', ')})`);
          if (!out.roles.includes(r)) out.roles.push(r);
        }
        break;
      case '--live': out.live = true; break;
      case '--offline': out.live = false; break;
      case '--max-rounds': {
        const n = Number(take());
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new UsageError('--max-rounds must be an integer 1-5');
        out.maxRounds = n; break;
      }
      case '--threshold': {
        const n = Number(take());
        if (!Number.isInteger(n) || n < 0 || n > 100) throw new UsageError('--threshold must be an integer 0-100');
        out.threshold = n; break;
      }
      case '--out': out.out = take(); break;
      case '--fixtures': out.fixturesDir = take(); break;
      case '--quiet': case '-q': out.quiet = true; break;
      default: throw new UsageError(`unknown option "${a}"`);
    }
  }
  if (!out.roles.length) out.roles = [...EVAL_ROLES];
  return out;
}

const ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * Env for an eval run, set BEFORE the worker modules (config.ts reads process.env at import): live runs read the
 * repo's .env for keys; both modes use the mock RizeHub, a scratch brain/ copy and a temp workspaces dir.
 */
export function prepareEnv(live: boolean, env: NodeJS.ProcessEnv = process.env): { scratch: string } {
  if (live) {
    const file = path.join(ROOT, '.env');
    if (fs.existsSync(file)) {
      try { process.loadEnvFile(file); } catch (e) { console.warn(`[eval] could not read ${file}: ${(e as Error).message}`); }
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rizehubhq-eval-'));
  const brainSrc = env.BRAIN_DIR ?? path.join(ROOT, 'brain');
  const brain = path.join(scratch, 'brain');
  if (fs.existsSync(brainSrc)) fs.cpSync(brainSrc, brain, { recursive: true });
  else fs.mkdirSync(brain);
  env.BRAIN_DIR = brain;
  env.WORKSPACES_DIR = path.join(scratch, 'workspaces');
  fs.mkdirSync(env.WORKSPACES_DIR);
  env.RIZEHUB_API_URL = 'mock'; // never a real RizeHub from an eval (CLAUDE.md rule 9)
  return { scratch };
}

async function cli() {
  let args: CliArgs;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`eval:roles: ${(e as Error).message}`);
    process.exit(2);
  }
  const { scratch } = prepareEnv(args.live);
  try {
    const { main } = await import('./main');
    process.exitCode = await main(args);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}

// node --test scripts/deploy.test.mjs  (part of pnpm test): pnpm check:deploy helpers + a fast full run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caddySites, contextCopies, dockerignored, nginxSites, parseDockerfile } from './check-deploy.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

test('Dockerfile parsing: continuations joined, comments dropped, --from copies ignored, JSON form supported', () => {
  const df = [
    '# syntax=docker/dockerfile:1.7',
    'FROM node:22 AS base',
    'COPY pnpm-lock.yaml pnpm-workspace.yaml ./',
    'RUN apt-get update \\',
    '  # a comment inside a continuation',
    ' && echo hi',
    'COPY --chown=node:node agents ./agents',
    'COPY --from=build --chown=node:node /repo/apps/x/.next ./',
    'COPY ["apps/bot", "apps/bot"]',
    'ENV A=1 \\',
    '    B=2',
  ].join('\n');
  const ins = parseDockerfile(df);
  assert.deepEqual(ins.map((i) => i.op), ['FROM', 'COPY', 'RUN', 'COPY', 'COPY', 'COPY', 'ENV']);
  assert.equal(ins[2].args, 'apt-get update && echo hi');
  assert.equal(ins[6].args, 'A=1 B=2');
  assert.deepEqual(contextCopies(ins).map((c) => c.src), ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'agents', 'apps/bot']);
});

test('.dockerignore: parent-dir matches, ** patterns, negation (last rule wins)', () => {
  const ig = '**/node_modules\n.env.*\n!.env.example\ndeploy\ndocs\n# comment\n';
  assert.equal(dockerignored('deploy/hermes/Dockerfile', ig), true);
  assert.equal(dockerignored('apps/worker/node_modules/x', ig), true);
  assert.equal(dockerignored('.env.worker', ig), true);
  assert.equal(dockerignored('.env.example', ig), false);
  assert.equal(dockerignored('apps/worker', ig), false);
  assert.equal(dockerignored('brain', ig), false);
});

test('proxy parsing: only active (uncommented) Caddy sites and nginx server_names count', () => {
  const caddy = 'hq.rizehub.ph {\n\treverse_proxy 127.0.0.1:3100\n}\n# rizehub.ph {\n# \treverse_proxy 127.0.0.1:8080\n# }\n';
  assert.deepEqual(caddySites(caddy), { sites: ['hq.rizehub.ph'], upstreams: ['127.0.0.1:3100'] });
  assert.deepEqual(caddySites('a.example, b.example {\n}\n').sites, ['a.example', 'b.example']);
  const ng = 'server {\n  server_name hq.rizehub.ph;\n  # server_name old.example;\n  location / { proxy_pass http://127.0.0.1:3100; }\n}\n';
  assert.deepEqual(nginxSites(ng), { names: ['hq.rizehub.ph'], upstreams: ['http://127.0.0.1:3100'] });
});

test('pnpm check:deploy (without db + docker) passes on the committed deploy kit', () => {
  const r = spawnSync(process.execPath, [path.join(DIR, 'check-deploy.mjs'), '--skip-db', '--skip-docker'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 failed/);
  const bad = spawnSync(process.execPath, [path.join(DIR, 'check-deploy.mjs'), '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

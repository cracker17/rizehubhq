// Jail guard for Claude Code's native file tools (CLAUDE_FILE_TOOLS=native).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openJail } from '../dev/jail';
import { checkNativeFileCall, jailRel } from './guard';

function jail() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-guard-'));
  const j = openJail(dir, 'task-1');
  fs.mkdirSync(path.join(j.root, 'src'));
  fs.writeFileSync(path.join(j.root, 'src', 'app.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret');
  return { dir, j };
}

test('guard: Read/Edit/Write only inside the task workspace', () => {
  const { dir, j } = jail();
  const ok = (tool: string, input: unknown) => assert.equal(checkNativeFileCall(tool, input, j), null, `${tool} ${JSON.stringify(input)}`);
  const no = (tool: string, input: unknown, re: RegExp) => assert.match(String(checkNativeFileCall(tool, input, j)), re, `${tool} ${JSON.stringify(input)}`);
  ok('Read', { file_path: path.join(j.root, 'src', 'app.ts') });
  ok('Read', { file_path: 'src/app.ts' });
  ok('Write', { file_path: path.join(j.root, 'new', 'file.ts'), content: 'x' });
  ok('Edit', { file_path: 'src/app.ts', old_string: 'x', new_string: 'y' });
  no('Read', { file_path: path.join(dir, 'outside.txt') }, /outside your workspace/);
  no('Read', { file_path: '../outside.txt' }, /outside your workspace/);
  no('Read', { file_path: os.homedir() }, /outside your workspace/);
  no('Read', { file_path: path.join(j.root, '.env') }, /secret/);
  no('Read', { file_path: 'config/id_rsa' }, /secret/);
  no('Write', { file_path: '.git/config', content: 'x' }, /\.git internals/);
  no('Write', { file_path: j.root, content: 'x' }, /workspace root/);
  no('Read', {}, /needs file_path/);
  no('Bash', { command: 'ls' }, /not available/);
  no('NotebookEdit', { notebook_path: 'a.ipynb' }, /not available/);
  assert.equal(jailRel(j, undefined), '.');
});

test('guard: symlinks out of the workspace are refused', (t) => {
  const { dir, j } = jail();
  try { fs.symlinkSync(dir, path.join(j.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('symlinks not permitted here'); return; }
  assert.match(String(checkNativeFileCall('Read', { file_path: 'escape/outside.txt' }, j)), /outside the workspace \(symlink\)/);
  assert.match(String(checkNativeFileCall('Write', { file_path: 'escape/x.txt', content: 'x' }, j)), /outside the workspace/);
  assert.match(String(checkNativeFileCall('Grep', { pattern: 'x', path: 'escape' }, j)), /outside the workspace/);
});

test('guard: Glob/Grep stay inside; Grep refuses folders holding secret files', () => {
  const { dir, j } = jail();
  assert.equal(checkNativeFileCall('Glob', { pattern: '**/*.ts' }, j), null);
  assert.equal(checkNativeFileCall('Glob', { pattern: '*.ts', path: 'src' }, j), null);
  assert.match(String(checkNativeFileCall('Glob', { pattern: '/etc/**' }, j)), /relative/);
  assert.match(String(checkNativeFileCall('Glob', { pattern: '../**' }, j)), /"\.\."/);
  assert.match(String(checkNativeFileCall('Glob', { pattern: '*', path: dir }, j)), /outside your workspace/);
  assert.equal(checkNativeFileCall('Grep', { pattern: 'x' }, j), null);
  assert.match(String(checkNativeFileCall('Grep', { pattern: 'x', glob: '../*' }, j)), /"\.\."/);
  fs.writeFileSync(path.join(j.root, 'src', '.env'), 'KEY=1');
  assert.match(String(checkNativeFileCall('Grep', { pattern: 'KEY' }, j)), /secret-looking file \(src\/\.env\)/);
  assert.match(String(checkNativeFileCall('Grep', { pattern: 'KEY', path: 'src/.env' }, j)), /secret/);
  assert.equal(checkNativeFileCall('Grep', { pattern: 'x', path: 'src/app.ts' }, j), null, 'a single file is fine');
});

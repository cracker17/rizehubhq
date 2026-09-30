// Secret scan: the same patterns as the vault's own sync (claude-memory-vault/scripts/sync.ps1), so a file the PC would
// refuse to back up is also never indexed here. PowerShell's -match is case-insensitive, hence the `i` flag on all of them.
// The brain stores where a secret lives ("in the VPS .env"), never the secret itself.

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/i },
  { name: 'openai-key', re: /sk-(proj-)?[A-Za-z0-9]{32,}/i },
  { name: 'github-token', re: /ghp_[A-Za-z0-9]{30,}/i },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{30,}/i },
  { name: 'github-oauth', re: /gho_[A-Za-z0-9]{30,}/i },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/i },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/i },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { name: 'jwt', re: /eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./i },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/i },
  { name: 'telegram-bot-token', re: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/i },
  { name: 'assigned-secret', re: /(api[_-]?key|secret|password|passwd|service_role)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{16,}/i },
];

/** Name of the first pattern the text matches, or null when it looks clean. */
export function findSecret(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.name;
  return null;
}

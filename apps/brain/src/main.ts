// Shared boot for production (index.ts) and local runs (dev.ts): first sync, HTTP API, poll fallback.
import type { BrainConfig } from './config';
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import { createBrainService } from './service';
import { createHttpServer } from './http';
import { applyApprovedProposals } from './proposals';

export const log = (msg: string) => console.log(`[brain] ${new Date().toISOString()} ${msg}`);

export async function start(config: BrainConfig, store: Store, embedder: Embedder | null) {
  const git = {
    repoUrl: config.repoUrl, branch: config.branch, dir: config.vaultDir,
    deployKeyPath: config.deployKeyPath, knownHostsPath: config.knownHostsPath,
  };
  const service = createBrainService({ store, embedder, git, log, timeZone: config.timeZone });
  log(`vault ${config.repoUrl || '(no BRAIN_REPO_URL)'} @ ${config.branch} → ${config.vaultDir}; embeddings ${embedder ? embedder.model : 'OFF (keyword only)'}`);
  // Serve right away (health shows "running"); the first sync clones/pulls and indexes in the background.
  const server = createHttpServer({
    store, embedder, service, internalSecret: config.internalSecret, webhookSecret: config.webhookSecret, branch: config.branch, log,
    vaultDir: config.vaultDir, redirectHosts: config.oauthRedirectHosts,
  });
  server.listen(config.httpPort, () => log(`API on :${config.httpPort}`));
  service.trigger({ reason: 'boot' });
  const poll = setInterval(() => service.trigger({ reason: 'poll' }), config.pollSeconds * 1000);
  poll.unref();
  // Approved agent proposals (M14.4): checked every 20 s; runs one batch at a time.
  let applying = false;
  const proposals = setInterval(() => {
    if (applying) return;
    applying = true;
    void applyApprovedProposals({ store, service, log }).finally(() => { applying = false; });
  }, 20_000);
  proposals.unref();
  const stop = (sig: string) => { log(`${sig}: shutting down`); clearInterval(poll); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', () => { clearInterval(proposals); stop('SIGTERM'); });
  process.once('SIGINT', () => stop('SIGINT'));
  return { server, service };
}

# Auto-deploy (pull model)

The VPS deploys `main` by itself: every 2 minutes `deploy/autodeploy.sh` (as `rizehq`) fetches `origin/main`, asks the
public GitHub API whether the **CI** workflow passed for that exact commit, and only then runs
`deploy/update.sh` with `TARGET_SHA` pinned to it (build → health check → automatic rollback). A failed CI or a
failed deploy is logged once and that commit is skipped; the next green commit deploys.

Nothing in GitHub can reach the server: no SSH key or secret is stored there. (The push-style
`.github/workflows/deploy.yml` stays off; don't enable both.)

## Install (root, once — one line at a time)

```bash
install -m 644 /home/rizehq/rizehub-hq/deploy/systemd/rizehq-autodeploy.service /home/rizehq/rizehub-hq/deploy/systemd/rizehq-autodeploy.timer /etc/systemd/system/
```
```bash
systemctl daemon-reload && systemctl enable --now rizehq-autodeploy.timer
```

## Use

| What | Command |
|---|---|
| Is it on? next check? | `systemctl list-timers rizehq-autodeploy.timer` |
| What did it do? | `journalctl -u rizehq-autodeploy --since today` |
| Pause (e.g. before a risky merge) | `sudo -u rizehq touch /home/rizehq/rizehub-hq/.autodeploy-off` |
| Resume | `sudo -u rizehq rm /home/rizehq/rizehub-hq/.autodeploy-off` |
| Retry a skipped commit | `sudo -u rizehq rm /home/rizehq/rizehub-hq/.autodeploy-failed` |
| Turn off | `systemctl disable --now rizehq-autodeploy.timer` |

**Migrations are still applied by hand** (Supabase SQL editor / MCP): apply a new migration *before* pushing the
commit that needs it, or pause auto-deploy until it is applied.

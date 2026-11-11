// The HQ Sync script for team members' PCs (P3), installed by the setup link's installer to
// %LOCALAPPDATA%\HQBrain\hq-sync.ps1 and run every 15 minutes by the "HQ Brain Sync" scheduled task.
// Windows PowerShell 5.1. It reads ~/.claude/hq-brain.json (server, device token, folder) and talks only to
// <server>/api/brain/sync/{manifest,file,upload}. State (path → sha at the last sync) lives next to the files.
//   1. files that left the manifest (deleted, or access revoked) are removed from the PC
//   2. every manifest file: same → skip; changed here and editable → upload (server keeps both on a conflict);
//      changed here but read-only → kept aside as *.local-copy.md, then the server version is downloaded
//   3. new .md files in an editable project folder are uploaded
// No backticks or "${" in the body (it is embedded in a JS template string).

export const HQ_SYNC_VERSION = '1.0.0';

export const HQ_SYNC_PS = String.raw`# HQ Brain Sync for team members. Keeps this PC's copy of your HQ Brain projects current.
param([string]$Config = '')
$HqSyncVersion = '1.0.0'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cfgPath = if ($Config) { $Config } else { Join-Path $HOME '.claude\hq-brain.json' }
if (-not (Test-Path -LiteralPath $cfgPath)) { exit 0 }
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $cfg.token -or -not $cfg.server -or -not $cfg.vaultPath) { exit 0 }
$root = $cfg.vaultPath
New-Item -ItemType Directory -Force -Path $root | Out-Null
$statePath = Join-Path $root '.hq-sync-state.json'
$logPath = Join-Path $root '.hq-sync.log'
$lock = Join-Path $env:TEMP 'hq-brain-sync.lock'
$utf8 = New-Object Text.UTF8Encoding($false)

function Log([string]$m) { Add-Content -LiteralPath $logPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }
function Api([string]$action, [hashtable]$body) {
  $body.token = $cfg.token
  $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))
  return Invoke-RestMethod -Method Post -Uri ($cfg.server.TrimEnd('/') + '/api/brain/sync/' + $action) -ContentType 'application/json' -Body $bytes -TimeoutSec 90
}
function Sha([string]$text) {
  $h = [Security.Cryptography.SHA256]::Create()
  return -join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') })
}
function ReadText([string]$p) { return [IO.File]::ReadAllText($p, $utf8) }
function WriteText([string]$p, [string]$t) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null; [IO.File]::WriteAllText($p, $t, $utf8) }
function LocalPath([string]$rel) { return Join-Path $root ($rel -replace '/', '\') }

if ((Test-Path -LiteralPath $lock) -and ((Get-Item -LiteralPath $lock).LastWriteTime -gt (Get-Date).AddMinutes(-10))) { exit 0 }
Set-Content -LiteralPath $lock -Value $PID
$err = ''; $down = 0; $up = 0; $removed = 0; $kept = 0
try {
  $state = @{}
  if (Test-Path -LiteralPath $statePath) { (Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } }
  $m = Api 'manifest' @{}
  $writable = @{}
  foreach ($p in @($m.projects)) { if ($p.access -eq 'write') { $writable[$p.slug] = $true } }
  $remote = @{}
  foreach ($f in @($m.files)) { $remote[$f.path] = $f.sha }

  # 1. gone from the manifest: deleted on the server, or your access to that project ended
  foreach ($rel in @($state.Keys)) {
    if ($remote.ContainsKey($rel)) { continue }
    $local = LocalPath $rel
    if (Test-Path -LiteralPath $local) { Remove-Item -LiteralPath $local -Force; $removed++ }
    $state.Remove($rel)
  }

  # 2. every file you may have
  foreach ($rel in @($remote.Keys)) {
    $local = LocalPath $rel
    $rsha = $remote[$rel]
    $base = $state[$rel]
    $slug = ($rel -split '/')[1]
    if (Test-Path -LiteralPath $local) {
      $text = ReadText $local
      $lsha = Sha $text
      if ($lsha -eq $rsha) { $state[$rel] = $rsha; continue }
      if ($base -and $lsha -ne $base) {
        if ($writable.ContainsKey($slug)) {
          try {
            $r = Api 'upload' @{ path = $rel; content = $text; base_sha = $base }
            if ($r.conflict) {
              # both sides changed: the server kept your version as a conflict copy; take theirs here, keep yours beside it
              WriteText (LocalPath $r.path) $text
              $state[$r.path] = Sha $text
              $kept++
            } else { $state[$rel] = $r.sha; $up++; continue }
          } catch { Log ("upload failed for " + $rel + ": " + $_.Exception.Message); continue }
        } else {
          Copy-Item -LiteralPath $local -Destination ($local -replace '\.md$', '.local-copy.md') -Force
          $kept++
        }
      }
    }
    $f = Api 'file' @{ path = $rel }
    WriteText $local $f.content
    $state[$rel] = $f.sha
    $down++
  }

  # 3. new notes you wrote in a project you can edit
  foreach ($slug in @($writable.Keys)) {
    $dir = Join-Path $root ("projects\" + $slug)
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -Recurse -File -Filter '*.md')) {
      $rel = 'projects/' + $slug + '/' + ($file.FullName.Substring($dir.Length + 1) -replace '\\', '/')
      if ($remote.ContainsKey($rel) -or $state.ContainsKey($rel) -or $rel -match '\.(local-copy|conflict-[^/]+)\.md$') { continue }
      try {
        $r = Api 'upload' @{ path = $rel; content = (ReadText $file.FullName); base_sha = $null }
        $state[$r.path] = $r.sha
        $up++
      } catch { Log ("upload failed for " + $rel + ": " + $_.Exception.Message) }
    }
  }

  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 3), $utf8)
  Log ("synced: " + $down + " down, " + $up + " up, " + $removed + " removed, " + $kept + " kept aside")
} catch {
  $err = $_.Exception.Message
  Log ("sync failed: " + $err)
} finally {
  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  try {
    $s = if ($err) { 'fail' } else { 'done' }
    $detail = if ($err) { $err } else { "$down down, $up up, $removed removed" }
    $hb = @{ token = $cfg.token; step = 'hqsync'; s = $s; detail = $detail; error = $err; pull_ok = (-not $err); push_ok = (-not $err) }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($hb | ConvertTo-Json -Compress))
    Invoke-RestMethod -Method Post -Uri ($cfg.server.TrimEnd('/') + '/api/brain/device') -ContentType 'application/json' -Body $bytes -TimeoutSec 15 | Out-Null
  } catch { }
}
`;

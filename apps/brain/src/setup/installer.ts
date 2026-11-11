// The one-line installer behind https://hq.rizehub.ph/setup/<code> (`irm … | iex`). Rendered per device after the setup
// link is redeemed: it carries that device's token (heartbeats only; revocable in HQ) and nothing else secret.
// Windows PowerShell 5.1 compatible. Every step reports {step, s, detail} so the HQ wizard ticks itself.
// Lessons from setting up the second PC (2026-11-11): no `claude` CLI on desktop-only installs (write ~/.claude.json
// directly), winget hangs (download the signed Git release and check its signature), no E: drive (pick the folder and
// save it in ~/.claude/hq-brain.json), Git sign-in needs an interactive window (this script runs in one).

export const INSTALLER_VERSION = '1.0.0';

export interface InstallerInput {
  /** public HQ origin, e.g. https://hq.rizehub.ph */
  server: string;
  token: string;
  deviceId: string;
  name: string;
  track: 'owner' | 'member';
  /** HTTPS clone URL of the vault (owner track) */
  repoUrl: string;
}

/** A PowerShell single-quoted literal: ' doubles, control characters go. */
export const psq = (s: string) => `'${s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/'/g, "''")}'`;

/** What `iex` prints when the link can't be used (expired, used, unknown). Still a valid script. */
export function errorScript(message: string): string {
  return `Write-Host ''\nWrite-Host ${psq(`HQ Brain setup: ${message}`)} -ForegroundColor Yellow\nWrite-Host 'Open HQ > Brain > Devices and create a new setup link.' -ForegroundColor Yellow\n`;
}

/** HTTPS form of the vault remote (the PC signs in to GitHub in the browser; SSH keys are not set up by this script). */
export function httpsRepoUrl(repoUrl: string): string {
  const m = /^git@github\.com:(.+?)(\.git)?$/.exec(repoUrl.trim());
  if (m) return `https://github.com/${m[1]}.git`;
  return /^https:\/\/github\.com\//.test(repoUrl.trim()) ? repoUrl.trim() : 'https://github.com/cracker17/claude-memory-vault.git';
}

export function renderInstaller(i: InstallerInput): string {
  const head = [
    `# HQ Brain setup for "${i.name.replace(/[\r\n]/g, ' ')}" (installer ${INSTALLER_VERSION}).`,
    '# Made for this computer only. It reports each step to HQ so the setup page ticks itself.',
    '$ErrorActionPreference = \'Stop\'',
    '$ProgressPreference = \'SilentlyContinue\'',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `$Server = ${psq(i.server.replace(/\/+$/, ''))}`,
    `$Token = ${psq(i.token)}`,
    `$DeviceId = ${psq(i.deviceId)}`,
    `$DeviceName = ${psq(i.name)}`,
    `$Track = ${psq(i.track)}`,
    `$RepoUrl = ${psq(httpsRepoUrl(i.repoUrl))}`,
    `$InstallerVersion = ${psq(INSTALLER_VERSION)}`,
  ].join('\n');
  return `${head}\n${BODY}`;
}

// The script body is static (no interpolation): everything device-specific is in the variables above.
// No backticks inside (String.raw would keep a backslash before an escaped one) and no "${" sequences.
const BODY = String.raw`
function Report([string]$Step, [string]$S, [string]$Detail, [hashtable]$Extra) {
  $body = @{ token = $Token; step = $Step; s = $S; detail = $Detail }
  if ($Extra) { foreach ($k in $Extra.Keys) { $body[$k] = $Extra[$k] } }
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress))
    Invoke-RestMethod -Method Post -Uri "$Server/api/brain/device" -ContentType 'application/json' -TimeoutSec 20 -Body $bytes | Out-Null
  } catch { Write-Host "   (could not reach HQ to report this step: $($_.Exception.Message))" -ForegroundColor DarkGray }
}
function Title([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

Write-Host ''
Write-Host "HQ Brain setup: $DeviceName" -ForegroundColor White
Write-Host 'Keep this window open. Your HQ page ticks each step as it finishes.' -ForegroundColor Gray
Report 'installer' 'done' "Installer $InstallerVersion started" @{ info = @{ installer = $InstallerVersion; os = [Environment]::OSVersion.VersionString; computer = $env:COMPUTERNAME; ps = $PSVersionTable.PSVersion.ToString() } }

# 1. Claude desktop app
Title 'Claude desktop app'
function Find-Claude {
  $hits = @()
  $hits += @(Get-ChildItem "$env:LOCALAPPDATA\AnthropicClaude" -Filter 'claude.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
  $hits += @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | Select-Object -First 1)
  return ($hits | Where-Object { $_ }).Count -gt 0
}
Report 'claude' 'run' 'Looking for the Claude app'
$claude = Find-Claude
for ($try = 0; -not $claude -and $try -lt 3; $try++) {
  Warn 'Claude is not installed yet. Opening the download page...'
  Start-Process 'https://claude.ai/download'
  Read-Host '   Install Claude, sign in, then press Enter here' | Out-Null
  $claude = Find-Claude
}
if ($claude) { Ok 'Found'; Report 'claude' 'done' 'Claude desktop app found' }
else { Warn 'Still not found. Continuing; install it later from https://claude.ai/download'; Report 'claude' 'fail' 'Not installed. Get it from claude.ai/download, then re-check from Devices.' }

# 2. PowerShell
Title 'PowerShell'
Ok "Version $($PSVersionTable.PSVersion)"
Report 'ps' 'done' "PowerShell $($PSVersionTable.PSVersion)"

# 3. Git (owner track only: members never need Git)
if ($Track -eq 'owner') {
  Title 'Git for Windows'
  Report 'git' 'run' 'Checking for Git'
  Refresh-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $installed = $false
    for ($try = 1; -not $installed -and $try -le 2; $try++) {
      try {
        Write-Host "   Downloading the signed Git installer (attempt $try)..."
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'hq-brain-installer' } -TimeoutSec 30
        $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
        if (-not $asset) { throw 'No 64-bit installer in the latest release' }
        $exe = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing -TimeoutSec 300
        $sig = Get-AuthenticodeSignature $exe
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Johannes Schindelin') { throw "Signature check failed ($($sig.Status))" }
        Write-Host '   Signature OK. Installing quietly (about a minute)...'
        $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "Installer exit code $($p.ExitCode)" }
        Refresh-Path
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $env:Path = "C:\Program Files\Git\cmd;$env:Path" }
        $installed = [bool](Get-Command git -ErrorAction SilentlyContinue)
      } catch {
        Warn $_.Exception.Message
        Report 'git' 'fail' ("Attempt $try failed: " + $_.Exception.Message)
      }
    }
    if (-not $installed) {
      Report 'git' 'fail' 'Could not install Git. Install it from git-scm.com/download/win, then create a new setup link.'
      Warn 'Install Git from https://git-scm.com/download/win and create a new setup link in HQ.'
      return
    }
  }
  $gv = (git --version) -replace 'git version ', ''
  Ok "Git $gv"
  Report 'git' 'done' "Git $gv" @{ info = @{ git = $gv } }
} else {
  Report 'git' 'skip' 'Not needed for team members'
}

# 4. Python (optional, design skills only)
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py -and $py.Source -notmatch 'WindowsApps') { Report 'python' 'done' 'Python found (design skills ready)' }
else { Report 'python' 'skip' 'Optional. Install from python.org if you use the design skills.' }

# 5. Folder
Title 'Vault folder'
$base = if (Test-Path 'E:\001 Personal Projects') { 'E:\001 Personal Projects' } elseif (Test-Path 'D:\') { 'D:\Personal Projects' } else { Join-Path $HOME 'Documents' }
$folderName = if ($Track -eq 'owner') { 'claude-memory-vault' } else { 'HQ Brain' }
$vault = Join-Path $base $folderName
New-Item -ItemType Directory -Force -Path $base | Out-Null
$cfgDir = Join-Path $HOME '.claude'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = [ordered]@{ server = $Server; deviceId = $DeviceId; deviceName = $DeviceName; track = $Track; vaultPath = $vault; token = $Token; installer = $InstallerVersion }
[IO.File]::WriteAllText((Join-Path $cfgDir 'hq-brain.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Ok $vault
Report 'folder' 'done' $vault @{ info = @{ vault_path = $vault } }

if ($Track -ne 'owner') {
  Report 'clone' 'fail' 'Team-member PC copies (HQ Sync) are not switched on yet. Use the Claude app for now.'
  Warn 'Team-member PC copies are coming soon. You can already use HQ Brain in the Claude app.'
  return
}

# 6. Clone (first GitHub sign-in happens here, in your browser)
Title 'Vault copy'
Report 'clone' 'run' 'Signing in to GitHub and downloading the vault'
Report 'github' 'run' 'A GitHub sign-in window may open in your browser'
try {
  if (Test-Path (Join-Path $vault '.git')) { git -C $vault pull --rebase --autostash -q 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'git pull failed' } }
  else { git clone -q $RepoUrl $vault 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'git clone failed (sign-in cancelled?)' } }
  $n = @(git -C $vault ls-files).Count
  Ok "$n files"
  Report 'github' 'done' 'Signed in to GitHub'
  Report 'clone' 'done' "$n files" @{ pull_ok = $true }
} catch {
  Report 'github' 'fail' 'GitHub sign-in did not finish'
  Report 'clone' 'fail' ($_.Exception.Message + '. Run this setup line again to retry.')
  Warn $_.Exception.Message
  return
}

# 7. Claude Code commands, session hook, background sync (the vault's own installer)
Title 'Commands, session hook and 15-minute sync'
Report 'cmds' 'run' 'Running the vault installer'
try {
  & (Join-Path $vault 'scripts\install.ps1') | Out-Host
  $cmds = @('load', 'save', 'recall', 'projects', 'new-project') | Where-Object { Test-Path (Join-Path $cfgDir "commands\$_.md") }
  Report 'cmds' 'done' ("/" + ($cmds -join ' /'))
} catch { Report 'cmds' 'fail' $_.Exception.Message; Warn $_.Exception.Message }
$task = Get-ScheduledTask -TaskName 'Claude Memory Vault Sync' -ErrorAction SilentlyContinue
if ($task) { Ok 'Background sync scheduled'; Report 'task' 'done' 'Every 15 minutes and at sign-in' }
else { Report 'task' 'fail' 'The sync task was not created. Run scripts\install.ps1 in the vault folder.' }

# 8. HQ Brain connector for Claude Code (no CLI needed)
Title 'HQ Brain in Claude Code'
try {
  $cj = Join-Path $HOME '.claude.json'
  if (Test-Path $cj) { Copy-Item $cj "$cj.bak-hq-brain" -Force; $j = Get-Content $cj -Raw -Encoding UTF8 | ConvertFrom-Json } else { $j = New-Object psobject }
  if (-not $j.PSObject.Properties['mcpServers']) { $j | Add-Member -NotePropertyName mcpServers -NotePropertyValue (New-Object psobject) }
  $entry = [pscustomobject]@{ type = 'http'; url = "$Server/mcp/brain" }
  if ($j.mcpServers.PSObject.Properties['hq-brain']) { $j.mcpServers.'hq-brain' = $entry } else { $j.mcpServers | Add-Member -NotePropertyName 'hq-brain' -NotePropertyValue $entry }
  [IO.File]::WriteAllText($cj, ($j | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
  Ok 'Added. In Claude Code type /mcp > hq-brain > Authenticate once.'
  Report 'mcp' 'done' 'Written to ~/.claude.json'
} catch { Report 'mcp' 'fail' $_.Exception.Message; Warn $_.Exception.Message }

# 9. Round trip: a small device note travels PC > GitHub > HQ Brain
Title 'Round-trip test'
$nonce = [guid]::NewGuid().ToString('N')
$devDir = Join-Path $vault 'devices'
New-Item -ItemType Directory -Force -Path $devDir | Out-Null
$note = @(
  '---', "device: $DeviceId", "roundtrip: $nonce", "updated: $((Get-Date).ToString('yyyy-MM-dd HH:mm'))", '---',
  "# Device: $DeviceName", '',
  "- Computer: $env:COMPUTERNAME", "- Windows: $([Environment]::OSVersion.Version)", "- Vault folder: $vault",
  "- Set up with HQ Brain installer $InstallerVersion", '',
  'This note proves the round trip PC > GitHub > HQ Brain. It is safe to keep.'
) -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $devDir "$DeviceId.md"), $note, (New-Object Text.UTF8Encoding($false)))
Report 'roundtrip' 'run' 'Test note written' @{ roundtrip = @{ nonce = $nonce; written_at = (Get-Date).ToUniversalTime().ToString('o') } }
& (Join-Path $vault 'scripts\sync.ps1') -Message 'device check' 2>&1 | Out-Null
git -C $vault fetch -q 2>&1 | Out-Null
$ahead = git -C $vault rev-list --count '@{u}..HEAD' 2>$null
if ("$ahead" -eq '0') {
  Ok 'Pushed. HQ is indexing it now; watch the setup page.'
  Report 'roundtrip' 'run' 'Pushed to GitHub, waiting for HQ Brain' @{ push_ok = $true; roundtrip = @{ pushed_at = (Get-Date).ToUniversalTime().ToString('o') } }
} else {
  Warn 'The test note did not reach GitHub yet. The 15-minute sync will retry.'
  Report 'roundtrip' 'fail' 'Push did not go through yet (see .sync.log in the vault folder)'
}

Write-Host ''
Write-Host 'Done. Go back to the HQ setup page to see the result. You can close this window.' -ForegroundColor Green
`;

param(
  [switch]$RunOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DaemonDir = Join-Path $Root 'daemon'
$ConfigExampleDir = Join-Path $DaemonDir 'config.example'
$ConfigDir = Join-Path $env:USERPROFILE '.geekgeekrun\config'
$StorageDir = Join-Path $env:USERPROFILE '.geekgeekrun\storage'
$StateDir = Join-Path $DaemonDir 'state'
$Port = 8788
$WorkbenchUrl = "http://127.0.0.1:$Port/"

function Say([string]$Message) {
  Write-Host "[Job Agent] $Message" -ForegroundColor Cyan
}

function Get-CurrentSessionId {
  try { return [int](Get-Process -Id $PID -ErrorAction Stop).SessionId } catch { return 0 }
}

function Assert-DesktopSession {
  # 这个启动器必须由用户在 Windows 桌面里双击运行。此前的跨会话转交会触发
  # 管理员权限错误，也会让浏览器窗口跑到看不见的会话；现已完全移除。
  if ((Get-CurrentSessionId) -le 0) {
    throw '检测到非桌面会话。请在笔记本桌面双击“Job-Agent-Workbench”，不要从后台或远程终端启动。'
  }
}

function Get-WorkbenchListenerSession {
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      try {
        return [int](Get-Process -Id $connection.OwningProcess -ErrorAction Stop).SessionId
      } catch {}
    }
  } catch {}
  return $null
}

function Stop-ConflictingWorkbench {
  $listenerSession = Get-WorkbenchListenerSession
  if ($null -eq $listenerSession -or $listenerSession -eq (Get-CurrentSessionId)) { return }

  Say "A workbench service is running in Windows session $listenerSession; stopping it before starting in the signed-in desktop session..."
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$WorkbenchUrl`api/shutdown" -TimeoutSec 3 | Out-Null
  } catch {}
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ($null -eq (Get-WorkbenchListenerSession)) { return }
  }
  throw 'The existing workbench service did not stop. Close the old Job Agent process, then run the launcher again.'
}

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Programs\nodejs\node.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Refresh-Environment {
  $extra = @(
    (Join-Path ${env:ProgramFiles} 'nodejs'),
    (Join-Path ${env:LOCALAPPDATA} 'Programs\nodejs'),
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $env:Path = (($env:Path -split ';') + $extra | Select-Object -Unique) -join ';'
}

function Install-WithWinget([string]$Id, [string]$Name) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (!$winget) {
    throw "winget was not found. Install Windows App Installer or install $Name manually."
  }
  Say "Installing $Name (Windows permission confirmation may appear)..."
  & $winget.Source install --id $Id --exact --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "$Name installation failed. winget exit code: $LASTEXITCODE." }
  Refresh-Environment
}

function Find-Chrome {
  $cmd = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Google\Chrome\Application\chrome.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Ensure-Environment {
  Refresh-Environment
  $node = Find-Node
  $nodeVersion = [version]'0.0.0'
  if ($node) {
    try { $nodeVersion = [version]((& $node --version).TrimStart('v')) } catch { $nodeVersion = [version]'0.0.0' }
  }
  if (!$node -or $nodeVersion -lt [version]'22.12.0') {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js 22.12+'
    $node = Find-Node
    if (!$node) { throw 'Node.js was installed but node.exe is not available. Run the launcher again.' }
  }
  $chrome = Find-Chrome
  if (!$chrome) {
    Install-WithWinget 'Google.Chrome' 'Google Chrome'
    $chrome = Find-Chrome
    if (!$chrome) { throw 'Chrome was installed but chrome.exe is not available. Run the launcher again.' }
  }
  return @{ Node = $node; Chrome = $chrome }
}

function Ensure-Config {
  New-Item -ItemType Directory -Force -Path $ConfigDir, $StorageDir, $StateDir | Out-Null
  Get-ChildItem -LiteralPath $ConfigExampleDir -Filter '*.json' -File | ForEach-Object {
    $target = Join-Path $ConfigDir $_.Name
    if (!(Test-Path -LiteralPath $target)) {
      Copy-Item -LiteralPath $_.FullName -Destination $target
    }
  }
}

function Ensure-Dependencies([string]$Node) {
  $marker = Join-Path $DaemonDir 'node_modules\puppeteer-extra\package.json'
  if (Test-Path -LiteralPath $marker) { return }
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$npm) { throw 'npm.cmd was not found. Re-run the launcher or reinstall Node.js.' }
  Say 'Installing project dependencies. System Chrome is used; no extra Chromium download...'
  $env:PUPPETEER_SKIP_DOWNLOAD = '1'
  Push-Location $DaemonDir
  try {
    & $npm.Source install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed. npm exit code: $LASTEXITCODE." }
  } finally { Pop-Location }
}

function Ensure-Shortcut {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (!$desktop) { return }
  $shortcutPath = Join-Path $desktop 'Job-Agent-Workbench.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $Root 'one-click-start.bat'
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = 'Job Agent Workbench'
  $shortcut.Save()
  Say "Desktop shortcut created: $shortcutPath"
}

function Start-Workbench([hashtable]$Runtime) {
  $env:GEEK_RUN_ROOT = $DaemonDir
  $env:GEEK_GEEK_RUN_CONFIG = $ConfigDir
  $env:GEEK_GEEK_RUN_STORAGE = $StorageDir
  $env:BOSS_DAEMON_STATE = $StateDir
  $env:BOSS_CHROME_PATH = $Runtime.Chrome
  Stop-ConflictingWorkbench
  $alreadyRunning = $false
  try { Invoke-WebRequest -UseBasicParsing -Uri "$WorkbenchUrl`api/worker" -TimeoutSec 2 | Out-Null; $alreadyRunning = $true } catch {}
  if (!$alreadyRunning) {
    Say 'Starting background service...'
    Start-Process -FilePath $Runtime.Node -ArgumentList 'index.mjs' -WorkingDirectory $DaemonDir -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 500
      try { Invoke-WebRequest -UseBasicParsing -Uri "$WorkbenchUrl`api/worker" -TimeoutSec 2 | Out-Null; $alreadyRunning = $true; break } catch {}
    }
  }
  if (!$alreadyRunning) { throw 'The background service did not start within 15 seconds. Check daemon\log\daemon.log.' }
  Start-Process $WorkbenchUrl
}

try {
  Assert-DesktopSession
  Say 'Checking runtime environment...'
  $runtime = Ensure-Environment
  Ensure-Config
  Ensure-Dependencies $runtime.Node
  Ensure-Shortcut
  Start-Workbench $runtime
  Say 'Done. The background service is running. Chrome stays visible for login and delivery.'
} catch {
  Write-Host "`n[Job Agent] Startup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Follow the message above, then run one-click-start.bat again.' -ForegroundColor Yellow
  exit 1
}


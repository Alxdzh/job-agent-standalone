import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON = path.join(ROOT, 'daemon')
const URL = 'http://127.0.0.1:8788/'

function startWindows() {
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'one-click-start.ps1'),
    '-RunOnly'
  ], { cwd: ROOT, stdio: 'inherit', windowsHide: false })
  process.exit(result.status ?? 1)
}

function openWorkbench() {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const result = spawnSync(opener, [URL], { stdio: 'ignore', detached: true })
  if (result.error) console.warn(`[Job Agent] Open ${URL} manually if the browser did not open.`)
}

async function waitForWorkbench() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`${URL}api/worker`)
      if (response.ok) return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function startUnix() {
  const env = {
    ...process.env,
    GEEK_RUN_ROOT: DAEMON,
    GEEK_GEEK_RUN_CONFIG: path.join(os.homedir(), '.geekgeekrun', 'config'),
    GEEK_GEEK_RUN_STORAGE: path.join(os.homedir(), '.geekgeekrun', 'storage'),
    BOSS_DAEMON_STATE: path.join(DAEMON, 'state')
  }
  const child = spawn(process.execPath, [path.join(DAEMON, 'index.mjs')], {
    cwd: DAEMON,
    env,
    stdio: 'inherit'
  })
  const ready = await waitForWorkbench()
  if (ready) openWorkbench()
  else console.warn(`[Job Agent] Workbench did not answer at ${URL}; check daemon/log/daemon.log.`)
  child.on('exit', code => process.exit(code ?? 0))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
}

if (process.platform === 'win32') startWindows()
else startUnix()

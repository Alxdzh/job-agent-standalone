import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON = path.join(ROOT, 'daemon')
const HOME = os.homedir()

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run setup\n\nPrepare Node.js dependencies, local config, and a desktop launcher.')
  process.exit(0)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit',
    windowsHide: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function ensureLocalConfig() {
  const configDir = path.join(HOME, '.job-agent', 'config')
  const storageDir = path.join(HOME, '.job-agent', 'storage')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(storageDir, { recursive: true })
  fs.mkdirSync(path.join(DAEMON, 'state'), { recursive: true })
  fs.mkdirSync(path.join(DAEMON, 'log'), { recursive: true })
  const exampleDir = path.join(DAEMON, 'config.example')
  if (!fs.existsSync(exampleDir)) return
  for (const name of fs.readdirSync(exampleDir)) {
    if (!name.endsWith('.json')) continue
    const source = path.join(exampleDir, name)
    const target = path.join(configDir, name)
    if (!fs.existsSync(target)) fs.copyFileSync(source, target)
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function desktopQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') }"`
}

function createUnixShortcut() {
  const desktop = path.join(HOME, 'Desktop')
  if (!fs.existsSync(desktop)) {
    console.log('[Job Agent] Desktop folder not found; skipping desktop shortcut.')
    return
  }
  if (process.platform === 'darwin') {
    const launcher = path.join(desktop, 'Job-Agent-Workbench.command')
    fs.writeFileSync(launcher, `#!/bin/sh\ncd ${shellQuote(ROOT)}\nexec /usr/bin/env node ${shellQuote(path.join(ROOT, 'tools', 'start.mjs'))}\n`, 'utf8')
    fs.chmodSync(launcher, 0o755)
    console.log(`[Job Agent] Desktop shortcut created: ${launcher}`)
    return
  }
  const launcher = path.join(desktop, 'Job-Agent-Workbench.desktop')
  const startScript = path.join(ROOT, 'start.sh')
  fs.writeFileSync(launcher, `[Desktop Entry]\nType=Application\nName=求职管家工作台\nComment=Start the job application workbench\nExec=sh ${desktopQuote(startScript)}\nPath=${desktopQuote(ROOT)}\nTerminal=true\nCategories=Utility;\n`, 'utf8')
  fs.chmodSync(launcher, 0o755)
  console.log(`[Job Agent] Desktop shortcut created: ${launcher}`)
}

function setupWindows() {
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  run(powershell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'one-click-start.ps1'),
    '-InstallOnly'
  ])
}

function setupUnix() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error('Node.js 22.12+ is required. Install it, then run npm run setup again.')
  }
  ensureLocalConfig()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  run(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: DAEMON,
    env: { PUPPETEER_SKIP_DOWNLOAD: '1' }
  })
  createUnixShortcut()
  console.log('[Job Agent] Installation complete. Run npm start to open the workbench.')
}

try {
  if (process.platform === 'win32') setupWindows()
  else setupUnix()
} catch (err) {
  console.error(`[Job Agent] Setup failed: ${err?.message || err}`)
  process.exit(1)
}

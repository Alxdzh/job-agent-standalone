import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getRuntimeEdition } from './src/edition.mjs'

function currentWindowsSessionId() {
  if (process.platform !== 'win32') return null
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-Process -Id $PID).SessionId'
  ], { encoding: 'utf8', windowsHide: true })
  const value = Number(String(result.stdout || '').trim())
  return Number.isInteger(value) ? value : null
}

function assertInteractiveWindowsLaunch() {
  const sessionId = currentWindowsSessionId()
  if (sessionId === 0) {
    throw new Error('检测到非桌面 Windows 会话。请在笔记本桌面双击 Job-Agent-Workbench 启动；不会创建计划任务或请求管理员权限。')
  }
}

try {
  assertInteractiveWindowsLaunch()
} catch (err) {
  console.error(`[daemon] ${err?.message || err}`)
  process.exit(1)
}

const { startRuntime } = await import('./src/runtime.mjs')
const edition = getRuntimeEdition()
// 两个版本共享可见浏览器、资料库、投递调度和工作台；启动后保持空闲，
// 只有用户明确点击开始或外部 Agent 明确调用开始工具才执行投递。
startRuntime({ edition }).catch(err => {
  console.error(`[daemon] fatal: ${err?.stack || err?.message}`)
  process.exit(1)
})

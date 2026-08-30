import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWebServer } from './web.mjs'
import { startScheduler } from './worker.mjs'
import { getRuntimeEdition, normalizeEdition } from './edition.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 测试可通过 JOB_AGENT_LOG_DIR 把日志完全隔离；正常运行仍写入 daemon/log。
const LOG_DIR = process.env.JOB_AGENT_LOG_DIR
  ? path.resolve(process.env.JOB_AGENT_LOG_DIR)
  : path.join(__dirname, '..', 'log')
let loggingConfigured = false

// MCP 的 stdio 是协议通道，任何普通日志写到 stdout 都会把协议打断。
// 两种运行方式都仍会写入同一个工作台日志文件。
function teeToFile({ mcpStdout = false } = {}) {
  if (loggingConfigured) return
  loggingConfigured = true
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const logPath = path.join(LOG_DIR, 'daemon.log')
    const stream = fs.createWriteStream(logPath, { flags: 'a' })
    const originalLog = console.log.bind(console)
    const originalError = console.error.bind(console)
    const consoleWriter = mcpStdout ? originalError : originalLog
    const write = (level, data) => {
      const text = data.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
      stream.write(`[${new Date().toISOString()}] [${level}] ${text.trimEnd()}\n`)
    }
    console.log = (...args) => { consoleWriter(...args); write('info', args) }
    console.error = (...args) => { originalError(...args); write('error', args) }
  } catch (err) {
    console.error(`[daemon] log setup failed: ${err?.message}`)
  }
}

// 两个版本复用同一个浏览器、worker、数据库与工作台；差别只在“谁负责决策”。
// 独立版由用户操作工作台，MCP 版由外部 Agent 调用同一套投递工具。
export async function startRuntime({ edition = getRuntimeEdition(), mcpStdout = false } = {}) {
  const normalizedEdition = normalizeEdition(edition)
  teeToFile({ mcpStdout })
  console.log(`[daemon] 求职自动化 ${normalizedEdition === 'mcp' ? 'MCP 版' : '独立版'}启动`)
  const { listEnabledPlatforms, PLATFORM_NAMES } = await import('./platforms/index.mjs')
  const platforms = listEnabledPlatforms()
  console.log(`[daemon] 启用的平台: ${platforms.map(p => PLATFORM_NAMES[p] || p).join(', ') || '无'}（浏览器按需打开）`)

  console.log('[daemon] 工作台：投递执行端已就绪，等待明确触发')

  const webServer = startWebServer()
  void startScheduler().catch(err => console.error(`[daemon] scheduler fatal: ${err?.stack || err?.message}`))
  return { edition: normalizedEdition, webServer }
}

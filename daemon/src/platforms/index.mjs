import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { saveStorage, getPlatformBrowserInfo, setActivePlatform, sleep } from '../browser.mjs'

// =====================================================================
// BOSS 投递系统 — 平台适配器注册表
//
// 每个平台一个适配器模块，实现统一的 PlatformAdapter 接口：
//
//   platform            'boss'
//   homeUrl             平台首页（登录后落点）
//   configName          配置文件名字（如 'boss.json'）
//
//   async launch()                          启动/复用本平台浏览器实例
//   async searchJobs(keyword, cityName)     搜索岗位（返回列表）
//   async readJobDetail(index)              读取列表第 index 个岗位的完整 JD
//   async apply(job)                        投递岗位（返回 {ok, reason, ...}）
//   async detectRiskSignal()                风控检测（403/验证码/登录失效）
//   async backToHome(prevUrl)               操作后回岗位页
//
// 调度器按平台隔离调用适配器；所有平台适配器只负责可见页面上的投递。
// =====================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.JOB_AGENT_CONFIG_DIR || path.join(os.homedir(), '.job-agent', 'config')

export const PLATFORMS = ['boss', 'zhilian', 'job51', 'liepin']
export const PLATFORM_NAMES = {
  boss: 'Boss直聘',
  zhilian: '智联招聘',
  job51: '51job（前程无忧）',
  liepin: '猎聘'
}

// read platform config from its own json file (same field structure as boss.json)
export function readPlatformConfig(platform) {
  try {
    const file = path.join(CONFIG_DIR, `${platform}.json`)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    console.error(`[platforms] 读 ${platform}.json 失败: ${err?.message}`)
  }
  return null
}

export function listEnabledPlatforms() {
  return PLATFORMS.filter(p => {
    const cfg = readPlatformConfig(p)
    return cfg && cfg.enabled !== false
  })
}

// lazy-loaded adapter registry
const _adapters = new Map()

export async function getAdapter(platform) {
  if (!PLATFORMS.includes(platform)) return null
  if (!_adapters.has(platform)) {
    const mod = await import(`./${platform}.mjs`)
    _adapters.set(platform, mod.default)
  }
  return _adapters.get(platform)
}

export async function getEnabledAdapters() {
  const out = []
  for (const p of listEnabledPlatforms()) {
    const a = await getAdapter(p)
    if (a) out.push(a)
  }
  return out
}

// Open a visible browser for one platform, inspect its login page, and save a
// compatibility snapshot after a successful login. The persistent Chrome
// profile remains the source of truth; the JSON snapshot is only a fallback
// for older deployments.
export async function inspectPlatformLogin(platform, { open = true, save = true } = {}) {
  const adapter = await getAdapter(platform)
  if (!adapter) return { ok: false, platform, reason: 'adapter_not_found' }
  try {
    setActivePlatform(platform)
    if (open) {
      await adapter.launch?.()
      // The recruiting sites are SPA shells; DOM login markers often appear
      // a moment after domcontentloaded.
      await sleep(2500)
    }
    const diagnostics = typeof adapter.getLoginDiagnostics === 'function'
      ? await adapter.getLoginDiagnostics()
      : null
    const loggedIn = typeof adapter.isLoggedIn === 'function'
      ? !!(diagnostics ? diagnostics.loggedIn : await adapter.isLoggedIn())
      : null
    const snapshot = loggedIn && save ? await saveStorage(platform) : null
    return {
      ok: true,
      platform,
      name: PLATFORM_NAMES[platform] || platform,
      loggedIn,
      browser: getPlatformBrowserInfo(platform),
      snapshot,
      diagnostics
    }
  } catch (err) {
    return { ok: false, platform, name: PLATFORM_NAMES[platform] || platform, reason: err?.message || 'login check failed' }
  }
}

export async function inspectEnabledPlatformLogins({ platforms = listEnabledPlatforms(), save = true } = {}) {
  const results = []
  // Deliberately sequential: only one visible platform browser is active at
  // a time, matching the worker's normal operating mode.
  for (const platform of platforms) {
    results.push(await inspectPlatformLogin(platform, { open: true, save }))
  }
  return results
}

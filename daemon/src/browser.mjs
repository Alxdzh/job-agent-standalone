import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readWorkbenchSettings } from './workbench-settings.mjs'
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url))

// dependency root for puppeteer-extra.
// 1. JOB_AGENT_DEPENDENCY_ROOT env if set and exists
// 2. dependencies installed beside this package
// 3. an optional sibling deps directory for portable deployments
function resolveDependencyRoot() {
  const candidates = [
    process.env.JOB_AGENT_DEPENDENCY_ROOT,
    path.join(CURRENT_DIR, '..'),
    path.join(CURRENT_DIR, '..', '..', 'deps')
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'node_modules', 'puppeteer-extra'))) return c
    } catch {}
  }
  return candidates[0]
}

const DEPENDENCY_ROOT = resolveDependencyRoot()
const STORAGE_DIR = process.env.JOB_AGENT_STORAGE_DIR || path.join(os.homedir(), '.job-agent', 'storage')

function resolveChromePath() {
  const candidates = [process.env.BOSS_CHROME_PATH, process.env.CHROME_PATH]
  if (process.platform === 'win32') {
    candidates.push(
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
    )
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return candidates.filter(Boolean).find(p => {
    try { return fs.existsSync(p) }
    catch { return false }
  }) || ''
}

const CHROME_PATH = resolveChromePath()
// 强制使用真实可见浏览器；不提供 headless 配置开关。
const HEADLESS = false
// 每个平台使用独立的持久化 Chrome 用户目录，避免不同站点互相污染登录态。
// BOSS 保留旧目录名以兼容已有登录；其它平台默认放在当前用户目录，
// 也可以用 JOB_AGENT_BROWSER_ROOT 或平台专属环境变量改到任意可写位置。
const BROWSER_ROOT = process.env.JOB_AGENT_BROWSER_ROOT
  ? path.resolve(process.env.JOB_AGENT_BROWSER_ROOT)
  : ''
const profilePath = (platform, legacyName, envName) => process.env[envName]
  || (BROWSER_ROOT ? path.join(BROWSER_ROOT, platform) : path.join(os.homedir(), legacyName))
const USER_DATA_DIRS = {
  boss: profilePath('boss', '.boss-daemon-chrome', 'BOSS_USER_DATA_DIR'),
  zhilian: profilePath('zhilian', '.zhilian-daemon-chrome', 'ZHILIAN_USER_DATA_DIR'),
  job51: profilePath('job51', '.job51-daemon-chrome', 'JOB51_USER_DATA_DIR'),
  liepin: profilePath('liepin', '.liepin-daemon-chrome', 'LIEPIN_USER_DATA_DIR')
}
// 每个平台使用独立 CDP 端口，避免连接到错误的 Chrome 实例。
const DEBUG_PORTS = {
  boss: process.env.BOSS_DEBUG_PORT || 9222,
  zhilian: process.env.ZHILIAN_DEBUG_PORT || 9223,
  job51: process.env.JOB51_DEBUG_PORT || 9224,
  liepin: process.env.LIEPIN_DEBUG_PORT || 9225
}
// createRequire 需要文件路径；使用包根目录下的虚拟文件，避免换电脑/换目录后
// 把依赖解析到包的父目录。
const dependencyRequire = createRequire(path.join(DEPENDENCY_ROOT, 'noop.js'))
const puppeteerExtra = dependencyRequire('puppeteer-extra')
// Restore the project's original anti-detection plugin chain.
// Laodeng is kept outside node_modules because npm install may remove it.
const LAODENG_DIR = process.env.BOSS_LAODENG_DIR || path.join(CURRENT_DIR, '..', 'laodeng')
const laodengRequire = createRequire(path.join(LAODENG_DIR, 'noop.js'))
const StealthPlugin = dependencyRequire('puppeteer-extra-plugin-stealth')
const LaodengPlugin = laodengRequire(path.join(LAODENG_DIR, '@geekgeekrun', 'puppeteer-extra-plugin-laodeng', 'index.js'))
const AnonymizeUaPlugin = dependencyRequire('puppeteer-extra-plugin-anonymize-ua')
puppeteerExtra.use(StealthPlugin())
puppeteerExtra.use(LaodengPlugin())
puppeteerExtra.use(AnonymizeUaPlugin({ makeWindows: false }))

// per-platform browser/page instances, keyed by platform name.
// Only ONE platform is "active" at a time (worker runs platforms serially in random order),
// so boss.mjs can keep calling getPage()/safeEval() without changing its signature.
const instances = new Map()
let activePlatform = 'boss'
const PAGE_WIDTH = 1440
const PAGE_HEIGHT = 900

// Chrome 的 --start-minimized/--window-position 只在首次启动时生效。
// 如果切换设置后复用旧的 CDP 浏览器，单纯 bringToFront 不能把屏幕外窗口拉回来，
// 所以每次复用/启动平台浏览器时都同步一次窗口状态。
async function syncWindowVisibility(page, silentMode) {
  if (!page || page.isClosed()) return
  let cdp
  try {
    cdp = await page.target().createCDPSession()
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: silentMode
        ? { windowState: 'minimized' }
        : { windowState: 'normal', left: 24, top: 24 }
    })
  } catch (err) {
    console.log(`[browser] 同步窗口可见性失败: ${err?.message || err}`)
  } finally {
    try { await cdp?.detach?.() } catch {}
  }
  if (!silentMode) await page.bringToFront?.().catch(() => {})
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

// switch which platform the shared getPage()/safeEval() refer to.
// Worker calls this before operating on each platform (serial scheduling).
export function setActivePlatform(platform) {
  activePlatform = platform || 'boss'
  return activePlatform
}

export function getActivePlatform() {
  return activePlatform
}

export async function safeEval(fn, args, { retries = 5 } = {}) {
  const page = getPage()
  if (!page) throw new Error(`[browser] no active page (platform=${activePlatform})`)
  for (let i = 0; i < retries; i++) {
    try {
      return await page.evaluate(fn, args)
    } catch (err) {
      if (/Execution context was destroyed|Cannot find context|Navigation|Protocol error|same JavaScript world|is not defined|detached Frame|Detached/.test(String(err?.message || err)) && i < retries - 1) {
        await sleep(2000)
        continue
      }
      throw err
    }
  }
}

export function getPage() {
  return instances.get(activePlatform)?.page || null
}

export function getPageFor(platform) {
  return instances.get(platform)?.page || null
}

// 某些站点的真实“搜索”点击会在新 tab 打开职位列表。适配器确认这是由
// 可见 UI 点击产生的新列表页后，需要把该 tab 设为本平台后续读 JD / 投递
// 的工作页；不能继续对原首页等待岗位卡片。
export function setPlatformPage(platform, page) {
  const inst = instances.get(platform)
  if (!inst || !page || page.isClosed?.()) return false
  inst.page = page
  instances.set(platform, inst)
  setActivePlatform(platform)
  return true
}

// inject saved cookies + localStorage for the given domain. The fixed homeUrl
// here is only the initial browser landing point; target cities, keywords and
// jobs must be reached through the platform's visible UI adapters.
async function injectSession(page, domainPrefix, homeUrl, cookiesFileName) {
  const cookies = readJson(path.join(STORAGE_DIR, cookiesFileName)) || []
  const lsData = readJson(path.join(STORAGE_DIR, cookiesFileName.replace('cookies', 'local-storage'))) || {}
  for (const c of cookies) {
    if (Object.hasOwn(c, 'sameSite')) c.sameSite = 'unspecified'
    try { await page.setCookie(c) } catch {}
  }
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  globalThis.__bossLsData = lsData
  await page.evaluate(() => {
    const items = globalThis.__bossLsData
    for (const [k, v] of Object.entries(items || {})) {
      try { window.localStorage.setItem(k, v) } catch {}
    }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

// Launch (or reuse) the browser instance for a platform.
// Each platform gets its own persistent profile + cookies file → login states isolated.
// If the CDP debug port for this platform is already listening (an old browser window
// survived a daemon restart), CONNECT to it instead of launching a duplicate window —
// this preserves the login state that lives in the already-open window.
export async function launchPlatform({ platform = 'boss', homeUrl, cookiesFileName }) {
  const silentMode = readWorkbenchSettings().silentMode === true
  const existing = instances.get(platform)
  if (existing && existing.browser && existing.page && !existing.page.isClosed()) {
    await syncWindowVisibility(existing.page, silentMode)
    return existing.browser
  }
  if (!CHROME_PATH) throw new Error('未找到系统原生 Chrome，请先安装 Chrome 或设置 CHROME_PATH')
  const debugPort = DEBUG_PORTS[platform] || 9222
  // try to connect to an already-running browser on this platform's debug port
  // (no fetch precheck — puppeteer.connect itself throws if the port is dead)
  try {
    const browser = await puppeteerExtra.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT } })
    const pages = await browser.pages()
    const homeHost = (() => { try { return new URL(homeUrl || '').hostname } catch { return '' } })()
    const usable = pages.filter(p => !p.isClosed() && !/^devtools:/.test(p.url()))
    const page = usable.find(p => homeHost && p.url().includes(homeHost))
      || usable.find(p => !/^about:blank$|^chrome:\/\//.test(p.url()))
      || usable[0]
    instances.set(platform, { browser, page })
    await syncWindowVisibility(page, silentMode)
    console.log(`[browser] ${platform} 连接已存在的浏览器实例 (port ${debugPort})`)
    return browser
  } catch (err) {
    console.log(`[browser] ${platform} 端口 ${debugPort} 不可连（${err?.message || 'connect failed'}），将新开浏览器`)
  }
  // close OTHER platforms' browsers first so only one Chrome window is open at a time,
  // and so a fresh launch can't accidentally attach to a competing instance
  for (const [p, inst] of instances) {
    if (p !== platform && inst.browser) {
      try { await inst.browser.close() } catch {}
      console.log(`[browser] closed ${p} browser before launching ${platform}`)
    }
  }
  const userDataDir = USER_DATA_DIRS[platform] || path.join(os.homedir(), `.${platform}-daemon-chrome`)
  const browser = await puppeteerExtra.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    ignoreHTTPSErrors: true,
    userDataDir,
    args: [
      `--remote-debugging-port=${debugPort}`,
      ...(silentMode ? ['--start-minimized', '--window-position=-2400,-1600'] : [])
    ],
    defaultViewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT }
  })
  const page = (await browser.pages())[0]
  instances.set(platform, { browser, page })
  await syncWindowVisibility(page, silentMode)
  // NOTE: login state comes from the persistent userDataDir profile now.
  // If a cookies file exists, inject it once as a fallback bootstrap.
  const saved = readJson(path.join(STORAGE_DIR, cookiesFileName))
  if (saved && saved.length) {
    try { await injectSession(page, null, homeUrl, cookiesFileName) } catch {}
  } else {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  }
  // A login action is explicitly interactive. Re-apply the window bounds after
  // navigation as Chrome can restore a minimized/off-screen state while the SPA
  // is loading.
  await syncWindowVisibility(page, readWorkbenchSettings().silentMode === true)
  return browser
}

// Manual login must always be visible, even when delivery is configured for
// silent mode. This is intentionally a separate operation so automated runs
// keep their configured visibility while the user can always bring a login
// window back to the foreground from Settings.
export async function showPlatformBrowser(platform = activePlatform) {
  const inst = instances.get(platform)
  if (!inst?.page || inst.page.isClosed()) return false
  setActivePlatform(platform)
  await syncWindowVisibility(inst.page, false)
  return true
}

export async function saveStorage(platform = activePlatform) {
  const page = getPageFor(platform)
  if (!page) return { ok: false, reason: 'browser page not open' }
  try {
    const cookies = await page.cookies()
    fs.mkdirSync(STORAGE_DIR, { recursive: true })
    fs.writeFileSync(path.join(STORAGE_DIR, `${platform}-cookies.json`), JSON.stringify(cookies))
    const ls = await page.evaluate(() => {
      const out = {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k) out[k] = localStorage.getItem(k)
      }
      return out
    })
    fs.writeFileSync(path.join(STORAGE_DIR, `${platform}-local-storage.json`), JSON.stringify(ls))
    return { ok: true, cookieCount: cookies.length, localStorageCount: Object.keys(ls).length }
  } catch {}
  return { ok: false, reason: 'session snapshot failed' }
}

// Login state is primarily kept in the persistent Chrome userDataDir. These
// paths are also useful to the workbench for explaining where a platform's
// session lives without exposing cookies or other secrets.
export function getPlatformBrowserInfo(platform = activePlatform) {
  const inst = instances.get(platform)
  const page = inst?.page && !inst.page.isClosed() ? inst.page : null
  return {
    platform,
    userDataDir: USER_DATA_DIRS[platform] || '',
    debugPort: DEBUG_PORTS[platform] || null,
    opened: !!page,
    visible: !!page && readWorkbenchSettings().silentMode !== true,
    url: page ? page.url() : ''
  }
}

export async function closeBrowser() {
  for (const [platform, inst] of instances) {
    if (inst.browser) {
      try { await inst.browser.close() } catch {}
      console.log(`[browser] closed ${platform} browser`)
    }
  }
  instances.clear()
}

// Close the browser instance for ONE platform (used when switching platforms serially,
// so only one Chrome window is open at a time). Login state lives in the persistent
// profile, so re-opening later restores the session.
export async function closePlatformBrowser(platform) {
  const inst = instances.get(platform)
  if (inst?.browser) {
    try { await inst.browser.close() } catch {}
    console.log(`[browser] closed ${platform} browser (switching)`)
  }
  instances.delete(platform)
  if (activePlatform === platform) {
    // fall back to boss as the "neutral" active platform
    activePlatform = 'boss'
  }
}

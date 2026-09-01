import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import * as store from './store.mjs'
import { state as workerState, setPaused, triggerHunt, resumeHunt, getWorkerSnapshot, getRuntimeDiagnostics, startContinuousHunt, stopContinuousHunt, toggleContinuousHunt } from './worker.mjs'
import { readConfig, testLlmConnection, listLlmModels } from './llm.mjs'
import { setActivePlatform, showPlatformBrowser, getPlatformBrowserInfo } from './browser.mjs'
import { readWorkbenchSettings, updateWorkbenchSettings } from './workbench-settings.mjs'
import { getRuntimeEdition } from './edition.mjs'
import { readDeliveryConfig, updateDeliveryConfig } from './delivery-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// The source tree keeps web/ at project root; the distributable template
// keeps a copy beside daemon/. Resolve both layouts so moving the bundle or
// running the source checkout does not silently produce a 404 for the UI.
const DAEMON_WEB_DIR = path.join(__dirname, '..', 'web')
const WEB_DIR = fs.existsSync(DAEMON_WEB_DIR)
  ? DAEMON_WEB_DIR
  : path.join(__dirname, '..', '..', 'web')
const LOG_DIR = path.join(__dirname, '..', 'log')
const CONFIG_DIR = process.env.JOB_AGENT_CONFIG_DIR || path.join(os.homedir(), '.job-agent', 'config')
const PORT = Number(process.env.BOSS_DAEMON_PORT || 8788)
const HOST = process.env.BOSS_DAEMON_HOST || '0.0.0.0'
let shutdownRequested = false

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function apiHandler(req, res, url) {
  const edition = getRuntimeEdition()
  if (req.method === 'GET' && url.pathname === '/api/edition') {
    return sendJson(res, { edition, controlSurface: 'shared-workbench' })
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const stats = store.getStats()
    return sendJson(res, { ...stats, byPlatform: stats.byPlatform || {}, industry: store.getIndustryStats() })
  }
  if (req.method === 'GET' && url.pathname === '/api/applications') {
    const platform = url.searchParams.get('platform') || undefined
    return sendJson(res, store.listApplications({ limit: 50, platform }))
  }
  if (req.method === 'GET' && url.pathname === '/api/worker') {
    return sendJson(res, getWorkerSnapshot())
  }
  if (req.method === 'GET' && url.pathname === '/api/runtime') {
    return sendJson(res, { ok: true, runtime: getWorkerSnapshot() })
  }
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    return getRuntimeDiagnostics()
      .then(diagnostics => sendJson(res, { ok: true, diagnostics }))
      .catch(err => sendJson(res, { ok: false, error: err?.message || '诊断读取失败' }, 500))
  }
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    if (shutdownRequested) return sendJson(res, { ok: true, shuttingDown: true })
    shutdownRequested = true
    setPaused(true)
    sendJson(res, { ok: true, shuttingDown: true, message: '后台服务将退出；下次请双击快捷方式启动' })
    setTimeout(() => {
      console.log('[daemon] 用户从工作台请求退出后台，进程结束')
      process.exit(0)
    }, 350)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench-settings') {
    const settings = readWorkbenchSettings()
    return sendJson(res, {
      silentMode: settings.silentMode === true,
      deliveryWindow: settings.deliveryWindow,
      pacing: settings.pacing
    })
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench-settings') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let p
      try { p = JSON.parse(body || '{}') } catch (err) { return sendJson(res, { ok: false, error: `bad json: ${err.message}` }, 400) }
      const patch = {}
      if (typeof p.silentMode === 'boolean') patch.silentMode = p.silentMode
      if (p.deliveryWindow && typeof p.deliveryWindow === 'object') patch.deliveryWindow = p.deliveryWindow
      if (p.pacing && typeof p.pacing === 'object') patch.pacing = p.pacing
      try {
        const next = updateWorkbenchSettings(patch)
        return sendJson(res, {
          ok: true,
          silentMode: next.silentMode === true,
          deliveryWindow: next.deliveryWindow,
          pacing: next.pacing
        })
      } catch (err) { return sendJson(res, { ok: false, error: err?.message }, 500) }
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    let lines = []
    try {
      const logPath = path.join(LOG_DIR, 'daemon.log')
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, 'utf-8')
        lines = raw.split(/\r?\n/).filter(Boolean).slice(-300)
      }
    } catch {}
    return sendJson(res, { lines })
  }
  if (req.method === 'POST' && url.pathname === '/api/pause') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {}
      // 保留旧前端的“切换”兼容性；新调用方应明确传 paused true/false。
      const paused = typeof payload.paused === 'boolean' ? payload.paused : !workerState.paused
      setPaused(paused, payload.reason || '')
      return sendJson(res, { ok: true, paused: workerState.paused, runtime: getWorkerSnapshot() })
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/continuous') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {}
      const options = {
        platform: payload.platform || 'all',
        keywords: payload.keywords,
        source: payload.source || 'web',
        acknowledgeRisk: payload.acknowledgeRisk === true
      }
      let result
      if (payload.action === 'start') result = startContinuousHunt(options)
      else if (payload.action === 'stop') result = workerState.running && !workerState.continuous
        ? (setPaused(true, payload.reason || '暂停当前定量投递'), { ok: true, action: 'paused_manual', runtime: getWorkerSnapshot() })
        : stopContinuousHunt(payload.reason || '已暂停持续投递')
      else result = toggleContinuousHunt(options)
      return sendJson(res, result, result.ok === false ? 409 : 200)
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/trigger-hunt') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {}
      return triggerHunt(payload.maxJobs, {
        platform: payload.platform,
        keywords: payload.keywords,
        source: payload.source || 'web',
        // 网页请求不能等完整个投递周期；任务状态会马上返回，实时进度走 /api/runtime。
        asyncMode: payload.asyncMode !== false,
        acknowledgeRisk: payload.acknowledgeRisk === true
      }).then(r => sendJson(res, r))
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/hunt/resume') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {}
      return resumeHunt({
        asyncMode: payload.asyncMode !== false,
        source: payload.source || 'web',
        acknowledgeRisk: payload.acknowledgeRisk === true
      }).then(r => sendJson(res, r))
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const platform = url.searchParams.get('platform') || 'boss'
    const cfg = readDeliveryConfig(platform)
    if (platform === 'all') {
      const configs = Array.isArray(cfg.platforms) ? cfg.platforms : []
      return sendJson(res, {
        platform: 'all',
        configs,
        enabled: configs.some(item => item.enabled === true),
        daemonCity: '',
        expectSalaryLow: 0,
        keywords: [],
        expectJobNameRegExpStr: '',
        blockCompanyNameRegExpStr: '',
        blockJobRiskKeywordsRegExpStr: ''
      })
    }
    return sendJson(res, {
      platform,
      exists: cfg.exists,
      enabled: cfg.enabled,
      daemonCity: cfg.city,
      expectSalaryLow: cfg.salaryMin,
      keywords: cfg.keywords,
      expectJobNameRegExpStr: cfg.keywords.join('|'),
      blockCompanyNameRegExpStr: cfg.exclusions.company,
      blockJobRiskKeywordsRegExpStr: cfg.exclusions.jobRisk
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/platforms') {
    return import('./platforms/index.mjs').then(async ({ PLATFORMS, PLATFORM_NAMES, listEnabledPlatforms, getAdapter, readPlatformConfig }) => {
      const enabled = listEnabledPlatforms()
      const items = []
      for (const platform of PLATFORMS) {
        const adapter = await getAdapter(platform)
        const config = readPlatformConfig(platform)
        items.push({
          platform,
          name: PLATFORM_NAMES[platform] || platform,
          enabled: enabled.includes(platform),
          configured: !!config,
          capabilities: adapter?.capabilities || { delivery: false, replies: false }
        })
      }
      return sendJson(res, items)
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/platform/login-status') {
    const requested = url.searchParams.get('platform') || 'all'
    return import('./platforms/index.mjs').then(async ({ PLATFORMS, PLATFORM_NAMES, listEnabledPlatforms, inspectPlatformLogin, inspectEnabledPlatformLogins }) => {
      const platforms = requested === 'all'
        ? listEnabledPlatforms()
        : PLATFORMS.includes(requested) ? [requested] : []
      if (!platforms.length) return sendJson(res, { ok: false, error: '没有可检查的平台' }, 400)
      const results = requested === 'all'
        ? await inspectEnabledPlatformLogins({ platforms })
        : [await inspectPlatformLogin(platforms[0])]
      return sendJson(res, {
        ok: true,
        allLoggedIn: results.every(x => x.loggedIn === true),
        platforms: results.map(x => ({ ...x, browser: undefined }))
      })
    }).catch(err => sendJson(res, { ok: false, error: err?.message || '登录状态检查失败' }, 500))
  }
  if (req.method === 'POST' && url.pathname === '/api/platform/login') {
    // 打开某平台的浏览器窗口（用户扫码登录用）
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let platform
      try { platform = JSON.parse(body || '{}').platform } catch {}
      if (!platform) return sendJson(res, { ok: false, error: 'platform required' }, 400)
      return import('./platforms/index.mjs').then(async ({ getAdapter, PLATFORM_NAMES }) => {
        const adapter = await getAdapter(platform)
        if (!adapter) return sendJson(res, { ok: false, error: `platform ${platform} not found` }, 404)
        setActivePlatform(platform)
        await adapter.launch()
        const visible = await showPlatformBrowser(platform)
        if (!visible) throw new Error('浏览器已启动，但没有找到可用页面；请重试')
        return sendJson(res, {
          ok: true,
          platform,
          name: PLATFORM_NAMES[platform] || platform,
          browser: { ...getPlatformBrowserInfo(platform), visible: true },
          hint: '可见浏览器已打开，请在窗口内扫码/登录；完成后点击“检查”保存状态'
        })
      }).catch(err => sendJson(res, { ok: false, error: err?.message }, 500))
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let updates
      try { updates = JSON.parse(body || '{}') } catch (err) { return sendJson(res, { ok: false, error: `bad json: ${err.message}` }, 400) }
      const platform = updates.platform || 'boss'
      const patch = { platform }
      // Only the explicit platform toggle may change enabled. This keeps an
      // old cached preference form from re-enabling every platform while it
      // saves city/keywords for “all”.
      if (updates.action === 'set-enabled' && Object.prototype.hasOwnProperty.call(updates, 'enabled')) patch.enabled = updates.enabled
      if (Object.prototype.hasOwnProperty.call(updates, 'daemonCity')) patch.city = updates.daemonCity
      if (Object.prototype.hasOwnProperty.call(updates, 'expectSalaryLow')) patch.salaryMin = updates.expectSalaryLow
      if (Object.prototype.hasOwnProperty.call(updates, 'keywords')) patch.keywords = updates.keywords
      if (Object.prototype.hasOwnProperty.call(updates, 'blockCompanyNameRegExpStr')) patch.companyExclusions = updates.blockCompanyNameRegExpStr
      if (Object.prototype.hasOwnProperty.call(updates, 'blockJobRiskKeywordsRegExpStr')) patch.jobRiskExclusions = updates.blockJobRiskKeywordsRegExpStr
      const result = updateDeliveryConfig(patch)
      return sendJson(res, result, result.ok ? 200 : 400)
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/llm-config') {
    const llm = readConfig('llm.json')
    const conf = Array.isArray(llm) ? (llm.find(it => it.enabled) || llm[0] || null) : null
    return sendJson(res, {
      providerCompleteApiUrl: conf?.providerCompleteApiUrl || '',
      providerApiSecret: conf?.providerApiSecret ? '••••••••（已设置）' : '',
      model: conf?.model || ''
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/llm-models') {
    return listLlmModels().then(result => sendJson(res, result)).catch(err => sendJson(res, {
      ok: false,
      models: [],
      source: 'fallback',
      error: err?.message || '读取模型列表失败'
    }))
  }
  if (req.method === 'POST' && url.pathname === '/api/llm-test') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      let updates
      try { updates = JSON.parse(body || '{}') } catch (err) { return sendJson(res, { ok: false, error: `bad json: ${err.message}` }, 400) }
      const patch = {}
      if (typeof updates.providerCompleteApiUrl === 'string') patch.providerCompleteApiUrl = updates.providerCompleteApiUrl.trim()
      if (typeof updates.providerApiSecret === 'string' && !updates.providerApiSecret.includes('••••')) patch.providerApiSecret = updates.providerApiSecret.trim()
      if (typeof updates.model === 'string') patch.model = updates.model.trim()
      try {
        const result = await testLlmConnection(patch)
        return sendJson(res, result)
      } catch (err) {
        return sendJson(res, { ok: false, error: err?.message || '模型连接测试失败' }, 400)
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/llm-config') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      let updates
      try { updates = JSON.parse(body || '{}') } catch (err) { return sendJson(res, { ok: false, error: `bad json: ${err.message}` }, 400) }
      const llm = readConfig('llm.json')
      const list = Array.isArray(llm) ? llm : [{ enabled: true, serveWeight: 100 }]
      const conf = list.find(it => it.enabled) || list[0] || {}
      if (updates.providerCompleteApiUrl) conf.providerCompleteApiUrl = updates.providerCompleteApiUrl
      // 密钥：只有前端没回显占位符时才覆盖（避免把"••••"存回去）
      if (updates.providerApiSecret && updates.providerApiSecret.includes('••••') === false) conf.providerApiSecret = updates.providerApiSecret
      if (updates.model) conf.model = updates.model
      if (!conf.enabled) conf.enabled = true
      try {
        fs.writeFileSync(CONFIG_DIR + '/llm.json', JSON.stringify(list, null, 2))
        sendJson(res, { ok: true })
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 500)
      }
    })
    return
  }
  sendJson(res, { error: 'not found' }, 404)
}
export function startWebServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname.startsWith('/api/')) {
      return apiHandler(req, res, url)
    }
    // static file or fallback to index.html
    let filePath = path.join(WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(WEB_DIR, 'index.html')
    }
    try {
      const ext = path.extname(filePath)
      const mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2'
      }
      const html = fs.readFileSync(filePath)
      res.writeHead(200, { 'Content-Type': `${mime[ext] || 'text/plain'}; charset=utf-8` })
      res.end(html)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  server.listen(PORT, HOST, () => {
    console.log(`[web] 工作台 http://${HOST}:${PORT}`)
  })
  return server
}

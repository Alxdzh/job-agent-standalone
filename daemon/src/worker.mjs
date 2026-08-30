import { sleep, getPage, safeEval, setActivePlatform, closePlatformBrowser } from './browser.mjs'
import * as store from './store.mjs'
import { PLATFORMS, getAdapter, listEnabledPlatforms, readPlatformConfig, inspectPlatformLogin } from './platforms/index.mjs'
import { readWorkbenchSettings } from './workbench-settings.mjs'

export const state = {
  running: false,
  // 持续投递只在用户明确点击/调用“开始持续投递”后置为 true；
  // 该标志不从磁盘恢复，服务重启后永远从 idle 开始。
  continuous: false,
  lastHunt: null,
  paused: false,
  // Each enabled platform owns its own cooldown. The scheduler can switch
  // platforms while one entry is cooling down instead of blocking on it.
  platformSchedule: {},
  progress: null,
  // 一次“今天投 30 个”不是一次页面扫描，而是可恢复的用户任务。
  // 任务中断后只有用户明确说“接着投/继续投”才会继续，不会后台偷跑。
  huntPlan: null
}

function normalizePlanTarget(value, fallback = 10) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function huntPlanSnapshot(plan = state.huntPlan) {
  if (!plan) return null
  const target = normalizePlanTarget(plan.target, 10)
  const applied = Math.max(0, Math.floor(Number(plan.applied) || 0))
  return {
    ...plan,
    target,
    applied,
    remaining: Math.max(0, target - applied),
    keywords: Array.isArray(plan.keywords) ? [...plan.keywords] : []
  }
}

function persistRuntimeState() {
  try {
    store.saveRuntimeState('worker', {
      progress: state.progress,
      lastHunt: state.lastHunt,
      huntPlan: huntPlanSnapshot(),
      platformSchedule: state.platformSchedule,
      running: state.running,
      paused: state.paused
    })
  } catch {}
}

function setProgress(patch = {}) {
  state.progress = { ...(state.progress || {}), ...patch, updatedAt: new Date().toISOString() }
  persistRuntimeState()
}

function updateHuntPlan(patch = {}) {
  if (!state.huntPlan) return null
  const current = huntPlanSnapshot()
  state.huntPlan = huntPlanSnapshot({ ...current, ...patch, updatedAt: new Date().toISOString() })
  persistRuntimeState()
  return state.huntPlan
}

function createHuntPlan({ target, platform, keywords, source } = {}) {
  const now = new Date().toISOString()
  state.huntPlan = huntPlanSnapshot({
    id: `hunt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target: normalizePlanTarget(target),
    applied: 0,
    platform: platform || 'all',
    keywords: normalizeKeywordOverride(keywords),
    source: source || 'manual',
    status: 'queued',
    reason: '',
    rounds: 0,
    createdAt: now,
    startedAt: now,
    updatedAt: now
  })
  persistRuntimeState()
  return state.huntPlan
}

// 供 Agent/网页读取：只返回可向用户展示的计划摘要，不暴露运行时对象。
export function getHuntPlan() {
  return huntPlanSnapshot()
}

// 给工作台、MCP 和其他调用方的稳定状态视图。不要直接把可变的 state
// 对象交出去，否则调用方很容易读到一半更新中的内容。
export function getWorkerSnapshot() {
  return {
    running: !!state.running,
    continuous: !!state.continuous,
    paused: !!state.paused,
    platformSchedule: getPlatformScheduleSnapshot(),
    progress: state.progress ? { ...state.progress } : null,
    huntPlan: huntPlanSnapshot(),
    lastHunt: state.lastHunt ? { ...state.lastHunt } : null
  }
}

// 守护进程重启时绝不偷偷续投。保留未完成计划和已有计数，让人或外部
// Agent 能够看见“中断”并在确认后调用 resume，而不是把一次扫描误报为完成。
function restorePersistedWorkerState() {
  try {
    const saved = store.getRuntimeState('worker')
    if (!saved) return
    state.lastHunt = saved.lastHunt || null
    // 冷却只属于正在运行的调度器。服务重启后绝不能把上次的冷却倒计时
    // 带到新的空闲工作台里，否则用户还没有点击开始就会看到“冷却中”。
    state.platformSchedule = {}
    const savedPlan = huntPlanSnapshot(saved.huntPlan)
    if (savedPlan) {
      const unfinished = savedPlan.remaining > 0 && !['completed', 'cancelled'].includes(savedPlan.status)
      state.huntPlan = huntPlanSnapshot({
        ...savedPlan,
        status: unfinished ? 'interrupted' : savedPlan.status,
        reason: unfinished ? '服务已重启，等待明确的“继续投递”指令' : (savedPlan.reason || '')
      })
    }
    state.progress = saved.progress
      ? state.huntPlan?.status === 'interrupted'
        ? {
            ...saved.progress,
            phase: 'interrupted',
            reason: state.huntPlan.reason,
            activePlatform: null,
            currentJob: null,
            platformSchedule: {}
          }
        : {
            ...saved.progress,
            phase: 'idle',
            reason: '等待明确开始投递指令',
            activePlatform: null,
            currentJob: null,
            platformSchedule: {}
          }
      : null
    // 旧进程是否运行/暂停不能带进新进程；新进程一定从安全的 idle 开始。
    state.running = false
    state.continuous = false
    state.paused = false
  } catch {}
}

restorePersistedWorkerState()

let currentPlatformCache = 'boss'
export function currentPlatform() { return currentPlatformCache }
export function setCurrentPlatform(p) { currentPlatformCache = p || 'boss' }

export function setPaused(v, reason = '') {
  state.paused = !!v
  if (state.paused && state.progress) {
    const pauseReason = reason || '已收到停止请求，不再进入下一个岗位'
    setProgress({ phase: 'pause_requested', reason: pauseReason })
    // 风控阻断会在 pauseOnRiskSignal 中标为 blocked，普通人工暂停才标 paused。
    if (state.huntPlan?.remaining > 0 && state.huntPlan.status !== 'blocked') {
      updateHuntPlan({ status: 'paused', reason: pauseReason, pausedAt: new Date().toISOString() })
    }
  } else if (!state.paused && state.huntPlan?.status === 'paused') {
    updateHuntPlan({ status: 'ready', reason: '' })
  }
  persistRuntimeState()
  console.log(`[worker] paused=${!!v}`)
}

// 长等待也要能响应“停止投递”，不让暂停只能等完整的随机间隔结束。
async function sleepWithPause(ms, shouldStop = () => state.paused) {
  const end = Date.now() + Math.max(0, Number(ms) || 0)
  while (Date.now() < end) {
    if (shouldStop()) return false
    await sleep(Math.min(1000, end - Date.now()))
  }
  return !shouldStop()
}

function clockMinutes(value, fallback) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/)
  if (!match) return fallback
  return Number(match[1]) * 60 + Number(match[2])
}

function deliveryWindowConfig() {
  const settings = readWorkbenchSettings()
  return settings.deliveryWindow || { start: '09:00', end: '21:00' }
}

function deliveryWindowLabel() {
  const window = deliveryWindowConfig()
  return `${window.start}–${window.end}`
}

function isDeliveryWindowOpen(at = new Date()) {
  const window = deliveryWindowConfig()
  const start = clockMinutes(window.start, 9 * 60)
  const end = clockMinutes(window.end, 21 * 60)
  const now = at.getHours() * 60 + at.getMinutes()
  if (start === end) return true
  return start < end ? now >= start && now < end : now >= start || now < end
}

function nextDeliveryWindowStart(at = new Date()) {
  const window = deliveryWindowConfig()
  const start = clockMinutes(window.start, 9 * 60)
  const end = clockMinutes(window.end, 21 * 60)
  const now = at.getHours() * 60 + at.getMinutes()
  const next = new Date(at)
  next.setSeconds(0, 0)
  next.setHours(Math.floor(start / 60), start % 60, 0, 0)
  if (start === end) return next
  if (start < end) {
    if (now >= end) next.setDate(next.getDate() + 1)
    return next
  }
  // For a window crossing midnight, the only outside interval is [end, start).
  // The next start is therefore today when it has not arrived yet.
  if (now >= start) next.setDate(next.getDate() + 1)
  return next
}

function stopReasonForSchedule() {
  if (state.paused) return 'paused'
  return isDeliveryWindowOpen() ? '' : 'outside_delivery_window'
}

async function waitUntilDeliveryWindow() {
  while (!state.paused && !isDeliveryWindowOpen()) {
    const next = nextDeliveryWindowStart()
    const waitMs = Math.max(1000, next.getTime() - Date.now())
    setProgress({
      phase: 'outside_delivery_window',
      currentJob: null,
      reason: `当前不在投递时间窗（${deliveryWindowLabel()}），将在 ${next.toLocaleString()} 后开始`
    })
    if (!await sleepWithPause(Math.min(waitMs, 30000))) return false
  }
  return !state.paused
}

function getPlatformScheduleSnapshot(platforms = Object.keys(state.platformSchedule || {})) {
  const now = Date.now()
  const schedulerActive = state.running === true
  const ids = Array.from(new Set([...(platforms || []), ...Object.keys(state.platformSchedule || {})]))
  return Object.fromEntries(ids.map(platform => {
    const entry = state.platformSchedule?.[platform] || {}
    const cooldownUntil = entry.cooldownUntil || null
    const untilMs = cooldownUntil ? Date.parse(cooldownUntil) : 0
    // 停止或重启后的旧 cooldownUntil 只作历史记录，不能驱动空闲状态。
    const remainingMs = schedulerActive && Number.isFinite(untilMs) ? Math.max(0, untilMs - now) : 0
    const status = remainingMs > 0
      ? 'cooldown'
      : entry.status === 'disabled'
        ? 'disabled'
        : ['unconfigured', 'blocked'].includes(entry.status)
          ? entry.status
        : schedulerActive && entry.status === 'active'
          ? 'active'
          : 'ready'
    return [platform, {
      ...entry,
      status,
      cooldownRemainingMs: remainingMs,
      cooldownRemainingSeconds: Math.ceil(remainingMs / 1000),
      cooldownUntil: remainingMs > 0 ? cooldownUntil : null
    }]
  }))
}

function resetPlatformSchedule(platforms) {
  state.platformSchedule = Object.fromEntries((platforms || []).map(platform => [platform, {
    status: 'ready',
    cooldownUntil: null,
    cooldownReason: '',
    lastBatchApplied: 0
  }]))
  persistRuntimeState()
}

function markPlatformActive(platform) {
  const current = state.platformSchedule[platform] || {}
  state.platformSchedule[platform] = { ...current, status: 'active', activeAt: new Date().toISOString() }
}

function setPlatformCooldown(platform, minutes, reason = 'batch_rest', applied = 0) {
  const safeMinutes = Math.max(1, Number(minutes) || 1)
  const until = new Date(Date.now() + safeMinutes * 60 * 1000)
  const current = state.platformSchedule[platform] || {}
  state.platformSchedule[platform] = {
    ...current,
    status: 'cooldown',
    cooldownUntil: until.toISOString(),
    cooldownReason: reason,
    lastBatchApplied: applied,
    lastBatchEndedAt: new Date().toISOString()
  }
  return until
}

function markPlatformReady(platform) {
  const current = state.platformSchedule[platform] || {}
  state.platformSchedule[platform] = { ...current, status: 'ready', cooldownUntil: null }
}

function selectReadyPlatform(platforms, cursor = 0) {
  const now = Date.now()
  for (let offset = 0; offset < platforms.length; offset++) {
    const index = (cursor + offset) % platforms.length
    const platform = platforms[index]
    const entry = state.platformSchedule[platform] || {}
    const until = Date.parse(entry.cooldownUntil || '') || 0
    if (until <= now) return { platform, index }
  }
  return null
}

function nextPlatformCooldownMs(platforms) {
  const now = Date.now()
  const values = (platforms || [])
    .map(platform => Date.parse(state.platformSchedule?.[platform]?.cooldownUntil || ''))
    .filter(Number.isFinite)
    .map(until => until - now)
    .filter(ms => ms > 0)
  return values.length ? Math.min(...values) : 1000
}

async function waitForPlatformAvailability(platforms) {
  const nextMs = nextPlatformCooldownMs(platforms)
  const cooldowns = getPlatformScheduleSnapshot(platforms)
  const labels = Object.entries(cooldowns)
    .filter(([, item]) => item.status === 'cooldown')
    .map(([platform, item]) => `${platform} ${Math.ceil(item.cooldownRemainingSeconds / 60)}分钟`)
  setProgress({
    phase: 'platform_cooldown',
    currentJob: null,
    reason: labels.length ? `当前平台冷却中：${labels.join('、')}` : '等待可投递平台',
    platformSchedule: cooldowns
  })
  // 冷却等待也要被每日停止时间打断，避免窗口结束后还挂着旧的等待状态。
  return sleepWithPause(
    Math.min(Math.max(1000, nextMs), 30000),
    () => state.paused || !isDeliveryWindowOpen()
  )
}

// 推送投递记录到 ECS workbench（云服务器工作台）
const CLOUD_WB_URL = process.env.CLOUD_WB_URL || ''
// 云工作台凭据只允许通过环境变量注入；分发版不携带任何人的 token。
const CLOUD_WB_TOKEN = process.env.CLOUD_WB_TOKEN || ''

async function pushApplicationToCloud(record) {
  if (!CLOUD_WB_URL || !CLOUD_WB_TOKEN) return
  try {
    const res = await fetch(`${CLOUD_WB_URL}/api/applications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CLOUD_WB_TOKEN}`
      },
      body: JSON.stringify({
        platform: record.platform || 'boss',
        job_name: record.jobName || '',
        salary: record.salaryDesc || '',
        brand: record.brandName || '',
        city: record.cityName || '',
        reason: record.reason || '',
        sent: record.sent ? 1 : 0,
        source: 'daemon'
      })
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[worker] 推送投递记录到云工作台失败: ${res.status} ${err.slice(0, 150)}`)
    } else {
      console.log(`[worker] 已推送投递记录到云工作台: ${record.jobName}`)
    }
  } catch (err) {
    console.error(`[worker] 推送云工作台异常: ${err?.message}`)
  }
}

async function pauseOnRiskSignal(platform, risk) {
  state.paused = true
  const reason = `检测到${risk?.kind || '异常页面'}，需人工检查后再继续`
  updateHuntPlan({ status: 'blocked', reason, blockedAt: new Date().toISOString(), risk: risk || null })
  setProgress({ phase: 'risk_blocked', reason, currentJob: null })
  console.error(`[worker] 🚨 【${platform}】风控信号: ${risk?.kind || 'unknown'} (${risk?.url || ''}) — 已暂停调度`)
}

async function blockForManualIntervention(platform, { code = 'platform_issue', reason = '页面状态异常，需要人工检查', phase = 'blocked', evidence = null } = {}) {
  state.paused = true
  updateHuntPlan({ status: 'blocked', reason, blockedAt: new Date().toISOString(), issue: { code, evidence } })
  setProgress({ phase, reason, currentJob: null, issue: { platform, code, evidence } })
  console.error(`[worker] 【${platform}】${reason}（${code}），已暂停等待人工检查`)
}

// “blocked”不全是同一类问题：登录失效、验证页和投递结果不确定需要用户先
// 人工确认；但“页面选择器未命中/页面尚未就绪”在适配器修复后应允许直接重新
// 开一个新任务，不能把旧错误永久锁住。
function blockNeedsAcknowledgement(plan) {
  if (plan?.risk) return true
  const code = String(plan?.issue?.code || '')
  return ['risk_detected', 'login_required', 'delivery_indeterminate', 'apply_indeterminate'].includes(code)
}

// 随机打乱数组（避免每天固定从同一平台开始，降低风控固化风险）
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function checkLoginBeforeHunt(platforms) {
  const results = []
  for (const platform of platforms) {
    const prevPlatform = currentPlatform()
    if (prevPlatform && prevPlatform !== platform) {
      await closePlatformBrowser(prevPlatform)
    }
    setActivePlatform(platform)
    currentPlatformCache = platform
    const result = await inspectPlatformLogin(platform, { open: true, save: true })
    results.push(result)
    console.log(`[worker] 【${platform}】登录检查: ${result.loggedIn === true ? '已登录，状态已保存' : '需要登录'}`)
  }
  return results
}

function normalizeKeywordOverride(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean).slice(0, 30)
  if (typeof value === 'string') return value.split(/[|,，、\n；;]/).map(v => v.trim()).filter(Boolean).slice(0, 30)
  return []
}

function configuredSearchKeywords(config = {}) {
  const sourceKeywords = (config.jobSourceList || [])
    .filter(s => s.type === 'search' && s.enabled !== false)
    .flatMap(s => (s.children || []))
    .filter(c => c.type === 'search-kw' && c.enabled !== false)
    .map(c => String(c.keyword || '').trim())
    .filter(Boolean)
  return sourceKeywords.length ? sourceKeywords : normalizeKeywordOverride(config.expectJobNameRegExpStr)
}

function normalizePlatformTarget(value) {
  const platform = String(value || '').trim().toLowerCase()
  return platform && platform !== 'all' ? platform : ''
}

function configWithKeywordOverride(config, keywords) {
  const normalized = normalizeKeywordOverride(keywords)
  if (!normalized.length) return config || {}
  return {
    ...(config || {}),
    // 本轮覆盖只存在于内存里，不改平台原始配置；搜索和 JD 判断必须使用同一组关键词。
    expectJobNameRegExpStr: normalized.join('|'),
    jobSourceList: [{ type: 'search', enabled: true, children: normalized.map(keyword => ({ type: 'search-kw', enabled: true, keyword })) }]
  }
}

function recordHuntDecision({ status, job, judged, sent }) {
  const progress = state.progress || {}
  const countsAsScan = ['applied', 'skip', 'apply_failed', 'apply_indeterminate'].includes(status)
  const appliedIncrement = status === 'applied' ? 1 : 0
  const skippedIncrement = ['skip', 'apply_failed'].includes(status) ? 1 : 0
  const decision = {
    status,
    brandName: job?.brandName || '',
    jobName: job?.jobName || '',
    reason: judged?.reason || sent?.reason || '',
    time: new Date().toISOString()
  }
  const previousPlan = getHuntPlan()
  if (previousPlan) {
    const planPatch = {
      applied: previousPlan.applied + appliedIncrement,
      scanned: Number(previousPlan.scanned || 0) + (countsAsScan ? 1 : 0),
      skipped: Number(previousPlan.skipped || 0) + skippedIncrement,
      lastDecision: decision
    }
    if (status === 'blocked') {
      state.paused = true
      planPatch.status = 'blocked'
      planPatch.reason = decision.reason || '页面状态异常，需要人工检查'
      planPatch.blockedAt = new Date().toISOString()
    }
    if (status === 'apply_indeterminate') {
      state.paused = true
      planPatch.status = 'blocked'
      planPatch.reason = decision.reason || '投递结果不确定，需要人工检查'
      planPatch.blockedAt = new Date().toISOString()
    }
    updateHuntPlan(planPatch)
  }
  const nextPlan = getHuntPlan()
  setProgress({
    phase: status === 'applied' ? 'cooldown' : ['blocked', 'apply_indeterminate'].includes(status) ? 'blocked' : 'judging',
    target: nextPlan?.target,
    remaining: nextPlan?.remaining,
    scanned: nextPlan?.scanned ?? Number(progress.scanned || 0) + (countsAsScan ? 1 : 0),
    applied: nextPlan?.applied ?? Number(progress.applied || 0) + appliedIncrement,
    skipped: nextPlan?.skipped ?? Number(progress.skipped || 0) + skippedIncrement,
    currentJob: job ? { brandName: decision.brandName, jobName: decision.jobName } : null,
    lastDecision: decision,
    recentDecisions: [...(progress.recentDecisions || []), decision].slice(-12)
  })
  return decision
}

// Run one bounded pass on one platform. The pass deliberately yields when its
// platform reaches the random batch boundary; the caller then puts that
// platform into cooldown and selects another ready platform.
async function runPlatformPass(platform, maxJobs, keywordOverrides = [], { deferRest = false } = {}) {
  const adapter = await getAdapter(platform)
  if (!adapter) {
    return { platform, applied: 0, skipped: 0, scanned: 0, errors: [], reason: 'adapter_not_found' }
  }

  const prevPlatform = currentPlatform()
  if (prevPlatform && prevPlatform !== platform) await closePlatformBrowser(prevPlatform)
  setActivePlatform(platform)
  currentPlatformCache = platform

  const config = configWithKeywordOverride(readPlatformConfig(platform) || {}, keywordOverrides)
  if (config.enabled === false) return { platform, applied: 0, skipped: 0, scanned: 0, errors: [], reason: 'platform_disabled' }
  if (!configuredSearchKeywords(config).length) {
    console.log(`[worker] 【${platform}】未配置搜索关键词，跳过本平台，不进入冷却`)
    return { platform, applied: 0, skipped: 0, scanned: 0, errors: [], reason: 'no keywords' }
  }
  const cityName = config.daemonCity || (Array.isArray(config.expectCityList) && config.expectCityList[0]) || ''
  console.log(`[worker] 【${platform}】开始投递一轮 (limit=${maxJobs}, city=${cityName})`)
  adapter.configure?.(config)
  try {
    await adapter.launch?.()
  } catch (err) {
    console.error(`[worker] ${platform} 浏览器启动失败: ${err?.message}`)
    return { platform, applied: 0, skipped: 0, scanned: 0, errors: [{ code: 'browser_launch_failed', reason: err?.message || String(err) }], reason: 'browser_launch_failed' }
  }

  const shouldStop = () => state.paused || !isDeliveryWindowOpen()
  const onJob = ({ status, job, judged, sent }) => {
    recordHuntDecision({ status, job, judged, sent })
    if (status !== 'applied') return
    const record = {
      platform,
      jobId: job?.jobId,
      jobName: job?.jobName,
      salaryDesc: job?.salaryDesc,
      brandName: job?.brandName,
      cityName: job?.cityName,
      postDescription: job?.postDescription || '',
      reason: judged?.reason || '',
      sent: !!sent?.clicked
    }
    store.addApplication(record)
    pushApplicationToCloud(record).catch(() => {})
  }

  let report
  if (typeof adapter.autoHunt === 'function') {
    report = await adapter.autoHunt({
      maxJobs,
      keywords: normalizeKeywordOverride(keywordOverrides),
      cityName,
      platformConfig: config,
      onRisk: risk => pauseOnRiskSignal(platform, risk),
      shouldStop,
      deferRest,
      onJob
    })
  } else {
    report = await runGenericHunt(adapter, { maxJobs, cityName, platformConfig: config, deferRest, shouldStop })
  }
  const result = { platform, ...(report || {}) }
  if (!state.paused && !isDeliveryWindowOpen() && !result.reason) result.reason = 'outside_delivery_window'
  return result
}

async function runHuntRound(maxJobsOverride, targetPlatform, keywordOverrides = []) {
  if (state.running) return { applied: 0, skipped: 0, reason: 'already_running', plan: getHuntPlan() }
  if (targetPlatform && !PLATFORMS.includes(targetPlatform)) {
    console.log(`[worker] 平台 ${targetPlatform} 已停用，本轮拒绝执行`)
    return { applied: 0, skipped: 0, reason: 'platform_disabled', platform: targetPlatform, plan: getHuntPlan() }
  }
  if (targetPlatform && !listEnabledPlatforms().includes(targetPlatform)) {
    console.log(`[worker] 平台 ${targetPlatform} 未启用或没有配置，本轮拒绝执行`)
    return { applied: 0, skipped: 0, reason: 'platform_disabled', platform: targetPlatform, plan: getHuntPlan() }
  }

  const target = normalizePlanTarget(maxJobsOverride)
  if (!state.huntPlan) createHuntPlan({ target, platform: targetPlatform, keywords: keywordOverrides, source: 'worker' })
  state.running = true
  updateHuntPlan({ status: 'preflight', reason: '', rounds: Number(state.huntPlan?.rounds || 0) + 1, lastRoundStartedAt: new Date().toISOString() })
  setProgress({
    phase: 'preflight',
    target: getHuntPlan()?.target ?? target,
    remaining: getHuntPlan()?.remaining ?? target,
    applied: getHuntPlan()?.applied || 0,
    scanned: getHuntPlan()?.scanned || 0,
    skipped: getHuntPlan()?.skipped || 0,
    currentJob: null,
    reason: ''
  })

  let loginResults = []
  const overall = { applied: 0, skipped: 0 }
  try {
    // 没有指定平台时读取所有已启用的平台；没有关键词的平台不参与登录检查、
    // 不打开浏览器，也不应被计入投递冷却。
    const normalizedOverrides = normalizeKeywordOverride(keywordOverrides)
    let platforms = targetPlatform ? [targetPlatform] : listEnabledPlatforms()
    const skippedPlatforms = platforms.filter(item => !normalizedOverrides.length && !configuredSearchKeywords(readPlatformConfig(item) || {}).length)
    platforms = platforms.filter(item => normalizedOverrides.length || !skippedPlatforms.includes(item))
    if (skippedPlatforms.length) {
      console.log(`[worker] 本轮忽略未配置搜索关键词的平台: ${skippedPlatforms.join(', ')}`)
    }
    platforms = shuffle(platforms.filter(Boolean))
    if (!platforms.length) {
      const reason = skippedPlatforms.length
        ? `启用平台未配置搜索关键词，未开始投递：${skippedPlatforms.join('、')}`
        : '没有启用的平台，未开始投递'
      updateHuntPlan({ status: 'blocked', reason })
      setProgress({ phase: 'blocked', reason })
      return { ...overall, reason: skippedPlatforms.length ? 'no_keywords' : 'no_enabled_platform', plan: getHuntPlan() }
    }
    console.log(`[worker] 本轮投递平台顺序: ${platforms.join(' → ')}`)

    if (!isDeliveryWindowOpen()) {
      const next = nextDeliveryWindowStart()
      const reason = `当前不在投递时间窗（${deliveryWindowLabel()}），本轮未启动；下个开始时间为 ${next.toLocaleString()}`
      updateHuntPlan({ status: 'outside_window', reason })
      setProgress({ phase: 'outside_delivery_window', reason, currentJob: null })
      return { ...overall, reason: 'outside_delivery_window', plan: getHuntPlan() }
    }

    // 投递前先确认保存的登录态。未登录时不进入岗位页反复重试。
    loginResults = await checkLoginBeforeHunt(platforms)
    const missingLogin = loginResults.filter(x => x.loggedIn !== true)
    if (missingLogin.length) {
      const reason = `登录检查未通过：${missingLogin.map(x => x.platform).join(', ')}`
      state.paused = true
      updateHuntPlan({ status: 'blocked', reason, login: loginResults, blockedAt: new Date().toISOString() })
      setProgress({ phase: 'login_required', login: loginResults, reason })
      console.log(`[worker] ${reason}，已暂停投递`)
      return { ...overall, reason: 'login_required', login: loginResults, plan: getHuntPlan() }
    }
    if (state.paused) return { ...overall, reason: 'paused', login: loginResults, plan: getHuntPlan() }

    updateHuntPlan({ status: 'running', reason: '', login: loginResults, startedAt: state.huntPlan?.startedAt || new Date().toISOString() })
    resetPlatformSchedule(platforms)
    setProgress({ phase: 'delivering', login: loginResults, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })

    // Rotate through ready platforms. A platform that reaches its random
    // batch boundary is put into its own cooldown; other platforms continue
    // while its timer counts down.
    let rotationCursor = 0
    const noProgress = new Set()
    while (!state.paused && (getHuntPlan()?.remaining || 0) > 0) {
      const scheduleStop = stopReasonForSchedule()
      if (scheduleStop === 'outside_delivery_window') {
        const reason = `已到投递停止时间（${deliveryWindowLabel()}），本轮暂存剩余岗位`
        updateHuntPlan({ status: 'outside_window', reason })
        setProgress({ phase: 'outside_delivery_window', reason, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })
        break
      }
      const selected = selectReadyPlatform(platforms, rotationCursor)
      if (!selected) {
        if (!await waitForPlatformAvailability(platforms)) break
        continue
      }
      const { platform, index } = selected
      rotationCursor = (index + 1) % platforms.length
      markPlatformActive(platform)
      const remaining = getHuntPlan()?.remaining ?? target
      const batchLimit = Math.min(remaining, randInt(pacingConfig().batchCountMin, pacingConfig().batchCountMax))
      setProgress({ phase: 'delivering', activePlatform: platform, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })
      const report = await runPlatformPass(platform, batchLimit, keywordOverrides, { deferRest: true })
      overall.applied += report?.applied || 0
      overall.skipped += report?.skipped || 0
      state.lastHunt = { time: new Date().toISOString(), platform, ...report, plan: getHuntPlan() }
      if (report?.errors?.length) {
        const firstError = report.errors[0]
        const reason = firstError?.reason || firstError?.error || firstError?.code || '岗位搜索异常'
        updateHuntPlan({ lastError: firstError, reason })
      }

      const cooldownMinutes = Number(report?.cooldownMinutes) > 0
        ? Number(report.cooldownMinutes)
        : report?.applied > 0
          ? randInt(pacingConfig().batchRestMinMinutes, pacingConfig().batchRestMaxMinutes)
          : 0
      if (cooldownMinutes > 0) {
        setPlatformCooldown(platform, cooldownMinutes, report?.reason === 'platform_cooldown' ? 'batch_rest' : 'pass_complete', report.applied || 0)
        noProgress.delete(platform)
        console.log(`[worker] 【${platform}】进入独立冷却 ${cooldownMinutes} 分钟，转到其他可投平台`)
      } else {
        markPlatformReady(platform)
        if (report?.applied > 0) noProgress.clear()
        else noProgress.add(platform)
      }
      persistRuntimeState()
      console.log(`[worker] 【${platform}】投递轮完成: applied=${report?.applied || 0} skipped=${report?.skipped || 0}`)
      if (state.paused || ['outside_delivery_window', 'paused', 'login_required', 'risk_detected', 'delivery_indeterminate', 'browser_launch_failed'].includes(report?.reason)) break
      if (noProgress.size >= platforms.length) {
        const reason = '所有已启用平台本轮都没有新增投递，保留诊断等待下一次明确继续'
        updateHuntPlan({ status: 'incomplete', reason })
        setProgress({ phase: 'incomplete', reason, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })
        break
      }
    }
  } catch (err) {
    const reason = err?.message || String(err)
    updateHuntPlan({ status: 'error', reason, failedAt: new Date().toISOString() })
    setProgress({ phase: 'error', reason, currentJob: null })
    console.error(`[worker] 投递轮异常: ${reason}`)
  } finally {
    state.running = false
    const plan = getHuntPlan()
    if (plan) {
      let status = plan.status
      let phase = state.progress?.phase || 'idle'
      let reason = plan.reason || ''
      if (state.paused && status !== 'blocked') {
        status = 'paused'
        phase = 'paused'
        reason = reason || '已收到停止请求'
      } else if (status === 'blocked') {
        phase = state.progress?.phase === 'login_required' ? 'login_required' : 'blocked'
      } else if (status === 'error') {
        phase = 'error'
      } else if (plan.remaining <= 0) {
        status = 'completed'
        phase = 'completed'
        reason = ''
      } else if (status === 'outside_window' || state.progress?.phase === 'outside_delivery_window') {
        status = 'outside_window'
        phase = 'outside_delivery_window'
        reason = reason || `当前不在投递时间窗（${deliveryWindowLabel()}）`
      } else {
        // 一次搜索结果耗尽、城市不一致或页面异常都不是“完成”。保留剩余数，
        // 由人或 MCP Agent 根据诊断决定继续、改条件或人工处理。
        status = 'incomplete'
        phase = 'incomplete'
        reason = reason || `本轮扫描结束，仍需投递 ${plan.remaining} 个岗位`
      }
      updateHuntPlan({ status, reason, lastRoundEndedAt: new Date().toISOString() })
      const latest = getHuntPlan()
      setProgress({
        phase,
        reason,
        target: latest?.target,
        remaining: latest?.remaining,
        applied: latest?.applied,
        scanned: latest?.scanned,
        skipped: latest?.skipped,
        platformSchedule: getPlatformScheduleSnapshot(),
        currentJob: null,
        completedAt: new Date().toISOString()
      })
    }
    persistRuntimeState()
    if (state.continuous) {
      console.log('[worker] 连续投递：本轮结束后由持续投递 supervisor 安排下一轮')
    } else {
      console.log('[worker] 投递轮结束：不会读取或发送站外消息')
    }
  }
  console.log(`[worker] 本轮总投递: applied=${overall.applied} skipped=${overall.skipped}`)
  return { ...overall, login: loginResults, plan: getHuntPlan() }
}

// 通用投递编排骨架：search → readJD → judge → dedup → apply → record。
// 非 BOSS 平台都走这里。适配器必须返回明确的 success=true 才能记为成功；
// 点击后没有最终证据时会暂停并保留 indeterminate 记录，绝不自动重试点击。
async function runGenericHunt(adapter, { maxJobs, cityName, platformConfig, deferRest = false, shouldStop = () => state.paused }) {
  const config = platformConfig || {}
  const keywords = configuredSearchKeywords(config)
  const report = { applied: 0, skipped: 0, scanned: 0, errors: [], indeterminate: [] }
  const stopReason = () => shouldStop() ? (state.paused ? 'paused' : 'outside_delivery_window') : ''
  if (!keywords.length) {
    console.log(`[worker] 【${adapter.platform}】未配置搜索关键词，跳过`)
    return { ...report, reason: 'no keywords' }
  }

  const { llmJudgeJob } = await import('./llm.mjs')
  const pacingState = createPacingState()
  const mark = (status, job, reason, sent = null, judged = null) => {
    const item = job || { jobName: '(未识别岗位)', brandName: '' }
    const decision = recordHuntDecision({
      status,
      job: item,
      judged: judged || (reason ? { reason } : null),
      sent: sent || (reason ? { reason } : null)
    })
    if (status === 'applied') report.applied += 1
    if (status === 'skip' || status === 'apply_failed') report.skipped += 1
    return decision
  }

  for (const keyword of keywords) {
    if (stopReason()) return { ...report, reason: stopReason() }
    if (report.applied >= maxJobs) break
    setProgress({ phase: 'searching', currentKeyword: keyword, currentJob: null })

    let searchResult = null
    let lastSearchError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await adapter.searchJobs(keyword, cityName, config)
        lastSearchError = result
        // “页面尚未就绪”不能伪装成登录失效。只有平台明确报登录页，或没有
        // 其它错误码却明确返回未登录时，才进入登录阻断。
        const loginFailed = result?.code === 'login_required'
          || result?.diagnostics?.loginRequired === true
          || (result?.loggedIn === false && !result?.code)
        if (loginFailed) {
          const error = { code: 'login_required', reason: result.reason || '登录状态失效', keyword, diagnostics: result.diagnostics }
          report.errors.push(error)
          await blockForManualIntervention(adapter.platform, { code: error.code, reason: error.reason, phase: 'login_required', evidence: result.diagnostics })
          return { ...report, reason: 'login_required' }
        }
        if (result?.risk || result?.code === 'risk_detected') {
          const risk = result.risk || { kind: 'platform_verification', url: result.url }
          report.errors.push({ code: 'risk_detected', reason: result.reason || '平台验证', risk })
          await pauseOnRiskSignal(adapter.platform, risk)
          return { ...report, riskPaused: true }
        }
        if (result?.ok === true && Array.isArray(result.list)) {
          searchResult = result
          break
        }
        if (['city_switch_failed', 'city_selector_not_found', 'city_selector_click_failed', 'city_dialog_not_found', 'city_option_not_found', 'search_page_not_opened'].includes(result?.code)) {
          const error = { code: result.code, reason: result.reason || '平台搜索条件未就绪', keyword }
          report.errors.push(error)
          await blockForManualIntervention(adapter.platform, { code: error.code, reason: error.reason, phase: 'blocked', evidence: result.diagnostics })
          return { ...report, reason: result.code }
        }
        console.log(`[worker] 【${adapter.platform}】搜索 ${keyword} 未就绪（第 ${attempt + 1}/3）: ${result?.reason || 'unknown'}`)
      } catch (err) {
        lastSearchError = { code: 'search_exception', reason: err?.message || String(err) }
        console.log(`[worker] 【${adapter.platform}】搜索 ${keyword} 异常(${attempt + 1}/3): ${err?.message}`)
      }
      if (attempt < 2 && !stopReason()) await sleep(5000 + Math.random() * 5000)
    }
    if (!searchResult) {
      if (lastSearchError?.code && lastSearchError.code !== 'no_results') report.errors.push({ ...lastSearchError, keyword })
      if (['page_not_ready', 'search_result_tab_not_opened'].includes(lastSearchError?.code)) {
        await blockForManualIntervention(adapter.platform, {
          code: lastSearchError.code,
          reason: lastSearchError.reason || '职位结果页没有就绪',
          phase: 'blocked',
          evidence: lastSearchError.diagnostics || null
        })
        return { ...report, reason: lastSearchError.code }
      }
      continue
    }
    const list = searchResult.list
    if (!list.length) continue

    for (let idx = 0; idx < list.length && report.applied < maxJobs; idx++) {
      if (stopReason()) return { ...report, reason: stopReason() }
      const listEntry = list[idx] || null
      report.scanned += 1
      setProgress({
        phase: 'reading_jd',
        currentKeyword: keyword,
        currentJob: listEntry ? { brandName: listEntry.brandName, jobName: listEntry.jobName } : null
      })
      try {
        const detail = await adapter.readJobDetail(idx)
        const job = detail?.listEntry || detail?.job || listEntry
        if (!job || !job.jobName) {
          mark('skip', listEntry, '未读取到完整岗位信息')
          continue
        }
        if (job.hasApply === false || job.alreadyApplied === true) {
          mark('skip', job, job.alreadyApplied ? '岗位已投递' : '无明确投递入口')
          continue
        }
        if (job.brandName && store.hasCompanyBeenApplied(job.brandName)) {
          mark('skip', job, '公司已投递过，避免重复投递')
          continue
        }

        setProgress({ phase: 'judging', currentJob: { brandName: job.brandName, jobName: job.jobName } })
        let judged
        try {
          judged = await llmJudgeJob(job, config)
        } catch (err) {
          judged = { match: false, reason: `LLM 判断失败，未自动投递：${err?.message || '请检查模型配置'}` }
        }
        if (judged?.match !== true) {
          mark('skip', job, judged?.reason || '未通过岗位匹配判断', null, judged)
          continue
        }
        if (stopReason()) return { ...report, reason: stopReason() }

        let risk = null
        try { risk = await adapter.detectRiskSignal?.() } catch {}
        if (risk) {
          report.errors.push({ code: 'risk_detected', reason: risk.kind || '平台验证', risk })
          await pauseOnRiskSignal(adapter.platform, risk)
          return { ...report, riskPaused: true }
        }
        setProgress({ phase: 'applying', currentJob: { brandName: job.brandName, jobName: job.jobName } })
        let sent
        try {
          sent = await adapter.apply(job)
        } catch (err) {
          sent = { ok: false, success: false, code: 'apply_exception', reason: err?.message || String(err) }
        }
        if (sent?.risk || sent?.code === 'risk_detected' || sent?.code === 'login_required') {
          report.errors.push({ code: sent.code, reason: sent.reason || '平台状态异常', evidence: sent.evidence })
          if (sent.code === 'risk_detected') await pauseOnRiskSignal(adapter.platform, sent.risk || { kind: 'platform_verification', url: '' })
          else await blockForManualIntervention(adapter.platform, { code: sent.code, reason: sent.reason || '登录状态失效', phase: 'login_required', evidence: sent.evidence })
          return { ...report, reason: sent.code }
        }
        if (sent?.indeterminate || sent?.code === 'delivery_indeterminate') {
          const reason = sent.reason || '投递结果不确定，需要人工检查'
          report.indeterminate.push({ job, reason, evidence: sent.evidence || null })
          mark('apply_indeterminate', job, reason, sent, judged)
          await blockForManualIntervention(adapter.platform, { code: 'delivery_indeterminate', reason, phase: 'delivery_indeterminate', evidence: sent.evidence || null })
          return { ...report, reason: 'delivery_indeterminate' }
        }
        if (sent?.ok === true && sent?.success === true) {
          mark('applied', job, judged.reason || '平台返回明确投递成功', sent, judged)
          const record = {
            platform: adapter.platform,
            jobId: job.jobId,
            jobName: job.jobName,
            salaryDesc: job.salaryDesc,
            brandName: job.brandName,
            cityName: job.cityName,
            postDescription: job.postDescription || '',
            reason: judged.reason || '',
            sent: sent.clicked !== false,
            deliveryEvidence: sent.evidence || null
          }
          store.addApplication(record)
          pushApplicationToCloud(record).catch(() => {})
          const waitResult = await waitAfterApplication(pacingState, { deferRest, shouldStop })
          if (!waitResult.ok) return { ...report, reason: waitResult.reason, cooldownMinutes: waitResult.cooldownMinutes }
        } else {
          const reason = sent?.reason || '平台未确认投递成功'
          console.log(`[worker] 【${adapter.platform}】${job.brandName} 投递失败: ${reason}`)
          mark('apply_failed', job, reason, sent, judged)
          report.errors.push({ code: sent?.code || 'apply_failed', reason, job: { brandName: job.brandName, jobName: job.jobName } })
        }
      } catch (err) {
        const reason = err?.message || String(err)
        report.errors.push({ code: 'job_processing_error', reason, job: { brandName: listEntry?.brandName, jobName: listEntry?.jobName } })
        mark('skip', listEntry, `岗位处理异常：${reason}`)
      }
    }
  }
  return { ...report, reason: report.applied >= maxJobs ? 'target_reached' : undefined }
}

// 随机整数 [min, max]
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pacingConfig() {
  return readWorkbenchSettings().pacing
}

function createPacingState() {
  const pacing = pacingConfig()
  return {
    appliedSinceRest: 0,
    nextRestAfter: randInt(pacing.batchCountMin, pacing.batchCountMax)
  }
}

async function waitAfterApplication(pacingState, { deferRest = false, shouldStop = () => state.paused } = {}) {
  const pacing = pacingConfig()
  pacingState.appliedSinceRest += 1
  const gapSeconds = randInt(pacing.applicationGapMinSeconds, pacing.applicationGapMaxSeconds)
  console.log(`[worker] 下一次投递前等待 ${gapSeconds} 秒（随机范围 ${pacing.applicationGapMinSeconds}-${pacing.applicationGapMaxSeconds}）`)
  if (!await sleepWithPause(gapSeconds * 1000, shouldStop)) return { ok: false, reason: state.paused ? 'paused' : 'outside_delivery_window' }
  if (pacingState.appliedSinceRest < pacingState.nextRestAfter) return { ok: true }
  const restMinutes = randInt(pacing.batchRestMinMinutes, pacing.batchRestMaxMinutes)
  console.log(`[worker] 已完成 ${pacingState.appliedSinceRest} 个岗位，休息 ${restMinutes} 分钟（随机范围 ${pacing.batchRestMinMinutes}-${pacing.batchRestMaxMinutes}）`)
  if (deferRest) return { ok: false, reason: 'platform_cooldown', cooldownMinutes: restMinutes }
  if (!await sleepWithPause(restMinutes * 60 * 1000, shouldStop)) return { ok: false, reason: state.paused ? 'paused' : 'outside_delivery_window' }
  pacingState.appliedSinceRest = 0
  pacingState.nextRestAfter = randInt(pacing.batchCountMin, pacing.batchCountMax)
  return { ok: true }
}

export async function startScheduler() {
  const platforms = listEnabledPlatforms()
  console.log(`[worker] 调度启动：只在用户明确触发后投递，不自动读取或发送消息（平台=${platforms.join(',') || '无'}）`)
  while (true) {
    await sleep(60 * 1000)
  }
}

// 连续投递：每个平台独立计数、独立冷却。一个平台休息时，调度器会
// 立即选择其它 ready 平台；没有 ready 平台时才等待最早结束的冷却。
// 这是显式用户动作，不会在 daemon 启动时自动调用。
async function runContinuousHunt({ platform = '', keywords = [], source = 'manual' } = {}) {
  const requestedPlatforms = platform ? [platform] : listEnabledPlatforms()
  const keywordOverrides = normalizeKeywordOverride(keywords)
  const skippedPlatforms = requestedPlatforms.filter(item => !keywordOverrides.length && !configuredSearchKeywords(readPlatformConfig(item) || {}).length)
  const platforms = requestedPlatforms.filter(item => keywordOverrides.length || !skippedPlatforms.includes(item))
  let enteredWindow = false
  try {
    if (skippedPlatforms.length) {
      console.log(`[worker] 连续投递忽略未配置搜索关键词的平台: ${skippedPlatforms.join(', ')}`)
    }
    if (!platforms.length) {
      const reason = skippedPlatforms.length
        ? `启用平台未配置搜索关键词，连续投递未启动：${skippedPlatforms.join('、')}`
        : '没有启用的平台，连续投递未启动'
      setProgress({ phase: 'blocked', reason, currentJob: null })
      return
    }
    state.running = true
    state.huntPlan = null
    resetPlatformSchedule(platforms)
    setProgress({
      phase: 'preflight',
      continuous: true,
      deliveryWindow: deliveryWindowConfig(),
      reason: '',
      currentJob: null,
      platformSchedule: getPlatformScheduleSnapshot(platforms)
    })

    // 如果用户在开始时间之前启动，等待开始时间；一旦当天窗口结束，
    // 当前连续任务结束，不跨夜自动恢复。
    if (!isDeliveryWindowOpen() && !await waitUntilDeliveryWindow()) return
    const loginResults = await checkLoginBeforeHunt(platforms)
    const missingLogin = loginResults.filter(x => x.loggedIn !== true)
    if (missingLogin.length) {
      const reason = `登录检查未通过：${missingLogin.map(x => x.platform).join(', ')}`
      state.paused = true
      setProgress({ phase: 'login_required', login: loginResults, reason, currentJob: null })
      console.log(`[worker] ${reason}，连续投递已暂停`)
      return
    }

    let rotationCursor = 0
    const noProgress = new Set()
    let round = 0
    while (state.continuous && !state.paused) {
      if (!isDeliveryWindowOpen()) {
        const reason = `已到投递停止时间（${deliveryWindowLabel()}），今天的连续投递已结束`
        setProgress({ phase: 'outside_delivery_window', continuous: true, reason, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })
        break
      }
      enteredWindow = true
      const selected = selectReadyPlatform(platforms, rotationCursor)
      if (!selected) {
        if (!await waitForPlatformAvailability(platforms)) break
        continue
      }
      const { platform: selectedPlatform, index } = selected
      rotationCursor = (index + 1) % platforms.length
      const pacing = pacingConfig()
      const batchTarget = randInt(pacing.batchCountMin, pacing.batchCountMax)
      round += 1
      markPlatformActive(selectedPlatform)
      setProgress({
        phase: 'delivering',
        continuous: true,
        continuousRound: round,
        activePlatform: selectedPlatform,
        currentJob: null,
        platformSchedule: getPlatformScheduleSnapshot(platforms)
      })
      console.log(`[worker] 连续投递第 ${round} 个平台批次: ${selectedPlatform}，目标 ${batchTarget} 个`)

      const report = await runPlatformPass(selectedPlatform, batchTarget, keywords, { deferRest: true })
      state.lastHunt = { time: new Date().toISOString(), platform: selectedPlatform, ...report }
      const applied = Number(report?.applied) || 0
      const cooldownMinutes = Number(report?.cooldownMinutes) > 0
        ? Number(report.cooldownMinutes)
        : applied > 0
          ? randInt(pacing.batchRestMinMinutes, pacing.batchRestMaxMinutes)
          : 0
      if (cooldownMinutes > 0) {
        setPlatformCooldown(selectedPlatform, cooldownMinutes, 'batch_rest', applied)
      } else {
        markPlatformReady(selectedPlatform)
      }
      if (applied > 0) noProgress.clear()
      else noProgress.add(selectedPlatform)
      persistRuntimeState()
      console.log(`[worker] 【${selectedPlatform}】批次结束: applied=${applied} skipped=${report?.skipped || 0}${cooldownMinutes > 0 ? `，冷却 ${cooldownMinutes} 分钟` : '，未新增投递，不进入冷却'}`)

      if (state.paused || ['outside_delivery_window', 'paused', 'login_required', 'risk_detected', 'delivery_indeterminate', 'browser_launch_failed'].includes(report?.reason)) break
      if (noProgress.size >= platforms.length && platforms.length > 0) {
        const reason = '所有可投递平台本轮都没有新增投递，连续任务已暂停；未进入投递冷却'
        setProgress({ phase: 'incomplete', continuous: true, reason, currentJob: null, platformSchedule: getPlatformScheduleSnapshot(platforms) })
        break
      }
    }
  } catch (err) {
    const reason = err?.message || String(err)
    console.error(`[worker] 连续投递异常: ${reason}`)
    setProgress({ phase: 'error', reason, currentJob: null })
  } finally {
    state.running = false
    state.continuous = false
    if (state.paused) setProgress({ phase: 'paused', continuous: false, currentJob: null })
    else if (enteredWindow && !isDeliveryWindowOpen() && state.progress?.phase !== 'error') {
      setProgress({ phase: 'outside_delivery_window', continuous: false, currentJob: null })
    }
    persistRuntimeState()
    console.log('[worker] 连续投递已停止，等待下一次明确启动')
  }
}

export function startContinuousHunt({ platform = '', keywords = [], source = 'manual', acknowledgeRisk = false } = {}) {
  const targetPlatform = normalizePlatformTarget(platform)
  if (state.running) return { ok: false, reason: 'already_running', runtime: getWorkerSnapshot() }
  if (state.continuous) return { ok: false, reason: 'already_continuous', runtime: getWorkerSnapshot() }
  if (targetPlatform && !PLATFORMS.includes(targetPlatform)) return { ok: false, reason: 'platform_disabled', platform: targetPlatform, runtime: getWorkerSnapshot() }
  if (targetPlatform && !listEnabledPlatforms().includes(targetPlatform)) return { ok: false, reason: 'platform_disabled', platform: targetPlatform, runtime: getWorkerSnapshot() }
  const existingPlan = getHuntPlan()
  if (existingPlan?.status === 'blocked' && blockNeedsAcknowledgement(existingPlan) && !acknowledgeRisk) {
    return { ok: false, reason: 'manual_check_required', plan: existingPlan, runtime: getWorkerSnapshot() }
  }

  state.continuous = true
  setPaused(false, '')
  runContinuousHunt({ platform: targetPlatform, keywords, source }).catch(err => console.error(`[worker] 连续投递 supervisor 异常: ${err?.message}`))
  return { ok: true, action: 'started', continuous: true, runtime: getWorkerSnapshot() }
}

export function stopContinuousHunt(reason = '已暂停持续投递') {
  // 保留 continuous=true 到当前异步批次退到安全节点；这样前端不会在
  // “停止请求”与实际停止之间误显示成另一种手动任务。
  const wasContinuous = state.continuous
  setPaused(true, reason)
  if (!wasContinuous) state.continuous = false
  return { ok: true, action: 'stopped', continuous: !!state.continuous, runtime: getWorkerSnapshot() }
}

export function toggleContinuousHunt({ platform = '', keywords = [], source = 'manual', acknowledgeRisk = false } = {}) {
  // 右上角按钮在手动定量任务进行中时，仍保留“暂停当前投递”的安全能力。
  if (state.running && !state.continuous) {
    setPaused(!state.paused, state.paused ? '恢复当前定量投递' : '暂停当前定量投递')
    return { ok: true, action: state.paused ? 'paused_manual' : 'resumed_manual', runtime: getWorkerSnapshot() }
  }
  if (state.continuous && !state.paused) return stopContinuousHunt()
  return startContinuousHunt({ platform, keywords, source, acknowledgeRisk })
}

// 手动触发投递。每一次普通“开始投 N 个”都会创建一个新的明确任务；
// “继续投”必须走 resumeHunt，避免把上一次未完成任务和新任务混在一起。
export async function triggerHunt(maxJobs, {
  asyncMode = false,
  platform,
  keywords = [],
  source = 'manual',
  resume = false,
  acknowledgeRisk = false,
  continuousRound = false
} = {}) {
  if (state.running) return { ok: false, reason: 'already_running', plan: getHuntPlan() }
  if (state.continuous && !continuousRound) return { ok: false, reason: 'continuous_running', plan: getHuntPlan() }
  const targetPlatform = normalizePlatformTarget(platform)
  if (targetPlatform && !PLATFORMS.includes(targetPlatform)) return { ok: false, reason: 'platform_disabled', platform: targetPlatform, plan: getHuntPlan() }
  if (targetPlatform && !listEnabledPlatforms().includes(targetPlatform)) return { ok: false, reason: 'platform_disabled', platform: targetPlatform, plan: getHuntPlan() }

  let plan
  if (resume) {
    plan = getHuntPlan()
    if (!plan) return { ok: false, reason: 'no_resumable_plan' }
    if (plan.remaining <= 0) return { ok: false, reason: 'plan_completed', plan }
    if (plan.status === 'blocked' && blockNeedsAcknowledgement(plan) && !acknowledgeRisk) {
      return { ok: false, reason: 'manual_check_required', plan }
    }
    setPaused(false)
    updateHuntPlan({ status: 'queued', reason: '', resumedAt: new Date().toISOString(), source })
    plan = getHuntPlan()
  } else {
    const oldPlan = getHuntPlan()
    if (state.paused && oldPlan?.status === 'blocked' && blockNeedsAcknowledgement(oldPlan) && !acknowledgeRisk) {
      return { ok: false, reason: 'manual_check_required', plan: oldPlan }
    }
    setPaused(false)
    plan = createHuntPlan({ target: maxJobs, platform: targetPlatform, keywords, source })
  }

  const roundTarget = plan.remaining
  const roundPlatform = normalizePlatformTarget(plan.platform)
  const roundKeywords = plan.keywords?.length ? plan.keywords : normalizeKeywordOverride(keywords)
  if (asyncMode) {
    // runHuntRound 在第一个 await 前立即占用 running 标志，避免两次“开始”并发。
    runHuntRound(roundTarget, roundPlatform, roundKeywords)
      .catch(err => console.error(`[worker] 后台投递异常: ${err?.message}`))
    return { ok: true, async: true, plan: getHuntPlan() }
  }
  const result = await runHuntRound(roundTarget, roundPlatform, roundKeywords)
  return { ok: result?.reason !== 'login_required' && result?.reason !== 'no_enabled_platform', ...result, plan: getHuntPlan() }
}

// 恢复的是同一个任务的剩余数，而不是重新按默认数量开一轮。
// 对风控/登录阻断，调用方必须把用户已经人工检查过的确认明确传入。
export async function resumeHunt({ asyncMode = true, source = 'manual', acknowledgeRisk = false } = {}) {
  const plan = getHuntPlan()
  if (!plan) return { ok: false, reason: 'no_resumable_plan' }
  if (plan.remaining <= 0) return { ok: false, reason: 'plan_completed', plan }
  return triggerHunt(plan.remaining, {
    asyncMode,
    platform: plan.platform,
    keywords: plan.keywords,
    source,
    resume: true,
    acknowledgeRisk
  })
}

// 只读诊断：不会导航、点击或打开新浏览器窗口。外部 Agent 在解释“为什么没投”
// 前应先读它，而不是猜测页面、城市或风控状态。
export async function getRuntimeDiagnostics() {
  const result = { worker: getWorkerSnapshot(), browser: { open: false, url: '', title: '', displayedCity: '', pageState: 'not_open' } }
  try {
    const page = getPage()
    if (!page || page.isClosed?.()) return result
    const activePlatform = currentPlatform()
    result.browser.open = true
    result.browser.platform = activePlatform
    result.browser.url = page.url?.() || ''
    try {
      const adapter = await getAdapter(activePlatform)
      if (typeof adapter?.getPageDiagnostics === 'function') {
        const platformDom = await adapter.getPageDiagnostics()
        result.browser = {
          ...result.browser,
          ...platformDom,
          pageState: platformDom?.riskDetected
            ? 'risk_or_verification'
            : platformDom?.loginRequired
              ? 'login_required'
              : platformDom?.pageReady
                ? 'jobs'
                : 'other'
        }
        return result
      }
    } catch (err) {
      result.browser.adapterDiagnosticsError = err?.message || String(err)
    }
    const dom = await safeEval(() => ({
      title: document.title || '',
      displayedCity: document.querySelector('.cur-city-label')?.textContent?.trim() || '',
      bodyStart: (document.body?.innerText || '').trim().slice(0, 180),
      hasJobList: !!document.querySelector('.job-list-container, .page-jobs-main'),
      hasCaptcha: !!document.querySelector('.captcha, .verify, .geetest, .login-qrcode'),
      hasLoginForm: !!document.querySelector('.login-btn, .btn-login, .login-qrcode')
    }))
    result.browser = {
      ...result.browser,
      title: dom?.title || '',
      displayedCity: dom?.displayedCity || '',
      pageState: dom?.hasCaptcha ? 'risk_or_verification' : dom?.hasLoginForm ? 'login_required' : dom?.hasJobList ? 'jobs' : 'other',
      bodyStart: dom?.bodyStart || ''
    }
  } catch (err) {
    result.browser.pageState = 'unavailable'
    result.browser.error = err?.message || String(err)
  }
  return result
}

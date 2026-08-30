import os from 'node:os'
import path from 'node:path'
import { sleep, safeEval, getPage } from './browser.mjs'
import { llmJudgeJob } from './llm.mjs'
import { readWorkbenchSettings } from './workbench-settings.mjs'
import {
  clickElementHandle,
  findIndexedVisibleHandle,
  findVisibleHandle,
  findVisibleTextHandle,
  isHandleVisible,
  readHandleText,
  readVisibleHandleTexts,
  disposeHandle
} from './platforms/ui-helpers.mjs'

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export const BOSS_HOME = 'https://www.zhipin.com/web/geek/jobs'

// 站内回到职位列表也优先点击可见导航；BOSS_HOME 只作为浏览器首次启动地址，
// 不用于设置城市、关键词或筛选条件。
export async function openJobsPage() {
  const page = getPage()
  if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
  const current = (await page.url()).split('?')[0]
  if (current === BOSS_HOME) return { ok: true, reused: true }
  let entry = await findVisibleHandle(page, [
    'a[href="/web/geek/jobs"]',
    'a[href*="/web/geek/jobs"]',
    '[class*="nav"] a[href*="/web/geek/jobs"]'
  ])
  if (!entry) entry = await findVisibleTextHandle(page, '职位', ['header a', 'nav a', '[class*="nav"] a'], { contains: true })
  if (!entry) entry = await findVisibleTextHandle(page, '招聘', ['header a', 'nav a', '[class*="nav"] a'], { contains: true })
  if (!entry) return { ok: false, code: 'jobs_page_not_opened', reason: '没有找到可见的职位列表入口' }
  if (!await clickElementHandle(entry, { delay: 45 + Math.floor(Math.random() * 45) })) {
    return { ok: false, code: 'jobs_page_not_opened', reason: '职位列表入口真实点击失败' }
  }
  await sleep(2500)
  const ready = await page.waitForSelector('.page-jobs-main, .job-list-container, .job-list-box', { timeout: 12000 }).catch(() => null)
  return ready ? { ok: true } : { ok: false, code: 'jobs_page_not_ready', reason: '点击职位列表入口后页面未就绪' }
}

export async function waitForPageReady() {
  const page = getPage()
  try {
    await page.waitForFunction(() => {
      const body = document.body?.innerText || ''
      return !body.includes('加载中，请稍候') && (document.querySelector('.page-jobs-main') || document.querySelector('.job-list-container') || body.includes('推荐'))
    }, { timeout: 30000 })
  } catch {}
}

export async function getState() {
  const page = getPage()
  await waitForPageReady()
  const url = await page.url()
  const result = await safeEval(() => {
    const cityEl = document.querySelector('.cur-city-label')
    const searchEl = document.querySelector('.search-input-box input')
    const qrCode = !!document.querySelector('.login-qrcode, .qrcode-content, .captcha, .verify')
    const userInfo = !!document.querySelector('.geek-user-info, .user-info, .account-info, .job-name')
    return {
      title: document.title?.slice(0, 80),
      displayedCity: cityEl?.textContent?.trim() || null,
      searchInput: searchEl?.value || null,
      isLoggedIn: userInfo && !qrCode
    }
  })
  const jobList = await readJobListData()
  return {
    url,
    displayedCity: result.displayedCity,
    isLoggedIn: result.isLoggedIn,
    jobListCount: jobList ? jobList.length : 0
  }
}

export async function searchJobs(keyword, cityName = null) {
  // 整体重试 2 次（首次搜索/导航时序紧张，容易 context destroyed）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await doSearch(keyword, cityName)
      if (r.ok) return r
      if (attempt < 3) {
        console.log(`[search] 第 ${attempt} 次失败(${r.error || r.reason})，重试...`)
        await sleep(3000)
        // 失败后通过页面上的可见职位入口重置状态，不直接输入搜索/城市 URL。
        const reset = await openJobsPage()
        if (!reset.ok) return reset
        await sleep(2000)
      }
    } catch (err) {
      console.error('[search] FULL STACK:', err?.stack || err?.message)
      if (attempt >= 3) return { ok: false, error: err?.message }
      await sleep(3000)
    }
  }
  return { ok: false, error: 'search failed after retries' }
}

async function doSearch(keyword, cityName = null) {
  const page = getPage()
  try {
    // 先在可见页面的城市弹层里完成选择，不能靠 URL 参数或本地城市表。
    let cityResult = null
    if (cityName) {
      cityResult = await switchCity(cityName)
      if (!cityResult.ok) {
        return { ok: false, code: 'city_switch_failed', reason: cityResult.reason, citySwitch: cityResult }
      }
      await sleep(1200)
    }

    await page.waitForSelector('.c-search-input .search-input-box', { timeout: 15000 }).catch(() => null)
    const inputHandle = await findVisibleHandle(page, [
      '.c-search-input .search-input-box input',
      '.c-search-input input[placeholder*="职位"]',
      '.c-search-input input'
    ])
    if (!inputHandle) return { ok: false, reason: 'no search input found' }
    try {
      await inputHandle.click({ delay: 35 })
      await sleep(300)
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.down(modifier)
      await page.keyboard.press('KeyA')
      await page.keyboard.up(modifier)
      await page.keyboard.press('Backspace')
      await sleep(300)
      await inputHandle.type(String(keyword || ''), { delay: 80 + Math.floor(Math.random() * 50) })
    } catch (e) {
      await disposeHandle(inputHandle)
      return { ok: false, reason: `search input interaction failed: ${e?.message || e}` }
    }
    await disposeHandle(inputHandle)
    await sleep(500)

    // 搜索必须点击页面上的按钮；不再用 Enter 或 DOM 脚本点击兜底。
    let searchHandle = await findVisibleHandle(page, [
      '.c-search-input .search-btn',
      '.c-search-input button',
      '.c-search-input [role="button"]',
      'button.search-btn',
      '[class*="search-btn"]'
    ])
    if (!searchHandle) {
      searchHandle = await findVisibleTextHandle(page, '搜索', ['button', 'a', 'span', '[role="button"]'], { contains: true })
    }
    if (!searchHandle) return { ok: false, reason: 'no search button found' }
    if (!await clickElementHandle(searchHandle, { delay: 40 + Math.floor(Math.random() * 50) })) {
      return { ok: false, reason: 'search button click failed' }
    }
    await sleep(6000)
    try {
      await page.waitForFunction(() => document.querySelector('.job-list-container .rec-job-list, .job-list-box'), { timeout: 15000 })
    } catch (e) { console.log('[search] wait list err', e.message) }
    await sleep(2000)

    await sleep(2000)
    const state = await getState()
    return { ok: true, keyword, citySwitch: cityResult, state }
  } catch (err) {
    console.error('[search] doSearch err:', err?.message)
    return { ok: false, error: err?.message || String(err) }
  }
}

export async function readJobListData() {
  return safeEval(() => {
    const el = document.querySelector('.page-jobs-main')
    const jl = el?.__vue__?.jobList
    if (!Array.isArray(jl)) return null
    return jl.map(j => ({
      jobId: j.encryptJobId,
      bossId: j.encryptBossId,
      jobName: j.jobName,
      salaryDesc: j.salaryDesc,
      cityName: j.cityName,
      jobExperience: j.jobExperience,
      brandName: j.brandName,
      postDescription: j.postDescription
    }))
  })
}

function cityLabelMatches(displayedCity, targetCity) {
  const normalize = value => String(value || '').replace(/\s+/g, '').replace(/市$/, '')
  return !!normalize(displayedCity) && normalize(displayedCity) === normalize(targetCity)
}

const CITY_DIALOG_SELECTORS = [
  '.city-select-dialog',
  '[class*="city-select-dialog"]',
  '[class*="city-dialog"]'
]
const CITY_OPTION_SELECTORS = ['a', 'button', 'li', 'span', '[role="option"]', '[role="button"]']
const CITY_TAB_SELECTORS = [
  '.city-char-list li',
  '[class*="city-char"] li',
  '[class*="city-group"] li',
  '[role="tab"]'
]

async function visibleCityDialog(page) {
  return findVisibleHandle(page, CITY_DIALOG_SELECTORS)
}

async function findCityOption(dialog, cityName) {
  const candidates = [String(cityName || '').trim(), `${String(cityName || '').trim()}市`]
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const handle = await findVisibleTextHandle(dialog, candidate, CITY_OPTION_SELECTORS)
    if (handle) return handle
  }
  return null
}

export async function switchCity(cityName) {
  const page = getPage()
  const urlBefore = await page.url()
  const displayedBefore = await safeEval(() => document.querySelector('.cur-city-label')?.textContent?.trim() || '')
  if (cityLabelMatches(displayedBefore, cityName)) {
    return {
      ok: true,
      already: true,
      selectedBy: 'visible-ui',
      displayedCity: displayedBefore,
      urlBefore,
      urlAfter: urlBefore,
      urlChanged: false
    }
  }
  const trigger = await findVisibleHandle(page, ['.cur-city-label', '[class*="cur-city-label"]'])
  if (!trigger) return { ok: false, reason: 'no visible city selector (.cur-city-label)' }
  if (!await clickElementHandle(trigger, { delay: 45 + Math.floor(Math.random() * 45) })) {
    return { ok: false, reason: 'city selector click failed' }
  }
  await sleep(1200)
  let dialog = await visibleCityDialog(page)
  if (!dialog) return { ok: false, reason: 'city dialog did not appear after visible click' }

  // 先找当前已展开的城市列表；找不到时再用弹层自己的搜索框输入城市。
  let cityHandle = await findCityOption(dialog, cityName)
  if (!cityHandle) {
    const searchInput = await findVisibleHandle(dialog, [
      'input[placeholder*="搜索"]',
      'input[placeholder*="城市"]',
      'input[aria-label*="城市"]',
      'input'
    ])
    if (searchInput) {
      try {
        await searchInput.click({ delay: 35 })
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.down(modifier)
        await page.keyboard.press('KeyA')
        await page.keyboard.up(modifier)
        await page.keyboard.press('Backspace')
        await searchInput.type(String(cityName), { delay: 80 + Math.floor(Math.random() * 50) })
      } finally {
        await disposeHandle(searchInput)
      }
      await sleep(900)
      await disposeHandle(dialog)
      dialog = await visibleCityDialog(page)
      cityHandle = await findCityOption(dialog, cityName)
    }
  }

  // BOSS 历史页面常用字母分组。分组标签从当前页面读取，不再维护本地城市码表。
  if (!cityHandle) {
    const tabTexts = await readVisibleHandleTexts(dialog, CITY_TAB_SELECTORS)
    await disposeHandle(dialog)
    for (const tabText of tabTexts.slice(0, 24)) {
      const nextDialog = await visibleCityDialog(page)
      if (!nextDialog) break
      const tab = await findVisibleTextHandle(nextDialog, tabText, CITY_TAB_SELECTORS)
      if (!tab) {
        await disposeHandle(nextDialog)
        continue
      }
      const tabClicked = await clickElementHandle(tab, { delay: 35 + Math.floor(Math.random() * 45) })
      await disposeHandle(nextDialog)
      if (!tabClicked) continue
      await sleep(600)
      const candidateDialog = await visibleCityDialog(page)
      if (!candidateDialog) break
      cityHandle = await findCityOption(candidateDialog, cityName)
      await disposeHandle(candidateDialog)
      if (cityHandle) break
    }
  } else {
    await disposeHandle(dialog)
  }

  if (!cityHandle) {
    return { ok: false, reason: `visible city option not found: ${cityName}` }
  }
  const picked = await clickElementHandle(cityHandle, { delay: 45 + Math.floor(Math.random() * 45) })
  await sleep(4500)
  const urlAfter = await page.url()
  const displayedCityAfter = await safeEval(() => document.querySelector('.cur-city-label')?.textContent?.trim() || '')
  const switched = !!picked && cityLabelMatches(displayedCityAfter, cityName)
  return {
    ok: switched,
    selectedBy: 'visible-ui',
    urlBefore,
    urlAfter,
    urlChanged: urlAfter !== urlBefore,
    urlHasCityParam: /(?:[?&])city=/.test(urlAfter),
    displayedCityBefore: displayedBefore,
    displayedCityAfter,
    switched,
    reason: switched ? '' : `城市切换未确认（目标：${cityName}，当前：${displayedCityAfter || '未知'}）`
  }
}

export async function scrollJobList() {
  const page = getPage()
  const before = await readJobListData()
  const beforeCount = before ? before.length : 0
  // 分多次小步滚动（600-1200px/次 + 随机间隔），模拟真人滚轮，不一次跳 5000px
  const steps = 3 + Math.floor(Math.random() * 3)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: 600 + Math.floor(Math.random() * 600) })
    await sleep(900 + Math.random() * 1400)
  }
  await sleep(1500)
  const after = await readJobListData()
  const afterCount = after ? after.length : 0
  return { beforeCount, afterCount, loadedMore: afterCount > beforeCount }
}

export async function getJobDetail(index) {
  const jobList = await readJobListData()
  if (!jobList || !jobList[index]) return { ok: false, reason: `index ${index} out of range` }
  const target = jobList[index]
  // 用 Puppeteer 元素句柄点击卡片，保留完整的真实鼠标事件链。
  const page = getPage()
  const card = await findIndexedVisibleHandle(page, [
    '.job-list-container .rec-job-list li.job-card-box',
    '.job-list-container li.job-card-box',
    'li.job-card-box'
  ], index)
  const clicked = await clickElementHandle(card, { delay: 35 + Math.floor(Math.random() * 40) })
  if (!clicked) return { ok: false, reason: `visible job card ${index} not found or click failed` }
  await sleep(3500)
  // 等详情面板 + 投递入口就绪（否则 sendResume 时按钮可能不可点）
  try {
    await page.waitForFunction(() => {
      const btn = document.querySelector('a.op-btn-chat')
      return !!btn && (btn.innerText || '').trim() === '立即沟通'
    }, { timeout: 10000 })
  } catch {}
  await sleep(500)
  const detail = await safeEval(() => {
    const body = document.querySelector('.job-detail-body')
    const title = document.querySelector('.job-detail-header .job-title, .job-detail-title, .job-primary h1, .job-name')
    // 位置：详情面板里"工作地址"附近
    let location = ''
    const addrEl = document.querySelector('.job-detail-body .job-address, .job-detail-body .address, .job-detail-body [class*=address], .job-detail-body .location')
    if (addrEl) location = addrEl.innerText?.trim() || ''
    if (!location) {
      const bodyText = body?.innerText || ''
      const m = bodyText.match(/工作地址\s*\n?\s*([^\n]+)/)
      if (m) location = m[1].trim()
    }
    // 提取 JD 正文：从"岗位职责/职位描述/工作职责"标题后开始，去掉开头 UI 噪音（举报/扫码等）
    let rawText = body?.innerText?.slice(0, 3000) || ''
    let desc = rawText
    // 定位 JD 正文起点
    const m = rawText.match(/(岗位职责|职位描述|工作职责|岗位要求|任职要求|工作内容)/)
    if (m && m.index > 0) desc = rawText.slice(m.index)
    // 去掉尾部"立即沟通/收藏/分享"等按钮噪音
    desc = desc
      .replace(/^\s*举报[\s\S]*?职位描述/, '')
      .replace(/\s*(立即沟通|继续沟通|收藏|分享|举报)\s*$/, '')
      .trim()
    return {
      jobName: title?.innerText?.trim() || '',
      postDescription: desc || rawText,
      location
    }
  })
  return {
    ok: true,
    clicked,
    listEntry: { jobId: target.jobId, jobName: target.jobName, salaryDesc: target.salaryDesc, cityName: target.cityName, brandName: target.brandName },
    detail
  }
}

const STAY_ON_PAGE_DIALOG_SELECTORS = [
  '[role="dialog"]',
  '.dialog-wrap',
  '.dialog-container',
  '[class*="dialog"]',
  '[class*="modal"]',
  '[class*="popup"]'
]
const STAY_ON_PAGE_BUTTON_SELECTORS = ['button', 'a', '[role="button"]', '.btn', '[class*="btn"]']

// BOSS 初始投递按钮点击后可能非常快地展示成功提示。必须优先轮询并真实点击
// 成功提示里的“留在此页”，不能把“继续沟通/去聊天”当成投递确认。
async function clickStayOnCurrentPage(page, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    let url = ''
    try { url = page.url() || '' } catch {}
    if (url.includes('/web/geek/chat')) {
      return { clicked: false, redirectedToChat: true, url, attempts }
    }

    let dialog = await findVisibleHandle(page, STAY_ON_PAGE_DIALOG_SELECTORS)
    let stayEl = dialog
      ? await findVisibleTextHandle(dialog, '留在此页', STAY_ON_PAGE_BUTTON_SELECTORS, { contains: true })
      : null
    if (!stayEl) {
      stayEl = await findVisibleTextHandle(page, '留在此页', STAY_ON_PAGE_BUTTON_SELECTORS, { contains: true })
    }
    if (stayEl) {
      const clicked = await clickElementHandle(stayEl, { delay: 40 + Math.floor(Math.random() * 50) })
      await disposeHandle(dialog)
      if (clicked) {
        await sleep(900)
        let urlAfter = ''
        try { urlAfter = page.url() || '' } catch {}
        return { clicked: true, redirectedToChat: urlAfter.includes('/web/geek/chat'), url: urlAfter, attempts }
      }
    } else {
      await disposeHandle(dialog)
    }
    await sleep(220)
  }
  let url = ''
  try { url = page.url() || '' } catch {}
  return { clicked: false, redirectedToChat: url.includes('/web/geek/chat'), url, attempts }
}

// 如果 BOSS 在“留在此页”出现前就跳转聊天，只能用页面中的可见“职位”入口
// 回到岗位列表。找不到入口时不猜 URL、不重复投递，而是交给上层暂停人工确认。
async function recoverFromUnexpectedChatRedirect() {
  const page = getPage()
  const url = page ? (page.url() || '') : ''
  if (!page || !url.includes('/web/geek/chat')) return { recovered: false, reason: 'not_in_chat' }
  const result = await openJobsPage()
  if (result.ok) return { recovered: true, method: 'visible_jobs_navigation' }
  return { recovered: false, reason: result.reason || 'visible_jobs_navigation_failed' }
}

export async function sendResume(jobId = '') {
  console.log(`[boss] sendResume v5 调用（只点初始投递与留在此页） jobId=${(jobId || '').slice(0, 20)}`)
  const page = getPage()
  if (!page) return { clicked: false, reason: 'no active Boss page' }

  // 只允许点击初始投递入口。详情页若已经变成“继续沟通/去聊天”，
  // 说明该岗位并非新的可投递状态，绝不能拿它当作投递按钮点击。
  let btnHandle = await findVisibleHandle(page, ['a.op-btn-chat', 'button.op-btn-chat', '.op-btn-chat'])
  if (!btnHandle) btnHandle = await findVisibleTextHandle(page, '立即沟通', ['button', 'a', '[role="button"]'], { contains: true })
  if (!btnHandle) btnHandle = await findVisibleTextHandle(page, '发送简历', ['button', 'a', '[role="button"]'], { contains: true })
  if (!btnHandle) return { clicked: false, reason: 'no visible initial delivery button found' }

  const result = { clicked: await isHandleVisible(btnHandle), text: await readHandleText(btnHandle) }
  const actionText = String(result.text || '').replace(/\s+/g, '')
  const looksLikeChatContinuation = /继续沟通|去聊天|聊天/.test(actionText)
  const looksLikeInitialDelivery = /立即沟通|发送简历|投递/.test(actionText)
  if (!result.clicked || looksLikeChatContinuation || !looksLikeInitialDelivery) {
    await disposeHandle(btnHandle)
    return {
      clicked: false,
      reason: looksLikeChatContinuation
        ? `refuse to click chat-continuation button: ${result.text || 'unknown'}`
        : `unexpected delivery button text: ${result.text || 'unknown'}`
    }
  }

  // 响应监听必须在初始投递点击之前挂好；不把 chat 类接口当成投递成功证据。
  const seenResponses = new Set()
  let finishDeliveryWait = () => {}
  const waitDeliveryResponse = new Promise(resolve => {
    let done = false
    let timer = null
    const finish = value => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { page.off('response', onResponse) } catch {}
      resolve(value)
    }
    const onResponse = response => {
      const url = response.url() || ''
      const isDeliveryResponse = url.includes('friend/add') || /\/wapi\/zpgeek\/(friend|geek)\/.*(add|send|link|connect)/.test(url)
      if (!isDeliveryResponse || seenResponses.has(url)) return
      seenResponses.add(url)
      finish(response)
    }
    page.on('response', onResponse)
    timer = setTimeout(() => finish(null), 12000)
    finishDeliveryWait = () => finish(null)
  })

  if (!await clickElementHandle(btnHandle, { delay: 45 + Math.floor(Math.random() * 45) })) {
    finishDeliveryWait()
    return { clicked: false, reason: 'initial delivery button click failed' }
  }

  // 初始投递之后只轮询“留在此页”；不查找、更不点击“继续沟通”。
  const stay = await clickStayOnCurrentPage(page)
  let recovery = { recovered: false, reason: '' }
  if (stay.redirectedToChat) recovery = await recoverFromUnexpectedChatRedirect()
  const deliveryResponse = await waitDeliveryResponse
  finishDeliveryWait()

  let body = null
  if (deliveryResponse) {
    try { body = await deliveryResponse.json() } catch {}
  }
  const responseOk = body?.code === 0
  const hasReliableStayEvidence = stay.clicked && !stay.redirectedToChat
  console.log(`[boss] 初始投递后留在此页: clicked=${stay.clicked}, redirected=${stay.redirectedToChat}, recovered=${recovery.recovered}, responseCode=${body?.code}`)

  if (stay.redirectedToChat && !recovery.recovered) {
    return {
      clicked: true,
      ok: false,
      indeterminate: true,
      stop: true,
      reason: `投递后意外进入聊天页，且无法通过可见“职位”入口返回（${recovery.reason || 'unknown'}）`,
      code: body?.code,
      greeting: body?.zpData?.greeting || '',
      text: result.text,
      stayClicked: stay.clicked,
      recovery
    }
  }

  // 没有“留在此页”证据时不继续投下一份，避免把未确认结果误记或触发聊天流程。
  if (!hasReliableStayEvidence) {
    return {
      clicked: true,
      ok: false,
      indeterminate: true,
      stop: true,
      reason: stay.redirectedToChat
        ? '投递后出现聊天跳转，已返回职位页但未完成“留在此页”确认'
        : '初始投递后未找到可见“留在此页”确认，不继续下一份岗位',
      code: body?.code,
      greeting: body?.zpData?.greeting || '',
      text: result.text,
      stayClicked: false,
      recovery: recovery.recovered ? recovery : undefined
    }
  }

  // “留在此页”是首要页面证据；接口 0 码仅作为附加记录，避免接口路径变化误报失败。
  return {
    clicked: true,
    ok: hasReliableStayEvidence || responseOk,
    reason: '',
    code: body?.code,
    greeting: body?.zpData?.greeting || '',
    text: result.text,
    stayClicked: true
  }
}

// run a full auto-hunt round for Boss; yields via callbacks so daemon can record progress
async function pauseAwareSleep(ms, shouldStop) {
  const end = Date.now() + Math.max(0, Number(ms) || 0)
  while (Date.now() < end) {
    if (shouldStop?.()) return false
    await sleep(Math.min(1000, end - Date.now()))
  }
  return !shouldStop?.()
}

export async function autoHunt({ maxJobs = 10, keywords = [], cityName = '', platformConfig, onJob = () => {}, onRisk = async () => {}, shouldStop = () => false, deferRest = false } = {}) {
  const config = platformConfig || (await import('./llm.mjs')).readConfig('boss.json') || {}
  const allKeywords = keywords.length
    ? keywords
    : ((config.jobSourceList || []).flatMap(s => s.children || []).filter(c => c.type === 'search-kw' && c.enabled).map(c => c.keyword) || ['单证员'])
  const pacing = readWorkbenchSettings().pacing
  const report = { platform: 'boss', applied: 0, skipped: 0, indeterminate: [], jobs: [], errors: [] }
  let opCount = 0
  let nextRestAfter = randInt(pacing.batchCountMin, pacing.batchCountMax)

  try {
    for (const kw of allKeywords) {
      if (shouldStop()) break
      if (report.applied >= maxJobs) break
      try {
        const searchResult = await searchJobs(kw, cityName)
        const listLen = searchResult.state?.jobListCount || 0
        console.log(`[boss] ${kw}: listLen=${listLen} citySwitched=${searchResult.citySwitch?.switched}`)
        const displayedCity = searchResult.state?.displayedCity || searchResult.citySwitch?.displayedCityAfter || ''
        if (cityName && !cityLabelMatches(displayedCity, cityName)) {
          const reason = `城市未切换到${cityName}（当前：${displayedCity || '未知'}）`
          const error = { code: 'city_mismatch', keyword: kw, targetCity: cityName, displayedCity, reason }
          report.errors.push(error)
          onJob({ status: 'blocked', judged: { reason }, sent: { reason } })
          console.error(`[boss] ${reason}，停止本轮，避免在错误城市投递`)
          return report
        }
        let index = 0
        let pagesWithoutApply = 0
        while (index < listLen && report.applied < maxJobs) {
          if (shouldStop()) return report
          const detailResult = await getJobDetail(index)
          if (!detailResult.ok) { index++; continue }
          if (shouldStop()) return report
          const postDesc = detailResult.detail?.postDescription || ''
          console.log(`[boss] JD诊断 idx=${index} ${detailResult.listEntry?.jobName} JD长度=${postDesc.length} JD头=${JSON.stringify(postDesc.slice(0, 80))}`)
          const jobForJudge = {
            jobId: detailResult.listEntry?.jobId,
            jobName: detailResult.listEntry?.jobName,
            salaryDesc: detailResult.listEntry?.salaryDesc,
            brandName: detailResult.listEntry?.brandName,
            cityName: detailResult.listEntry?.cityName,
            postDescription: postDesc
          }
          const judged = await llmJudgeJob(jobForJudge, config)
          if (shouldStop()) return report
          if (!judged.match) {
            report.skipped++
            index++
            pagesWithoutApply++
            onJob({ status: 'skip', job: jobForJudge, judged })
            console.log(`[boss] 跳过 ${jobForJudge.jobName} (${jobForJudge.salaryDesc}) ${jobForJudge.brandName}: ${judged.reason}`)
            if (pagesWithoutApply >= 10) {
              await scrollJobList()
              pagesWithoutApply = 0
            }
            continue
          }
          // 投过去重：同公司已投过就跳过（同一公司可能有多个HR发重复招聘）
          const { hasCompanyBeenApplied } = await import('./store.mjs')
          if (hasCompanyBeenApplied(jobForJudge.brandName)) {
            console.log(`[boss] 公司已投过，跳过: ${jobForJudge.brandName}`)
            report.skipped++
            onJob({ status: 'skip', job: jobForJudge, judged: { match: false, reason: '公司已投过' } })
            index++
            pagesWithoutApply++
            continue
          }
          pagesWithoutApply = 0
          if (shouldStop()) return report
          const risk = await detectRiskSignal()
          if (risk) {
            await onRisk(risk)
            return report
          }
          const sent = await sendResume(jobForJudge.jobId)
          // “留在此页”没有被可靠确认、或页面意外进入聊天页时，投递结果是未知的。
          // 这不是普通的失败：必须立刻停下本轮，避免继续操作造成重复投递或误入聊天。
          if (sent.indeterminate || sent.stop) {
            const reason = sent.reason || '投递结果未确认，已暂停本轮'
            const incident = {
              code: 'delivery_indeterminate',
              keyword: kw,
              jobId: jobForJudge.jobId,
              jobName: jobForJudge.jobName,
              reason
            }
            report.indeterminate.push(incident)
            report.errors.push(incident)
            onJob({ status: 'apply_indeterminate', job: jobForJudge, judged, sent })
            console.error(`[boss] 投递状态未确认，停止本轮: ${jobForJudge.jobName}: ${reason}`)
            return { ...report, reason: 'delivery_indeterminate' }
          }
          if (sent.ok) {
            report.applied++
            // 点击成功后立刻写入投递记录和计划进度。等待间隔/休息中收到“停止”
            // 也不会把这次已经发生的投递漏记成“没投”。
            onJob({ status: 'applied', job: jobForJudge, judged, sent })
            console.log(`[boss] 投递成功 ${jobForJudge.jobName} (${jobForJudge.salaryDesc}) greeting=${sent.greeting?.slice(0, 20) || ''}`)
            // 只在真正投递后计操作次数（读详情/判断不算）
            opCount++
            const gapSeconds = randInt(pacing.applicationGapMinSeconds, pacing.applicationGapMaxSeconds)
            console.log(`[boss] 下一次投递前等待 ${gapSeconds} 秒（随机范围 ${pacing.applicationGapMinSeconds}-${pacing.applicationGapMaxSeconds}）`)
            if (!await pauseAwareSleep(gapSeconds * 1000, shouldStop)) return report
            if (opCount >= nextRestAfter) {
              const restMinutes = randInt(pacing.batchRestMinMinutes, pacing.batchRestMaxMinutes)
              console.log(`[boss] 已完成 ${opCount} 个岗位，休息 ${restMinutes} 分钟（随机范围 ${pacing.batchRestMinMinutes}-${pacing.batchRestMaxMinutes}）`)
              if (deferRest) return { ...report, reason: 'platform_cooldown', cooldownMinutes: restMinutes }
              if (!await pauseAwareSleep(restMinutes * 60 * 1000, shouldStop)) return report
              opCount = 0
              nextRestAfter = randInt(pacing.batchCountMin, pacing.batchCountMax)
            }
          } else {
            report.skipped++
            onJob({ status: 'apply_failed', job: jobForJudge, judged, sent })
            console.log(`[boss] 投递失败 ${jobForJudge.jobName}: ${sent.reason || sent.code || '未知'}`)
          }
          if (!sent.ok) {
            const gapSeconds = randInt(pacing.applicationGapMinSeconds, pacing.applicationGapMaxSeconds)
            if (!await pauseAwareSleep(gapSeconds * 1000, shouldStop)) return report
          }
          index++
        }
      } catch (err) {
        console.error(`[boss] keyword ${kw} error: ${err?.message}`)
        report.errors.push({ keyword: kw, error: err?.message })
      }
    }
  } catch (err) {
    console.error(`[boss] fatal: ${err?.message}`)
    report.errors.push({ fatal: err?.message })
  }
  return report
}

// 风控信号检测：URL 变成 403/验证码/安全问答 → 返回原因，否则返回 null
export async function detectRiskSignal() {
  const page = getPage()
  if (!page) return null
  try {
    const url = page.url() || ''
    if (url.includes('/web/common/403') || url.includes('/error.html')) return { kind: '403', url }
    if (url.includes('/web/user/safe/verify-slider') || url.includes('verify')) return { kind: 'captcha', url }
    if (url.includes('/web/user/')) return { kind: 'login-expired', url }
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '')
    if (bodyText.includes('您访问的页面不存在') || bodyText.includes('访问过于频繁')) return { kind: 'blocked', url, text: bodyText.slice(0, 120) }
    return null
  } catch { return null }
}

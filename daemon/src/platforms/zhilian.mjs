// 智联招聘投递适配器。
//
// 参考来源：历史归档中的 DOM 实测，以及 GitHub 上对“页面就绪、登录证据、
// 成功证据和不确定结果”的分层设计。这里故意只实现可见网页投递。
// 页面没有明确成功证据时会返回 delivery_indeterminate，调度器会暂停，
// 不会再次点击同一岗位。
import { launchPlatform, getPage, setPlatformPage, sleep } from '../browser.mjs'
import {
  cleanText,
  disposeHandle,
  findIndexedVisibleHandle,
  findVisibleHandle,
  findVisibleTextHandle,
  isHandleVisible,
  pageSnapshot,
  readHandleText,
  readVisibleHandleTexts,
  riskFromSnapshot,
  waitForAny,
  textOf,
  clickElementHandle
} from './ui-helpers.mjs'

const LOGIN_TEXTS = ['登录/注册', '扫码登录', '手机号登录', '密码登录', '立即登录']
const RISK_TEXTS = ['安全验证', '请完成验证', '滑动验证', '验证码', '访问受限', '操作频繁', '账号异常']
const RESULT_SELECTORS = ['.job-card', '[class*="job-card"]']
const SEARCH_INPUT_SELECTORS = [
  // 智联首页与职位列表页是两套独立组件，不能只按通用 placeholder 猜。
  '.search-wrapper__input',
  '.query-sug__input',
  'input[placeholder*="搜索"]',
  'input[placeholder*="职位"]',
  'input[placeholder*="关键词"]',
  'input[class*="search"]'
]
const SEARCH_BUTTON_SELECTORS = [
  'a.search-wrapper__button',
  'button.query-sug__button',
  'button[class*="search"]',
  '[class*="search-btn"]',
  '[class*="searchButton"]'
]
const CITY_TRIGGER_SELECTORS = [
  // 2026-08 可见页面实测：首页为 home-header__city__choose，
  // 职位结果页为 filter-region-box。这里不复用其它平台的城市选择器。
  'a.home-header__city__choose',
  '.filter-region-box .filter-select-box__trigger',
  '.filter-region-box',
  '[class*="city-select"]',
  '[class*="citySelect"]',
  '[class*="city-picker"]',
  '[class*="cityPicker"]',
  '[class*="location-select"]',
  'button[class*="city"]',
  '[role="button"][class*="city"]'
]
const CITY_DISPLAY_SELECTORS = [
  '.home-header__city',
  '.filter-region-box .filter-select-box__label',
  '.filter-region-box .filter-select-box__trigger',
  '.filter-region-box'
]
const CITY_DIALOG_SELECTORS = [
  '[role="dialog"]',
  '[class*="city-modal"]',
  '[class*="city-dialog"]',
  '[class*="city-picker"]'
]
const CITY_OPTION_SELECTORS = ['a', 'button', 'li', 'span', '[role="option"]', '[role="button"]']
const CITY_TAB_SELECTORS = ['[role="tab"]', '[class*="city"] li', '[class*="letter"] li']
const DELIVERY_SUCCESS_DIALOG_SELECTORS = [
  '[role="dialog"]',
  '[class*="dialog"]',
  '[class*="modal"]',
  '[class*="popup"]'
]
const DELIVERY_SUCCESS_BUTTON_SELECTORS = ['button', 'a', '[role="button"]', '.btn', '[class*="btn"]']

function normalizeCityText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/\[?切换\]?/g, '')
    .replace(/市$/, '')
}

function cityTextMatches(displayedCity, targetCity) {
  const displayed = normalizeCityText(displayedCity)
  const target = normalizeCityText(targetCity)
  return !!displayed && !!target && displayed.includes(target)
}

async function readDisplayedCity(page) {
  const handle = await findVisibleHandle(page, CITY_DISPLAY_SELECTORS)
  const text = handle ? await readHandleText(handle, 160) : ''
  await disposeHandle(handle)
  return text
}

async function typeInVisibleInput(page, value) {
  const input = await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)
  if (!input) return { ok: false, reason: '智联招聘搜索输入框未找到' }
  try {
    await input.click({ delay: 35 })
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(modifier)
    await page.keyboard.press('KeyA')
    await page.keyboard.up(modifier)
    await page.keyboard.press('Backspace')
    await input.type(String(value || ''), { delay: 75 + Math.floor(Math.random() * 55) })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || '智联招聘搜索输入失败' }
  } finally {
    await disposeHandle(input)
  }
}

function isZhilianJobsPage(page) {
  try {
    const url = new URL(page?.url?.() || '')
    return url.hostname.endsWith('zhaopin.com') && url.pathname === '/jobs'
  } catch {
    return false
  }
}

// 智联首页的“搜索”会在真实用户点击后新开职位 tab。必须接管这个 tab，
// 否则旧首页永远等不到 .job-card，造成“看起来在跑、实际不投”的假象。
async function waitForSearchResultPage(sourcePage, beforePages, timeout = 18000) {
  const browser = sourcePage.browser()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!sourcePage.isClosed?.() && isZhilianJobsPage(sourcePage)) {
      setPlatformPage('zhilian', sourcePage)
      return { page: sourcePage, openedNewTab: false }
    }
    const pages = await browser.pages().catch(() => [])
    const resultPage = pages
      .filter(page => page !== sourcePage && !beforePages.includes(page) && !page.isClosed?.() && isZhilianJobsPage(page))
      .at(-1)
    if (resultPage) {
      await resultPage.bringToFront().catch(() => {})
      const remaining = Math.max(1, deadline - Date.now())
      await waitForAny(resultPage, RESULT_SELECTORS.concat(['[class*="empty"]', '[class*="no-result"]']), remaining)
      setPlatformPage('zhilian', resultPage)
      return { page: resultPage, openedNewTab: true }
    }
    await sleep(260)
  }
  return null
}

async function clickSearchControl(page) {
  const beforePages = await page.browser().pages().catch(() => [])
  const sourceWasJobsPage = isZhilianJobsPage(page)
  let handle = await findVisibleHandle(page, SEARCH_BUTTON_SELECTORS)
  if (!handle) handle = await findVisibleTextHandle(page, '搜索', ['button', 'a', 'span', '[role="button"]'], { contains: true })
  if (!handle) return { ok: false, reason: '智联招聘搜索按钮未找到' }
  const ok = await clickElementHandle(handle, { delay: 40 + Math.floor(Math.random() * 45) })
  if (!ok) return { ok: false, reason: '智联招聘搜索按钮点击失败' }
  // 已在职位页时，平台会在当前 tab 刷新列表；首页则等待真实点击生成的新 tab。
  if (sourceWasJobsPage) {
    await sleep(1200)
    setPlatformPage('zhilian', page)
    return { ok: true, page, openedNewTab: false }
  }
  const result = await waitForSearchResultPage(page, beforePages)
  return result
    ? { ok: true, ...result }
    : { ok: false, code: 'search_result_tab_not_opened', reason: '智联招聘点击搜索后没有出现可用的职位结果页' }
}

async function openSearchSurface(page) {
  const existing = await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)
  if (existing) {
    await disposeHandle(existing)
    return { ok: true, reused: true }
  }
  let entry = await findVisibleHandle(page, ['a[href*="/jobs"]', '[class*="nav"] a[href*="/jobs"]'])
  if (!entry) entry = await findVisibleTextHandle(page, '找工作', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
  if (!entry) entry = await findVisibleTextHandle(page, '职位', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
  if (!entry) return { ok: false, code: 'search_page_not_opened', reason: '智联招聘没有找到可见的找工作入口' }
  if (!await clickElementHandle(entry, { delay: 45 + Math.floor(Math.random() * 45) })) {
    return { ok: false, code: 'search_page_not_opened', reason: '智联招聘找工作入口真实点击失败' }
  }
  await sleep(3000)
  const input = await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)
  const ok = !!input
  await disposeHandle(input)
  return ok ? { ok: true, reused: false } : { ok: false, code: 'search_page_not_opened', reason: '点击找工作后搜索输入框未出现' }
}

async function visibleDialog(page) {
  return findVisibleHandle(page, CITY_DIALOG_SELECTORS)
}

async function findCityOption(dialog, cityName) {
  for (const value of [...new Set([String(cityName || '').trim(), `${String(cityName || '').trim()}市`].filter(Boolean))]) {
    const handle = await findVisibleTextHandle(dialog, value, CITY_OPTION_SELECTORS)
    if (handle) return handle
  }
  return null
}

async function selectCityThroughUi(page, cityName) {
  if (!cityName) return { ok: true, skipped: true }
  // 先读取智联当前页面实际展示的城市。当前已经是目标城市时不需要多点一次
  // 左上角“切换”，避免人为制造多余跳转。
  const displayedBefore = await readDisplayedCity(page)
  if (cityTextMatches(displayedBefore, cityName)) {
    return { ok: true, already: true, selectedBy: 'zhilian-visible-city', displayedCity: displayedBefore }
  }
  const trigger = await findVisibleHandle(page, CITY_TRIGGER_SELECTORS)
    || await findVisibleTextHandle(page, '切换', ['header button', 'header a', 'header span', 'nav button', 'nav a', '[class*="filter"] button', '[class*="filter"] [role="button"]'], { contains: true })
    || await findVisibleTextHandle(page, '城市', ['header button', 'header a', 'nav button', 'nav a', '[class*="filter"] button', '[class*="filter"] [role="button"]'], { contains: true })
  if (!trigger) return { ok: false, code: 'city_selector_not_found', reason: `智联招聘页面没有找到可见城市选择器（目标：${cityName}）` }
  const beforeText = displayedBefore || await readHandleText(trigger, 160)
  if (cityTextMatches(beforeText, cityName)) {
    await disposeHandle(trigger)
    return { ok: true, already: true, selectedBy: 'visible-ui', displayedCity: beforeText }
  }
  if (!await clickElementHandle(trigger, { delay: 40 + Math.floor(Math.random() * 45) })) {
    return { ok: false, code: 'city_selector_click_failed', reason: '智联招聘城市选择器点击失败' }
  }
  await sleep(1000)
  let dialog = await visibleDialog(page)
  if (!dialog) return { ok: false, code: 'city_dialog_not_found', reason: '智联招聘城市弹层未出现' }
  let option = await findCityOption(dialog, cityName)
  if (!option) {
    const tabTexts = await readVisibleHandleTexts(dialog, CITY_TAB_SELECTORS)
    await disposeHandle(dialog)
    for (const tabText of tabTexts.slice(0, 24)) {
      const next = await visibleDialog(page)
      if (!next) break
      const tab = await findVisibleTextHandle(next, tabText, CITY_TAB_SELECTORS)
      await disposeHandle(next)
      if (!tab || !await clickElementHandle(tab, { delay: 35 + Math.floor(Math.random() * 40) })) continue
      await sleep(500)
      const current = await visibleDialog(page)
      if (!current) break
      option = await findCityOption(current, cityName)
      await disposeHandle(current)
      if (option) break
    }
  } else {
    await disposeHandle(dialog)
  }
  if (!option) return { ok: false, code: 'city_option_not_found', reason: `智联招聘可见城市弹层中没有“${cityName}”` }
  const clicked = await clickElementHandle(option, { delay: 45 + Math.floor(Math.random() * 45) })
  await sleep(2500)
  const afterText = await readDisplayedCity(page)
  const confirmed = cityTextMatches(afterText, cityName)
  return {
    ok: !!clicked && confirmed,
    selectedBy: 'zhilian-visible-ui',
    displayedCityBefore: beforeText,
    displayedCityAfter: afterText,
    reason: clicked && confirmed ? '' : `智联招聘城市选择后未确认当前城市为“${cityName}”`
  }
}

function cardNodes(root) {
  const all = [...(root?.querySelectorAll?.(RESULT_SELECTORS.join(',')) || [])]
  return all.filter(card => !card.parentElement?.closest(RESULT_SELECTORS.join(',')))
}

function cardJobFromDom(card, index) {
  const text = textOf(card, 2600)
  const title = firstText(card, [
    '[class*="job-name"]', '[class*="jobName"]', '[class*="title"]',
    'h1', 'h2', 'h3', 'a'
  ]).split('\n')[0]
  const salary = firstText(card, ['[class*="salary"]', '[class*="pay"]'])
  const company = firstText(card, ['[class*="company-name"]', '[class*="company"]', '[class*="brand"]'])
  const area = firstText(card, ['[class*="area"]', '[class*="region"]', '[class*="location"]'])
  const buttons = [...(card.querySelectorAll?.('button, a, [role="button"]') || [])]
    .map(node => textOf(node, 100))
    .filter(Boolean)
  const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
  const hasApply = buttons.some(value => /立即投递|投递简历|申请职位|申请/.test(value)) && !applied
  return {
    index,
    jobId: jobIdFromNode(card),
    jobName: cleanText(title, 160),
    salaryDesc: cleanText(salary, 100),
    brandName: cleanText(company.split('\n')[0], 160),
    cityName: cleanText(area.split(/[\s·|]/)[0], 80),
    postDescription: text,
    hasApply,
    alreadyApplied: applied,
    jobUrl: card.querySelector('a[href]')?.href || ''
  }
}

// 智联投递成功后会弹出“留在此页 / 继续沟通”。弹窗本身就是成功证据，
// 但后续流程必须停留在职位页，所以这里只寻找并点击“留在此页”，
// 永远不把“继续沟通”当成可操作入口。
async function clickStayOnCurrentPage(page, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let detected = false
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    let dialog = await findVisibleHandle(page, DELIVERY_SUCCESS_DIALOG_SELECTORS)
    let stayButton = dialog
      ? await findVisibleTextHandle(dialog, '留在此页', DELIVERY_SUCCESS_BUTTON_SELECTORS, { contains: true })
      : null
    if (!stayButton) {
      stayButton = await findVisibleTextHandle(page, '留在此页', DELIVERY_SUCCESS_BUTTON_SELECTORS, { contains: true })
    }
    if (stayButton) {
      detected = true
      const buttonText = await readHandleText(stayButton, 120)
      const clicked = await clickElementHandle(stayButton, { delay: 40 + Math.floor(Math.random() * 50) })
      await disposeHandle(dialog)
      if (clicked) {
        await sleep(900)
        const stillVisible = await findVisibleTextHandle(page, '留在此页', DELIVERY_SUCCESS_BUTTON_SELECTORS, { contains: true })
        const dismissed = !stillVisible
        await disposeHandle(stillVisible)
        return { detected: true, clicked: true, dismissed, buttonText, attempts }
      }
    } else {
      await disposeHandle(dialog)
    }
    await sleep(220)
  }
  return { detected, clicked: false, dismissed: false, attempts }
}

function successEvidenceFromPage(page) {
  return page.evaluate(() => {
    const visible = node => {
      if (!node) return false
      const r = node.getBoundingClientRect?.()
      const s = window.getComputedStyle?.(node)
      return !!r && r.width > 0 && r.height > 0 && s?.display !== 'none' && s?.visibility !== 'hidden'
    }
    const texts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="modal"], .a-attachment-select, .job-detail-summary')]
      .filter(visible)
      .map(node => (node.innerText || '').trim())
      .filter(Boolean)
    const body = document.body?.innerText || ''
    const detailButton = [...document.querySelectorAll('.job-detail-summary button, .job-detail-summary a, button, a')]
      .filter(visible)
      .map(node => (node.innerText || '').trim())
      .find(value => /已投递|投递成功/.test(value)) || ''
    const evidenceText = [...texts, detailButton].filter(Boolean).join('\n').slice(-1200)
    const success = /投递成功|简历已投递|投递完成/.test(evidenceText) || /已投递/.test(detailButton)
    const failed = /投递失败|投递未成功|暂不能投递|请稍后再试/.test(evidenceText)
    const risk = /安全验证|请完成验证|滑动验证|验证码|访问受限|操作频繁|账号异常/.test(evidenceText)
    return { success, failed, risk, detailButton, evidenceText }
  }).catch(() => ({ success: false, failed: false, risk: false, evidenceText: '' }))
}

async function evidenceAfterDelivery(page) {
  const popup = await clickStayOnCurrentPage(page)
  const evidence = await successEvidenceFromPage(page)
  if (!popup.detected) return evidence
  const popupEvidence = `智联招聘投递成功弹窗：${popup.buttonText || '留在此页'}`
  return {
    ...evidence,
    success: true,
    deliveryPopup: true,
    stayOnPageClicked: popup.clicked,
    popupDismissed: popup.dismissed,
    popupButtonText: popup.buttonText || '留在此页',
    evidenceText: [popupEvidence, evidence.evidenceText].filter(Boolean).join('\n').slice(-1200)
  }
}

const adapter = {
  platform: 'zhilian',
  name: '智联招聘',
  homeUrl: 'https://www.zhaopin.com/',
  configName: 'zhilian.json',
  capabilities: { delivery: true, replies: false },

  async launch() {
    await launchPlatform({ platform: this.platform, homeUrl: this.homeUrl, cookiesFileName: 'zhilian-cookies.json' })
  },

  async getLoginDiagnostics() {
    const page = getPage()
    if (!page) return { loggedIn: false, reason: 'no_page' }
    const snapshot = await pageSnapshot(page, {
      readySelectors: ['header', '[class*="header"]', '[class*="nav"]', '[class*="user"]', '[class*="avatar"]'],
      authSelectors: ['[class*="avatar"]', '[class*="user-info"]', '[class*="account"]', '[class*="logout"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS
    })
    if (!snapshot.ok) return { loggedIn: false, ...snapshot }
    const authenticated = snapshot.authHint && !snapshot.loginRequired && !snapshot.riskDetected
    return { ...snapshot, loggedIn: !!authenticated }
  },

  async isLoggedIn() {
    return (await this.getLoginDiagnostics()).loggedIn === true
  },

  async searchJobs(keyword, cityName, platformConfig = {}) {
    const page = getPage()
    if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
    // 这里只允许从当前页面进入搜索并操作控件；不拼接职位/城市查询 URL。
    const opened = await openSearchSurface(page)
    if (!opened.ok) return opened
    const citySelection = await selectCityThroughUi(page, cityName)
    if (!citySelection.ok) return { ok: false, ...citySelection }
    const typed = await typeInVisibleInput(page, keyword)
    if (!typed.ok) return { ok: false, code: 'search_input_not_found', reason: typed.reason }
    await sleep(700)
    const searched = await clickSearchControl(page)
    if (!searched.ok) return { ok: false, code: searched.code || 'search_button_not_found', reason: searched.reason }
    const resultsPage = searched.page || page
    await waitForAny(resultsPage, RESULT_SELECTORS, 15000)
    await sleep(2200)
    const snapshot = await pageSnapshot(resultsPage, {
      readySelectors: RESULT_SELECTORS.concat(['[class*="no-result"]', '[class*="empty"]']),
      authSelectors: ['[class*="avatar"]', '[class*="user-info"]', '[class*="account"]', '[class*="logout"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '暂无相关职位', '没有符合条件的职位']
    })
    const risk = riskFromSnapshot(snapshot)
    if (risk?.kind === 'platform_verification') return { ok: false, code: 'risk_detected', reason: risk.signal, risk, url: resultsPage.url() }
    if (snapshot.loginRequired) return { ok: false, code: 'login_required', reason: '智联招聘登录状态失效', loggedIn: false, url: resultsPage.url(), diagnostics: snapshot }
    const list = await this.readJobList()
    if (!list.length && !snapshot.emptyText && !snapshot.pageReady) {
      return { ok: false, code: 'page_not_ready', reason: '智联招聘职位列表页面未就绪', loggedIn: !!snapshot.authHint, url: resultsPage.url(), diagnostics: snapshot }
    }
    return {
      ok: true,
      loggedIn: snapshot.authHint || list.length > 0,
      list,
      url: resultsPage.url(),
      diagnostics: { ...snapshot, cityName: cityName || '', citySelection, resultCount: list.length }
    }
  },

  async readJobList() {
    const page = getPage()
    if (!page) return []
    return page.evaluate(() => {
      const selectors = ['.job-card', '[class*="job-card"]']
      const all = [...document.querySelectorAll(selectors.join(','))]
      const cards = all.filter(card => !card.parentElement?.closest(selectors.join(',')))
      const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
      const first = (root, list) => {
        for (const selector of list) {
          const node = root.querySelector(selector)
          const value = clean(node?.innerText || node?.textContent || '')
          if (value) return value
        }
        return ''
      }
      const idOf = root => {
        for (const name of ['data-job-id', 'data-jobid', 'data-position-id', 'data-id']) {
          const value = root.getAttribute(name)
          if (value) return value
        }
        return root.querySelector('a[href]')?.href || ''
      }
      return cards.map((card, index) => {
        const buttons = [...card.querySelectorAll('button, a, [role="button"]')].map(node => clean(node.innerText)).filter(Boolean)
        const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
        return {
          index,
          jobId: idOf(card),
          jobName: first(card, ['[class*="job-name"]', '[class*="jobName"]', '[class*="title"]', 'h1', 'h2', 'h3', 'a']).split('\n')[0],
          salaryDesc: first(card, ['[class*="salary"]', '[class*="pay"]']),
          brandName: first(card, ['[class*="company-name"]', '[class*="company"]', '[class*="brand"]']).split('\n')[0],
          cityName: first(card, ['[class*="area"]', '[class*="region"]', '[class*="location"]']).split(/[\s·|]/)[0],
          postDescription: clean(card.innerText).slice(0, 2600),
          hasApply: buttons.some(value => /立即投递|投递简历|申请职位|申请/.test(value)) && !applied,
          alreadyApplied: applied,
          jobUrl: card.querySelector('a[href]')?.href || ''
        }
      }).filter(job => job.jobName)
    })
  },

  async readJobDetail(index) {
    const page = getPage()
    if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
    const card = await findIndexedVisibleHandle(page, ['.job-card'], index)
      || await findIndexedVisibleHandle(page, ['[class*="job-card"]'], index)
    if (!card) return { ok: false, code: 'job_card_not_found', reason: `没有找到第 ${index} 个智联招聘岗位卡片` }
    const clicked = await clickElementHandle(card, { delay: 40 + Math.floor(Math.random() * 45) })
    if (!clicked) return { ok: false, code: 'card_click_failed', reason: '智联招聘岗位卡片真实点击失败' }
    await sleep(3000)
    const ready = await waitForAny(page, ['.job-detail-panel', '.job-detail-summary', '[class*="job-detail"]'], 8000)
    if (!ready) return { ok: false, code: 'detail_not_ready', reason: '智联招聘职位详情面板未出现' }
    const detail = await page.evaluate(() => {
      const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
      const first = (root, selectors) => {
        for (const selector of selectors) {
          const node = root?.querySelector(selector)
          const value = clean(node?.innerText || node?.textContent || '')
          if (value) return value
        }
        return ''
      }
      const panel = document.querySelector('.job-detail-panel, [class*="job-detail"]') || document.body
      const summary = document.querySelector('.job-detail-summary') || panel
      const buttons = [...document.querySelectorAll('.job-detail-summary button, .job-detail-summary a, button, a')]
        .filter(node => { const r = node.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0 })
        .map(node => clean(node.innerText))
        .filter(Boolean)
      const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
      return {
        jobName: first(summary, ['[class*="title"]', '[class*="job-name"]', 'h1', 'h2']),
        salaryDesc: first(summary, ['[class*="salary"]', '[class*="pay"]']),
        brandName: first(summary, ['[class*="company-name"]', '[class*="company"]', '[class*="brand"]']),
        cityName: first(summary, ['[class*="area"]', '[class*="region"]', '[class*="location"]']).split(/[\s·|]/)[0],
        postDescription: clean(panel.innerText).slice(0, 3200),
        hasApply: buttons.some(value => /立即投递|投递简历|申请职位|申请/.test(value)) && !applied,
        alreadyApplied: applied
      }
    }).catch(err => ({ jobName: '', postDescription: '', detailError: err?.message }))
    const listEntry = (await this.readJobList())[index] || {}
    const job = { ...listEntry, ...detail, index, jobId: detail.jobId || listEntry.jobId }
    return { ok: true, listEntry: job, job, detail }
  },

  async apply(job) {
    const page = getPage()
    if (!page) return { ok: false, success: false, code: 'no_page', reason: 'no page' }
    const before = await pageSnapshot(page, { loginTexts: LOGIN_TEXTS, riskTexts: RISK_TEXTS })
    const risk = riskFromSnapshot(before)
    if (risk) return { ok: false, success: false, code: risk.kind === 'login_required' ? 'login_required' : 'risk_detected', reason: risk.signal, risk }
    const root = await findVisibleHandle(page, ['.job-detail-summary', '.job-detail-panel', '[class*="job-detail"]'])
    const actionRoot = root || page
    const buttonTexts = await readVisibleHandleTexts(actionRoot, ['button', 'a', '[role="button"]'])
    if (buttonTexts.some(value => /已投递|已申请|已投/.test(value))) {
      await disposeHandle(root)
      return { ok: true, success: false, alreadyApplied: true, code: 'already_applied', reason: '岗位已经显示为已投递' }
    }
    let button = null
    for (const text of ['立即投递', '投递简历', '申请职位', '申请']) {
      button = await findVisibleTextHandle(actionRoot, text, ['button', 'a', '[role="button"]'], { contains: true })
      if (button) break
    }
    if (!button) {
      await disposeHandle(root)
      return { ok: true, success: false, code: 'apply_button_not_found', reason: '详情页没有明确的投递按钮' }
    }
    const buttonText = await readHandleText(button, 120)
    const didClick = await clickElementHandle(button, { delay: 45 + Math.floor(Math.random() * 45) })
    await disposeHandle(root)
    if (!didClick) return { ok: true, success: false, code: 'apply_click_failed', reason: '智联招聘投递按钮真实点击失败' }
    const clicked = { ok: true, buttonText }
    await sleep(1800)
    const attachmentReady = await waitForAny(page, ['.a-attachment-select', '[class*="attachment-select"]'], 7000)
    if (!attachmentReady) {
      const evidence = await evidenceAfterDelivery(page)
      if (evidence.risk) return { ok: false, success: false, code: 'risk_detected', reason: '智联招聘出现验证页面', risk: { kind: 'platform_verification', url: page.url() }, evidence }
      if (evidence.success) return { ok: true, success: true, clicked: true, evidence }
      return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '点击投递后没有出现简历确认面板或成功证据', evidence }
    }
    const panel = await findVisibleHandle(page, ['.a-attachment-select', '[class*="attachment-select"]'])
    if (!panel) return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '简历确认面板未找到，未重复点击' }
    let deliveryButton = null
    for (const text of ['确认投递', '投递简历', '立即投递']) {
      deliveryButton = await findVisibleTextHandle(panel, text, ['button', 'a', '[role="button"]'], { contains: true })
      if (deliveryButton) break
    }
    if (!deliveryButton) {
      await disposeHandle(panel)
      return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '简历确认按钮未找到，未重复点击' }
    }
    const delivered = { ok: await clickElementHandle(deliveryButton, { delay: 45 + Math.floor(Math.random() * 45) }) }
    await disposeHandle(panel)
    if (!delivered.ok) return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '简历确认按钮真实点击失败，未重复点击' }
    await sleep(3500)
    const evidence = await evidenceAfterDelivery(page)
    if (evidence.risk) return { ok: false, success: false, code: 'risk_detected', reason: '智联招聘投递后出现验证页面', risk: { kind: 'platform_verification', url: page.url() }, evidence }
    if (evidence.failed) return { ok: true, success: false, code: 'apply_failed', reason: '智联招聘明确返回投递失败', evidence }
    if (evidence.success) return { ok: true, success: true, clicked: true, evidence }
    return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '智联招聘没有返回明确的投递成功证据，未重复点击', evidence }
  },

  async getPageDiagnostics() {
    const page = getPage()
    return pageSnapshot(page, {
      readySelectors: RESULT_SELECTORS.concat(['.job-detail-panel', '.job-detail-summary']),
      authSelectors: ['[class*="avatar"]', '[class*="user-info"]', '[class*="account"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '暂无相关职位']
    })
  },

  async detectRiskSignal() {
    const snapshot = await this.getPageDiagnostics()
    return riskFromSnapshot(snapshot)
  },

  async backToHome() {
    const page = getPage()
    if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
    const list = await findVisibleHandle(page, RESULT_SELECTORS)
    if (list) {
      await disposeHandle(list)
      return { ok: true, reused: true }
    }
    let close = await findVisibleHandle(page, ['[aria-label="关闭"]', '[title="关闭"]', '[class*="close"]'])
    if (!close) close = await findVisibleTextHandle(page, '关闭', ['button', 'a', '[role="button"]'], { contains: true })
    if (close) {
      const closed = await clickElementHandle(close, { delay: 40 + Math.floor(Math.random() * 45) })
      if (closed) {
        await sleep(1800)
        const afterClose = await findVisibleHandle(page, RESULT_SELECTORS)
        if (afterClose) {
          await disposeHandle(afterClose)
          return { ok: true, via: 'visible-close' }
        }
      }
    }
    return { ok: false, code: 'home_page_not_opened', reason: '智联招聘未找到可见的返回岗位列表入口' }
  }
}

export default adapter

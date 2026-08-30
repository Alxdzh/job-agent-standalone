// 51job（前程无忧）投递适配器。
//
// 搜索页通过已登录页面上的“搜索”入口打开，岗位卡片使用历史归档实测和
// AgentMesh 中反复出现的稳定选择器。投递结果必须看到明确成功提示；
// 点击后证据不足时标记为 indeterminate，避免重复点击造成重复投递。
import { launchPlatform, getPage, sleep } from '../browser.mjs'
import {
  cleanText,
  clickElementHandle,
  disposeHandle,
  findVisibleHandle,
  findVisibleHandleWhere,
  findVisibleTextHandle,
  pageSnapshot,
  readHandleText,
  readVisibleHandleTexts,
  riskFromSnapshot,
  waitForAny,
  textOf
} from './ui-helpers.mjs'

const LOGIN_TEXTS = ['登录/注册', '扫码登录', '请登录', '密码登录', '立即登录']
const RISK_TEXTS = ['安全验证', '请完成验证', '滑动验证', '验证码', '访问受限', '操作频繁', '账号异常']
const RESULT_SELECTORS = ['.joblist-item', '[class*="joblist-item"]']
const SEARCH_INPUT_SELECTORS = ['.shadedword', 'input[placeholder*="搜索职位"]', 'input[placeholder*="职位"]']
const SEARCH_BUTTON_SELECTORS = ['.search-btn', 'button.search-btn', '[class*="search-btn"]']
const APPLY_BUTTON_SELECTORS = ['.btn.apply', 'button.btn.apply']
const CITY_TRIGGER_SELECTORS = [
  '[class*="city-select"]',
  '[class*="citySelect"]',
  '[class*="city-picker"]',
  '[class*="cityPicker"]',
  '[class*="area-select"]',
  '[class*="areaSelect"]',
  'button[class*="city"]',
  '[role="button"][class*="city"]'
]
// 51job 当前搜索页不是城市弹窗，而是直接显示 .ch 城市标签；当前城市为 .ch.on。
// 这是 51job 独有结构，不能套用 BOSS/智联的城市触发器。
const CITY_CHIP_SELECTORS = ['a.ch', '[class~="ch"]']
const CITY_DIALOG_SELECTORS = ['[role="dialog"]', '[class*="city-modal"]', '[class*="city-dialog"]', '[class*="city-picker"]']
const CITY_OPTION_SELECTORS = ['a', 'button', 'li', 'span', '[role="option"]', '[role="button"]']
const CITY_TAB_SELECTORS = ['[role="tab"]', '[class*="city"] li', '[class*="letter"] li']
// 51job 投递成功后会在结果页上方留下一个小弹层；如果不收掉，下一次
// 读取岗位卡片时 Puppeteer 会一直被它挡住。只在已经识别到“投递成功”
// 的弹层内寻找关闭控件，避免把搜索页上的普通按钮当成关闭按钮。
const SUCCESS_POPUP_SELECTORS = [
  '.success-popup',
  '.success-dialog',
  '.apply-success',
  '.apply-success-popup',
  '[class*="success-popup"]',
  '[class*="apply-success"]',
  '[class*="success-dialog"]',
  '[class*="success-modal"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[class*="modal"]',
  '[class*="popup"]',
  '[class*="dialog"]',
  '[role="alert"]',
  '[class*="toast"]',
  '[class*="message"]',
  '[class*="success"]'
]
const SUCCESS_POPUP_CLOSE_SELECTORS = [
  '[aria-label="关闭"]',
  '[aria-label="Close"]',
  '[title*="关闭"]',
  '[title*="Close"]',
  'button[class*="close"]',
  'a[class*="close"]',
  'i[class*="close"]',
  'span[class*="close"]',
  '[class*="close"]'
]
const SUCCESS_TEXT = /投递成功|申请成功|投递完成|申请完成/

function visible(node) {
  const rect = node?.getBoundingClientRect?.()
  return !!rect && rect.width > 0 && rect.height > 0
}

async function visibleCityDialog(page) {
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
  const target = String(cityName).replace(/\s+/g, '').replace(/市$/, '')

  // 搜索页直接显示热门城市和当前城市标签。优先在这一层完成选择，
  // 这样“青岛”已处于 .ch.on 时不会误报为缺少城市选择器。
  let cityChip = null
  for (const candidate of [...new Set([String(cityName).trim(), target].filter(Boolean))]) {
    cityChip = await findVisibleTextHandle(page, candidate, CITY_CHIP_SELECTORS, { contains: false })
    if (cityChip) break
  }
  if (cityChip) {
    const beforeText = await readHandleText(cityChip, 160)
    const beforeClass = await cityChip.evaluate(node => String(node.className || '')).catch(() => '')
    if (/\bon\b/.test(beforeClass)) {
      await disposeHandle(cityChip)
      return { ok: true, already: true, selectedBy: 'visible-ui', displayedCity: beforeText }
    }
    const clicked = await clickElementHandle(cityChip, { delay: 40 + Math.floor(Math.random() * 45) })
    await sleep(1800)
    let selected = null
    for (const candidate of [...new Set([String(cityName).trim(), target].filter(Boolean))]) {
      selected = await findVisibleTextHandle(page, candidate, CITY_CHIP_SELECTORS, { contains: false })
      if (selected) break
    }
    const afterText = selected ? await readHandleText(selected, 160) : ''
    const afterClass = selected ? await selected.evaluate(node => String(node.className || '')).catch(() => '') : ''
    await disposeHandle(selected)
    const confirmed = !!selected && /\bon\b/.test(afterClass)
    return {
      ok: !!clicked && (confirmed || afterText.replace(/\s+/g, '').replace(/市$/, '') === target),
      selectedBy: 'visible-ui',
      displayedCityBefore: beforeText,
      displayedCityAfter: afterText,
      reason: clicked ? '' : '51job 城市标签真实点击失败'
    }
  }

  const trigger = await findVisibleHandle(page, CITY_TRIGGER_SELECTORS)
    || await findVisibleTextHandle(page, '城市', ['header button', 'header a', 'nav button', 'nav a', '[class*="filter"] button', '[class*="filter"] [role="button"]'], { contains: true })
  if (!trigger) return { ok: false, code: 'city_selector_not_found', reason: `51job 页面没有找到可见城市选择器（目标：${cityName}）` }
  const beforeText = await readHandleText(trigger, 160)
  if (beforeText.replace(/\s+/g, '').replace(/市$/, '').includes(target)) {
    await disposeHandle(trigger)
    return { ok: true, already: true, selectedBy: 'visible-ui', displayedCity: beforeText }
  }
  if (!await clickElementHandle(trigger, { delay: 40 + Math.floor(Math.random() * 45) })) {
    return { ok: false, code: 'city_selector_click_failed', reason: '51job 城市选择器点击失败' }
  }
  await sleep(1000)
  let dialog = await visibleCityDialog(page)
  if (!dialog) return { ok: false, code: 'city_dialog_not_found', reason: '51job 城市弹层未出现' }
  let option = await findCityOption(dialog, cityName)
  if (!option) {
    const tabTexts = await readVisibleHandleTexts(dialog, CITY_TAB_SELECTORS)
    await disposeHandle(dialog)
    for (const tabText of tabTexts.slice(0, 24)) {
      const next = await visibleCityDialog(page)
      if (!next) break
      const tab = await findVisibleTextHandle(next, tabText, CITY_TAB_SELECTORS)
      await disposeHandle(next)
      if (!tab || !await clickElementHandle(tab, { delay: 35 + Math.floor(Math.random() * 40) })) continue
      await sleep(500)
      const current = await visibleCityDialog(page)
      if (!current) break
      option = await findCityOption(current, cityName)
      await disposeHandle(current)
      if (option) break
    }
  } else {
    await disposeHandle(dialog)
  }
  if (!option) return { ok: false, code: 'city_option_not_found', reason: `51job 可见城市弹层中没有“${cityName}”` }
  const clicked = await clickElementHandle(option, { delay: 45 + Math.floor(Math.random() * 45) })
  await sleep(2500)
  const selected = await findVisibleHandle(page, CITY_TRIGGER_SELECTORS)
  const afterText = selected ? await readHandleText(selected, 160) : ''
  await disposeHandle(selected)
  const confirmed = afterText.replace(/\s+/g, '').replace(/市$/, '').includes(target)
  return {
    ok: !!clicked && confirmed,
    selectedBy: 'visible-ui',
    displayedCityBefore: beforeText,
    displayedCityAfter: afterText,
    reason: clicked && confirmed ? '' : `51job 城市选择后未确认当前城市为“${cityName}”`
  }
}

async function findSuccessPopup(page) {
  return findVisibleHandleWhere(page, SUCCESS_POPUP_SELECTORS, async text => SUCCESS_TEXT.test(text))
}

async function clickOutsideBox(page, box) {
  if (!box) return false
  let viewport = page.viewport?.() || {}
  if (!viewport.width || !viewport.height) {
    viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1280, height: 800 }))
  }
  const points = [
    { x: 8, y: 8 },
    { x: Math.max(8, viewport.width - 8), y: 8 },
    { x: 8, y: Math.max(8, viewport.height - 8) },
    { x: Math.max(8, viewport.width - 8), y: Math.max(8, viewport.height - 8) }
  ]
  const point = points.find(({ x, y }) => x < box.x - 5 || x > box.x + box.width + 5 || y < box.y - 5 || y > box.y + box.height + 5)
  if (!point) return false
  try {
    await page.mouse.click(point.x, point.y, { delay: 25 + Math.floor(Math.random() * 25) })
    return true
  } catch {
    return false
  }
}

async function dismissJob51SuccessPopup(page) {
  const popup = await findSuccessPopup(page)
  if (!popup) return { found: false, closed: false, via: '' }
  const box = await popup.boundingBox().catch(() => null)
  let closed = false
  let via = ''
  let close = await findVisibleHandle(popup, SUCCESS_POPUP_CLOSE_SELECTORS)
  if (!close) {
    for (const label of ['×', '✕', '关闭']) {
      close = await findVisibleTextHandle(popup, label, ['button', 'a', 'i', 'span', 'div', '[role="button"]'])
      if (close) break
    }
  }
  if (close) {
    closed = await clickElementHandle(close, { delay: 35 + Math.floor(Math.random() * 35) })
    via = 'close-button'
  }
  await disposeHandle(popup)
  if (!closed) {
    closed = await clickOutsideBox(page, box)
    via = closed ? 'outside-click' : ''
  }
  if (!closed) {
    try { await page.keyboard.press('Escape'); closed = true; via = 'escape' } catch {}
  }
  await sleep(350)
  const remaining = await findSuccessPopup(page)
  const gone = !remaining
  await disposeHandle(remaining)
  return { found: true, closed: gone, via: gone ? via : 'not-dismissed' }
}

function cardIdFromDom(item) {
  for (const name of ['data-job-id', 'data-jobid', 'data-position-id', 'data-positionid', 'data-id']) {
    const value = item?.getAttribute?.(name)
    if (value) return value
  }
  const raw = item?.getAttribute?.('data-sensorsdata') || item?.getAttribute?.('data-sensors-data') || ''
  const match = raw.match(/(?:jobId|job_id|positionId|position_id)["'=:\s]+([A-Za-z0-9_-]+)/i)
  if (match?.[1]) return match[1]
  try { return item?.querySelector?.('a[href]')?.href || '' } catch { return '' }
}

function cardJobFromDom(item, index, cityName = '') {
  const buttons = [...(item?.querySelectorAll?.('button, a, [role="button"]') || [])].map(node => textOf(node, 100)).filter(Boolean)
  const alreadyApplied = buttons.some(value => /已投递|已申请|已投/.test(value))
  const area = firstText(item, ['.area', '[class*="area"]', '[class*="city"]'])
  return {
    index,
    jobId: cardIdFromDom(item),
    jobName: firstText(item, ['.jname', '[class*="jname"]', '[class*="job-name"]', '[class*="jobName"]', 'h3', 'h2']).split('\n')[0],
    salaryDesc: firstText(item, ['.sal', '[class*="sal"]', '[class*="salary"]']),
    brandName: firstText(item, ['.cname', '[class*="cname"]', '[class*="company-name"]', '[class*="company"]']).split('|')[0].trim(),
    cityName: cleanText(area.split(/[·|]/)[0], 80),
    targetCity: cityName,
    postDescription: textOf(item, 2600),
    hasApply: buttons.some(value => /投递|申请/.test(value)) && !alreadyApplied,
    alreadyApplied,
    jobUrl: item?.querySelector?.('a[href]')?.href || ''
  }
}

async function applyEvidence(page) {
  return page.evaluate(() => {
    const visible = node => {
      const r = node?.getBoundingClientRect?.()
      const s = window.getComputedStyle?.(node)
      return !!r && r.width > 0 && r.height > 0 && s?.display !== 'none' && s?.visibility !== 'hidden'
    }
    const nodes = [...document.querySelectorAll('.success-popup, [role="alert"], [class*="toast"], [class*="message"], [class*="dialog"], .joblist-item')].filter(visible)
    const texts = nodes.map(node => (node.innerText || '').trim()).filter(Boolean)
    const successText = texts.find(text => /投递成功|申请成功|已投递|已申请/.test(text)) || ''
    const failureText = texts.find(text => /投递失败|申请失败|暂不能投递|请稍后再试/.test(text)) || ''
    const riskText = texts.find(text => /安全验证|请完成验证|滑动验证|验证码|访问受限|操作频繁|账号异常/.test(text)) || ''
    return {
      success: !!successText,
      failed: !!failureText,
      risk: !!riskText,
      evidenceText: (successText || failureText || riskText || '').slice(0, 500),
      popupText: texts.find(text => /成功|失败/.test(text))?.slice(0, 160) || ''
    }
  }).catch(() => ({ success: false, failed: false, risk: false, evidenceText: '' }))
}

const adapter = {
  platform: 'job51',
  name: '51job（前程无忧）',
  homeUrl: 'https://we.51job.com/pc/my/myjob',
  configName: 'job51.json',
  capabilities: { delivery: true, replies: false },

  async launch() {
    await launchPlatform({ platform: this.platform, homeUrl: this.homeUrl, cookiesFileName: 'job51-cookies.json' })
  },

  async getLoginDiagnostics() {
    const page = this._sp && !this._sp.isClosed?.() ? this._sp : getPage()
    if (!page) return { loggedIn: false, reason: 'no_page' }
    const snapshot = await pageSnapshot(page, {
      readySelectors: ['.myjob', '.joblist-item', '[class*="myjob"]', '[class*="header"]', '[class*="nav"]'],
      authSelectors: ['[class*="avatar"]', '[class*="user"]', '[class*="account"]', '[class*="logout"]'],
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

  async openSearchTab() {
    const base = getPage()
    if (!base) return { ok: false, code: 'no_page', reason: 'no page' }
    const browser = base.browser()
    const before = await browser.pages()
    const searchAlreadyOpen = before.find(page => !page.isClosed() && page.url().includes('/pc/search'))
    if (searchAlreadyOpen) {
      await searchAlreadyOpen.bringToFront().catch(() => {})
      return { ok: true, page: searchAlreadyOpen, url: searchAlreadyOpen.url(), reused: true }
    }
    // SPA 登录页在 launchPlatform 返回后还需要一小段时间挂载导航；
    // 搜索入口固定在页面内，但不能在 DOM 尚未完成时过早判定为不存在。
    await sleep(2600)
    let link = await findVisibleHandle(base, ['a[href*="/pc/search"]'])
    if (!link) link = await findVisibleTextHandle(base, '搜索', ['a', 'button', '[role="link"]'], { contains: false })
    if (!link) return { ok: false, reason: '搜索入口未找到' }
    const clicked = await clickElementHandle(link, { delay: 45 + Math.floor(Math.random() * 45) })
    if (!clicked) return { ok: false, reason: '搜索入口真实点击失败' }
    await sleep(4500)
    const pages = await browser.pages()
    const searchPage = pages.find(page => !page.isClosed() && page.url().includes('/pc/search'))
    if (!searchPage) return { ok: false, code: 'search_page_not_opened', reason: '点击搜索入口后没有打开搜索页面' }
    await searchPage.bringToFront().catch(() => {})
    return { ok: true, page: searchPage, url: searchPage.url() }
  },

  async searchJobs(keyword, cityName, platformConfig = {}) {
    this._config = platformConfig || {}
    this._cityFilter = cityName || ''
    let page = this._sp && !this._sp.isClosed?.() ? this._sp : null
    if (!page || !page.url().includes('/pc/search')) {
      const opened = await this.openSearchTab()
      if (!opened?.ok) return opened
      page = opened.page
      this._sp = page
    }
    // 上一条岗位的成功弹层可能还在页面上；搜索前先清理，避免它挡住城市、关键词或列表。
    await dismissJob51SuccessPopup(page)
    const citySelection = await selectCityThroughUi(page, cityName)
    if (!citySelection.ok) return { ok: false, ...citySelection }
    const input = await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)
    if (!input) return { ok: false, code: 'search_input_not_found', reason: '搜索输入框未找到' }
    let typed = true
    try {
      await input.click({ delay: 35 })
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.down(modifier)
      await page.keyboard.press('KeyA')
      await page.keyboard.up(modifier)
      await page.keyboard.press('Backspace')
      await input.type(String(keyword || ''), { delay: 75 + Math.floor(Math.random() * 55) })
    } catch (err) {
      typed = false
    } finally {
      await disposeHandle(input)
    }
    if (!typed) return { ok: false, code: 'search_input_not_found', reason: '输入关键词失败' }
    await sleep(800)
    let searchButton = await findVisibleHandle(page, SEARCH_BUTTON_SELECTORS)
    if (!searchButton) searchButton = await findVisibleTextHandle(page, '搜索', ['button', 'a', '[role="button"]'], { contains: true })
    if (!searchButton) return { ok: false, code: 'search_button_not_found', reason: '搜索按钮未找到' }
    const clicked = await clickElementHandle(searchButton, { delay: 40 + Math.floor(Math.random() * 45) })
    if (!clicked) return { ok: false, code: 'search_button_not_found', reason: '搜索按钮真实点击失败' }
    await waitForAny(page, RESULT_SELECTORS.concat(['.no-result', '[class*="empty"]']), 15000)
    await sleep(2400)
    const snapshot = await pageSnapshot(page, {
      readySelectors: RESULT_SELECTORS.concat(['.no-result', '[class*="empty"]']),
      authSelectors: ['[class*="avatar"]', '[class*="user"]', '[class*="account"]', '[class*="logout"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '无匹配职位', '没有相关职位']
    })
    const risk = riskFromSnapshot(snapshot)
    if (risk?.kind === 'platform_verification') return { ok: false, code: 'risk_detected', reason: risk.signal, risk, url: page.url() }
    if (snapshot.loginRequired) return { ok: false, code: 'login_required', reason: '51job 登录状态失效', loggedIn: false, url: page.url(), diagnostics: snapshot }
    const list = await this.readJobList(page, cityName)
    this._list = list
    if (!list.length && !snapshot.emptyText && !snapshot.pageReady) {
      return { ok: false, code: 'page_not_ready', reason: '51job 职位列表页面未就绪', loggedIn: false, url: page.url(), diagnostics: snapshot }
    }
    return {
      ok: true,
      loggedIn: snapshot.authHint || list.length > 0,
      list,
      url: page.url(),
      diagnostics: { ...snapshot, cityName, citySelection, resultCount: list.length }
    }
  },

  async readJobList(page = this._sp || getPage(), cityName = '') {
    if (!page || page.isClosed?.()) return []
    return page.evaluate(({ selectors, cityName }) => {
      const all = [...document.querySelectorAll(selectors.join(','))]
      const cards = all.filter(item => !item.parentElement?.closest(selectors.join(',')))
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
        for (const name of ['data-job-id', 'data-jobid', 'data-position-id', 'data-positionid', 'data-id']) {
          const value = root.getAttribute(name)
          if (value) return value
        }
        const raw = root.getAttribute('data-sensorsdata') || root.getAttribute('data-sensors-data') || ''
        const match = raw.match(/(?:jobId|job_id|positionId|position_id)["'=:\s]+([A-Za-z0-9_-]+)/i)
        if (match?.[1]) return match[1]
        return root.querySelector('a[href]')?.href || ''
      }
      const rows = cards.map((item, index) => {
        const buttons = [...item.querySelectorAll('button, a, [role="button"]')].map(node => clean(node.innerText)).filter(Boolean)
        const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
        const area = first(item, ['.area', '[class*="area"]', '[class*="city"]'])
        return {
          index,
          jobId: idOf(item),
          jobName: first(item, ['.jname', '[class*="jname"]', '[class*="job-name"]', '[class*="jobName"]', 'h3', 'h2']).split('\n')[0],
          salaryDesc: first(item, ['.sal', '[class*="sal"]', '[class*="salary"]']),
          brandName: first(item, ['.cname', '[class*="cname"]', '[class*="company-name"]', '[class*="company"]']).split('|')[0].trim(),
          cityName: clean(area.split(/[·|]/)[0], 80),
          postDescription: clean(item.innerText).slice(0, 2600),
          hasApply: buttons.some(value => /投递|申请/.test(value)) && !applied,
          alreadyApplied: applied,
          jobUrl: item.querySelector('a[href]')?.href || ''
        }
      }).filter(job => job.jobName)
      if (!cityName) return rows
      return rows.filter(job => !job.cityName || job.cityName.includes(cityName))
    }, { selectors: RESULT_SELECTORS, cityName })
  },

  async readJobDetail(index) {
    const page = this._sp || getPage()
    await dismissJob51SuccessPopup(page)
    const list = this._list?.length ? this._list : await this.readJobList(page, this._cityFilter || '')
    const job = list[index]
    if (!job) return { ok: false, code: 'job_not_found', reason: `没有找到第 ${index} 个 51job 岗位` }
    return { ok: true, listEntry: job, job, detail: job }
  },

  async apply(job) {
    const page = this._sp || getPage()
    if (!page) return { ok: false, success: false, code: 'no_page', reason: 'no page' }
    // 兜底处理上一个岗位遗留的成功弹层；这里仍然只会关闭带成功文案的弹层。
    await dismissJob51SuccessPopup(page)
    const before = await pageSnapshot(page, { loginTexts: LOGIN_TEXTS, riskTexts: RISK_TEXTS })
    const risk = riskFromSnapshot(before)
    if (risk) return { ok: false, success: false, code: risk.kind === 'login_required' ? 'login_required' : 'risk_detected', reason: risk.signal, risk }
    const name = String(job?.jobName || '')
    const jobId = String(job?.jobId || '')
    const card = await findVisibleHandleWhere(page, RESULT_SELECTORS, async (text, handle) => {
      const cardId = await handle.evaluate(root => {
        for (const attr of ['data-job-id', 'data-jobid', 'data-position-id', 'data-positionid', 'data-id']) {
          const value = root.getAttribute(attr)
          if (value) return value
        }
        return root.querySelector('a[href]')?.href || ''
      }).catch(() => '')
      return (jobId && cardId === jobId) || (!!name && text.includes(name))
    })
    if (!card) return { ok: true, success: false, code: 'job_card_not_found', reason: '搜索结果中没有找到目标岗位' }
    const cardButtons = await readVisibleHandleTexts(card, ['button', 'a', '[role="button"]'])
    if (cardButtons.some(value => /已投递|已申请|已投/.test(value))) {
      await disposeHandle(card)
      return { ok: true, success: false, alreadyApplied: true, code: 'already_applied', reason: '岗位已经显示为已投递' }
    }
    let applyButton = null
    applyButton = await findVisibleHandle(card, APPLY_BUTTON_SELECTORS)
    for (const text of ['立即投递', '投递简历', '投递', '申请']) {
      if (applyButton) break
      applyButton = await findVisibleTextHandle(card, text, ['button', 'a', '[role="button"]'], { contains: true })
      if (applyButton) break
    }
    if (!applyButton) {
      await disposeHandle(card)
      return { ok: true, success: false, code: 'apply_button_not_found', reason: '岗位卡片没有明确的投递按钮' }
    }
    const buttonText = await readHandleText(applyButton, 120)
    const didClick = await clickElementHandle(applyButton, { delay: 45 + Math.floor(Math.random() * 45) })
    await disposeHandle(card)
    if (!didClick) return { ok: true, success: false, code: 'apply_click_failed', reason: '51job 投递按钮真实点击失败' }
    const clicked = { ok: true, buttonText }
    await sleep(3500)
    const evidence = await applyEvidence(page)
    if (evidence.risk) return { ok: false, success: false, code: 'risk_detected', reason: '51job 投递后出现验证页面', risk: { kind: 'platform_verification', url: page.url() }, evidence }
    if (evidence.failed) return { ok: true, success: false, code: 'apply_failed', reason: '51job 明确返回投递失败', evidence }
    if (evidence.success) {
      const popupDismissal = await dismissJob51SuccessPopup(page)
      if (popupDismissal.found) {
        console.log(`[job51] 投递成功弹窗关闭: ${popupDismissal.via || 'unknown'} (${popupDismissal.closed ? 'ok' : '未确认'})`)
      }
      return { ok: true, success: true, clicked: true, evidence, popupDismissal }
    }
    return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '51job 没有返回明确的投递成功证据，未重复点击', evidence }
  },

  async getPageDiagnostics() {
    const page = this._sp && !this._sp.isClosed?.() ? this._sp : getPage()
    const snapshot = await pageSnapshot(page, {
      readySelectors: RESULT_SELECTORS.concat(['.myjob', '[class*="myjob"]']),
      authSelectors: ['[class*="avatar"]', '[class*="user"]', '[class*="account"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '无匹配职位']
    })
    const popup = await findSuccessPopup(page)
    const successPopupText = popup ? await readHandleText(popup, 300) : ''
    await disposeHandle(popup)
    return { ...snapshot, successPopup: !!popup, successPopupText }
  },

  async detectRiskSignal() {
    return riskFromSnapshot(await this.getPageDiagnostics())
  },

  async backToHome() {
    const page = this._sp && !this._sp.isClosed?.() ? this._sp : getPage()
    if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
    let home = await findVisibleHandle(page, ['a[href*="/pc/my/myjob"]', 'a[href="/pc/my/myjob"]'])
    if (!home) home = await findVisibleTextHandle(page, '我的工作', ['a', 'button', '[role="link"]', '[role="button"]'], { contains: true })
    if (home) {
      const clicked = await clickElementHandle(home, { delay: 45 + Math.floor(Math.random() * 45) })
      if (clicked) {
        await sleep(2500)
        this._sp = null
        return { ok: true, via: 'visible-nav' }
      }
    }
    if (this._sp && this._sp !== getPage() && !this._sp.isClosed?.()) {
      await this._sp.close().catch(() => {})
      this._sp = null
      return { ok: true, via: 'closed-detail-tab' }
    }
    return { ok: false, code: 'home_page_not_opened', reason: '51job 未找到可见的返回入口' }
  }
}

export default adapter

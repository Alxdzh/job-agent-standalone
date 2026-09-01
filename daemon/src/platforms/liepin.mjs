// 猎聘投递适配器。
//
// 这里保留历史归档里“通过可见 UI 选择城市、详情页新标签、直接投递/补充投递
// 两条路径”的方案，同时采用 GitHub 方案的页面就绪和最终证据校验。
// 默认优先详情页“投简历”；只有配置允许时才使用平台的补充投递入口回退。
// 没有成功提示时一律记为 indeterminate，不重复点击。
import { launchPlatform, getPage, sleep } from '../browser.mjs'
import {
  cleanText,
  clickElementHandle,
  disposeHandle,
  findIndexedVisibleHandle,
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
const RESULT_SELECTORS = ['.job-card-pc-container', '[class*="job-card-pc-container"]']
const SEARCH_INPUT_SELECTORS = [
  'input[placeholder*="搜索职位"]',
  'input[placeholder*="职位"]',
  'input[placeholder*="关键词"]',
  'input[class*="search"]'
]
const SEARCH_BUTTON_SELECTORS = ['button[class*="search"]', '[class*="search-btn"]', '[class*="searchButton"]']
const CITY_TRIGGER_SELECTORS = [
  '#filter-option-other-city',
  'li#filter-option-other-city',
  '[class*="city-select"]',
  '[class*="citySelect"]',
  '[class*="city-picker"]',
  '[class*="cityPicker"]',
  '[class*="area-select"]',
  'button[class*="city"]',
  '[role="button"][class*="city"]'
]
const CITY_DIALOG_SELECTORS = ['.ant-modal.city-modal', '.ant-modal', '[role="dialog"]', '[class*="city-modal"]', '[class*="city-dialog"]']
const CITY_SEARCH_INPUT_SELECTORS = ['input[placeholder="搜索城市"]', '.city-modal input.ant-input', '.city-modal input']
// 猎聘城市弹层由 React Portal 渲染；这些选择器必须从页面根节点查找，
// 不能把 .ant-modal ElementHandle 当作稳定的查询根。
const CITY_OPTION_SELECTORS = [
  '.ant-modal.city-modal a',
  '.ant-modal.city-modal button',
  '.ant-modal.city-modal li',
  '.ant-modal.city-modal span',
  '.ant-modal.city-modal [role="option"]',
  '.ant-modal.city-modal [role="button"]'
]
const CITY_TAB_SELECTORS = [
  '.ant-modal.city-modal [role="tab"]',
  '.ant-modal.city-modal [class*="city"] li',
  '.ant-modal.city-modal [class*="letter"] li',
  '.ant-modal.city-modal .ant-menu-item'
]
// 猎聘首页/职位页会出现广告或会员权益弹层。当前页面实测的广告弹层使用
// adslot-sdk-dialog-*，关闭叉在弹层底部；VIP 弹层的 class 版本会变，
// 所以只在检测到会员语义或这些明确的 adslot class 后寻找关闭控件。
const LIEPIN_AD_CLOSE_SELECTORS = [
  '.adslot-sdk-dialog-container .adslot-sdk-dialog-close-bottom',
  '.adslot-sdk-dialog-container .adslot-sdk-dialog-close',
  '.adslot-sdk-dialog-modal .adslot-sdk-dialog-close-bottom',
  '.adslot-sdk-dialog-modal .adslot-sdk-dialog-close',
  '[class*="adslot-sdk-dialog-close"]',
  '[class*="adslot"][class*="close"]'
]
const LIEPIN_VIP_DIALOG_SELECTORS = [
  '[class*="vip"]',
  '[class*="VIP"]',
  '[class*="member"]',
  '[class*="privilege"]',
  '[class*="purchase"]',
  '.ant-modal-wrap',
  '.ant-modal',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[class*="modal"]',
  '[class*="popup"]'
]
const LIEPIN_VIP_CLOSE_SELECTORS = [
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
const LIEPIN_VIP_TEXT = /VIP|会员|金卡|开通|购买|权益|猎聘卡|超级会员/i
const LIEPIN_DETAIL_SURFACE_SELECTORS = [
  '[class*="job-detail"]',
  '[class*="job-info"]',
  '[class*="job-content"]',
  'h1'
]
const LIEPIN_APPLY_ACTION_SELECTORS = ['button', 'a', '[role="button"]', '.btn', '[class*="btn"]']
const LIEPIN_DIRECT_APPLY_TEXTS = ['投简历', '投递简历', '立即投递']

async function visibleCityDialog(page) {
  return findVisibleHandle(page, CITY_DIALOG_SELECTORS)
}

async function findCityOption(page, cityName) {
  for (const value of [...new Set([String(cityName || '').trim(), `${String(cityName || '').trim()}市`].filter(Boolean))]) {
    const handle = await findVisibleTextHandle(page, value, CITY_OPTION_SELECTORS)
    if (handle) return handle
  }
  return null
}

async function closeCityDialog(page) {
  const close = await findVisibleHandle(page, [
    '.ant-modal.city-modal .city-modal-close',
    '.ant-modal.city-modal [aria-label="Close"]',
    '.ant-modal.city-modal [aria-label="关闭"]'
  ])
  if (close) {
    await clickElementHandle(close, { delay: 35 + Math.floor(Math.random() * 35) })
    await sleep(350)
    return
  }
  try { await page.keyboard.press('Escape') } catch {}
  await sleep(350)
}

async function findLiepinVipDialog(page) {
  return findVisibleHandleWhere(page, LIEPIN_VIP_DIALOG_SELECTORS, async (text, handle) => {
    const meta = await handle.evaluate(node => `${node.id || ''} ${String(node.className || '')}`).catch(() => '')
    return LIEPIN_VIP_TEXT.test(text) || /vip|member|privilege|purchase/i.test(meta)
  })
}

async function dismissLiepinPopups(page) {
  const result = { found: 0, closed: 0, remaining: false, via: [] }
  if (!page || page.isClosed?.()) return result
  // 一个页面可能先挂广告层、再挂会员层；最多处理几次，避免意外的
  // 异步重渲染造成无限循环。
  for (let attempt = 0; attempt < 3; attempt++) {
    const adClose = await findVisibleHandle(page, LIEPIN_AD_CLOSE_SELECTORS)
    if (adClose) {
      result.found += 1
      const clicked = await clickElementHandle(adClose, { delay: 35 + Math.floor(Math.random() * 35) })
      if (clicked) {
        result.closed += 1
        result.via.push('adslot-bottom-close')
      }
      await sleep(450)
      continue
    }

    const vipDialog = await findLiepinVipDialog(page)
    if (!vipDialog) break
    result.found += 1
    let clicked = false
    const close = await findVisibleHandle(vipDialog, LIEPIN_VIP_CLOSE_SELECTORS)
    if (close) {
      clicked = await clickElementHandle(close, { delay: 35 + Math.floor(Math.random() * 35) })
      if (clicked) result.via.push('vip-close-button')
    } else {
      try {
        await page.keyboard.press('Escape')
        clicked = true
        result.via.push('vip-escape')
      } catch {}
    }
    await disposeHandle(vipDialog)
    if (clicked) result.closed += 1
    await sleep(450)
  }
  const remainingAd = await findVisibleHandle(page, LIEPIN_AD_CLOSE_SELECTORS)
  result.remaining = !!remainingAd
  await disposeHandle(remainingAd)
  if (!result.remaining) {
    const remainingVip = await findLiepinVipDialog(page)
    result.remaining = !!remainingVip
    await disposeHandle(remainingVip)
  }
  if (result.found) {
    console.log(`[liepin] 已处理弹窗: ${result.via.join(', ') || '未找到可用关闭动作'} (${result.closed}/${result.found}${result.remaining ? '，仍有弹窗' : ''})`)
  }
  return result
}

function pageUrl(page) {
  try { return page?.url?.() || '' } catch { return '' }
}

function isLiepinDetailUrl(page) {
  try {
    const parsed = new URL(pageUrl(page))
    return parsed.hostname.endsWith('liepin.com') && /\/job(?:\/|$)/.test(parsed.pathname)
  } catch {
    return false
  }
}

async function findLiepinAction(page, labels) {
  for (const label of labels) {
    const handle = await findVisibleTextHandle(page, label, LIEPIN_APPLY_ACTION_SELECTORS, { contains: true })
    if (handle) return handle
  }
  return null
}

async function hasVisibleLiepinDetailSurface(page) {
  if (!page || page.isClosed?.()) return false
  const surface = await findVisibleHandle(page, LIEPIN_DETAIL_SURFACE_SELECTORS)
  const surfaceText = surface ? await readHandleText(surface, 500) : ''
  await disposeHandle(surface)
  if (surfaceText) return true
  const direct = await findLiepinAction(page, LIEPIN_DIRECT_APPLY_TEXTS)
  if (direct) {
    await disposeHandle(direct)
    return true
  }
  const resumePrompt = await findLiepinAction(page, ['聊一聊'])
  if (resumePrompt) {
    await disposeHandle(resumePrompt)
    return true
  }
  return false
}

// 点击职位链接后，猎聘可能新开标签，也可能复用当前标签；不能按“任意已有
// /job/ URL”选择页面，否则会读取旧详情页，造成“页面明明有投简历却说没有入口”。
// 只接受点击后新出现、URL 发生变化，或当前标签明确变成详情面的页面。
async function waitForLiepinDetailPage(base, beforeUrls, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = await base.browser().pages().catch(() => [])
    const changedPages = pages.filter(page => {
      if (!page || page.isClosed?.() || page === base) return false
      const previousUrl = beforeUrls.get(page)
      return previousUrl === undefined || pageUrl(page) !== previousUrl
    })
    const detailByUrl = changedPages.find(isLiepinDetailUrl)
    if (detailByUrl) {
      await detailByUrl.bringToFront().catch(() => {})
      return { page: detailByUrl, openedNewTab: true, via: 'new-or-changed-detail-url' }
    }
    for (const candidate of changedPages) {
      if (await hasVisibleLiepinDetailSurface(candidate)) {
        await candidate.bringToFront().catch(() => {})
        return { page: candidate, openedNewTab: true, via: 'new-or-changed-detail-surface' }
      }
    }
    const baseChanged = beforeUrls.get(base) !== pageUrl(base)
    if (baseChanged && (isLiepinDetailUrl(base) || await hasVisibleLiepinDetailSurface(base))) {
      await base.bringToFront().catch(() => {})
      return { page: base, openedNewTab: false, via: 'same-tab-detail' }
    }
    await sleep(250)
  }
  return null
}

async function waitForLiepinDetailReady(page, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await hasVisibleLiepinDetailSurface(page)) return true
    await sleep(250)
  }
  return false
}

async function openSearchSurface(page) {
  if ((await page.url()).includes('/zhaopin')) {
    await dismissLiepinPopups(page)
    return { ok: true, reused: true }
  }
  let entry = await findVisibleHandle(page, ['a[href*="/zhaopin"]', '[class*="nav"] a[href*="zhaopin"]'])
  if (!entry) entry = await findVisibleTextHandle(page, '找工作', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
  if (!entry) entry = await findVisibleTextHandle(page, '职位', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
  if (!entry) return { ok: false, code: 'search_page_not_opened', reason: '猎聘没有找到可见的找工作入口' }
  const clicked = await clickElementHandle(entry, { delay: 45 + Math.floor(Math.random() * 45) })
  if (!clicked) return { ok: false, code: 'search_page_not_opened', reason: '猎聘找工作入口真实点击失败' }
  await sleep(3500)
  await dismissLiepinPopups(page)
  return { ok: (await page.url()).includes('/zhaopin') || !!(await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)), reused: false }
}

function cardNodes(root) {
  const all = [...(root?.querySelectorAll?.(RESULT_SELECTORS.join(',')) || [])]
  return all.filter(card => !card.parentElement?.closest(RESULT_SELECTORS.join(',')))
}

function cardJobFromDom(card, index, cityName = '') {
  const link = card?.querySelector?.('a[data-nick="job-detail-job-info"], a[href*="/job/"]')
  const linkText = textOf(link, 500)
  const titleMatch = linkText.match(/([^【]+)【\s*([^】]+)\s*】/)
  const area = titleMatch?.[2] || firstText(card, ['[class*="area"]', '[class*="city"]'])
  const buttons = [...(card?.querySelectorAll?.('button, a, [role="button"], .btn, [class*="btn"]') || [])].map(node => textOf(node, 100)).filter(Boolean)
  const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
  return {
    index,
    jobId: card?.getAttribute?.('data-job-id') || card?.getAttribute?.('data-id') || link?.href || '',
    jobName: cleanText(titleMatch?.[1] || linkText.split('\n')[0], 160),
    salaryDesc: cleanText((textOf(card, 2600).match(/\d+(?:\.\d+)?k(?:-\d+(?:\.\d+)?k)?(?:·\d+薪)?/i) || [])[0], 100),
    brandName: firstText(card, ['[class*="company-name"]', '[class*="comp-name"]', '[class*="company"]']).split('\n')[0],
    cityName: cleanText(String(area || '').split(/[-·|\s]/)[0], 80),
    targetCity: cityName,
    postDescription: textOf(card, 2600),
    hasApply: buttons.some(value => /投简历|投递简历|立即投递|聊一聊/.test(value)) && !applied,
    alreadyApplied: applied,
    jobUrl: link?.href || ''
  }
}

async function applyEvidence(page) {
  return page.evaluate(() => {
    const visible = node => {
      const r = node?.getBoundingClientRect?.()
      const s = window.getComputedStyle?.(node)
      return !!r && r.width > 0 && r.height > 0 && s?.display !== 'none' && s?.visibility !== 'hidden'
    }
    const nodes = [...document.querySelectorAll('.ant-modal, [role="alert"], [class*="toast"], [class*="message"], [class*="success"], [class*="im-ui-basic-chat"]')].filter(visible)
    const texts = nodes.map(node => (node.innerText || '').trim()).filter(Boolean)
    const body = document.body?.innerText || ''
    const evidenceText = [...texts, body.slice(-1200)].join('\n').slice(-2600)
    const success = /简历投递成功|投递成功|简历已发送|这是我的简历|的简历/.test(evidenceText)
    const failed = /投递失败|发送失败|暂不能投递|请稍后再试/.test(evidenceText)
    const risk = /安全验证|请完成验证|滑动验证|验证码|访问受限|操作频繁|账号异常/.test(evidenceText)
    return { success, failed, risk, evidenceText: evidenceText.slice(-1200) }
  }).catch(() => ({ success: false, failed: false, risk: false, evidenceText: '' }))
}

const adapter = {
  platform: 'liepin',
  name: '猎聘',
  homeUrl: 'https://www.liepin.com/',
  configName: 'liepin.json',
  capabilities: { delivery: true, replies: false },

  async launch() {
    await launchPlatform({ platform: this.platform, homeUrl: this.homeUrl, cookiesFileName: 'liepin-cookies.json' })
    await dismissLiepinPopups(getPage())
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
    this._config = platformConfig || {}
    const page = getPage()
    if (!page) return { ok: false, code: 'no_page', reason: 'no page' }
    await dismissLiepinPopups(page)
    const opened = await openSearchSurface(page)
    if (!opened.ok) return opened
    const citySelection = cityName ? await this.ensureCity(page, cityName, platformConfig) : { ok: true, skipped: true }
    if (!citySelection.ok) return { ok: false, code: 'city_switch_failed', reason: citySelection.reason, citySelection }
    await dismissLiepinPopups(page)
    const input = await findVisibleHandle(page, SEARCH_INPUT_SELECTORS)
    if (!input) return { ok: false, code: 'search_input_not_found', reason: '猎聘搜索输入框未找到' }
    try {
      await input.click({ delay: 35 })
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.down(modifier)
      await page.keyboard.press('KeyA')
      await page.keyboard.up(modifier)
      await page.keyboard.press('Backspace')
      await input.type(String(keyword || ''), { delay: 75 + Math.floor(Math.random() * 55) })
    } catch (err) {
      await disposeHandle(input)
      return { ok: false, code: 'search_input_not_found', reason: err?.message || '猎聘搜索输入失败' }
    }
    await disposeHandle(input)
    await sleep(800)
    let searchButton = await findVisibleHandle(page, SEARCH_BUTTON_SELECTORS)
    if (!searchButton) searchButton = await findVisibleTextHandle(page, '搜索', ['button', 'a', 'span', '[role="button"]'], { contains: true })
    if (!searchButton) return { ok: false, code: 'search_button_not_found', reason: '猎聘搜索按钮未找到' }
    if (!await clickElementHandle(searchButton, { delay: 40 + Math.floor(Math.random() * 45) })) {
      return { ok: false, code: 'search_button_not_found', reason: '猎聘搜索按钮真实点击失败' }
    }
    await waitForAny(page, RESULT_SELECTORS.concat(['[class*="empty"]', '[class*="no-result"]']), 15000)
    await sleep(2500)
    await dismissLiepinPopups(page)
    const list = await this.readJobList(cityName)
    const snapshot = await pageSnapshot(page, {
      readySelectors: RESULT_SELECTORS.concat(['[class*="empty"]', '[class*="no-result"]']),
      authSelectors: ['[class*="avatar"]', '[class*="user-info"]', '[class*="account"]', '[class*="logout"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '暂无相关职位']
    })
    const risk = riskFromSnapshot(snapshot)
    if (risk?.kind === 'platform_verification') return { ok: false, code: 'risk_detected', reason: risk.signal, risk, url: page.url() }
    if (snapshot.loginRequired) return { ok: false, code: 'login_required', reason: '猎聘登录状态失效', loggedIn: false, url: page.url(), diagnostics: snapshot }
    if (!list.length && !snapshot.emptyText && !snapshot.pageReady) {
      return { ok: false, code: 'page_not_ready', reason: '猎聘职位列表页面未就绪', loggedIn: false, url: page.url(), diagnostics: snapshot }
    }
    this._list = list
    return {
      ok: true,
      loggedIn: snapshot.authHint || list.length > 0,
      list,
      url: page.url(),
      diagnostics: { ...snapshot, cityName, citySelection, resultCount: list.length }
    }
  },

  async ensureCity(page, cityName, platformConfig = {}) {
    const trigger = await findVisibleHandle(page, CITY_TRIGGER_SELECTORS)
      || await findVisibleTextHandle(page, '其他', ['li', 'button', 'span', 'a', '[role="button"]'], { contains: false })
    if (!trigger) return { ok: false, reason: '猎聘没有找到可见城市选择器' }
    if (!await clickElementHandle(trigger, { delay: 40 + Math.floor(Math.random() * 45) })) {
      return { ok: false, reason: '猎聘城市选择器真实点击失败' }
    }
    await sleep(1800)
    let dialog = await visibleCityDialog(page)
    if (!dialog) return { ok: false, reason: '猎聘城市弹层未出现' }
    let cityPoint = null
    const province = platformConfig.liepinProvince || ''
    if (province) {
      const provinceHandle = await findVisibleTextHandle(page, province, CITY_OPTION_SELECTORS)
      if (!provinceHandle) {
        await disposeHandle(dialog)
        await closeCityDialog(page)
        return { ok: false, reason: `猎聘城市弹层中没有配置的省份“${province}”` }
      }
      if (!await clickElementHandle(provinceHandle, { delay: 40 + Math.floor(Math.random() * 40) })) {
        await disposeHandle(dialog)
        await closeCityDialog(page)
        return { ok: false, reason: '猎聘省份选项真实点击失败' }
      }
      await sleep(1000)
      await disposeHandle(dialog)
      dialog = await visibleCityDialog(page)
      if (!dialog) return { ok: false, reason: '猎聘选择省份后城市弹层消失' }
    }
    cityPoint = await findCityOption(page, cityName)
    // 猎聘城市弹层先展示省份；弹层自带“搜索城市”输入框，优先用页面提供的
    // 可见搜索控件直接定位目标城市，避免把省份标签顺序当成稳定结构。
    if (!cityPoint) {
      // ElementHandle 根节点在部分 React 弹层版本中无法稳定解析后代选择器，
      // 这里从页面根查找“当前可见”的猎聘城市搜索框，仍然只走真实控件。
      const citySearch = await findVisibleHandle(page, CITY_SEARCH_INPUT_SELECTORS)
      if (citySearch) {
        try {
          await citySearch.click({ delay: 35 })
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
          await page.keyboard.down(modifier)
          await page.keyboard.press('KeyA')
          await page.keyboard.up(modifier)
          await page.keyboard.press('Backspace')
          await citySearch.type(String(cityName), { delay: 75 + Math.floor(Math.random() * 55) })
        } finally {
          await disposeHandle(citySearch)
        }
        await sleep(900)
        await disposeHandle(dialog)
        dialog = await visibleCityDialog(page)
        cityPoint = await findCityOption(page, cityName)
      }
    }
    if (!cityPoint) {
      const tabTexts = await readVisibleHandleTexts(page, CITY_TAB_SELECTORS)
      await disposeHandle(dialog)
      for (const tabText of tabTexts.slice(0, 24)) {
        const next = await visibleCityDialog(page)
        if (!next) break
        const tab = await findVisibleTextHandle(page, tabText, CITY_TAB_SELECTORS)
        if (!tab) {
          await disposeHandle(next)
          continue
        }
        const tabClicked = await clickElementHandle(tab, { delay: 35 + Math.floor(Math.random() * 40) })
        await disposeHandle(next)
        if (!tabClicked) continue
        await sleep(500)
        const current = await visibleCityDialog(page)
        if (!current) break
        cityPoint = await findCityOption(page, cityName)
        await disposeHandle(current)
        if (cityPoint) break
      }
    } else {
      await disposeHandle(dialog)
    }
    if (!cityPoint) {
      await disposeHandle(dialog)
      await closeCityDialog(page)
      return { ok: false, reason: `猎聘可见城市弹层中没有“${cityName}”` }
    }
    if (!await clickElementHandle(cityPoint, { delay: 45 + Math.floor(Math.random() * 45) })) {
      await closeCityDialog(page)
      return { ok: false, reason: '猎聘城市选项真实点击失败' }
    }
    await sleep(1000)
    const allPoint = await findVisibleTextHandle(page, `全${cityName}`, CITY_OPTION_SELECTORS)
    if (allPoint) {
      await clickElementHandle(allPoint, { delay: 40 + Math.floor(Math.random() * 40) })
      await sleep(4500)
    }
    const filterText = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[class*="filter"], [class*="city"], [class*="area"]')]
      return nodes.filter(node => {
        const r = node.getBoundingClientRect?.()
        return r && r.width > 0 && r.height > 0
      }).map(node => (node.innerText || '').trim()).filter(Boolean).slice(0, 40)
    }).catch(() => [])
    const normalized = filterText.join('').replace(/\s+/g, '')
    const target = String(cityName).replace(/\s+/g, '').replace(/市$/, '')
    return {
      ok: true,
      selectedBy: 'visible-ui',
      displayedCity: filterText.find(value => value.replace(/\s+/g, '').includes(target)) || '',
      confirmedBy: normalized.includes(target) ? 'visible-filter' : 'click-completed',
      warning: normalized.includes(target) ? '' : '页面没有回显城市标签，但目标选项已通过真实点击完成'
    }
  },

  async readJobList(cityFilter = '') {
    const page = getPage()
    if (!page) return []
    return page.evaluate(({ selectors, cityFilter }) => {
      const all = [...document.querySelectorAll(selectors.join(','))]
      const cards = all.filter(card => !card.parentElement?.closest(selectors.join(',')))
      const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
      return cards.map((card, index) => {
        const link = card.querySelector('a[data-nick="job-detail-job-info"], a[href*="/job/"]')
        const linkText = clean(link?.innerText || '')
        const titleMatch = linkText.match(/([^【]+)【\s*([^】]+)\s*】/)
        const full = clean(card.innerText)
        const buttons = [...card.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]')].map(node => clean(node.innerText)).filter(Boolean)
        const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
        const city = clean(titleMatch?.[2] || card.querySelector('[class*="area"], [class*="city"]')?.innerText || '').split(/[-·|\s]/)[0]
        return {
          index,
          jobId: card.getAttribute('data-job-id') || card.getAttribute('data-id') || link?.href || '',
          jobName: clean(titleMatch?.[1] || linkText.split('\n')[0]),
          salaryDesc: (full.match(/\d+(?:\.\d+)?k(?:-\d+(?:\.\d+)?k)?(?:·\d+薪)?/i) || [])[0] || '',
          brandName: clean(card.querySelector('[class*="company-name"], [class*="comp-name"], [class*="company"]')?.innerText || '').split('\n')[0],
          cityName: city,
          postDescription: full.slice(0, 2600),
          hasApply: buttons.some(value => /投简历|投递简历|立即投递|聊一聊/.test(value)) && !applied,
          alreadyApplied: applied,
          jobUrl: link?.href || ''
        }
      }).filter(job => job.jobName && (!cityFilter || !job.cityName || job.cityName === cityFilter))
    }, { selectors: RESULT_SELECTORS, cityFilter })
  },

  async readJobDetail(index) {
    const base = getPage()
    if (!base) return { ok: false, code: 'no_page', reason: 'no page' }
    try { if (this._detailPage && this._detailPage !== base && !this._detailPage.isClosed?.()) await this._detailPage.close() } catch {}
    const list = this._list?.length ? this._list : await this.readJobList('')
    const listEntry = list[index]
    if (!listEntry) return { ok: false, code: 'job_not_found', reason: `没有找到第 ${index} 个猎聘岗位` }
    const beforePages = await base.browser().pages()
    const beforeUrls = new Map(beforePages.map(page => [page, pageUrl(page)]))
    let link = await findIndexedVisibleHandle(base, ['a[data-nick="job-detail-job-info"]'], listEntry.index ?? index)
    if (!link) link = await findIndexedVisibleHandle(base, ['a[href*="/job/"]'], listEntry.index ?? index)
    if (!link && listEntry.jobUrl) {
      link = await findVisibleHandle(base, [`a[href="${String(listEntry.jobUrl).replace(/"/g, '\\"')}"]`])
    }
    if (!link) return { ok: false, code: 'detail_link_not_found', reason: `没有找到第 ${index} 个猎聘详情入口` }
    const clicked = await clickElementHandle(link, { delay: 45 + Math.floor(Math.random() * 45) })
    if (!clicked) return { ok: false, code: 'detail_click_failed', reason: '猎聘详情入口真实点击失败' }
    const detailResult = await waitForLiepinDetailPage(base, beforeUrls)
    const detailPage = detailResult?.page
    if (!detailPage) return { ok: false, code: 'detail_page_not_opened', reason: '猎聘详情页没有打开' }
    this._detailPage = detailPage
    await dismissLiepinPopups(detailPage)
    await waitForLiepinDetailReady(detailPage)
    await sleep(1800)
    const detail = await detailPage.evaluate(listJobName => {
      const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
      const body = clean(document.body?.innerText || '')
      const first = selectors => {
        for (const selector of selectors) {
          const node = document.querySelector(selector)
          const value = clean(node?.innerText || node?.textContent || '')
          if (value) return value
        }
        return ''
      }
      const buttons = [...document.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]')]
        .filter(node => { const r = node.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0 })
        .map(node => clean(node.innerText)).filter(Boolean)
      const applied = buttons.some(value => /已投递|已申请|已投/.test(value))
      return {
        jobName: listJobName || first(['h1', '[class*="job-name"]', '[class*="title"]']),
        salaryDesc: (body.match(/\d+(?:\.\d+)?k(?:-\d+(?:\.\d+)?k)?(?:·\d+薪)?/i) || [])[0] || '',
        brandName: first(['[class*="company-name"]', '[class*="comp-name"]', '[class*="company-info"] a', '[class*="job-company"]']),
        cityName: (body.match(/北京|上海|深圳|广州|杭州|南京|成都|重庆|武汉|西安|青岛|济南|烟台|威海|潍坊|临沂/) || [''])[0],
        postDescription: body.slice(0, 3400),
        hasDirectApply: buttons.some(value => /投简历|投递简历|立即投递/.test(value)) && !applied,
        hasResumePrompt: buttons.some(value => /聊一聊/.test(value)) && !applied,
        hasApply: buttons.some(value => /投简历|投递简历|立即投递|聊一聊/.test(value)) && !applied,
        visibleActionTexts: buttons.filter(value => /投简历|投递简历|立即投递|聊一聊|已投递|已申请|已投/.test(value)).slice(0, 12),
        alreadyApplied: applied
      }
    }, listEntry.jobName).catch(err => ({ jobName: listEntry.jobName, postDescription: '', detailError: err?.message }))
    const directAction = await findLiepinAction(detailPage, LIEPIN_DIRECT_APPLY_TEXTS)
    const resumePrompt = await findLiepinAction(detailPage, ['聊一聊'])
    const job = {
      ...listEntry,
      ...detail,
      hasDirectApply: detail.hasDirectApply === true || !!directAction,
      hasResumePrompt: detail.hasResumePrompt === true || !!resumePrompt,
      hasApply: detail.hasApply === true || !!directAction || !!resumePrompt,
      jobId: detail.jobId || listEntry.jobId,
      index
    }
    await disposeHandle(directAction)
    await disposeHandle(resumePrompt)
    return { ok: true, listEntry: job, job, detail }
  },

  async apply(job) {
    const page = this._detailPage || getPage()
    if (!page) return { ok: false, success: false, code: 'no_page', reason: 'no page' }
    await dismissLiepinPopups(page)
    const before = await pageSnapshot(page, { loginTexts: LOGIN_TEXTS, riskTexts: RISK_TEXTS })
    const risk = riskFromSnapshot(before)
    if (risk) return { ok: false, success: false, code: risk.kind === 'login_required' ? 'login_required' : 'risk_detected', reason: risk.signal, risk }
    const strategy = this._config?.liepinApplyStrategy || 'auto'
    const buttonTexts = await readVisibleHandleTexts(page, LIEPIN_APPLY_ACTION_SELECTORS)
    if (buttonTexts.some(value => /已投递|已申请|已投/.test(value))) {
      return { ok: true, success: false, alreadyApplied: true, code: 'already_applied', reason: '岗位已经显示为已投递' }
    }
    let direct = await findLiepinAction(page, LIEPIN_DIRECT_APPLY_TEXTS)
    let clicked = null
    if (direct) {
      clicked = { ok: await clickElementHandle(direct, { delay: 45 + Math.floor(Math.random() * 45) }), path: 'direct' }
    } else if (strategy === 'direct') {
      return { ok: true, success: false, code: 'direct_apply_unavailable', reason: '详情页没有直接投简历按钮' }
    } else {
      const resumeEntry = await findLiepinAction(page, ['聊一聊'])
      if (!resumeEntry) return { ok: true, success: false, code: 'apply_button_not_found', reason: '详情页没有可用投递入口' }
      clicked = { ok: await clickElementHandle(resumeEntry, { delay: 45 + Math.floor(Math.random() * 45) }), path: 'resume-prompt' }
    }
    if (!clicked?.ok) return { ok: true, success: false, code: 'apply_click_failed', reason: '猎聘投递入口真实点击失败' }
    if (clicked.path === 'direct') {
      await sleep(3500)
    } else {
      await sleep(2600)
      const resumeButton = await findVisibleTextHandle(page, '发简历', ['button', 'a', 'span', '[role="button"]', '.btn', '[class*="btn"]', '[class*="action-resume"]'], { contains: true })
      if (!resumeButton) return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '猎聘投递面板没有明确的发简历按钮，未重复点击' }
      if (!await clickElementHandle(resumeButton, { delay: 45 + Math.floor(Math.random() * 45) })) {
        return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '猎聘发简历按钮真实点击失败，未重复点击' }
      }
      await sleep(1600)
      const modal = await findVisibleHandle(page, ['.ant-im-modal-confirm', '[class*="modal-confirm"]', '.ant-modal', '[role="dialog"]'])
      const confirmButton = modal
        ? await findVisibleTextHandle(modal, '确定', ['button', 'a', '[role="button"]'], { contains: true })
        : null
      const confirmed = await clickElementHandle(confirmButton, { delay: 45 + Math.floor(Math.random() * 45) })
      await disposeHandle(modal)
      if (!confirmed) return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '猎聘发送简历确认框没有出现，未重复点击' }
      await sleep(3500)
    }
    await dismissLiepinPopups(page)
    const evidence = await applyEvidence(page)
    if (evidence.risk) return { ok: false, success: false, code: 'risk_detected', reason: '猎聘投递后出现验证页面', risk: { kind: 'platform_verification', url: page.url() }, evidence }
    if (evidence.failed) return { ok: true, success: false, code: 'apply_failed', reason: '猎聘明确返回投递失败', evidence }
    if (evidence.success) return { ok: true, success: true, clicked: true, path: clicked.path, evidence }
    return { ok: true, success: false, indeterminate: true, code: 'delivery_indeterminate', reason: '猎聘没有返回明确的投递成功证据，未重复点击', path: clicked.path, evidence }
  },

  async getPageDiagnostics() {
    const page = this._detailPage && !this._detailPage.isClosed?.() ? this._detailPage : getPage()
    const snapshot = await pageSnapshot(page, {
      readySelectors: RESULT_SELECTORS.concat(['h1', '[class*="job-detail"]', '[class*="job-info"]']),
      authSelectors: ['[class*="avatar"]', '[class*="user-info"]', '[class*="account"]'],
      loginTexts: LOGIN_TEXTS,
      riskTexts: RISK_TEXTS,
      emptyTexts: ['暂无职位', '没有找到', '暂无相关职位']
    })
    const adClose = await findVisibleHandle(page, LIEPIN_AD_CLOSE_SELECTORS)
    const vipDialog = await findLiepinVipDialog(page)
    await disposeHandle(adClose)
    await disposeHandle(vipDialog)
    return { ...snapshot, popups: { adslot: !!adClose, vip: !!vipDialog } }
  },

  async detectRiskSignal() {
    return riskFromSnapshot(await this.getPageDiagnostics())
  },

  async backToHome() {
    const base = getPage()
    try { if (this._detailPage && this._detailPage !== base && !this._detailPage.isClosed?.()) await this._detailPage.close() } catch {}
    this._detailPage = null
    if (!base) return { ok: false, code: 'no_page', reason: 'no page' }
    await dismissLiepinPopups(base)
    const list = await findVisibleHandle(base, RESULT_SELECTORS)
    if (list) {
      await disposeHandle(list)
      return { ok: true, reused: true }
    }
    let entry = await findVisibleHandle(base, ['a[href*="/zhaopin"]', 'a[href="/"]'])
    if (!entry) entry = await findVisibleTextHandle(base, '找工作', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
    if (!entry) entry = await findVisibleTextHandle(base, '职位', ['header a', 'nav a', 'button', '[role="link"]'], { contains: true })
    if (!entry) return { ok: false, code: 'home_page_not_opened', reason: '猎聘未找到可见的返回职位入口' }
    const clicked = await clickElementHandle(entry, { delay: 45 + Math.floor(Math.random() * 45) })
    if (!clicked) return { ok: false, code: 'home_page_not_opened', reason: '猎聘返回职位入口真实点击失败' }
    await sleep(2200)
    return { ok: true, via: 'visible-nav' }
  }
}

export default adapter

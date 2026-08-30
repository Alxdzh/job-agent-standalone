// 多平台 UI 适配器共用的小工具。
// 这里只读取页面状态、等待页面自身的可见节点，并返回可审计的证据；
// 不包含验证码绕过、设备伪造或其它规避平台限制的逻辑。

export function cleanText(value, max = 2400) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

export function firstText(root, selectors = []) {
  for (const selector of selectors) {
    try {
      const node = root?.querySelector?.(selector)
      const text = cleanText(node?.innerText || node?.textContent || '', 500)
      if (text) return text
    } catch {}
  }
  return ''
}

export function firstAttribute(root, names = []) {
  for (const name of names) {
    try {
      const value = root?.getAttribute?.(name)
      if (value) return String(value).trim()
    } catch {}
  }
  return ''
}

export function isVisible(node) {
  if (!node) return false
  try {
    const rect = node.getBoundingClientRect()
    const style = window.getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  } catch {
    return false
  }
}

export function visibleNodes(root, selectors = []) {
  const seen = new Set()
  const nodes = []
  for (const selector of selectors) {
    try {
      for (const node of root?.querySelectorAll?.(selector) || []) {
        if (!seen.has(node) && isVisible(node)) {
          seen.add(node)
          nodes.push(node)
        }
      }
    } catch {}
  }
  return nodes
}

export function textHasAny(text, values = []) {
  const source = String(text || '').toLowerCase()
  return values.find(value => source.includes(String(value || '').toLowerCase())) || ''
}

export function urlHasAny(url, values = []) {
  const source = String(url || '').toLowerCase()
  return values.find(value => source.includes(String(value || '').toLowerCase())) || ''
}

export async function pageSnapshot(page, {
  readySelectors = [],
  authSelectors = [],
  loginTexts = [],
  riskTexts = [],
  emptyTexts = [],
  extra = {}
} = {}) {
  if (!page || page.isClosed?.()) return { ok: false, reason: 'no_page' }
  try {
    return await page.evaluate(({ readySelectors, authSelectors, loginTexts, riskTexts, emptyTexts, extra }) => {
      const body = document.body?.innerText || ''
      const lower = body.toLowerCase()
      const visible = node => {
        if (!node) return false
        const r = node.getBoundingClientRect?.()
        const s = window.getComputedStyle?.(node)
        return !!r && r.width > 0 && r.height > 0 && s?.display !== 'none' && s?.visibility !== 'hidden'
      }
      const firstMatch = values => values.find(value => lower.includes(String(value || '').toLowerCase())) || ''
      const ready = readySelectors.filter(selector => {
        try { return [...document.querySelectorAll(selector)].some(visible) } catch { return false }
      })
      const auth = authSelectors.filter(selector => {
        try { return [...document.querySelectorAll(selector)].some(visible) } catch { return false }
      })
      const loginText = firstMatch(loginTexts)
      const riskText = firstMatch(riskTexts)
      const emptyText = firstMatch(emptyTexts)
      const authText = /我的简历|在线简历|我的申请|消息|退出登录|退出/.test(body)
      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        bodyLen: body.length,
        bodyStart: body.trim().slice(0, 220),
        readySelectors: ready,
        authSelectors: auth,
        loginText,
        riskText,
        emptyText,
        loginRequired: !!loginText,
        riskDetected: !!riskText,
        pageReady: ready.length > 0,
        authHint: auth.length > 0 || authText,
        loggedIn: !loginText && !riskText && (auth.length > 0 || authText),
        ...extra
      }
    }, { readySelectors, authSelectors, loginTexts, riskTexts, emptyTexts, extra })
  } catch (err) {
    return { ok: false, reason: err?.message || 'page_snapshot_failed' }
  }
}

export async function waitForAny(page, selectors = [], timeout = 12000) {
  if (!page || page.isClosed?.() || !selectors.length) return false
  try {
    await page.waitForFunction((items) => items.some(selector => {
      try {
        return [...document.querySelectorAll(selector)].some(node => {
          const rect = node.getBoundingClientRect?.()
          return rect && rect.width > 0 && rect.height > 0
        })
      } catch { return false }
    }), { timeout }, selectors)
    return true
  } catch {
    return false
  }
}

export function riskFromSnapshot(snapshot) {
  if (!snapshot || snapshot.ok === false) return null
  if (snapshot.riskDetected) return { kind: 'platform_verification', signal: snapshot.riskText, url: snapshot.url }
  if (snapshot.loginRequired) return { kind: 'login_required', signal: snapshot.loginText, url: snapshot.url }
  return null
}

export function jobIdFromNode(node) {
  const attrs = [
    'data-job-id', 'data-jobid', 'data-position-id', 'data-positionid',
    'data-id', 'data-code', 'data-serial-id', 'data-item-id'
  ]
  const direct = firstAttribute(node, attrs)
  if (direct) return direct
  try {
    const link = node.querySelector('a[href]')
    const href = link?.getAttribute('href') || ''
    const match = href.match(/(?:job|position|item|id)[=/:-]([A-Za-z0-9_-]{5,})/i)
    return match?.[1] || href.slice(0, 240)
  } catch {
    return ''
  }
}

export function textOf(node, max = 2400) {
  return cleanText(node?.innerText || node?.textContent || '', max)
}

// 下面这些函数只负责在 Puppeteer 的 Node 侧寻找并点击真实的元素句柄。
// 不要把会改变页面状态的 .click() 放进 page.evaluate：那是 DOM 脚本点击，
// 会绕过浏览器的鼠标事件链，也会让预置页面契约和真实用户操作不一致。
export function normalizeUiText(value) {
  return String(value || '').replace(/\s+/g, '').trim()
}

export async function isHandleVisible(handle) {
  if (!handle) return false
  try {
    const box = await handle.boundingBox()
    if (!box || box.width <= 0 || box.height <= 0) return false
    return await handle.evaluate(node => {
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
    })
  } catch {
    return false
  }
}

export async function disposeHandle(handle) {
  try { await handle?.dispose?.() } catch {}
}

export async function findVisibleHandle(root, selectors = []) {
  if (!root || !Array.isArray(selectors)) return null
  for (const selector of selectors) {
    let handles = []
    try { handles = await root.$$(selector) } catch {}
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i]
      if (await isHandleVisible(handle)) {
        await Promise.all(handles.slice(i + 1).map(disposeHandle))
        return handle
      }
      await disposeHandle(handle)
    }
  }
  return null
}

export async function findIndexedVisibleHandle(root, selectors = [], index = 0) {
  if (!root || !Array.isArray(selectors) || index < 0) return null
  for (const selector of selectors) {
    let handles = []
    try { handles = await root.$$(selector) } catch {}
    const visible = []
    for (const handle of handles) {
      if (await isHandleVisible(handle)) visible.push(handle)
      else await disposeHandle(handle)
    }
    if (visible[index]) {
      await Promise.all(visible.filter((_, i) => i !== index).map(disposeHandle))
      return visible[index]
    }
    await Promise.all(visible.map(disposeHandle))
  }
  return null
}

export async function readHandleText(handle, max = 500) {
  try {
    return cleanText(await handle.evaluate(node => node?.innerText || node?.textContent || ''), max)
  } catch {
    return ''
  }
}

export async function findVisibleTextHandle(root, text, selectors = ['button', 'a', 'li', 'span', '[role="button"]', '[role="option"]'], { contains = false } = {}) {
  if (!root) return null
  const expected = normalizeUiText(text)
  if (!expected) return null
  let handles = []
  try { handles = await root.$$(selectors.join(',')) } catch {}
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i]
    const value = normalizeUiText(await readHandleText(handle, 500))
    const matches = contains ? value.includes(expected) : value === expected
    if (matches && await isHandleVisible(handle)) {
      await Promise.all(handles.slice(i + 1).map(disposeHandle))
      return handle
    }
    await disposeHandle(handle)
  }
  return null
}

export async function findVisibleHandleWhere(root, selectors = [], predicate = () => false) {
  if (!root || !Array.isArray(selectors)) return null
  for (const selector of selectors) {
    let handles = []
    try { handles = await root.$$(selector) } catch {}
    for (const handle of handles) {
      if (!await isHandleVisible(handle)) {
        await disposeHandle(handle)
        continue
      }
      const text = await readHandleText(handle, 1000)
      let matched = false
      try { matched = await predicate(text, handle) } catch {}
      if (matched) {
        await Promise.all(handles.filter(item => item !== handle).map(disposeHandle))
        return handle
      }
      await disposeHandle(handle)
    }
  }
  return null
}

export async function readVisibleHandleTexts(root, selectors = ['button', 'a', 'li', 'span', '[role="button"]', '[role="tab"]']) {
  if (!root) return []
  let handles = []
  try { handles = await root.$$(selectors.join(',')) } catch {}
  const values = []
  const seen = new Set()
  for (const handle of handles) {
    if (await isHandleVisible(handle)) {
      const value = cleanText(await readHandleText(handle, 160), 160)
      if (value && !seen.has(value)) {
        seen.add(value)
        values.push(value)
      }
    }
    await disposeHandle(handle)
  }
  return values
}

export async function clickElementHandle(handle, { delay = 45 } = {}) {
  if (!handle || !(await isHandleVisible(handle))) {
    await disposeHandle(handle)
    return false
  }
  try {
    try { await handle.scrollIntoViewIfNeeded?.() } catch {}
    await handle.click({ delay })
    return true
  } finally {
    await disposeHandle(handle)
  }
}

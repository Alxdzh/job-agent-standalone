let currentTab = 'overview'
const currentOwner = 'default'
const PLATFORM_LABELS = { boss: 'Boss直聘', zhilian: '智联招聘', job51: '51job（前程无忧）', liepin: '猎聘' }
let deferredInstallPrompt = null
let agentExited = false
const $ = (id) => document.getElementById(id)

function isStandaloneApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function initAppShell() {
  const button = $('install-app')
  const status = $('install-status')
  if (!button) return
  const label = button.querySelector('.install-label')
  const markInstalled = () => {
    button.classList.add('installed')
    button.disabled = true
    button.title = '已安装为独立应用'
    if (label) label.textContent = '已安装'
  }
  if (isStandaloneApp()) markInstalled()

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    deferredInstallPrompt = event
    button.hidden = false
    button.title = '安装为独立应用窗口'
  })
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    markInstalled()
    if (status) status.textContent = '已安装为独立窗口'
  })
  button.addEventListener('click', async () => {
    if (button.disabled) return
    if (!deferredInstallPrompt) {
      if (status) status.textContent = '请在浏览器菜单中选择“安装求职管家”或“添加到主屏幕”'
      return
    }
    deferredInstallPrompt.prompt()
    const choice = await deferredInstallPrompt.userChoice
    deferredInstallPrompt = null
    if (choice.outcome === 'accepted') markInstalled()
  })

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js?v=20260902-delivery-materials1').catch(() => {})
  }
}

async function api(method, url, body, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const data = await r.json().catch(() => null)
    return { status: r.status, data }
  } catch (e) {
    return { status: 0, error: e?.name === 'AbortError' ? '后台服务无响应，请先启动工作台' : e.message }
  } finally {
    clearTimeout(timer)
  }
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') }
function showNotice(text) {
  const status = $('hunt-status')
  if (status) status.textContent = String(text || '')
}
// ===== 标签 =====
function tab(name) {
  currentTab = name
  document.querySelectorAll('.side-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name))
  if (name === 'overview') {
    loadStats()
    loadProfile()
  }
  if (name === 'records') loadApplications()
}
document.querySelectorAll('.side-tabs button[data-tab]').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)))

// ===== 概览 =====
async function loadStats() {
  const s = await api('GET', '/api/stats')
  const st = s.data || {}
  const platformCount = Object.keys(st.byPlatform || {}).length
  $('stats-cards').innerHTML = `
    <div class="stat-card hl"><div class="num">${st.todayApplied || 0}</div><div class="label">今日投递</div></div>
    <div class="stat-card"><div class="num">${st.totalApplied || 0}</div><div class="label">累计投递</div></div>
    <div class="stat-card"><div class="num">${platformCount}</div><div class="label">有记录的平台</div></div>`
  const industry = st.industry || []
  $('industry-stats').innerHTML = industry.length
    ? industry.map(i => `<span class="tag" style="margin:0 6px 6px 0;background:var(--accent-soft);color:var(--accent)">${escapeHtml(i.name)} ×${i.count}</span>`).join('')
    : '<span class="time">暂无</span>'
}

async function loadProfile() {
  const r = await api('GET', '/api/delivery-materials')
  const panel = $('profile-panel')
  if (!panel) return
  const profileText = String(r.data?.text || '')
  panel.innerHTML = `
    <div class="card profile-compact"><div class="section-head"><div><h3>求职资料</h3><div class="settings-note" style="margin-top:3px">把你的经历、技能、求职限制和在意的条件写在这里，供系统判断 JD 是否匹配。</div></div></div>
      <div class="profile-form" style="margin-top:9px">
        <label>个人资料与岗位判断补充<textarea id="profile-jd-context" rows="8" placeholder="例如：我有……经历，熟悉……；希望……；不接受……">${escapeHtml(profileText)}</textarea></label>
        <div class="profile-form-actions"><button class="btn primary" onclick="saveProfileForm()">保存资料</button><span class="time" id="profile-save-status"></span></div>
        <div class="settings-note">只保存到本机资料库，不修改设置里的城市、关键词、薪资或平台，也不会自动开始投递。</div>
      </div>
    </div>`
}

window.saveProfileForm = async function() {
  const status = $('profile-save-status')
  const text = $('profile-jd-context')?.value?.trim() || ''
  if (status) status.textContent = '保存中…'
  const r = await api('POST', '/api/delivery-materials', { text })
  if (status) status.textContent = r.data?.ok ? '已保存资料 ✅' : `保存失败：${r.data?.error || r.error || '未知错误'}`
  if (r.data?.ok) await loadProfile()
}

function renderApplicationRows(rows) {
  const body = $('apps-body')
  if (!body) return
  body.innerHTML = rows.length ? rows.map(a => `
    <tr><td class="time">${new Date(a.time).toLocaleString()}</td><td><span class="tag" style="background:var(--accent-soft);color:var(--accent)">${escapeHtml(PLATFORM_LABELS[a.platform] || a.platform || '未知平台')}</span></td><td>${escapeHtml(a.jobName || '')}</td><td>${escapeHtml(a.brandName || '')}</td><td><span class="tag ${a.sent ? 'green' : 'red'}">${a.sent ? '已投' : '失败'}</span></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">还没有投递记录</td></tr>'
}

async function loadApplications() {
  const r = await api('GET', '/api/applications?limit=100')
  const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.applications) ? r.data.applications : [])
  renderApplicationRows(rows)
}

function platformSummaryState(item) {
  if (item?.enabled) return ['已启用', 'ok']
  if (item?.configured) return ['已配置 · 未启用', 'need']
  return ['待配置', 'need']
}

function renderPlatformSummary(platforms) {
  const box = $('platform-summary')
  const note = $('platform-summary-note')
  if (!box) return
  if (!Array.isArray(platforms) || !platforms.length) {
    box.innerHTML = '<span class="time">暂无已接入平台</span>'
    if (note) note.textContent = '未读取到平台'
    return
  }
  const enabledCount = platforms.filter(item => item.enabled).length
  if (note) note.textContent = `${platforms.length} 个平台已接入 · ${enabledCount} 个已启用`
  box.innerHTML = platforms.map(item => {
    const [label, cls] = platformSummaryState(item)
    const capability = item.capabilities?.delivery ? '投递已接入' : '暂不可投递'
    const loginLabel = item.loggedIn === true ? '登录：已登录' : item.loggedIn === false ? '登录：未登录' : '登录：未检测'
    const loginClass = item.loggedIn === true ? 'ok' : item.loggedIn === false ? 'need' : ''
    return `<div class="platform-summary-item">
      <div class="platform-summary-name">${escapeHtml(item.name || item.platform)}</div>
      <span class="platform-summary-state ${cls}">${label}</span>
      <div class="platform-summary-meta">${capability}</div>
      <div class="platform-summary-login ${loginClass}" data-platform-summary-login="${escapeHtml(item.platform)}">${loginLabel}</div>
    </div>`
  }).join('')
}

async function loadPlatformSummary() {
  const r = await api('GET', '/api/platforms')
  renderPlatformSummary(r.data || [])
}

function platformLoginStateLabel(item) {
  if (item?.loggedIn === true) return ['已登录 · 状态已保存', 'ok']
  if (item?.loggedIn === false) return ['未登录 · 请打开网页扫码', 'need']
  if (item?.enabled === false) return ['未启用 · 勾选后参与投递', '']
  return ['尚未检查', '']
}

function renderPlatformLoginRows(platforms) {
  const box = $('platform-login-list')
  if (!box) return
  if (!platforms?.length) {
    box.innerHTML = '<span class="time">没有启用的平台</span>'
    return
  }
  box.innerHTML = platforms.map(p => {
    const [label, cls] = platformLoginStateLabel(p)
    return `<div class="platform-login-row" data-platform-row="${escapeHtml(p.platform)}">
      <label class="toggle-row" style="margin:0;white-space:nowrap"><input type="checkbox" data-platform-enable="${escapeHtml(p.platform)}" ${p.enabled ? 'checked' : ''}> 启用</label>
      <span class="platform-login-name">${escapeHtml(p.name || p.platform)}</span>
      <span class="platform-login-state ${cls}" data-platform-state>${label}${p.capabilities?.delivery ? '' : ' · 暂无投递能力'}</span>
      <button class="btn sm" data-platform-open="${escapeHtml(p.platform)}">打开登录</button>
      <button class="btn sm" data-platform-check="${escapeHtml(p.platform)}">检查</button>
    </div>`
  }).join('')
  box.querySelectorAll('[data-platform-open]').forEach(btn => btn.addEventListener('click', () => openPlatformLogin(btn.dataset.platformOpen)))
  box.querySelectorAll('[data-platform-check]').forEach(btn => btn.addEventListener('click', () => checkPlatformLogin(btn.dataset.platformCheck)))
  box.querySelectorAll('[data-platform-enable]').forEach(input => input.addEventListener('change', () => setPlatformEnabled(input.dataset.platformEnable, input.checked)))
}

async function loadPlatformLogins() {
  const r = await api('GET', '/api/platforms')
  renderPlatformLoginRows((r.data || []).map(p => ({ ...p, loggedIn: null })))
}

async function setPlatformEnabled(platform, enabled) {
  const status = $('platform-login-status')
  if (status) status.textContent = `${enabled ? '正在启用' : '正在停用'} ${platform}…`
  const r = await api('POST', '/api/config', { platform, enabled, action: 'set-enabled' })
  if (r.data?.ok) {
    if (status) status.textContent = enabled ? `${platform} 已启用；请打开登录完成扫码。` : `${platform} 已停用。`
    await loadPlatformSummary()
    await loadPlatformLogins()
  } else {
    if (status) status.textContent = `保存失败：${r.data?.reason || r.data?.error || r.error || '未知错误'}`
    await loadPlatformLogins()
  }
}

function updatePlatformLoginRow(item) {
  const row = document.querySelector(`[data-platform-row="${CSS.escape(item.platform)}"]`)
  if (row) {
    const state = row.querySelector('[data-platform-state]')
    const [label, cls] = platformLoginStateLabel(item)
    state.textContent = label
    state.className = `platform-login-state ${cls}`
  }
  const summary = document.querySelector(`[data-platform-summary-login="${CSS.escape(item.platform)}"]`)
  if (summary) {
    summary.textContent = item.loggedIn === true ? '登录：已登录' : item.loggedIn === false ? '登录：未登录' : '登录：未检测'
    summary.className = `platform-summary-login ${item.loggedIn === true ? 'ok' : item.loggedIn === false ? 'need' : ''}`
  }
}

async function openPlatformLogin(platform) {
  const status = $('platform-login-status')
  status.textContent = '正在打开可见浏览器…'
  const r = await api('POST', '/api/platform/login', { platform }, 60000)
  status.textContent = r.data?.ok ? `${r.data.name || platform} 已打开，请在笔记本窗口完成扫码/登录，然后点“检查”保存状态。` : `打开失败：${r.data?.error || r.error || '未知错误'}`
}

async function checkPlatformLogin(platform) {
  const status = $('platform-login-status')
  status.textContent = `正在检查 ${platform}…`
  const r = await api('GET', `/api/platform/login-status?platform=${encodeURIComponent(platform)}`, undefined, 60000)
  const item = r.data?.platforms?.[0]
  if (item) updatePlatformLoginRow(item)
  status.textContent = item?.loggedIn ? `${item.name || platform} 已登录，登录态已保存。` : `${item?.name || platform} 还没有登录。`
}

async function checkAllPlatformLogins() {
  const btn = $('check-all-platform-logins')
  const status = $('platform-login-status')
  if (btn) { btn.disabled = true; btn.textContent = '正在检测已启用平台…' }
  status.textContent = '正在依次检测已启用平台，请在可见浏览器完成扫码。'
  const r = await api('GET', '/api/platform/login-status?platform=all', undefined, 180000)
  if (!r.data?.ok) {
    status.textContent = `登录状态检测失败：${r.data?.error || r.error || '未知错误'}`
    if (btn) { btn.disabled = false; btn.textContent = '重新检测已启用平台登录状态' }
    return
  }
  const items = r.data?.platforms || []
  items.forEach(updatePlatformLoginRow)
  const missing = items.filter(x => x.loggedIn !== true)
  status.textContent = missing.length
    ? `仍有 ${missing.length} 个已启用平台未登录，请点击对应的“打开登录”完成扫码。`
    : '已启用平台均已登录，状态已保存 ✅'
  if (btn) { btn.disabled = false; btn.textContent = '重新检测已启用平台登录状态' }
}

// ===== 状态 & 设置 =====
async function refreshStatus() {
  if (agentExited) return
  const r = await api('GET', '/api/worker')
  if (r.status === 0) {
    const badge = $('status-badge')
    if (badge) {
      badge.innerHTML = '<span class="dot"></span>后台未连接'
      badge.className = 'badge paused'
    }
    const huntStatus = $('hunt-status')
    if (huntStatus) huntStatus.textContent = r.error || '后台服务无响应，请先启动工作台'
    return
  }
  const w = r.data || {}
  const badge = $('status-badge')
  const active = w.running || w.continuous
  const stateText = active ? '投递中' : w.paused ? '已暂停' : '空闲'
  badge.innerHTML = `<span class="dot"></span>${stateText}`
  badge.className = active ? 'badge busy' : w.paused ? 'badge paused' : 'badge idle'
  const stopBtn = $('stop-btn')
  if (stopBtn) {
    const icon = stopBtn.querySelector('.ti')
    const label = $('stop-label')
    const manualRunning = w.running && !w.continuous
    const continuousPaused = w.continuous && w.paused
    const showPlay = (!w.running && !w.continuous) || w.paused
    if (icon) icon.className = showPlay ? 'ti ti-player-play' : 'ti ti-player-pause'
    if (label) label.textContent = manualRunning
      ? (w.paused ? '继续当前投递' : '暂停当前投递')
      : continuousPaused ? '继续持续投递' : w.continuous ? '暂停持续投递' : '开始持续投递'
    stopBtn.classList.toggle('danger', (manualRunning || (w.continuous && !w.paused)))
    stopBtn.classList.toggle('continuous', !manualRunning && !(w.continuous && !w.paused))
    stopBtn.title = manualRunning
      ? (w.paused ? '继续当前定量投递' : '暂停当前定量投递')
      : continuousPaused ? '继续持续投递' : w.continuous ? '暂停持续投递' : '开始持续投递（不限数量，按配置节奏运行）'
  }
  const p = w.progress
  const phaseNames = { login_check: '检查登录', preflight: '准备中', delivering: '读取岗位', searching: '搜索岗位', reading_jd: '读取 JD', judging: '判断岗位', applying: '投递中', cooldown: '投递后等待', platform_cooldown: '平台冷却轮换', continuous_rest: '批次间休息', outside_delivery_window: '不在投递时间窗', pause_requested: '正在停止', paused: '已暂停', completed: '本轮完成', incomplete: '本轮未完成', login_required: '等待登录', error: '运行异常' }
  const cooldownText = Object.entries(w.platformSchedule || {})
    .filter(([, item]) => item?.status === 'cooldown' && Number(item.cooldownRemainingSeconds) > 0)
    .map(([platform, item]) => `${PLATFORM_LABELS[platform] || platform} ${formatDuration(item.cooldownRemainingSeconds)}`)
    .join('、')
  const scheduleText = cooldownText ? ` · 冷却中：${cooldownText}` : ''
  if (active && p) {
    const decision = p.lastDecision?.status === 'skip'
      ? ` · 最近跳过：${p.lastDecision.jobName || '岗位'}（${p.lastDecision.reason || '未通过判断'}）`
      : ''
    $('hunt-status').textContent = `${w.continuous ? '连续投递' : '本轮'}${phaseNames[p.phase] || p.phase || '运行中'} · 已扫描 ${p.scanned || 0} · 成功 ${p.applied || 0} · 跳过 ${p.skipped || 0}${scheduleText}${decision}`
  } else if (w.lastHunt) {
    $('hunt-status').textContent = `上次投递 ${new Date(w.lastHunt.time).toLocaleString()} · 投 ${w.lastHunt.applied} 跳过 ${w.lastHunt.skipped}`
  } else {
    $('hunt-status').textContent = p?.phase === 'error' ? `上次运行异常：${p.reason || '未知原因'}` : '尚未投递'
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  if (total >= 3600) return `${Math.floor(total / 3600)}小时${Math.ceil((total % 3600) / 60)}分`
  return `${Math.max(1, Math.ceil(total / 60))}分钟`
}
async function loadDeliveryConfig() {
  const platform = $('delivery-platform')?.value || 'boss'
  const r = await api('GET', `/api/config?platform=${encodeURIComponent(platform)}`)
  const c = r.data || {}
  if ($('delivery-city')) $('delivery-city').value = c.daemonCity || ''
  if ($('delivery-salary')) $('delivery-salary').value = c.expectSalaryLow || ''
  if ($('delivery-keywords')) $('delivery-keywords').value = (c.keywords || []).join('、')
}

async function saveDeliveryConfig() {
  const status = $('delivery-status')
  const rawKeywords = $('delivery-keywords')?.value || ''
  const keywords = rawKeywords.split(/[\n,，、；;]/).map(x => x.trim()).filter(Boolean)
  const body = {
    platform: $('delivery-platform')?.value || 'boss',
    daemonCity: $('delivery-city')?.value.trim() || '',
    expectSalaryLow: Number($('delivery-salary')?.value) || 0,
    keywords
  }
  if (!body.daemonCity || !keywords.length) {
    status.textContent = '请至少填写城市和一个搜索关键词'
    return
  }
  status.textContent = '保存中…'
  const r = await api('POST', '/api/config', body)
  if (r.data?.ok) {
    status.textContent = `已保存 ${body.platform === 'all' ? '全部平台' : body.platform} 投递偏好 ✅`
    await loadDeliveryConfig()
  } else status.textContent = `保存失败：${r.data?.error || r.error || '未知错误'}`
}

$('stop-btn').addEventListener('click', async () => {
  const button = $('stop-btn')
  if (button) button.disabled = true
  const r = await api('POST', '/api/continuous', { action: 'toggle' })
  const result = r.data || {}
  const reasonText = {
    already_running: '已有投递任务正在运行，本次没有重复启动。',
    already_continuous: '持续投递已经在运行，本次没有重复启动。',
    continuous_running: '持续投递正在运行，请先暂停持续投递。',
    manual_check_required: '当前被要求人工检查登录或异常页面；检查完成后再继续。',
    platform_disabled: '所选平台当前未启用或没有配置。'
  }
  const notice = r.status === 0
    ? `操作失败：${r.error || '后台服务无响应，请先启动工作台'}`
    : result.ok
      ? result.action === 'started' ? '已开始持续投递：不限数量，按配置节奏运行。'
        : result.action === 'stopped' ? '已暂停持续投递，当前批次会在安全节点停止。'
          : result.action === 'paused_manual' ? '已暂停当前定量投递。'
            : result.action === 'resumed_manual' ? '已继续当前定量投递。' : '状态已更新。'
      : `操作未执行：${reasonText[result.reason] || result.reason || result.error || '未知原因'}`
  await refreshStatus()
  showNotice(notice)
  if (button) button.disabled = false
})
$('exit-agent-btn').addEventListener('click', async () => {
  const button = $('exit-agent-btn')
  const label = button.querySelector('span')
  button.disabled = true
  if (label) label.textContent = '退出中…'
  const r = await api('POST', '/api/shutdown', {})
  if (r.data?.shuttingDown) {
    agentExited = true
    const badge = $('status-badge')
    badge.innerHTML = '<span class="dot"></span>后台已退出'
    badge.className = 'badge paused'
    if (label) label.textContent = '已退出'
    $('stop-btn').disabled = true
    $('btn-hunt').disabled = true
    $('install-status').textContent = '后台已退出；下次请双击快捷方式启动'
    showNotice('后台服务已退出。今天不会再自动运行；下次双击快捷方式即可重新启动。')
  } else {
    button.disabled = false
    if (label) label.textContent = '退出后台'
    showNotice(`退出失败：${r.data?.error || r.error || '后台没有响应'}`)
  }
})
$('btn-hunt').addEventListener('click', async () => {
  const n = Number($('hunt-max').value) || 10
  const selectedPlatform = $('hunt-platform')?.value || 'all'
  const selectedPlatformName = selectedPlatform === 'all'
    ? '全部已启用平台'
    : (PLATFORM_LABELS[selectedPlatform] || selectedPlatform)
  const btn = $('btn-hunt'); btn.disabled = true; btn.textContent = '投递中…'
  const r = await api('POST', '/api/trigger-hunt', { maxJobs: n, platform: selectedPlatform })
  const startReason = {
    already_running: '已有投递任务正在运行，本次没有重复启动。',
    continuous_running: '持续投递正在运行，请先暂停持续投递。',
    manual_check_required: '该平台正等待你处理登录、验证或异常页面；处理后再继续。',
    platform_disabled: `${selectedPlatformName} 尚未启用或未完成投递偏好。请到设置：勾选“启用”，填写城市和关键词，打开浏览器登录后再投。`,
    no_enabled_platform: '没有已启用的平台。请先到设置中启用至少一个平台。',
    outside_delivery_window: '当前不在允许投递时间内；请调整设置中的每日投递时间。'
  }
  const notice = r.status === 0
    ? `启动失败：${r.error || '后台服务无响应，请先启动工作台'}`
    : r.data?.ok
      ? `已启动 ${selectedPlatformName} 的 ${n} 个岗位任务；正在检查登录和页面状态。`
      : `无法启动 ${selectedPlatformName}：${startReason[r.data?.reason] || r.data?.reason || r.data?.error || '未知原因'}`
  if (r.status === 0) {
    const badge = $('status-badge')
    if (badge) {
      badge.innerHTML = '<span class="dot"></span>后台未连接'
      badge.className = 'badge paused'
    }
  } else {
    await refreshStatus()
  }
  showNotice(notice)
  setTimeout(() => { btn.disabled = false; btn.textContent = '开始本轮' }, 2000)
})

// ===== 设置（皮肤 + LLM）=====
function applySkin(skin) {
  document.body.setAttribute('data-skin', skin || 'light')
  localStorage.setItem('skin', skin || 'light')
  document.querySelectorAll('.skin-btn').forEach(b => b.classList.toggle('active', b.dataset.skin === skin))
}
window.setSkin = function(skin) { applySkin(skin) }
window.openSettings = function() {
  $('settings-modal').style.display = 'flex'
  loadLlmConfig(); loadRuntimeSettings(); loadDeliveryConfig()
  // Do not launch four platform browsers as a side effect of opening Settings.
  // The user can explicitly run the all-platform check, or open one platform
  // for login; this prevents the sequential checker from closing a manually
  // opened window a moment later.
  void loadPlatformLogins()
}
window.closeSettings = function() { $('settings-modal').style.display = 'none' }
$('tab-settings-btn').addEventListener('click', window.openSettings)

async function loadLlmConfig() {
  const r = await api('GET', '/api/llm-config')
  const c = r.data || {}
  $('set-llm-url').value = c.providerCompleteApiUrl || ''
  $('set-llm-key').value = c.providerApiSecret || ''
  setLlmModelOptions([], c.model || '')
  void loadLlmModels(c.model || '')
}

const FALLBACK_LLM_MODELS = ['MiMo V2.5', 'mimo-v2.5', 'mimo-v2-flash', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'gpt-4o-mini', 'qwen-plus', 'deepseek-chat']

function setLlmModelOptions(models = [], current = '') {
  const select = $('set-llm-model')
  if (!select) return
  const ids = [...new Set((Array.isArray(models) && models.length ? models : FALLBACK_LLM_MODELS).map(String).map(x => x.trim()).filter(Boolean))]
  if (current && !ids.includes(current)) ids.unshift(current)
  select.innerHTML = '<option value="">选择模型…</option>' + ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}${id === current ? '（当前）' : ''}</option>`).join('') + '<option value="__custom__">自定义模型…</option>'
  select.value = current && ids.includes(current) ? current : ''
  syncCustomLlmModel()
}

function syncCustomLlmModel() {
  const custom = $('set-llm-model')?.value === '__custom__'
  const row = $('llm-custom-model-row')
  if (row) row.style.display = custom ? 'flex' : 'none'
}

function selectedLlmModel() {
  const select = $('set-llm-model')
  if (!select) return ''
  if (select.value === '__custom__') return $('set-llm-model-custom')?.value.trim() || ''
  return select.value.trim()
}

async function loadLlmModels(current = selectedLlmModel()) {
  const note = $('llm-model-note')
  const r = await api('GET', '/api/llm-models', undefined, 15000)
  const models = r.data?.models || []
  setLlmModelOptions(models, current)
  if (note) note.textContent = models.length
    ? `已从当前接口读取 ${models.length} 个模型 ID；最终以接口实际支持的模型为准。`
    : '当前接口没有提供模型列表，已显示常用候选；最终以接口实际支持的模型为准。'
}

function llmFormBody() {
  const key = $('set-llm-key')?.value.trim() || ''
  return {
    providerCompleteApiUrl: $('set-llm-url')?.value.trim() || undefined,
    providerApiSecret: key && !key.includes('••••') ? key : undefined,
    model: selectedLlmModel() || undefined
  }
}

$('set-llm-model')?.addEventListener('change', syncCustomLlmModel)
$('refresh-llm-models')?.addEventListener('click', async () => {
  const note = $('llm-model-note')
  if (note) note.textContent = '正在读取当前接口的模型列表…'
  await loadLlmModels(selectedLlmModel())
})
$('save-llm').addEventListener('click', async () => {
  const body = llmFormBody()
  const statusEl = $('llm-status')
  statusEl.textContent = '保存中…'
  const r = await api('POST', '/api/llm-config', body)
  statusEl.textContent = r.data?.ok ? '已保存 ✅' : `保存失败：${r.data?.error || ''}`
})
$('test-llm')?.addEventListener('click', async () => {
  const statusEl = $('llm-status')
  const note = $('llm-model-note')
  statusEl.textContent = '测试中…'
  const r = await api('POST', '/api/llm-test', llmFormBody(), 30000)
  if (r.data?.ok) {
    statusEl.textContent = `连接正常 · ${r.data.model}`
    if (note) note.textContent = `接口已返回：${r.data.preview || '有响应'}。模型 ID 和接口配置可用。`
  } else {
    statusEl.textContent = `测试失败：${r.data?.error || r.error || '后台服务无响应'}`
  }
})
$('save-delivery-config')?.addEventListener('click', saveDeliveryConfig)

async function loadRuntimeSettings() {
  const r = await api('GET', '/api/workbench-settings')
  const c = r.data || {}
  $('set-silent-mode').checked = c.silentMode === true
  const window = c.deliveryWindow || {}
  if ($('delivery-window-start')) $('delivery-window-start').value = window.start || '09:00'
  if ($('delivery-window-end')) $('delivery-window-end').value = window.end || '21:00'
  const p = c.pacing || {}
  const values = {
    'pace-batch-count-min': p.batchCountMin,
    'pace-batch-count-max': p.batchCountMax,
    'pace-batch-rest-min': p.batchRestMinMinutes,
    'pace-batch-rest-max': p.batchRestMaxMinutes,
    'pace-gap-min': p.applicationGapMinSeconds,
    'pace-gap-max': p.applicationGapMaxSeconds
  }
  for (const [id, value] of Object.entries(values)) if ($(id) && value != null) $(id).value = value
}

async function saveRuntimeSettings() {
  const statusEl = $('runtime-status')
  const number = id => Number($(id)?.value)
  const pacing = {
    batchCountMin: number('pace-batch-count-min'), batchCountMax: number('pace-batch-count-max'),
    batchRestMinMinutes: number('pace-batch-rest-min'), batchRestMaxMinutes: number('pace-batch-rest-max'),
    applicationGapMinSeconds: number('pace-gap-min'), applicationGapMaxSeconds: number('pace-gap-max')
  }
  const deliveryWindow = {
    start: $('delivery-window-start')?.value || '09:00',
    end: $('delivery-window-end')?.value || '21:00'
  }
  const ranges = [
    ['投递批次', pacing.batchCountMin, pacing.batchCountMax],
    ['批次休息', pacing.batchRestMinMinutes, pacing.batchRestMaxMinutes],
    ['岗位间隔', pacing.applicationGapMinSeconds, pacing.applicationGapMaxSeconds]
  ]
  const bad = ranges.find(([, min, max]) => !Number.isFinite(min) || !Number.isFinite(max) || min >= max)
  if (bad) {
    statusEl.textContent = `${bad[0]}必须填写最小值 < 最大值`
    return
  }
  const body = {
    silentMode: $('set-silent-mode').checked,
    deliveryWindow,
    pacing
  }
  const r = await api('POST', '/api/workbench-settings', body)
  if (r.data?.ok) {
    statusEl.textContent = body.silentMode ? '已保存；下次打开投递网页时生效' : '已保存 ✅'
  } else statusEl.textContent = `保存失败：${r.data?.error || r.error || '未知'}`
}

$('save-runtime')?.addEventListener('click', saveRuntimeSettings)
$('check-all-platform-logins')?.addEventListener('click', checkAllPlatformLogins)
$('delivery-platform')?.addEventListener('change', loadDeliveryConfig)
$('records-refresh')?.addEventListener('click', loadApplications)

async function manualRefresh() {
  await refreshStatus()
  if (currentTab === 'overview') {
    await Promise.all([loadStats(), loadPlatformSummary(), loadProfile()])
  } else if (currentTab === 'records') {
    await loadApplications()
  }
}
$('btn-refresh')?.addEventListener('click', manualRefresh)

// ===== 初始化 =====
window.addEventListener('DOMContentLoaded', () => {
  initAppShell()
  applySkin(localStorage.getItem('skin') || 'light')
  loadStats(); refreshStatus()
  loadPlatformSummary()
  loadRuntimeSettings(); loadDeliveryConfig(); loadProfile()
  setInterval(() => { refreshStatus() }, 5000)
})

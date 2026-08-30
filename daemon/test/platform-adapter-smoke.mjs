import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '..', 'src')
const registry = fs.readFileSync(path.join(srcDir, 'platforms', 'index.mjs'), 'utf8')
assert.match(registry, /PLATFORMS\s*=\s*\['boss',\s*'zhilian',\s*'job51',\s*'liepin'\]/)
assert.match(registry, /zhilian:\s*'智联招聘'/)
assert.match(registry, /job51:\s*'51job（前程无忧）'/)
assert.match(registry, /liepin:\s*'猎聘'/)

for (const platform of ['zhilian', 'job51', 'liepin']) {
  const file = path.join(srcDir, 'platforms', `${platform}.mjs`)
  const source = fs.readFileSync(file, 'utf8')
  assert.match(source, new RegExp(String.raw`platform:\s*'${platform}'`))
  assert.match(source, /capabilities:\s*\{\s*delivery:\s*true,\s*replies:\s*false\s*\}/)
  assert.match(source, /delivery_indeterminate/)
  assert.match(source, /success:\s*true/)
  assert.match(source, /login_required/)
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{16,}|ghp_|github_pat_/)
}

const platformSources = Object.fromEntries(['boss', 'zhilian', 'job51', 'liepin'].map(platform => [
  platform,
  fs.readFileSync(path.join(srcDir, 'platforms', `${platform}.mjs`), 'utf8')
]))
for (const [platform, source] of Object.entries(platformSources)) {
  assert.doesNotMatch(source, /probePageStructure|probeVisiblePageStructure|页面结构探测/, `${platform} must use its prebuilt page contract`)
}
// 每个平台的控件契约独立固化；智联首页搜索的新标签接管也必须是适配器内部行为。
assert.match(platformSources.zhilian, /home-header__city/)
assert.match(platformSources.zhilian, /\.job-card/)
assert.match(platformSources.zhilian, /\.job-detail-summary/)
assert.match(platformSources.zhilian, /setPlatformPage\('zhilian'/)
assert.match(platformSources.zhilian, /search_result_tab_not_opened/)
assert.match(platformSources.job51, /\.shadedword/)
assert.match(platformSources.job51, /a\.ch/)
assert.match(platformSources.job51, /\.joblist-item/)
assert.match(platformSources.job51, /btn\.apply/)
assert.match(platformSources.job51, /dismissJob51SuccessPopup/)
assert.match(platformSources.job51, /SUCCESS_POPUP_CLOSE_SELECTORS/)
assert.match(platformSources.job51, /outside-click/)
assert.match(platformSources.job51, /successPopupText/)
assert.match(platformSources.liepin, /filter-option-other-city/)
assert.match(platformSources.liepin, /搜索城市/)
assert.match(platformSources.liepin, /job-card-pc-container/)
assert.match(platformSources.liepin, /data-nick="job-detail-job-info"/)
assert.match(platformSources.liepin, /adslot-sdk-dialog-close-bottom/)
assert.match(platformSources.liepin, /dismissLiepinPopups/)
assert.match(platformSources.liepin, /popups:\s*\{\s*adslot:/)

const browser = fs.readFileSync(path.join(srcDir, 'browser.mjs'), 'utf8')
assert.match(browser, /export function setPlatformPage/)
assert.match(browser, /ZHILIAN_USER_DATA_DIR/)
assert.match(browser, /JOB51_USER_DATA_DIR/)
assert.match(browser, /LIEPIN_USER_DATA_DIR/)
assert.match(browser, /headless:\s*HEADLESS/)
assert.match(browser, /const HEADLESS = false/)

const boss = fs.readFileSync(path.join(srcDir, 'boss.mjs'), 'utf8')
assert.match(boss, /cur-city-label/)
assert.doesNotMatch(boss, /cityGroup|flattedCityList|cityCode|urlCity|urlQuery/)
assert.doesNotMatch(boss, /setter\?\.call|mouse\.click|scrollTop\s*=|window\.scrollBy|keyboard\.press\(['"]Enter['"]\)/)
assert.doesNotMatch(boss, /\.click\(\)/)
assert.match(boss, /findVisibleTextHandle/)
assert.match(boss, /findIndexedVisibleHandle/)
// BOSS 投递确认只能点“留在此页”。绝不能把“继续沟通”当作下一步点击。
assert.match(boss, /clickStayOnCurrentPage/)
assert.match(boss, /留在此页/)
assert.match(boss, /refuse to click chat-continuation button/)
assert.doesNotMatch(boss, /findVisibleTextHandle\(page,\s*['"]继续沟通['"]|findVisibleTextHandle\([^\n]+,\s*['"]继续沟通['"]/, 'BOSS flow must never locate a continue-chat button for clicking')
assert.match(boss, /status:\s*'apply_indeterminate'/)

const web = fs.readFileSync(path.join(srcDir, 'web.mjs'), 'utf8')
assert.doesNotMatch(web, /page\.goto|target\.click|el\.click|\.click\(\)/)
assert.match(web, /showPlatformBrowser/)
assert.doesNotMatch(web, /api\/platform\/probe|api\/diag\/platform|api\/diag-jd-vue/)
assert.doesNotMatch(web, /openChatPage|diag-chat|goto-chat|trigger-reply|api\/audit|api\/conversations|api\/chat|agent\/reply|channels/)

assert.doesNotMatch(boss, /openChatPage|getUnreadChats|getAllChats|clickChatByIndex|clickChatByBossId|readLastMessages|sendChatMessage/)

for (const platform of ['zhilian', 'job51', 'liepin']) {
  const source = fs.readFileSync(path.join(srcDir, 'platforms', `${platform}.mjs`), 'utf8')
  assert.doesNotMatch(source, /CITY_CODES|CITY_META|cityCode|setter\?\.call|scrollTop\s*=|window\.scrollBy/)
  // 51job 成功提示支持点击弹窗外空白处关闭；这是关闭已确认成功弹层的
  // 安全兜底，不是用坐标代替页面控件完成投递。
  if (platform !== 'job51') assert.doesNotMatch(source, /mouse\.click/)
  assert.doesNotMatch(source, /\.click\(\)/)
  assert.match(source, /clickElementHandle/)
}

assert.equal(fs.existsSync(path.join(srcDir, 'cityGroup.mjs')), false)

console.log('Platform adapter smoke test passed')

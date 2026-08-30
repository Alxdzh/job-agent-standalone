// =====================================================================
// BOSS 直聘适配器 — 包装现有 src/boss.mjs（不改动其实现，零回归）
// =====================================================================
import * as boss from '../boss.mjs'
import { launchPlatform, getPage, safeEval } from '../browser.mjs'
import { readPlatformConfig } from './index.mjs'

const adapter = {
  platform: 'boss',
  homeUrl: boss.BOSS_HOME,
  configName: 'boss.json',
  capabilities: { delivery: true, replies: false },

  async launch() {
    await launchPlatform({ platform: 'boss', homeUrl: boss.BOSS_HOME, cookiesFileName: 'boss-cookies.json' })
  },

  async getLoginDiagnostics() {
    try {
      const page = getPage()
      if (!page) return { loggedIn: false, reason: 'no_page' }
      // Boss's newer page no longer exposes the old user-info class used by
      // getState(). Use the visible page shell plus its login overlay instead.
      return await safeEval(() => {
        const body = document.body?.innerText || ''
        const loginLayer = document.querySelector('.login-qrcode, .qrcode-content, .captcha, .verify')
        const loginText = /登录\/注册|扫码登录|手机号登录|密码登录|立即登录/.test(body)
        const appShell = document.querySelector('.page-jobs-main, .job-list-container, .job-card-box, .job-card-wrap')
        const loggedIn = !!appShell && !loginLayer && !loginText
        return { loggedIn, url: location.href, title: document.title || '', bodyLen: body.length, appShell: !!appShell, loginLayer: !!loginLayer, loginText }
      })
    } catch {
      return { loggedIn: false, reason: 'page_eval_failed' }
    }
  },

  async isLoggedIn() {
    return !!(await this.getLoginDiagnostics()).loggedIn
  },

  async searchJobs(keyword, cityName) {
    return boss.searchJobs(keyword, cityName)
  },

  async readJobDetail(index) {
    const r = await boss.getJobDetail(index)
    return r
  },

  async apply(job) {
    return boss.sendResume(job?.jobId || '')
  },

  async detectRiskSignal() {
    return boss.detectRiskSignal?.() || null
  },

  async jobLink(jobId) {
    return jobId ? `https://www.zhipin.com/web/geek/job?jobId=${jobId}` : ''
  },

  async backToHome() {
    // 恢复岗位页也必须走页面上的可见导航；BOSS_HOME 只用于首次启动浏览器。
    return boss.openJobsPage()
  },

  // full hunt orchestration reused from boss.mjs (platform-specific apply flow inside)
  async autoHunt(opts) {
    const config = readPlatformConfig('boss') || {}
    return boss.autoHunt({ ...opts, platformConfig: config })
  }
}

export default adapter

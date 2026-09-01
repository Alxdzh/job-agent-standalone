import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig } from './llm.mjs'

const CONFIG_DIR = process.env.JOB_AGENT_CONFIG_DIR || path.join(os.homedir(), '.job-agent', 'config')
const SUPPORTED_PLATFORMS = ['boss', 'zhilian', 'job51', 'liepin']

function asKeywords(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean).slice(0, 30)
  if (typeof value === 'string') return value.split(/[|,，、\n；;]/).map(v => v.trim()).filter(Boolean).slice(0, 30)
  return []
}

function normalizePlatform(platform) {
  return String(platform || 'boss').trim().toLowerCase() || 'boss'
}

export function readDeliveryConfig(platform = 'boss') {
  const name = normalizePlatform(platform)
  if (name === 'all') {
    return {
      platform: 'all',
      platforms: SUPPORTED_PLATFORMS.map(item => readDeliveryConfig(item))
    }
  }
  const cfg = readConfig(`${name}.json`) || null
  const keywords = ((cfg?.jobSourceList || [])
    .flatMap(source => source?.children || [])
    .filter(child => child?.type === 'search-kw' && child.enabled !== false)
    .map(child => String(child.keyword || '').trim())
    .filter(Boolean))
  return {
    platform: name,
    exists: !!cfg,
    enabled: cfg ? cfg.enabled !== false : false,
    city: cfg?.daemonCity || (Array.isArray(cfg?.expectCityList) && cfg.expectCityList[0]) || '',
    salaryMin: Number(cfg?.expectSalaryLow ?? 0) || 0,
    keywords,
    exclusions: {
      company: cfg?.blockCompanyNameRegExpStr || '',
      jobRisk: cfg?.blockJobRiskKeywordsRegExpStr || ''
    }
  }
}

// 只改平台投递配置，不处理密钥、Cookie 或投递资料文本；投递资料由
// delivery-materials.mjs 单独维护，避免和平台配置混在一起。
export function updateDeliveryConfig(updates = {}) {
  const platform = normalizePlatform(updates.platform)
  if (platform === 'all') {
    const results = SUPPORTED_PLATFORMS.map(item => updateDeliveryConfig({ ...updates, platform: item }))
    return {
      ok: results.every(result => result.ok !== false),
      platform: 'all',
      configs: results.map((result, index) => result.config || readDeliveryConfig(SUPPORTED_PLATFORMS[index]))
    }
  }
  if (!SUPPORTED_PLATFORMS.includes(platform)) return { ok: false, reason: 'platform_disabled', platform }
  const cfg = readConfig(`${platform}.json`) || {
    enabled: false,
    daemonCity: '',
    expectCityList: [],
    expectSalaryLow: 0,
    expectJobNameRegExpStr: '',
    jobSourceList: [{ type: 'search', enabled: true, children: [] }]
  }
  const has = key => Object.prototype.hasOwnProperty.call(updates, key)
  if (has('enabled')) cfg.enabled = updates.enabled === true
  if (has('city')) {
    const city = String(updates.city || '').trim()
    cfg.daemonCity = city
    cfg.expectCityList = city ? [city] : []
  }
  if (has('salaryMin')) {
    const value = Number(updates.salaryMin)
    if (!Number.isFinite(value) || value < 0 || value > 1000) return { ok: false, reason: 'salaryMin_invalid' }
    cfg.expectSalaryLow = value
  }
  if (has('keywords')) {
    const keywords = asKeywords(updates.keywords)
    cfg.jobSourceList = [{ type: 'search', enabled: true, children: keywords.map(keyword => ({ type: 'search-kw', enabled: true, keyword })) }]
    cfg.expectJobNameRegExpStr = keywords.join('|')
  }
  if (has('companyExclusions')) cfg.blockCompanyNameRegExpStr = String(updates.companyExclusions || '').trim()
  if (has('jobRiskExclusions')) cfg.blockJobRiskKeywordsRegExpStr = String(updates.jobRiskExclusions || '').trim()
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(path.join(CONFIG_DIR, `${platform}.json`), JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true, config: readDeliveryConfig(platform) }
  } catch (err) {
    return { ok: false, reason: err?.message || 'config_write_failed' }
  }
}

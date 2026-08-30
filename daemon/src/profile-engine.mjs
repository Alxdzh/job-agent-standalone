import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from './store.mjs'
import { llmComplete, readConfig } from './llm.mjs'

const CONFIG_DIR = process.env.GEEK_GEEK_RUN_CONFIG || path.join(os.homedir(), '.geekgeekrun', 'config')
// 资料中的长期方向同步到所有已经存在的平台注册配置；没有配置文件的平台
// 保持未启用，不会因为用户填写资料而意外启动。
const PLATFORM_FILES = ['boss', 'zhilian', 'job51', 'liepin']

function asList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[|,，、\n；;]/).map(v => v.trim()).filter(Boolean)
  return []
}

function legacyProfile() {
  const cfg = readConfig('boss.json') || {}
  const roles = asList(cfg.expectJobNameRegExpStr)
  const cities = asList(cfg.expectCityList || cfg.daemonCity)
  return {
    cities, city: cities[0] || '', targetRoles: roles,
    salaryMin: Number(cfg.expectSalaryLow || 0) || null,
    restPreference: '', benefitsPreference: '',
    source: 'platform-config-migration'
  }
}

export function normalizeProfilePatch(patch = {}) {
  const p = patch || {}
  const next = {}
  const aliases = {
    name: 'displayName', displayName: 'displayName', headline: 'headline', summary: 'summary',
    education: 'education', experience: 'experience', skills: 'skills', targetRoles: 'targetRoles', activeTargetRoles: 'activeTargetRoles',
    roles: 'targetRoles', activeRoles: 'activeTargetRoles', cities: 'cities', city: 'city', salaryMin: 'salaryMin', salaryMax: 'salaryMax',
    restPreference: 'restPreference', benefitsPreference: 'benefitsPreference', workMode: 'workMode',
    portfolioStatus: 'portfolioStatus', constraints: 'constraints', notes: 'notes'
  }
  for (const [key, value] of Object.entries(p)) {
    const target = aliases[key]
    if (!target || value === undefined || value === null) continue
    next[target] = Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean) : String(value).trim()
  }
  if (next.city && !next.cities) next.cities = [next.city]
  if (next.cities && !next.city) next.city = next.cities[0] || ''
  for (const k of ['salaryMin', 'salaryMax']) {
    if (next[k] !== undefined) next[k] = Number(next[k]) || null
  }
  return next
}

export function getUserProfile(ownerId = 'default') {
  const existing = store.getUserProfile(ownerId)
  if (existing) return existing
  if (String(ownerId || 'default') === 'default') return store.upsertUserProfile('default', legacyProfile())
  return { ownerId: String(ownerId), cities: [], targetRoles: [], salaryMin: null, updatedAt: null }
}

export function effectiveTargetRoles(profile = {}) {
  const active = asList(profile.activeTargetRoles)
  return active.length ? active : asList(profile.targetRoles || profile.roles)
}

export function profileSummary(ownerId = 'default') {
  const p = getUserProfile(ownerId)
  return JSON.stringify({
    name: p.displayName || '', headline: p.headline || '', summary: p.summary || '',
    education: p.education || '', experience: p.experience || '', skills: p.skills || [],
    targetRoles: effectiveTargetRoles(p),
    defaultTargetRoles: asList(p.targetRoles || p.roles),
    activeTargetRoles: asList(p.activeTargetRoles),
    cities: p.cities || (p.city ? [p.city] : []),
    salaryMin: p.salaryMin ?? null, salaryMax: p.salaryMax ?? null,
    restPreference: p.restPreference || '', benefitsPreference: p.benefitsPreference || '',
    workMode: p.workMode || '', portfolioStatus: p.portfolioStatus || '', constraints: p.constraints || '',
    notes: p.notes || ''
  })
}

function parseObject(raw) {
  const cleaned = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {} }
  return null
}

export async function recommendCareerSetup({ ownerId = 'default', question = '', preferences = '' } = {}) {
  const profile = profileSummary(ownerId)
  const prompt = `你是专业求职顾问。根据求职者资料和他的补充描述，给出可执行、克制的求职方向与城市建议，不要编造经历。
求职者资料：${profile}
补充描述：${String(question || preferences || '请帮我看看适合什么方向和城市').slice(0, 4000)}
只输出 JSON：{"directions":[{"name":"方向","reason":"依据真实经历的理由","fit":"高|中|低","searchTerms":["关键词"]}],"cities":[{"name":"城市","reason":"理由","tradeoff":"代价或限制"}],"questions":["还需要确认的问题"]}`
  try {
    const raw = await llmComplete([{ role: 'user', content: prompt }], { maxTokens: 1400, temperature: 0.45 })
    return { ok: true, ...(parseObject(raw) || { raw: String(raw || '').trim() }) }
  } catch (err) {
    return { ok: false, reason: err?.message || '推荐失败' }
  }
}

export function updateUserProfile({ ownerId = 'default', patch = {}, confirm = false, applyPlatforms = false } = {}) {
  if (confirm !== true) return { ok: false, requiresConfirmation: true, reason: '这是资料写入操作，请用户明确确认后再保存。', proposed: normalizeProfilePatch(patch) }
  const profile = store.upsertUserProfile(ownerId, normalizeProfilePatch(patch))
  const platformResult = applyPlatforms ? syncProfileToPlatforms(profile) : { ok: true, skipped: true }
  return { ok: true, profile, platformResult }
}

// 自然语言明确提出的求职指令由 Agent 直接调用；这是“用户已授权的配置动作”，
// 不再把用户逼回设置页，也不要求再确认一次。active 只切换当前投递方向，
// default 才会覆盖长期默认方向。
export function applyDeliveryPreferences({ ownerId = 'default', patch = {}, scope = 'active', applyPlatforms = true } = {}) {
  const normalized = normalizeProfilePatch(patch)
  const next = { ...normalized }
  if (scope === 'active' && normalized.targetRoles) {
    next.activeTargetRoles = normalized.targetRoles
    delete next.targetRoles
  }
  if (scope === 'default' && normalized.targetRoles) {
    next.activeTargetRoles = []
  }
  const profile = store.upsertUserProfile(ownerId, next)
  const platformResult = applyPlatforms ? syncProfileToPlatforms(profile) : { ok: true, skipped: true }
  return { ok: true, scope: scope === 'default' ? 'default' : 'active', profile, platformResult, effectiveTargetRoles: effectiveTargetRoles(profile) }
}

export function syncProfileToPlatforms(profile, platforms = PLATFORM_FILES) {
  const p = profile || {}
  const cities = asList(p.cities || p.city)
  const roles = effectiveTargetRoles(p)
  const updated = []
  for (const name of platforms) {
    const file = path.join(CONFIG_DIR, `${name}.json`)
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (cities.length) { cfg.daemonCity = cities[0]; cfg.expectCityList = cities }
    if (p.salaryMin !== undefined && p.salaryMin !== null) cfg.expectSalaryLow = Number(p.salaryMin) || 0
    if (roles.length) {
      cfg.expectJobNameRegExpStr = roles.join('|')
      cfg.jobSourceList = [{ type: 'search', enabled: true, children: roles.map(keyword => ({ type: 'search-kw', enabled: true, keyword })) }]
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
    updated.push(name)
  }
  return { ok: true, updatedPlatforms: updated }
}

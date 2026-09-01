import * as store from './store.mjs'

const PROFILE_ALIASES = Object.freeze({
  jdProfile: 'jdProfile',
  profile: 'jdProfile',
  // 保留旧 MCP/工作台调用的兼容入口；新资料统一落到一个文本框。
  summary: 'jdProfile'
})
const LEGACY_PROFILE_FIELDS = [
  'summary', 'education', 'experience', 'skills',
  'restPreference', 'benefitsPreference', 'workMode', 'constraints'
]
const HIDDEN_LEGACY_FIELDS = [
  'targetRoles', 'activeTargetRoles', 'roles', 'cities', 'city', 'salaryMin', 'salaryMax',
  'displayName', 'headline', 'portfolioStatus', 'notes', ...LEGACY_PROFILE_FIELDS
]

function legacyJdProfile(profile) {
  const labels = [
    ['个人概述', profile.summary],
    ['详细经历', profile.experience],
    ['教育背景', profile.education],
    ['技能关键词', profile.skills],
    ['休息与工时偏好', profile.restPreference],
    ['福利偏好', profile.benefitsPreference],
    ['工作方式', profile.workMode],
    ['其他限制', profile.constraints]
  ]
  return labels
    .filter(([, value]) => Array.isArray(value) ? value.length : String(value || '').trim())
    .map(([label, value]) => `${label}：${Array.isArray(value) ? value.join('、') : String(value).trim()}`)
    .join('\n')
    .slice(0, 4000)
}

function publicProfile(profile) {
  if (!profile) return profile
  const clean = { ...profile }
  const hasCompactProfile = Object.prototype.hasOwnProperty.call(profile, 'jdProfile')
  clean.jdProfile = hasCompactProfile ? String(profile.jdProfile || '') : legacyJdProfile(profile)
  for (const field of HIDDEN_LEGACY_FIELDS) delete clean[field]
  return clean
}

export function normalizeProfilePatch(patch = {}) {
  const next = {}
  for (const [key, value] of Object.entries(patch || {})) {
    const target = PROFILE_ALIASES[key]
    if (!target || value === undefined || value === null) continue
    next[target] = Array.isArray(value)
      ? value.map(item => String(item || '').trim()).filter(Boolean)
      : String(value).trim()
  }
  return next
}
export function getUserProfile(ownerId = 'default') {
  const id = String(ownerId || 'default').trim().slice(0, 160) || 'default'
  const existing = store.getUserProfile(id)
  if (existing) return publicProfile(existing)
  if (id === 'default') return publicProfile(store.upsertUserProfile(id, { source: 'manual' }))
  return { ownerId: id, updatedAt: null }
}

export function updateUserProfile({ ownerId = 'default', patch = {}, confirm = false } = {}) {
  const proposed = normalizeProfilePatch(patch)
  if (confirm !== true) {
    return {
      ok: false,
      requiresConfirmation: true,
      reason: '这是资料写入操作，请用户明确确认后再保存。',
      proposed
    }
  }
  return { ok: true, profile: publicProfile(store.upsertUserProfile(ownerId, proposed)) }
}

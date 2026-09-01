import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from './store.mjs'

const CONFIG_DIR = process.env.JOB_AGENT_CONFIG_DIR || path.join(os.homedir(), '.job-agent', 'config')
const MATERIALS_FILE = path.join(CONFIG_DIR, 'delivery-materials.json')
export const MAX_DELIVERY_MATERIALS_LENGTH = 20000

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_DELIVERY_MATERIALS_LENGTH)
}

function legacyProfileText(profile) {
  if (!profile) return ''
  if (Object.prototype.hasOwnProperty.call(profile, 'jdProfile')) return normalizeText(profile.jdProfile)
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
  return normalizeText(labels
    .filter(([, value]) => Array.isArray(value) ? value.length : String(value || '').trim())
    .map(([label, value]) => `${label}：${Array.isArray(value) ? value.join('、') : String(value).trim()}`)
    .join('\n'))
}

export function readDeliveryMaterials() {
  try {
    const saved = JSON.parse(fs.readFileSync(MATERIALS_FILE, 'utf8'))
    return {
      text: normalizeText(saved?.text),
      updatedAt: String(saved?.updatedAt || '')
    }
  } catch {
    try {
      const profile = store.getUserProfile('default')
      return { text: legacyProfileText(profile), updatedAt: String(profile?.updatedAt || '') }
    } catch {
      return { text: '', updatedAt: '' }
    }
  }
}

export function saveDeliveryMaterials(value = '') {
  const result = { text: normalizeText(value), updatedAt: new Date().toISOString() }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(MATERIALS_FILE, JSON.stringify(result, null, 2), 'utf8')
  return result
}

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG_DIR = process.env.GEEK_GEEK_RUN_CONFIG || path.join(os.homedir(), '.geekgeekrun', 'config')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'workbench.json')

const DEFAULTS = {
  silentMode: false,
  deliveryWindow: {
    start: '09:00',
    end: '21:00'
  },
  pacing: {
    batchCountMin: 4,
    batchCountMax: 8,
    batchRestMinMinutes: 15,
    batchRestMaxMinutes: 30,
    applicationGapMinSeconds: 75,
    applicationGapMaxSeconds: 150
  }
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) || {} } catch { return {} }
}

function finiteNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normaliseTime(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function normaliseDeliveryWindow(raw = {}) {
  return {
    start: normaliseTime(raw.start, DEFAULTS.deliveryWindow.start),
    end: normaliseTime(raw.end, DEFAULTS.deliveryWindow.end)
  }
}

function normaliseRange(raw, minKey, maxKey, { floor, ceiling, fallbackMin, fallbackMax }) {
  const min = Math.min(ceiling - 1, Math.max(floor, Math.round(finiteNumber(raw?.[minKey], fallbackMin))))
  const maxCandidate = Math.min(ceiling, Math.max(floor + 1, Math.round(finiteNumber(raw?.[maxKey], fallbackMax))))
  if (maxCandidate <= min) {
    return { [minKey]: Math.max(floor, Math.min(ceiling - 1, min - 1)), [maxKey]: min }
  }
  return { [minKey]: min, [maxKey]: maxCandidate }
}

export function normalisePacing(raw = {}) {
  return {
    ...normaliseRange(raw, 'batchCountMin', 'batchCountMax', { floor: 2, ceiling: 30, fallbackMin: DEFAULTS.pacing.batchCountMin, fallbackMax: DEFAULTS.pacing.batchCountMax }),
    ...normaliseRange(raw, 'batchRestMinMinutes', 'batchRestMaxMinutes', { floor: 5, ceiling: 180, fallbackMin: DEFAULTS.pacing.batchRestMinMinutes, fallbackMax: DEFAULTS.pacing.batchRestMaxMinutes }),
    ...normaliseRange(raw, 'applicationGapMinSeconds', 'applicationGapMaxSeconds', { floor: 45, ceiling: 900, fallbackMin: DEFAULTS.pacing.applicationGapMinSeconds, fallbackMax: DEFAULTS.pacing.applicationGapMaxSeconds })
  }
}

function assertPacingRange(pacing = {}) {
  const pairs = [
    ['batchCountMin', 'batchCountMax'],
    ['batchRestMinMinutes', 'batchRestMaxMinutes'],
    ['applicationGapMinSeconds', 'applicationGapMaxSeconds']
  ]
  for (const [minKey, maxKey] of pairs) {
    if (!(Number(pacing[minKey]) < Number(pacing[maxKey]))) {
      throw new Error(`节奏设置必须是范围：${minKey} 必须小于 ${maxKey}`)
    }
  }
}

function mergeSettings(raw = {}) {
  const base = cloneDefaults()
  const {
    agentMode: _ignoredAgentMode,
    channels: _ignoredChannels,
    desktopNotifications: _ignoredDesktopNotifications,
    ...saved
  } = raw || {}
  return {
    ...base,
    ...saved,
    deliveryWindow: normaliseDeliveryWindow({ ...base.deliveryWindow, ...(saved.deliveryWindow || {}) }),
    pacing: normalisePacing({ ...base.pacing, ...(saved.pacing || {}) })
  }
}

export function readWorkbenchSettings() {
  return mergeSettings(readRaw())
}

export function updateWorkbenchSettings(patch = {}) {
  const raw = readRaw()
  const next = mergeSettings({
    ...raw,
    ...patch,
    deliveryWindow: { ...raw.deliveryWindow, ...(patch.deliveryWindow || {}) },
    pacing: { ...raw.pacing, ...(patch.pacing || {}) }
  })
  if (patch.pacing) assertPacingRange(next.pacing)
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  return next
}

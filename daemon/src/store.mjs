import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.BOSS_DAEMON_STATE || path.join(__dirname, '..', 'state')
const DB_FILE = path.join(STATE_DIR, 'boss-daemon.db')
try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch {}

const db = new DatabaseSync(DB_FILE)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, time TEXT NOT NULL, platform TEXT, jobId TEXT, jobName TEXT,
  salaryDesc TEXT, brandName TEXT, cityName TEXT, postDescription TEXT, reason TEXT,
  sent INTEGER DEFAULT 0, extra TEXT
); CREATE INDEX IF NOT EXISTS idx_apps_brand ON applications(brandName);
CREATE INDEX IF NOT EXISTS idx_apps_jobid ON applications(jobId);
CREATE INDEX IF NOT EXISTS idx_apps_time ON applications(time);`)

// 用户资料与简历版本：每个部署可以服务不同 owner，资料不再写死在 Agent 提示词里。
db.exec(`CREATE TABLE IF NOT EXISTS user_profiles (
  ownerId TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT, platform TEXT, version INTEGER DEFAULT 1,
  content TEXT, status TEXT DEFAULT 'draft', source TEXT, baseResumeId TEXT,
  createdAt TEXT, updatedAt TEXT, extra TEXT
); CREATE INDEX IF NOT EXISTS idx_resumes_owner ON resumes(ownerId, updatedAt);
CREATE INDEX IF NOT EXISTS idx_resumes_platform ON resumes(ownerId, platform);
CREATE TABLE IF NOT EXISTS runtime_state (
  stateKey TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT NOT NULL
);`)

function now() { return new Date().toISOString() }
function safeParse(s, f) { try { return JSON.parse(s) } catch { return f } }

function migrateFromJson() {
  let cnt = 0
  try { cnt = db.prepare('SELECT COUNT(*) c FROM applications').get().c } catch { return }
  if (cnt > 0) return
  // applications
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'applications.json'), 'utf-8') || '[]')
    if (Array.isArray(raw) && raw.length) {
      const ins = db.prepare(`INSERT OR IGNORE INTO applications (id,time,platform,jobId,jobName,salaryDesc,brandName,cityName,postDescription,reason,sent,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const a of raw) {
        ins.run(a.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, a.time || now(), a.platform || null,
          a.jobId || null, a.jobName || null, a.salaryDesc || null, a.brandName || null, a.cityName || null,
          a.postDescription || null, a.reason || null, a.sent ? 1 : 0, a.extra ? JSON.stringify(a.extra) : null)
      }
      console.log(`[store-sqlite] 迁移 applications: ${raw.length} 条`)
    }
  } catch (err) { console.error(`[store-sqlite] 迁移 applications 失败: ${err?.message}`) }
}
migrateFromJson()

// ---------- applications ----------
export function addApplication(record) {
  const a = record || {}
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  db.prepare(`INSERT OR IGNORE INTO applications (id,time,platform,jobId,jobName,salaryDesc,brandName,cityName,postDescription,reason,sent,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, a.time || now(), a.platform || null, a.jobId || null, a.jobName || null,
      a.salaryDesc || null, a.brandName || null, a.cityName || null, a.postDescription || null,
      a.reason || null, a.sent ? 1 : 0, a.extra ? JSON.stringify(a.extra) : null)
  return id
}
function rowToApp(r) {
  return { id: r.id, time: r.time, platform: r.platform, jobId: r.jobId, jobName: r.jobName,
    salaryDesc: r.salaryDesc, brandName: r.brandName, cityName: r.cityName,
    postDescription: r.postDescription, reason: r.reason, sent: !!r.sent,
    ...(r.extra ? safeParse(r.extra, {}) : {}) }
}
export function listApplications({ limit = 50, platform } = {}) {
  const rows = platform
    ? db.prepare(`SELECT * FROM applications WHERE platform = ? ORDER BY time DESC LIMIT ?`).all(platform, limit)
    : db.prepare(`SELECT * FROM applications ORDER BY time DESC LIMIT ?`).all(limit)
  return rows.map(rowToApp)
}
export function hasCompanyBeenApplied(brandName) {
  if (!brandName) return false
  return !!db.prepare(`SELECT 1 FROM applications WHERE lower(brandName) = lower(?) LIMIT 1`).get(brandName)
}
export function hasJobBeenApplied(jobId) {
  if (!jobId) return false
  return !!db.prepare(`SELECT 1 FROM applications WHERE jobId = ? LIMIT 1`).get(jobId)
}


// ---------- user profile / resumes ----------
function normalizeOwnerId(ownerId) { return String(ownerId || 'default').trim().slice(0, 160) || 'default' }
function rowToProfile(row) {
  if (!row) return null
  return { ownerId: row.ownerId, ...(safeParse(row.data, {})), updatedAt: row.updatedAt }
}
export function getUserProfile(ownerId = 'default') {
  const row = db.prepare(`SELECT * FROM user_profiles WHERE ownerId=?`).get(normalizeOwnerId(ownerId))
  return rowToProfile(row)
}
export function upsertUserProfile(ownerId = 'default', patch = {}) {
  const id = normalizeOwnerId(ownerId)
  const current = getUserProfile(id) || { ownerId: id }
  const next = { ...current, ...(patch || {}), ownerId: id, updatedAt: now() }
  delete next.data
  const data = { ...next }
  delete data.ownerId
  delete data.updatedAt
  db.prepare(`INSERT INTO user_profiles (ownerId,data,updatedAt) VALUES (?,?,?)
    ON CONFLICT(ownerId) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt`)
    .run(id, JSON.stringify(data), next.updatedAt)
  return getUserProfile(id)
}
function rowToResume(row) {
  if (!row) return null
  return {
    id: row.id, ownerId: row.ownerId, name: row.name || '', platform: row.platform || 'all',
    version: row.version || 1, content: row.content || '', status: row.status || 'draft',
    source: row.source || '', baseResumeId: row.baseResumeId || '', createdAt: row.createdAt,
    updatedAt: row.updatedAt, ...(row.extra ? safeParse(row.extra, {}) : {})
  }
}
export function listResumes({ ownerId = 'default', platform, limit = 50 } = {}) {
  const id = normalizeOwnerId(ownerId)
  const rows = platform
    ? db.prepare(`SELECT * FROM resumes WHERE ownerId=? AND (platform=? OR platform='all') ORDER BY updatedAt DESC LIMIT ?`).all(id, platform, limit)
    : db.prepare(`SELECT * FROM resumes WHERE ownerId=? ORDER BY updatedAt DESC LIMIT ?`).all(id, limit)
  return rows.map(rowToResume)
}
export function getResume(id, ownerId = 'default') {
  return rowToResume(db.prepare(`SELECT * FROM resumes WHERE id=? AND ownerId=?`).get(String(id || ''), normalizeOwnerId(ownerId)))
}
export function saveResume(record = {}) {
  const ownerId = normalizeOwnerId(record.ownerId)
  const id = String(record.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const existing = getResume(id, ownerId)
  const createdAt = existing?.createdAt || now()
  const updatedAt = now()
  const version = Number(record.version || existing?.version || 0) + (existing ? 1 : 0)
  const extra = { ...(existing || {}), ...(record.extra || {}) }
  for (const k of ['id','ownerId','name','platform','version','content','status','source','baseResumeId','createdAt','updatedAt','extra']) delete extra[k]
  db.prepare(`INSERT INTO resumes (id,ownerId,name,platform,version,content,status,source,baseResumeId,createdAt,updatedAt,extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,version=excluded.version,
      content=excluded.content,status=excluded.status,source=excluded.source,baseResumeId=excluded.baseResumeId,
      updatedAt=excluded.updatedAt,extra=excluded.extra`)
    .run(id, ownerId, record.name ?? existing?.name ?? '未命名简历', record.platform ?? existing?.platform ?? 'all',
      version, record.content ?? existing?.content ?? '', record.status ?? existing?.status ?? 'draft',
      record.source ?? existing?.source ?? 'agent', record.baseResumeId ?? existing?.baseResumeId ?? '',
      createdAt, updatedAt, JSON.stringify(extra))
  return getResume(id, ownerId)
}

// 运行诊断单独放在 SQLite 中；默认状态查询只读摘要，用户追问时再读取详情。
export function saveRuntimeState(stateKey = 'worker', data = {}) {
  const key = String(stateKey || 'worker')
  db.prepare(`INSERT INTO runtime_state (stateKey,data,updatedAt) VALUES (?,?,?)
    ON CONFLICT(stateKey) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt`)
    .run(key, JSON.stringify(data || {}), now())
  return { stateKey: key, updatedAt: now() }
}

export function getRuntimeState(stateKey = 'worker') {
  const row = db.prepare(`SELECT * FROM runtime_state WHERE stateKey=?`).get(String(stateKey || 'worker'))
  if (!row) return null
  return { stateKey: row.stateKey, updatedAt: row.updatedAt, ...(safeParse(row.data, {})) }
}

// ---------- stats ----------
export function getStats() {
  const today = new Date().toISOString().slice(0, 10)
  const apps = db.prepare(`SELECT COUNT(*) c FROM applications`).get().c
  const todayApps = db.prepare(`SELECT COUNT(*) c FROM applications WHERE substr(time,1,10) = ?`).get(today).c
  const byPlatform = {}
  for (const r of db.prepare(`SELECT platform, COUNT(*) c FROM applications GROUP BY platform`).all()) {
    byPlatform[r.platform || '?'] = r.c
  }
  return { totalApplied: apps, todayApplied: todayApps, byPlatform }
}

export function getIndustryStats() {
  const keywordToIndustry = [
    { kw: /AIGC|AI内容|AI编剧|内容编导|编剧|短剧|漫剧/, name: 'AI内容/短剧' },
    { kw: /内容运营|新媒体|内容编辑|文案|编辑|运营/, name: '内容/新媒体运营' },
    { kw: /讲师|培训|训练师|教师/, name: 'AI培训讲师' },
    { kw: /产品经理/, name: '产品经理' },
    { kw: /剪辑|动画|设计|生图|视频|插画/, name: 'AI视觉/视频' },
    { kw: /单证|外贸|跨境|海运|货代|报关/, name: '外贸/物流' },
    { kw: /销售|客服|行政|助理|文员/, name: '销售/行政' }
  ]
  const buckets = {}
  for (const r of db.prepare(`SELECT jobName, brandName FROM applications`).all()) {
    const name = (r.jobName || '') + (r.brandName || '')
    const matched = keywordToIndustry.find(k => k.kw.test(name))
    const bucket = matched ? matched.name : '其他'
    buckets[bucket] = (buckets[bucket] || 0) + 1
  }
  return Object.entries(buckets).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

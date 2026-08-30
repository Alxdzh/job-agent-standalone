import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import * as store from './store.mjs'

const CONFIG_DIR = process.env.GEEK_GEEK_RUN_CONFIG || path.join(os.homedir(), '.geekgeekrun', 'config')

// 仅作为接口不提供 /models 时的兜底候选；实际支持的列表优先从当前接口读取。
// 保留当前项目曾使用过的值，避免升级后把已有配置改成另一个模型。
export const FALLBACK_LLM_MODELS = [
  'MiMo V2.5',
  'mimo-v2.5',
  'mimo-v2-flash',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'gpt-4o-mini',
  'qwen-plus',
  'deepseek-chat'
]

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

export function readConfig(fileName) {
  return readJson(path.join(CONFIG_DIR, fileName))
}

export function getLlmConfig() {
  const list = readConfig('llm.json') || []
  // 只有用户明确启用的云端模型配置才可用于实际请求；模板中的空白首项
  // 不能被误当成可用模型，从而把 undefined URL/密钥拿去发请求。
  return list.find(it => it?.enabled === true) || null
}

export function normalizeApiBaseUrl(value) {
  let base = String(value || '').trim().replace(/\/+$/, '')
  // 设置页允许用户粘贴完整的 /chat/completions 地址，统一成接口根地址，
  // 避免请求时拼出 /chat/completions/chat/completions。
  base = base.replace(/\/chat\/completions\/?$/i, '')
  return base.replace(/\/+$/, '')
}

function mergeLlmConfig(patch = {}) {
  const saved = getLlmConfig() || {}
  const next = { ...saved }
  for (const key of ['providerCompleteApiUrl', 'providerApiSecret', 'model']) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  return next
}

function validateLlmConfig(conf, { requireModel = true } = {}) {
  const base = normalizeApiBaseUrl(conf?.providerCompleteApiUrl)
  if (!base || !conf?.providerApiSecret || (requireModel && !conf?.model)) {
    throw new Error('用户配置的云端模型 API 未完整填写或未启用（需要接口地址、API Key' + (requireModel ? '、模型' : '') + '）')
  }
  return base
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
    }).join('')
  }
  if (content && typeof content === 'object') {
    return typeof content.text === 'string' ? content.text : typeof content.content === 'string' ? content.content : ''
  }
  return ''
}

// 不同 OpenAI 兼容服务对文本字段的返回略有差异；推理模型还可能把内容放在
// reasoning_content 中。统一提取，避免“接口成功但判定拿到空字符串”。
export function getAssistantText(message) {
  if (!message) return ''
  const fields = [message.content, message.output_text, message.reasoning_content, message.reasoning]
  for (const value of fields) {
    const text = contentToText(value)
    if (text.trim()) return text
  }
  return ''
}

async function requestChat(conf, messages, { maxTokens = 500, temperature = 0.7, tools, toolChoice } = {}) {
  const base = validateLlmConfig(conf)
  const payload = {
    model: conf.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false
  }
  if (Array.isArray(tools) && tools.length) payload.tools = tools
  if (toolChoice) payload.tool_choice = toolChoice
  let res
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${conf.providerApiSecret}`
      },
      body: JSON.stringify(payload)
    })
  } catch (err) {
    throw new Error(`无法连接模型接口 ${base}：${err?.message || String(err)}`)
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`模型接口返回 HTTP ${res.status}（${base}）；${errText.slice(0, 240) || '没有错误详情'}`)
  }
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('模型接口返回的不是有效 JSON')
  }
  const message = data?.choices?.[0]?.message
  if (message) return message
  if (typeof data?.choices?.[0]?.text === 'string') return { role: 'assistant', content: data.choices[0].text }
  if (typeof data?.output_text === 'string') return { role: 'assistant', content: data.output_text }
  throw new Error('模型接口响应缺少 choices[0].message；请检查接口地址、模型 ID 和响应格式')
}

// 标准 OpenAI 兼容对话入口。除普通文本外，保留原始 assistant message，
// 让支持 tools/function calling 的模型可以正确进行多步工具调用。
export async function llmChat(messages, options = {}) {
  return requestChat(getLlmConfig(), messages, options)
}

// 保持旧的文本调用方不受影响；Agent 主循环改用 llmChat 读取 tool_calls。
export async function llmComplete(messages, options = {}) {
  const message = await llmChat(messages, options)
  return getAssistantText(message)
}

export async function testLlmConnection(patch = {}) {
  const conf = mergeLlmConfig(patch)
  const base = validateLlmConfig(conf)
  const message = await requestChat(conf, [{ role: 'user', content: '只回复 OK，不要解释。' }], { maxTokens: 20, temperature: 0 })
  const text = getAssistantText(message)
  if (!text) throw new Error('接口已响应，但响应中没有可读取的文本内容')
  return { ok: true, endpoint: base, model: conf.model, preview: text.replace(/\s+/g, ' ').slice(0, 80) }
}

export async function listLlmModels() {
  const conf = mergeLlmConfig()
  let base
  try { base = validateLlmConfig(conf, { requireModel: false }) } catch (err) {
    return { ok: false, models: [], error: err?.message || String(err), source: 'fallback' }
  }
  try {
    const res = await fetch(`${base}/models`, {
      headers: { 'Authorization': `Bearer ${conf.providerApiSecret}` }
    })
    if (!res.ok) return { ok: false, models: [], error: `接口未提供可读取的模型列表（HTTP ${res.status}）`, source: 'fallback' }
    const data = await res.json()
    const models = Array.isArray(data?.data)
      ? data.data.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean)
      : []
    const unique = [...new Set(models.map(String))].slice(0, 200)
    if (!unique.length) return { ok: false, models: [], error: '接口没有返回可用模型 ID', source: 'fallback' }
    return { ok: true, models: unique, source: 'provider' }
  } catch (err) {
    return { ok: false, models: [], error: `读取接口模型列表失败：${err?.message || String(err)}`, source: 'fallback' }
  }
}

export function parseLlmResponse(raw, field = 'response') {
  try {
    const cleaned = raw.replace(/^```(json)?/m, '').replace(/```$/m, '').trim()
    const obj = JSON.parse(cleaned)
    if (obj && typeof obj[field] === 'string') return obj[field].trim()
    return raw.trim()
  } catch {
    return raw.trim()
  }
}

function balancedObjectAt(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

// 判定模型经常会在 JSON 前后附带 markdown 或 <think> 文本。只提取完整对象，
// 并尊重字符串中的大括号，避免旧的“截到第一个/最后一个大括号”误解析。
export function parseJudgeDecision(raw) {
  const text = String(raw || '').trim()
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const candidate = balancedObjectAt(text, start)
    if (!candidate) continue
    try {
      const obj = JSON.parse(candidate)
      if (!obj || !Object.prototype.hasOwnProperty.call(obj, 'match')) continue
      const match = typeof obj.match === 'boolean' ? obj.match : String(obj.match).toLowerCase() === 'true'
      return { match, reason: typeof obj.reason === 'string' ? obj.reason.trim() : String(obj.reason || '') }
    } catch {}
  }
  return null
}

function judgeProfile(ownerId = 'default') {
  try {
    const p = store.getUserProfile(ownerId) || {}
    // “今天/这次/本轮”写入 activeTargetRoles；岗位判断必须优先使用本轮方向，
    // 否则搜索词虽已切换，LLM 仍会拿长期默认方向把岗位全部判掉。
    const activeRoles = Array.isArray(p.activeTargetRoles) && p.activeTargetRoles.length
      ? p.activeTargetRoles
      : p.targetRoles
    return {
      background: [p.education, p.experience, p.skills, p.summary].flat().filter(Boolean).join('；').slice(0, 1800),
      roles: Array.isArray(activeRoles) ? activeRoles.join('、') : String(activeRoles || ''),
      cities: Array.isArray(p.cities) ? p.cities.join('、') : String(p.city || ''),
      salary: p.salaryMin ?? '', constraints: [p.restPreference, p.benefitsPreference, p.constraints].filter(Boolean).join('；')
    }
  } catch { return { background: '', roles: '', cities: '', salary: '', constraints: '' } }
}

// 根据用户资料和平台配置判断岗位是否匹配，不把某一位用户的经历写死在共享代码中。
export async function llmJudgeJob(job, platformConfig, ownerId = 'default') {
  const config = platformConfig || readConfig('boss.json') || {}
  const profile = judgeProfile(ownerId)
  const keywords = (config.expectJobNameRegExpStr || '').split('|').filter(Boolean)
  const city = profile.cities || (Array.isArray(config.expectCityList) && config.expectCityList[0]) || ''
  const lowSalary = config.expectSalaryLow ?? 5
  const blackCompany = config.blockCompanyNameRegExpStr || '外包|劳务派遣'
  const riskKeywords = config.blockJobRiskKeywordsRegExpStr || '助贷|传销'
  const prompt = `你是我的求职助手。请仔细阅读下面的完整 JD，判断这个岗位是否值得我投递简历。

用户资料：
- 背景：${profile.background || '未填写，请降低判断确定性，不要臆测'}
- 求职方向：${profile.roles || keywords.join('、') || '未填写'}
- 城市：${city || '未填写'}，期望薪资：${profile.salary || lowSalary || '未填写'}
- 休息/福利/其他限制：${profile.constraints || '未填写'}
- 平台规则：公司黑名单「${blackCompany}」；风险关键词「${riskKeywords}」

请重点分析 JD 内容：这个岗位具体做什么？要求什么能力？是否与我背景匹配？是否值得投？
特别关注：岗位是否明确满足用户的限制；没有足够用户资料时，不要把不确定内容当成硬性结论。

岗位信息：
- 职位：${job.jobName || ''}
- 薪资：${job.salaryDesc || ''}
- 公司：${job.brandName || ''}
- 城市：${job.cityName || ''}
- 职位描述（完整 JD）：${(job.postDescription || '').slice(0, 2000)}

请严格按以下 JSON 格式回答，不要输出其他内容。如果你是推理模型，也不要输出 <think>、分析过程、markdown 代码块或额外说明；最终消息只能是一个 JSON 对象：
{"match": true/false, "reason": "一句话理由，说明岗位与我的匹配点或不匹配点"}`

  // LLM 偶发返回空、推理文本或接口瞬时失败 → 重试最多 3 次。
  let lastRaw = ''
  let lastError = null
  let parseFailed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      lastRaw = await llmComplete([{ role: 'user', content: prompt }], { maxTokens: 1500, temperature: 0.3 })
      const decision = parseJudgeDecision(lastRaw)
      if (decision) return decision
      parseFailed = true
      lastError = null
    } catch (err) {
      lastError = err
    }
    if (attempt < 2) {
      console.log(`[llm] 岗位判断${lastError ? '请求失败' : 'JSON 解析失败'}，重试 ${attempt + 1}/3...`)
      await new Promise(r => setTimeout(r, 1500))
    }
  }
  if (parseFailed && !lastError) {
    const preview = String(lastRaw || '').replace(/\s+/g, ' ').slice(0, 180)
    return { match: false, reason: `LLM 判定失败：模型没有返回可解析的 JSON${preview ? `；返回片段：${preview}` : ''}` }
  }
  throw new Error(`模型请求失败：${lastError?.message || '没有收到模型响应'}`)
}

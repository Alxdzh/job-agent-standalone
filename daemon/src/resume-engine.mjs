import * as store from './store.mjs'
import { llmComplete } from './llm.mjs'
import { profileSummary } from './profile-engine.mjs'

function parseObject(raw) {
  const cleaned = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {} }
  return null
}

function plainModelText(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json|markdown)?/gi, '')
    .replace(/```/g, '')
    .trim()
}

export function listUserResumes(ownerId = 'default') { return store.listResumes({ ownerId }) }
export function getUserResume(ownerId = 'default', resumeId = '') {
  return resumeId ? store.getResume(resumeId, ownerId) : store.listResumes({ ownerId, limit: 1 })[0] || null
}

export async function rewriteResume({ ownerId = 'default', resumeId = '', resumeText = '', jd = '', targetPlatform = 'all', goal = '' } = {}) {
  const saved = getUserResume(ownerId, resumeId)
  const source = String(resumeText || saved?.content || '').trim()
  if (!source) return { ok: false, requiresInput: true, reason: '请先粘贴简历正文，或在简历工作台保存一份基础简历。' }
  const prompt = `你是专业求职简历顾问。只基于真实材料改写，不得虚构公司、业绩、技能、证书或项目。针对目标岗位调整重点，保留可核验事实；不确定的信息列为待补充。
求职者资料：${profileSummary(ownerId)}
目标平台：${targetPlatform}
目标岗位 JD：${String(jd || '未提供，请先做通用优化').slice(0, 9000)}
用户要求：${String(goal || '让简历更清晰、更适合目标岗位').slice(0, 2000)}
原始简历：
${source.slice(0, 16000)}
只输出 JSON：{"name":"简历名称","summary":"改写后的职业概述","content":"可直接保存的完整简历正文","changes":["改动说明"],"missingFacts":["需要用户确认或补充的信息"],"platformNotes":"平台填写注意事项"}`
  try {
    const raw = await llmComplete([{ role: 'user', content: prompt }], { maxTokens: 3200, temperature: 0.35 })
    const result = parseObject(raw)
    if (!result?.content) {
      // MiniMax 偶尔会返回完整的 Markdown 正文而不是 JSON；正文仍然可用，不能把它误报成失败。
      const fallbackContent = plainModelText(raw)
      if (fallbackContent.length >= 80 && !/^\s*\{/.test(fallbackContent)) {
        return {
          ok: true,
          name: 'Agent 简历改写草稿',
          summary: '',
          content: fallbackContent,
          changes: ['模型未按结构化格式返回，已保留可读正文供你审阅。'],
          missingFacts: [],
          platformNotes: '保存前请先检查事实、时间和岗位表述。',
          sourceResumeId: saved?.id || resumeId || null,
          targetPlatform
        }
      }
      return { ok: false, reason: '模型没有返回有效的简历正文' }
    }
    return { ok: true, ...result, sourceResumeId: saved?.id || resumeId || null, targetPlatform }
  } catch (err) {
    return { ok: false, reason: err?.message || '简历改写失败' }
  }
}

export function saveResumeVersion({ ownerId = 'default', name = '', content = '', platform = 'all', source = 'agent', baseResumeId = '', confirm = false, status = 'draft' } = {}) {
  if (confirm !== true) return { ok: false, requiresConfirmation: true, reason: '这是简历写入操作，请先展示草稿并得到用户明确确认。' }
  if (!String(content || '').trim()) return { ok: false, reason: '简历正文为空，未保存。' }
  return { ok: true, resume: store.saveResume({ ownerId, name: name || 'Agent 改写版', content, platform, source, baseResumeId, status }) }
}

export async function syncPlatformResume({ ownerId = 'default', resumeId = '', platform = '', confirm = false } = {}) {
  if (confirm !== true) return { ok: false, requiresConfirmation: true, reason: '平台简历同步会修改外部资料，请用户明确确认后再执行。' }
  const resume = getUserResume(ownerId, resumeId)
  if (!resume) return { ok: false, reason: '没有找到可同步的简历版本。' }
  if (!platform) return { ok: false, reason: '请指定平台。' }
  // 平台浏览器适配器尚未提供统一的简历编辑契约；先明确返回状态，避免假装已经改成功。
  return {
    ok: false, status: 'adapter_not_calibrated', platform, resumeId: resume.id,
    reason: `${platform} 的投递适配器目前只有投递能力，平台简历编辑入口还需要单独校准。已保留这份平台定制简历，可在校准后同步。`
  }
}

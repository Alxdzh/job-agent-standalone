import assert from 'node:assert/strict'
import { getAssistantText, normalizeApiBaseUrl, parseJudgeDecision } from '../src/llm.mjs'

assert.equal(normalizeApiBaseUrl('https://example.test/v1/'), 'https://example.test/v1')
assert.equal(normalizeApiBaseUrl('https://example.test/v1/chat/completions'), 'https://example.test/v1')
assert.equal(getAssistantText({ content: [{ type: 'text', text: 'OK' }] }), 'OK')
assert.equal(getAssistantText({ content: '', reasoning_content: '备用文本' }), '备用文本')
assert.deepEqual(
  parseJudgeDecision('<think>分析中</think>\n```json\n{"match":true,"reason":"职责匹配，薪资符合"}\n```'),
  { match: true, reason: '职责匹配，薪资符合' }
)
assert.deepEqual(
  parseJudgeDecision('前置说明 {"match":false,"reason":"JD 中包含 {风险} 关键词"} 后置说明'),
  { match: false, reason: 'JD 中包含 {风险} 关键词' }
)
assert.equal(parseJudgeDecision('模型只输出了一段普通说明'), null)

console.log('[llm-smoke] passed')

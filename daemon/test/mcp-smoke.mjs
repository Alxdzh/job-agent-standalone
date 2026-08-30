import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const daemonDir = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-mcp-smoke-'))
const configDir = path.join(scratch, 'config')
const stateDir = path.join(scratch, 'state')
const logDir = path.join(scratch, 'log')
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'boss.json'), JSON.stringify({
  enabled: false,
  daemonCity: '',
  expectCityList: [],
  expectSalaryLow: 0,
  jobSourceList: [{ type: 'search', enabled: true, children: [] }]
}))
fs.writeFileSync(path.join(configDir, 'llm.json'), JSON.stringify([{ enabled: false, providerCompleteApiUrl: '', providerApiSecret: '', model: '' }]))
fs.writeFileSync(path.join(configDir, 'workbench.json'), JSON.stringify({}))

let transport
try {
  const port = String(24000 + Math.floor(Math.random() * 1000))
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(daemonDir, 'mcp-server.mjs')],
    cwd: daemonDir,
    env: {
      ...process.env,
      GEEK_GEEK_RUN_CONFIG: configDir,
      BOSS_DAEMON_STATE: stateDir,
      JOB_AGENT_LOG_DIR: logDir,
      BOSS_DAEMON_HOST: '127.0.0.1',
      BOSS_DAEMON_PORT: port
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'job-agent-mcp-smoke', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  const names = new Set((listed.tools || []).map(tool => tool.name))
  for (const required of ['job_get_workflow', 'job_get_status', 'job_get_runtime_settings', 'job_update_runtime_settings', 'job_start_hunt', 'job_start_continuous_hunt', 'job_stop_continuous_hunt', 'job_get_delivery_config', 'job_update_delivery_preferences', 'job_list_applications', 'job_get_profile', 'job_list_resumes']) {
    assert.ok(names.has(required), `missing MCP tool: ${required}`)
  }
  for (const removed of ['job_read_new_hr_messages', 'job_list_conversations', 'job_list_pending_replies', 'job_get_reply_context', 'job_create_reply_draft', 'job_send_reply']) {
    assert.ok(!names.has(removed), `removed MCP tool still exposed: ${removed}`)
  }
  const status = await client.callTool({ name: 'job_get_status', arguments: {} })
  const payload = JSON.parse(status.content?.[0]?.text || '{}')
  assert.equal(payload.edition, 'mcp')
  assert.equal(payload.runtime.running, false)
  assert.equal(payload.cloudApi.configured, false)
  const runtimeSettings = await client.callTool({ name: 'job_get_runtime_settings', arguments: {} })
  const runtimePayload = JSON.parse(runtimeSettings.content?.[0]?.text || '{}')
  assert.equal(runtimePayload.deliveryWindow.start, '09:00')
  assert.equal(runtimePayload.deliveryWindow.end, '21:00')
  const updatedRuntime = await client.callTool({
    name: 'job_update_runtime_settings',
    arguments: { deliveryWindow: { start: '08:30', end: '20:30' }, pacing: { batchCountMin: 3, batchCountMax: 7 } }
  })
  const updatedRuntimePayload = JSON.parse(updatedRuntime.content?.[0]?.text || '{}')
  assert.equal(updatedRuntimePayload.ok, true)
  assert.equal(updatedRuntimePayload.deliveryWindow.start, '08:30')
  assert.equal(updatedRuntimePayload.deliveryWindow.end, '20:30')
  assert.equal(updatedRuntimePayload.pacing.batchCountMin, 3)
  assert.equal(updatedRuntimePayload.pacing.batchCountMax, 7)
  const update = await client.callTool({
    name: 'job_update_delivery_preferences',
    arguments: { city: '青岛', targetRoles: ['行政专员'], salaryMin: 5, scope: 'long_term' }
  })
  const updatePayload = JSON.parse(update.content?.[0]?.text || '{}')
  assert.equal(updatePayload.ok, true)
  assert.equal(updatePayload.profile.city, '青岛')
  assert.deepEqual(updatePayload.profile.targetRoles, ['行政专员'])
  const rejectedStart = await client.callTool({ name: 'job_start_hunt', arguments: { maxJobs: 1 } })
  const rejectedPayload = JSON.parse(rejectedStart.content?.[0]?.text || '{}')
  assert.equal(rejectedPayload.reason, 'user_cloud_api_required_for_unattended_batch')
  await client.close()
  console.log('MCP smoke test passed')
} finally {
  try { await transport?.close?.() } catch {}
  fs.rmSync(scratch, { recursive: true, force: true })
}

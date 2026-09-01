import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as store from './store.mjs'
import { getLlmConfig } from './llm.mjs'
import { readDeliveryConfig, updateDeliveryConfig } from './delivery-config.mjs'
import { readWorkbenchSettings, updateWorkbenchSettings } from './workbench-settings.mjs'
import { PLATFORMS, PLATFORM_NAMES, getAdapter, inspectPlatformLogin, listEnabledPlatforms } from './platforms/index.mjs'
import {
  setPaused,
  triggerHunt,
  resumeHunt,
  startContinuousHunt,
  stopContinuousHunt,
  getWorkerSnapshot,
  getRuntimeDiagnostics
} from './worker.mjs'
import { getRuntimeEdition } from './edition.mjs'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false }
const MUTATING = { readOnlyHint: false, destructiveHint: false }
const PLATFORM_OPTIONS = [...PLATFORMS, 'all']
const PLATFORM_ENUM = z.enum(PLATFORM_OPTIONS)

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase()
  return value && value !== 'all' ? value : undefined
}

function asResult(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {})
  }
}

function cloudApiReadiness() {
  const config = getLlmConfig()
  return {
    configured: !!(config?.enabled && config?.providerCompleteApiUrl && config?.providerApiSecret && config?.model),
    model: config?.model || '',
    // 不返回 API 地址之外的敏感内容，更不会返回密钥。
    endpointConfigured: !!config?.providerCompleteApiUrl
  }
}

// MCP 工具只承接投递执行与状态证据；讨论、研究和记忆由接入它的 Agent 提供。
export function createJobMcpServer() {
  const server = new McpServer({ name: 'job-agent-mcp', version: '1.0.0' })

  server.tool(
    'job_get_workflow',
    'Read the job-agent operating rules before changing settings or sending anything. This tool never changes user data.',
    {},
    READ_ONLY,
    async () => asResult({
      edition: getRuntimeEdition(),
      rules: [
        'Do not start applying unless the user explicitly asks to start or apply a stated number of jobs.',
        'Before explaining a failed or stalled delivery, call job_get_status and use the returned plan and browser diagnostics.',
        'Use job_update_delivery_preferences as the only source for city, target roles, salary, and platform filters; saved changes persist to the selected platform or platforms.',
        'Delivery scheduling is per-platform: a platform enters its own cooldown after a random batch, and other ready platforms may run during that cooldown. The daily delivery window stops new jobs after its end time.',
        'The MCP exposes delivery, JD judgment, and status tools; it has no resume, profile, message, or reply tools.',
        'If status is blocked by login, captcha, risk, or city mismatch, ask the user to inspect the visible browser. Do not try to bypass it.'
      ],
      unattendedBatchDecision: 'A background batch uses the user-configured cloud model API to judge JD fit. The external Agent remains responsible for discussion, planning and approval.'
    })
  )

  server.tool(
    'job_get_runtime_settings',
    'Read the workbench runtime settings: visible/silent browser display, random delivery pacing ranges, and the daily delivery time window. This never starts delivery.',
    {},
    READ_ONLY,
    async () => {
      const settings = readWorkbenchSettings()
      return asResult({
        silentMode: settings.silentMode === true,
        deliveryWindow: settings.deliveryWindow,
        pacing: settings.pacing
      })
    }
  )

  server.tool(
    'job_update_runtime_settings',
    'Update the workbench runtime settings without starting delivery. Use a start/end time window and ranges for batch size, batch cooldown, and job gap; fixed single values are rejected by the workbench rules.',
    {
      silentMode: z.boolean().optional(),
      deliveryWindow: z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        end: z.string().regex(/^\d{2}:\d{2}$/).optional()
      }).optional(),
      pacing: z.object({
        batchCountMin: z.number().int().min(2).max(29).optional(),
        batchCountMax: z.number().int().min(3).max(30).optional(),
        batchRestMinMinutes: z.number().int().min(5).max(179).optional(),
        batchRestMaxMinutes: z.number().int().min(6).max(180).optional(),
        applicationGapMinSeconds: z.number().int().min(45).max(899).optional(),
        applicationGapMaxSeconds: z.number().int().min(46).max(900).optional()
      }).optional()
    },
    MUTATING,
    async ({ silentMode, deliveryWindow, pacing }) => {
      const patch = {}
      if (silentMode !== undefined) patch.silentMode = silentMode
      if (deliveryWindow) patch.deliveryWindow = deliveryWindow
      if (pacing) patch.pacing = pacing
      try {
        const next = updateWorkbenchSettings(patch)
        return asResult({
          ok: true,
          silentMode: next.silentMode === true,
          deliveryWindow: next.deliveryWindow,
          pacing: next.pacing
        })
      } catch (err) {
        return asResult({ ok: false, error: err?.message || String(err) }, true)
      }
    }
  )

  server.tool(
    'job_get_status',
    'Get the real execution state: current task target/remaining counts, last decision, browser URL/city/page state, delivery statistics, and cloud API readiness. Use this before making claims about progress.',
    {},
    READ_ONLY,
    async () => {
      const diagnostics = await getRuntimeDiagnostics()
      return asResult({
        edition: getRuntimeEdition(),
        stats: store.getStats(),
        runtime: diagnostics.worker,
        browser: diagnostics.browser,
        enabledPlatforms: listEnabledPlatforms(),
        deliveryConfigs: Object.fromEntries(PLATFORMS.map(platform => [platform, readDeliveryConfig(platform)])),
        cloudApi: cloudApiReadiness()
      })
    }
  )

  server.tool(
    'job_get_delivery_config',
    'Read one platform or all persisted delivery configurations. These values are the source for actual delivery conditions; no browser action is taken.',
    { platform: PLATFORM_ENUM.optional() },
    READ_ONLY,
    async ({ platform = 'boss' }) => asResult({ config: readDeliveryConfig(platform) })
  )

  server.tool(
    'job_update_delivery_preferences',
    'Persist city, target roles, salary, and platform filters directly in the selected platform configuration. This is the only source for delivery conditions; it does not change personal background data or start delivery. Use platform="all" to update every supported platform.',
    {
      platform: PLATFORM_ENUM.optional(),
      city: z.string().optional(),
      targetRoles: z.array(z.string()).optional(),
      salaryMin: z.number().min(0).optional(),
      enabled: z.boolean().optional(),
      companyExclusions: z.string().optional(),
      jobRiskExclusions: z.string().optional()
    },
    MUTATING,
    async ({ platform = 'boss', city, targetRoles, salaryMin, enabled, companyExclusions, jobRiskExclusions }) => {
      const configPatch = { platform }
      if (city !== undefined) configPatch.city = city
      if (targetRoles !== undefined) configPatch.keywords = targetRoles
      if (salaryMin !== undefined) configPatch.salaryMin = salaryMin
      if (enabled !== undefined) configPatch.enabled = enabled
      if (companyExclusions !== undefined) configPatch.companyExclusions = companyExclusions
      if (jobRiskExclusions !== undefined) configPatch.jobRiskExclusions = jobRiskExclusions
      const configResult = updateDeliveryConfig(configPatch)
      return asResult({
        ok: configResult.ok !== false,
        config: configResult.config || configResult.configs || readDeliveryConfig(platform)
      }, configResult.ok === false)
    }
  )

  server.tool(
    'job_start_continuous_hunt',
    'Start an explicit, indefinite delivery loop for one platform or all enabled platforms. It starts only after this tool is called, gives each platform its own random batch and cooldown, rotates to other ready platforms during cooldown, obeys the configured daily delivery window, and stops on a user pause, login/risk block, or explicit stop. It does not accept a fixed job count.',
    {
      platform: PLATFORM_ENUM.optional().describe('Platform id, or all for every enabled platform.'),
      acknowledgeRisk: z.boolean().optional().describe('Set true only after the user has manually inspected and cleared a prior risk/login block.')
    },
    MUTATING,
    async ({ platform = 'all', acknowledgeRisk = false }) => {
      const result = startContinuousHunt({ platform: normalizePlatform(platform), source: 'mcp', acknowledgeRisk })
      return asResult(result, result.ok === false)
    }
  )

  server.tool(
    'job_stop_continuous_hunt',
    'Stop the indefinite BOSS delivery loop immediately before its next job and preserve the current evidence/status. It does not start a new task.',
    { reason: z.string().optional() },
    MUTATING,
    async ({ reason = '' }) => asResult(stopContinuousHunt(reason || '外部 Agent 按用户指令停止持续投递'))
  )

  server.tool(
    'job_start_hunt',
    'Start one explicit delivery task for one platform or all enabled platforms in the background. It never auto-starts merely because the service is running. Unattended JD decisions use the user-configured cloud model API; this tool returns a persisted task plan immediately, then call job_get_status for real progress.',
    {
      maxJobs: z.number().int().min(1).max(200).describe('How many successful applications the user explicitly requested.'),
      platform: PLATFORM_ENUM.optional().describe('Platform id, or all for every enabled platform.'),
      keywords: z.array(z.string()).optional().describe('Use only for an explicitly temporary one-round search override; persistent direction should use job_update_delivery_preferences first.'),
      acknowledgeRisk: z.boolean().optional().describe('Set true only after the user has manually inspected and cleared a prior risk/login block.')
    },
    MUTATING,
    async ({ maxJobs, platform = 'all', keywords, acknowledgeRisk = false }) => {
      const api = cloudApiReadiness()
      if (!api.configured) {
        return asResult({
          ok: false,
          reason: 'user_cloud_api_required_for_unattended_batch',
          message: '自动批量读取 JD 与匹配判断需要用户在独立配置中填写并启用云端模型 API；MCP 宿主的对话模型不会被后台 worker 擅自复用。',
          cloudApi: api
        }, true)
      }
      const result = await triggerHunt(maxJobs, {
        asyncMode: true,
        platform: normalizePlatform(platform),
        keywords: keywords || [],
        source: 'mcp',
        acknowledgeRisk
      })
      return asResult(result, result.ok === false)
    }
  )

  server.tool(
    'job_pause_hunt',
    'Immediately request that the active delivery task stop before its next job. It preserves the target and remaining count for an explicit later resume.',
    { reason: z.string().optional() },
    MUTATING,
    async ({ reason = '' }) => {
      if (workerState.continuous) return asResult(stopContinuousHunt(reason || '外部 Agent 按用户指令暂停持续投递'))
      setPaused(true, reason || '外部 Agent 按用户指令暂停投递')
      return asResult({ ok: true, runtime: getWorkerSnapshot() })
    }
  )

  server.tool(
    'job_resume_hunt',
    'Resume the persisted task using its remaining count, not a fresh default batch. If a risk/login block exists, confirmedManualCheck must be true and only after the user has inspected the visible browser.',
    { confirmedManualCheck: z.boolean().optional() },
    MUTATING,
    async ({ confirmedManualCheck = false }) => {
      const result = await resumeHunt({ asyncMode: true, source: 'mcp', acknowledgeRisk: confirmedManualCheck })
      return asResult(result, result.ok === false)
    }
  )

  server.tool(
    'job_open_boss_login',
    'Open the visible native Chrome page for one recruiting platform so the user can log in or verify saved login state. It does not apply to any job.',
    { platform: PLATFORM_ENUM.optional().describe('Platform id; all is not valid for a single login window.') },
    MUTATING,
    async ({ platform = 'boss' }) => {
      const target = normalizePlatform(platform) || 'boss'
      const adapter = await getAdapter(target)
      if (!adapter) return asResult({ ok: false, reason: 'platform_disabled', platform: target }, true)
      await adapter.launch()
      const status = await inspectPlatformLogin(target, { open: true, save: true })
      return asResult({ ok: true, status, platform: target, name: PLATFORM_NAMES[target] || target })
    }
  )

  server.tool(
    'job_list_applications',
    'List recent application records from the local database. This is evidence of applications that were actually recorded, not a prediction.',
    { limit: z.number().int().min(1).max(200).optional(), platform: PLATFORM_ENUM.optional() },
    READ_ONLY,
    async ({ limit = 50, platform = 'all' }) => asResult({ applications: store.listApplications({ limit, platform: normalizePlatform(platform) }) })
  )

  return server
}

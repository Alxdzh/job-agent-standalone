const EDITIONS = new Set(['standalone', 'mcp'])

export function normalizeEdition(value) {
  const edition = String(value || '').trim().toLowerCase()
  return EDITIONS.has(edition) ? edition : 'standalone'
}

export function getRuntimeEdition() {
  return normalizeEdition(process.env.JOB_AGENT_EDITION)
}

// 仅用于同一 Node 进程的启动入口。独立版默认值保持兼容已有快捷方式。
export function setRuntimeEdition(value) {
  const edition = normalizeEdition(value)
  process.env.JOB_AGENT_EDITION = edition
  return edition
}

export function isMcpEdition() {
  return getRuntimeEdition() === 'mcp'
}

export const EDITION_LABELS = {
  standalone: '独立版',
  mcp: 'MCP 版'
}

// Stdio MCP entry point. It starts the shared BOSS runtime in MCP mode inside
// the same user session, so the controlled Chrome stays visible on that user’s
// desktop and the worker/database are shared with the workbench.
process.env.JOB_AGENT_EDITION = 'mcp'

const { startRuntime } = await import('./src/runtime.mjs')
const { createJobMcpServer } = await import('./src/mcp-server.mjs')
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

try {
  await startRuntime({ edition: 'mcp', mcpStdout: true })
  const server = createJobMcpServer()
  await server.connect(new StdioServerTransport())
} catch (err) {
  // stdout is reserved for MCP messages; stderr is safe for diagnostics.
  console.error(`[job-agent-mcp] fatal: ${err?.stack || err?.message}`)
  process.exit(1)
}

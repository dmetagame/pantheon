#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // MCP clients pipe stderr into their logs; stdout is reserved for the
  // JSON-RPC framing, so any diagnostics go to stderr.
  console.error("[pantheon-mcp] fatal:", err);
  process.exit(1);
});

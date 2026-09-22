#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AircallClient } from "./client.js";
import { startHttpServer } from "./http.js";
import { createAircallServer } from "./server.js";

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function transportMode(): "stdio" | "http" {
  const raw = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (raw === "stdio" || raw === "http") return raw;
  throw new Error('MCP_TRANSPORT must be "stdio" or "http".');
}

async function main(): Promise<void> {
  const apiId = process.env.AIRCALL_API_ID?.trim() ?? "";
  const apiToken = process.env.AIRCALL_API_TOKEN?.trim() ?? "";

  if (!apiId || !apiToken) {
    throw new Error(
      "Missing Aircall credentials. Set AIRCALL_API_ID and AIRCALL_API_TOKEN in the MCP server environment.",
    );
  }

  const api = new AircallClient({
    apiId,
    apiToken,
    timeoutMs: positiveIntegerEnvironment("AIRCALL_TIMEOUT_MS", 30_000),
  });

  const mode = transportMode();
  if (mode === "http") {
    const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined;
    const handle = await startHttpServer({
      createServer: () => createAircallServer(api),
      host: process.env.HOST?.trim() || "127.0.0.1",
      port: positiveIntegerEnvironment("PORT", 8000),
      path: process.env.MCP_PATH?.trim() || "/mcp",
      authToken,
      jsonResponse: process.env.MCP_JSON_RESPONSE === "true",
    });

    if (!authToken) {
      console.error("aircall-mcp: MCP_AUTH_TOKEN is unset; /mcp is unauthenticated");
    }

    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());

    console.error(`aircall-mcp: read-only HTTP server ready on ${handle.url}${process.env.MCP_PATH?.trim() || "/mcp"}`);
    return;
  }

  const server = createAircallServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("aircall-mcp: read-only stdio server ready");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`aircall-mcp: ${message}`);
  process.exit(1);
});

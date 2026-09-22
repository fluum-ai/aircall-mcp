import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpServer } from "../dist/http.js";
import { createAircallServer } from "../dist/server.js";

async function withHttp(options, callback) {
  const handle = await startHttpServer({
    createServer: () => createAircallServer({ get: async () => ({}) }),
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    ...options,
  });

  try {
    await callback(handle);
  } finally {
    await handle.close();
  }
}

test("HTTP health endpoint is unauthenticated", async () => {
  await withHttp({ authToken: "secret" }, async (handle) => {
    const response = await fetch(`${handle.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("HTTP MCP endpoint rejects missing bearer tokens", async () => {
  await withHttp({ authToken: "secret" }, async (handle) => {
    const response = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 401);
  });
});

test("HTTP transport exposes the same read-only tools", async () => {
  await withHttp({ authToken: "secret" }, async (handle) => {
    const client = new Client({ name: "aircall-mcp-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer secret" } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 21);
    } finally {
      await client.close();
    }
  });
});

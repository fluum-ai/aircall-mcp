import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const MAX_BODY_BYTES = 1_000_000;

export interface HttpServerOptions {
  createServer: () => McpServer;
  host: string;
  port: number;
  path: string;
  authToken?: string;
  jsonResponse?: boolean;
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

export function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const mcpPath = normalizePath(options.path);
  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Internal server error";
      if (!res.headersSent) {
        writeJson(res, error instanceof PayloadTooLargeError ? 413 : 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null,
        });
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = normalizePath(url.pathname);

    if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (pathname !== mcpPath) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isAuthorized(req, options.authToken)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const sessionId = sessionIdFrom(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        const session = await createSession(options, sessions);
        await session.transport.handleRequest(req, res, body);
        return;
      }

      writeJson(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = sessionIdFrom(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (!existing) {
        writeJson(res, 400, { error: "Invalid or missing session ID" });
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" });
  }

  return listen(httpServer, options.host, options.port, async () => {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        await session.transport.close();
        await session.server.close();
      }),
    );
    sessions.clear();
  });
}

async function createSession(
  options: HttpServerOptions,
  sessions: Map<string, Session>,
): Promise<Session> {
  const server = options.createServer();
  let session: Session;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: options.jsonResponse === true,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });

  session = { server, transport };
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return session;
}

function listen(
  httpServer: Server,
  host: string,
  port: number,
  onClose: () => Promise<void>,
): Promise<HttpServerHandle> {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind HTTP server."));
        return;
      }

      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      resolve({
        port: address.port,
        url: `http://${displayHost}:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            void onClose()
              .catch(() => undefined)
              .finally(() => {
                httpServer.close((error) => (error ? closeReject(error) : closeResolve()));
              });
          }),
      });
    });
  });
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true;

  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqualToken(header.slice("Bearer ".length), authToken);
}

function timingSafeEqualToken(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "PayloadTooLargeError";
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }

  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

import { timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { Readable } from "node:stream"

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server"

import type { Config } from "./config.ts"
import type { Logger } from "./log.ts"
import { registerTools, type ToolDeps } from "./tools.ts"

/**
 * The MCP side: one HTTP server inside the container (PCP publishes its
 * port on the SSH server's 127.0.0.1 and reaches it through the SSH
 * connection).
 *
 * - `GET /health` answers `{"status":"ok"}` and nothing about the login.
 * - The MCP path (`/mcp`) serves MCP over Streamable HTTP, stateless: a
 *   fresh MCP server per request, nothing kept between them. With
 *   MCP_AUTH_TOKEN set (the service does not start without it unless
 *   MCP_AUTH=off), a request without `Authorization: Bearer <token>` is
 *   refused. Host and Origin must be well formed and loopback or in
 *   MCP_ALLOWED_HOSTS (DNS rebinding). The request the MCP handler gets is
 *   built on a fixed origin, never from the Host header.
 * - Everything else, `/` included, is 404 with no body worth reading.
 * - A request target that is not a path ("http://…", "*", "//…"), or
 *   anything else that throws while a request is read, is 400: nothing a
 *   request carries ends the process.
 *
 * Requests are not logged: no address, no body, no header.
 */

export const SERVER_NAME = "claude-sessions-mcp"
export const SERVER_VERSION = "0.1.0"
const MAX_BODY_BYTES = 1024 * 1024

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** A Host value: a name or a bracketed IPv6 address, then an optional port. */
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/

/** Whether a Host value reads as one: a name or [IPv6], a port of digits. */
export function hostWellFormed(value: string | undefined): boolean {
  return value !== undefined && HOST.test(value.toLowerCase())
}

/**
 * Whether a Host (or an Origin's host) value is one this server answers: a
 * well-formed host (a port, if any, all digits) that is loopback or in
 * MCP_ALLOWED_HOSTS.
 */
export function hostAllowed(
  value: string | undefined,
  allowed: string[],
): boolean {
  if (!value) return false
  const host = value.toLowerCase()
  const match = HOST.exec(host)
  if (!match) return false
  const name = match[1]!
  if (LOOPBACK.has(name)) return true
  return allowed.some(
    (entry) => entry === "*" || entry === host || entry === `${name}:*`,
  )
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false
  const given = Buffer.from(header.slice("Bearer ".length).trim(), "utf8")
  const expected = Buffer.from(token, "utf8")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(text)
}

/**
 * The request as the MCP handler takes it, on a fixed origin: the Host
 * header is checked against the allow-list but never parsed into a URL.
 * `path` is the request target, already checked to start with "/".
 */
function toWebRequest(req: IncomingMessage, path: string): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value)
    else if (Array.isArray(value))
      for (const v of value) headers.append(name, v)
  }
  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit)
}

async function sendWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  )
  res.on("close", () => body.destroy())
  body.pipe(res)
}

export function createMcpHttpServer(
  config: Pick<Config, "path" | "authToken" | "allowedHosts">,
  deps: ToolDeps,
  logger: Logger,
): Server {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      })
      registerTools(server, deps)
      return server
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: () => logger.warn("mcp_request_error"),
    },
  )

  function handle(req: IncomingMessage, res: ServerResponse) {
    // Origin-form targets only ("/mcp?…"): never an absolute URL, an
    // authority or "*", which would otherwise be parsed below.
    const target = req.url ?? ""
    if (!target.startsWith("/") || target.startsWith("//")) {
      plain(res, 400, "Bad request")
      return
    }
    const url = new URL(target, "http://localhost")
    if (url.pathname === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        plain(res, 405, "Method not allowed")
        return
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (url.pathname !== config.path) {
      plain(res, 404, "Not found")
      return
    }
    const host = req.headers.host
    if (!hostWellFormed(host)) {
      plain(res, 400, "Bad request")
      return
    }
    if (!hostAllowed(host, config.allowedHosts)) {
      plain(res, 403, "Host not allowed")
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost: string | undefined
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = undefined
      }
      if (!hostAllowed(originHost, config.allowedHosts)) {
        plain(res, 403, "Origin not allowed")
        return
      }
    }
    if (
      config.authToken &&
      !bearerMatches(req.headers.authorization, config.authToken)
    ) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Bearer realm="claude-sessions-mcp"',
      })
      res.end("Unauthorized")
      return
    }
    handler
      .fetch(toWebRequest(req, target))
      .then((response) => sendWebResponse(res, response))
      .catch(() => {
        logger.error("mcp_handler_failed")
        if (!res.headersSent) plain(res, 500, "Internal error")
        else res.destroy()
      })
  }

  return createServer((req, res) => {
    // Nothing a request carries may end the process: whatever throws
    // while it is read is a 400.
    try {
      handle(req, res)
    } catch {
      logger.warn("http_bad_request")
      if (!res.headersSent) plain(res, 400, "Bad request")
      else res.destroy()
    }
  })
}

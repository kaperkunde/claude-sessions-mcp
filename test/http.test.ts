import { request } from "node:http"
import { connect, type AddressInfo } from "node:net"

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"

import { createMcpHttpServer, hostAllowed } from "../src/http.ts"
import { setup } from "./helpers.ts"

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function serve(authToken?: string) {
  const s = setup()
  const server = createMcpHttpServer(
    { path: "/mcp", authToken, allowedHosts: [] },
    s.deps,
    s.logger,
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, fake: s.fake, lines: s.lines }
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
})
const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
}

describe("the HTTP side", () => {
  it("answers 404 on / and on any other path, with nothing about the login", async () => {
    const { base, fake } = await serve()
    for (const path of [
      "/",
      "/info",
      "/mcp/extra",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(404)
      expect(await response.text()).toBe("Not found")
    }
    expect(fake.requests).toHaveLength(0)
  })

  it("answers the health check without touching the API", async () => {
    const { base, fake } = await serve("a-long-enough-token-123")
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(fake.requests).toHaveLength(0)
  })

  it("refuses MCP without the bearer token, when one is set", async () => {
    const { base } = await serve("a-long-enough-token-123")
    const none = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: initialize,
    })
    expect(none.status).toBe(401)
    const wrong = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        Authorization: "Bearer a-long-enough-token-124",
      },
      body: initialize,
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        Authorization: "Bearer a-long-enough-token-123",
      },
      body: initialize,
    })
    expect(right.status).toBe(200)
  })

  it("lists the fifteen tools over MCP, with their annotations", async () => {
    const { base, fake } = await serve("a-long-enough-token-123")
    const client = new Client({ name: "test", version: "1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Authorization: "Bearer a-long-enough-token-123" },
        },
      }),
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      "answer_permission",
      "archive_session",
      "ask_session",
      "get_session",
      "interrupt_session",
      "list_environments",
      "list_sessions",
      "login_finish",
      "login_start",
      "login_status",
      "rename_session",
      "send_message",
      "session_status",
      "start_session",
      "unarchive_session",
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean")
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
      expect(tool.outputSchema, tool.name).toBeDefined()
    }
    const status = await client.callTool({
      name: "login_status",
      arguments: {},
    })
    expect(status.structuredContent).toMatchObject({ signed_in: true })
    await client.close()
    expect(fake.requests).toHaveLength(0)
  })

  it("refuses an Origin that is not loopback (DNS rebinding)", async () => {
    const { base } = await serve()
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, Origin: "http://evil.example" },
      body: initialize,
    })
    expect(response.status).toBe(403)
  })

  it("checks Host against loopback and MCP_ALLOWED_HOSTS", () => {
    expect(hostAllowed("127.0.0.1:8080", [])).toBe(true)
    expect(hostAllowed("localhost", [])).toBe(true)
    expect(hostAllowed("[::1]:9000", [])).toBe(true)
    expect(hostAllowed("evil.example", [])).toBe(false)
    expect(hostAllowed(undefined, [])).toBe(false)
    expect(hostAllowed("192.0.2.10:8080", ["192.0.2.10:8080"])).toBe(true)
    expect(hostAllowed("192.0.2.10:9999", ["192.0.2.10:8080"])).toBe(false)
    expect(hostAllowed("192.0.2.10:9999", ["192.0.2.10:*"])).toBe(true)
    expect(hostAllowed("localhost:abc", [])).toBe(false)
    expect(hostAllowed("localhost:", [])).toBe(false)
    expect(hostAllowed("local host", ["*"])).toBe(false)
    expect(hostAllowed("evil.example:80/x", ["*"])).toBe(false)
  })

  it("answers 400 to a request target it cannot parse, and keeps serving", async () => {
    const { base } = await serve("a-long-enough-token-123")
    const port = Number(new URL(base).port)
    for (const line of [
      "GET http://[ HTTP/1.1",
      "GET * HTTP/1.1",
      "GET //evil.example/mcp HTTP/1.1",
      "POST http://localhost/mcp HTTP/1.1",
    ]) {
      const status = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(
            `${line}\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`,
          ),
        )
        socket.once("data", (data) => {
          resolve(data.toString().split("\r\n")[0]!)
          socket.destroy()
        })
        socket.on("error", reject)
      })
      expect(status, line).toBe("HTTP/1.1 400 Bad Request")
    }
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  it("refuses a malformed Host after the token, and keeps serving", async () => {
    const { base, fake } = await serve("a-long-enough-token-123")
    const port = Number(new URL(base).port)
    for (const host of ["localhost:abc", "localhost:", "local host", "[::1"]) {
      expect(await postWithHost(port, host), host).toBe(400)
    }
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect(fake.requests).toHaveLength(0)
  })

  it("never builds the MCP request from the Host header", async () => {
    const { base } = await serve("a-long-enough-token-123")
    // An allowed Host on any port reaches the handler on a fixed origin.
    const port = Number(new URL(base).port)
    expect(await postWithHost(port, "localhost:65535")).toBe(200)
    expect(await postWithHost(port, "[::1]")).toBe(200)
    expect(await postWithHost(port, "evil.example:8080")).toBe(403)
  })
})

function postWithHost(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          ...mcpHeaders,
          Host: host,
          Authorization: "Bearer a-long-enough-token-123",
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end(initialize)
  })
}

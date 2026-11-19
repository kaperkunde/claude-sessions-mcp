import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  EgressError,
  HOSTS,
  httpsTransport,
  safePath,
  type HostKey,
} from "../src/egress.ts"

const SRC = join(import.meta.dirname, "..", "src")

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }))
}

describe("egress", () => {
  it("knows two hosts, the sessions API and the sign-in's token address", () => {
    expect(HOSTS).toEqual({
      api: "api.anthropic.com",
      auth: "platform.claude.com",
    })
  })

  // A code convention checked here and by ESLint, not a sandbox.
  const NETWORK =
    "(?:node:)?(?:https?|http2|net|tls|dns|dgram|worker_threads|cluster|inspector)|undici"
  const dialing = [
    new RegExp(`from "(?:${NETWORK})"`),
    new RegExp(`import\\(\\s*["'\`](?:${NETWORK})["'\`]`),
    /import\(\s*[^"'`\s]/, // a computed dynamic import
    /\brequire\s*\(/,
    /\bcreateRequire\b/,
    /(?<![.\w])fetch\s*\(/,
    /\b(?:globalThis|global|self)\s*(?:\.\s*fetch\b|\[)/,
    /\bWebSocket\b|\bEventSource\b|\bXMLHttpRequest\b/,
    /process\s*\.\s*(?:binding|dlopen)\b/,
  ]

  it("dials only from src/egress.ts", () => {
    const offenders = sources()
      .filter(({ file }) => file !== "egress.ts")
      .map(({ file, text }) => ({
        file,
        text: file === "http.ts" ? text.replace('from "node:http"', "") : text,
      }))
      .filter(({ text }) => dialing.some((pattern) => pattern.test(text)))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it("starts processes only from src/cli.ts, never through a shell", () => {
    const users = sources()
      .filter(({ text }) =>
        /from "(?:node:)?child_process"|import\(\s*["'`](?:node:)?child_process/.test(
          text,
        ),
      )
      .map(({ file }) => file)
    expect(users).toEqual(["cli.ts"])
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8")
    expect(cli).toMatch(/import \{ spawn \} from "node:child_process"/)
    expect(cli).toMatch(/shell: false/)
    expect(cli).not.toMatch(/(?<![.\w])exec(?:Sync)?\s*\(|execFile|shell: true/)
  })

  it("serves HTTP only from src/http.ts, and makes no HTTP request there", () => {
    const users = sources()
      .filter(({ text }) => /from "(?:node:)?http"/.test(text))
      .map(({ file }) => file)
    expect(users).toEqual(["http.ts"])
    const http = readFileSync(join(SRC, "http.ts"), "utf8")
    expect(http).not.toMatch(/\b(?:request|get)\s*\(/)
  })

  it("names hosts only in src/egress.ts", () => {
    const hostLike = /["'`][a-z0-9.-]+\.(?:com|net|org|io|ai|dev)\b/i
    const offenders = sources()
      .filter(({ file }) => file !== "egress.ts")
      .filter(({ text }) => hostLike.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it.each<[HostKey, string]>([
    ["api", "https://evil.example/v1/code/sessions"],
    ["api", "//evil.example/v1/code/sessions"],
    ["api", "/v1/messages"],
    ["api", "/v1/code/sessions/../../oauth/token"],
    ["api", "/v1/code/sessions/cse_1/events/x"],
    ["api", "/v1/code/sessions/cse_1?x=a b"],
    ["api", "/v1/code/sessions\r\nHost: evil.example"],
    ["api", "/v1/oauth/token"],
    ["api", "/v1/code/sessions/cse_1/delete"],
    ["api", "/v1/code/sessions/cse_1/archive/x"],
    ["api", "/v1/environment_providers/x"],
    ["api", "/v1/code/triggers"],
    ["auth", "/v1/code/sessions"],
    ["auth", "/v1/oauth/token?x=1"],
  ])("refuses %s %j before it dials", async (host, path) => {
    expect(safePath(host, path)).toBe(false)
    const send = httpsTransport()
    await expect(
      send({ host, method: "GET", path, headers: {} }),
    ).rejects.toBeInstanceOf(EgressError)
  })

  it("refuses a host that is not one of its two", async () => {
    const send = httpsTransport()
    await expect(
      send({
        host: "evil" as HostKey,
        method: "GET",
        path: "/v1/code/sessions",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(EgressError)
  })

  it("takes the paths the service sends", () => {
    expect(safePath("api", "/v1/code/sessions?limit=20")).toBe(true)
    expect(safePath("api", "/v1/code/sessions/cse_0123456789")).toBe(true)
    expect(
      safePath(
        "api",
        "/v1/code/sessions/cse_0123456789/events?limit=50&sort_order=desc",
      ),
    ).toBe(true)
    expect(safePath("auth", "/v1/oauth/token")).toBe(true)
    expect(safePath("api", "/v1/code/sessions/cse_0123456789/archive")).toBe(
      true,
    )
    expect(safePath("api", "/v1/code/sessions/cse_0123456789/unarchive")).toBe(
      true,
    )
    expect(
      safePath(
        "api",
        "/v1/code/sessions/cse_0123456789/events?limit=100&sort_order=asc&cursor=1042",
      ),
    ).toBe(true)
    expect(safePath("api", "/v1/environment_providers?limit=50")).toBe(true)
  })

  it("checks certificates, said outright", () => {
    const egress = readFileSync(join(SRC, "egress.ts"), "utf8")
    expect(egress.match(/rejectUnauthorized: true/g)).toHaveLength(2)
    expect(egress).not.toMatch(
      /rejectUnauthorized: false|NODE_TLS_REJECT_UNAUTHORIZED/,
    )
  })
})

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { CLIENT_ID, REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { FIRST_ACCESS, FIRST_REFRESH } from "./fake-api.ts"
import { errorText, setup } from "./helpers.ts"

const ID = "cse_0123456789abcdef"

function onFile(dir: string) {
  return JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as {
    claudeAiOauth: Record<string, unknown>
  }
}

describe("the login's renewal", () => {
  it("renews a token about to run out before the call, keeping the file's other fields", async () => {
    const s = setup({ expiresInMs: REFRESH_MARGIN_MS - 1000 })
    s.fake.addSession(ID)
    await s.ok("list_sessions")
    expect(s.fake.renewals).toBe(1)
    const renewal = s.fake.requests[0]!
    expect(renewal).toMatchObject({
      host: "auth",
      method: "POST",
      path: "/v1/oauth/token",
    })
    expect(JSON.parse(renewal.body!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: FIRST_REFRESH,
      client_id: CLIENT_ID,
      scope: "user:inference user:profile user:sessions:claude_code",
    })
    const file = onFile(s.dir)
    expect(file.claudeAiOauth).toMatchObject({
      accessToken: s.fake.accessToken,
      refreshToken: s.fake.refreshToken,
      expiresAt: s.clock.now() + s.fake.accessLifetimeMs,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
    expect(statSync(join(s.dir, ".credentials.json")).mode & 0o777).toBe(0o600)
  })

  it("renews once for calls at the same time, and never sends a refresh token twice", async () => {
    const s = setup({ expiresInMs: 1000 })
    s.fake.addSession(ID)
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => s.call("list_sessions")),
    )
    for (const answer of answers) expect(answer.isError).toBeFalsy()
    expect(s.fake.renewals).toBe(1)
    expect(s.fake.revoked).toBe(false)
  })

  it("keeps renewing over days without the owner", async () => {
    const s = setup()
    s.fake.addSession(ID)
    for (let day = 0; day < 5; day++) {
      s.clock.advance(9 * 60 * 60 * 1000)
      expect((await s.call("list_sessions")).isError).toBeFalsy()
    }
    expect(s.fake.renewals).toBe(5)
    expect(s.fake.revoked).toBe(false)
  })

  it("renews once on a 401 and sends the request again", async () => {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.force401 = 1
    expect((await s.call("list_sessions")).isError).toBeFalsy()
    expect(s.fake.renewals).toBe(1)
    // Two 401s at once renew once between them.
    s.fake.force401 = 2
    const both = await Promise.all([
      s.call("list_sessions"),
      s.call("list_sessions"),
    ])
    for (const answer of both) expect(answer.isError).toBeFalsy()
    expect(s.fake.renewals).toBe(2)
    expect(s.fake.revoked).toBe(false)
  })

  it("says to sign in again when claude.ai no longer takes the login", async () => {
    const s = setup({ expiresInMs: 1000 })
    s.fake.addSession(ID)
    s.fake.revoked = true
    const result = await s.call("list_sessions")
    expect(errorText(result)).toMatch(/Sign in again with login_start/)
    // The file is left as it was.
    expect(onFile(s.dir).claudeAiOauth.accessToken).toBe(FIRST_ACCESS)
  })

  it("takes a token the CLI renewed in the meantime from the file", async () => {
    const s = setup()
    s.fake.addSession(ID)
    await s.ok("list_sessions")
    // Something else (the CLI) renewed: the file has the new token.
    s.fake.usedRefresh.add(s.fake.refreshToken)
    s.fake.accessToken = "sk-ant-oat01-bythecliGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"
    s.fake.refreshToken = "sk-ant-ort01-bythecliHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH"
    const file = onFile(s.dir)
    file.claudeAiOauth.accessToken = s.fake.accessToken
    file.claudeAiOauth.refreshToken = s.fake.refreshToken
    const { writeFileSync } = await import("node:fs")
    writeFileSync(join(s.dir, ".credentials.json"), JSON.stringify(file))
    expect((await s.call("list_sessions")).isError).toBeFalsy()
    expect(s.fake.renewals).toBe(0)
  })
})

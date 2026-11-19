import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { lastWords, loginUrl, parseStart } from "../src/cli.ts"
import { REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { errorText, GOOD_CODE, setup } from "./helpers.ts"

describe("the sign-in", () => {
  it("login_start answers the CLI's sign-in address and keeps it waiting", async () => {
    const s = setup({ signedIn: false })
    const started = await s.ok("login_start")
    expect(started.url).toMatch(
      /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=/,
    )
    expect(await s.ok("login_status")).toMatchObject({
      signed_in: false,
      login_pending: true,
      login_pending_until: started.expires_at,
    })
    expect(s.cliRuns()[0]).toMatchObject({
      kind: "login",
      args: ["auth", "login", "--claudeai"],
    })
    // The CLI gets its own settings, never the MCP token.
    const env = s.cliRuns()[0]!.env as string[]
    expect(env).toContain("CLAUDE_CONFIG_DIR")
    expect(env).toContain("DISABLE_AUTOUPDATER")
    expect(env).not.toContain("MCP_AUTH_TOKEN")
    s.cli.loginPending() // still there
  })

  it("login_finish hands the code to the waiting CLI and answers the account, not a token", async () => {
    const s = setup({ signedIn: false })
    await s.ok("login_start")
    const finished = await s.ok("login_finish", { code: ` ${GOOD_CODE}\n` })
    expect(finished).toEqual({
      signed_in: true,
      email: "owner@example.org",
      organization: "Owner's Organization",
    })
    expect(await s.ok("login_status")).toMatchObject({
      signed_in: true,
      login_pending: false,
      renewable: true,
    })
    const everything = JSON.stringify(finished) + s.lines.join("\n")
    expect(everything).not.toContain("sk-ant-")
    expect(everything).not.toContain(GOOD_CODE)
    expect(statSync(join(s.dir, ".credentials.json")).mode & 0o777).toBe(0o600)
  })

  it("never echoes a code the CLI refused, and needs a new start after", async () => {
    const s = setup({ signedIn: false })
    await s.ok("login_start")
    const wrong = "wrongcode0123456789#FAKESTATE0123456789"
    const result = await s.call("login_finish", { code: wrong })
    const text = errorText(result)
    expect(text).toMatch(/did not finish/)
    expect(text).toMatch(/status code 400/)
    expect(text).not.toContain(wrong)
    expect(text).not.toContain("wrongcode0123456789")
    expect(s.lines.join("\n")).not.toContain("wrongcode0123456789")
    expect(
      errorText(await s.call("login_finish", { code: GOOD_CODE })),
    ).toMatch(/call login_start first/)
  })

  it("refuses what is not a whole code without using up the sign-in", async () => {
    const s = setup({ signedIn: false })
    await s.ok("login_start")
    for (const code of [
      "goodcode0123456789",
      "a#b",
      "x y#z",
      "--help#abcdefgh",
    ]) {
      expect(errorText(await s.call("login_finish", { code }))).toMatch(
        /whole code/,
      )
    }
    expect(
      (await s.call("login_finish", { code: GOOD_CODE })).isError,
    ).toBeFalsy()
  })

  it("refuses login_finish with no sign-in waiting", async () => {
    const s = setup({ signedIn: false })
    expect(
      errorText(await s.call("login_finish", { code: GOOD_CODE })),
    ).toMatch(/No sign-in is waiting/)
  })

  it("says so when the CLI offers no address", async () => {
    const s = setup({ signedIn: false, fakeMode: "no-url" })
    expect(errorText(await s.call("login_start"))).toMatch(
      /did not offer a sign-in address: Error: something went wrong/,
    )
    expect(s.cli.loginPending()).toBeUndefined()
  })

  it("a new start ends the one waiting", async () => {
    const s = setup({ signedIn: false })
    await s.ok("login_start")
    await s.ok("login_start")
    expect(s.cliRuns().filter((r) => r.kind === "login")).toHaveLength(2)
    expect(
      (await s.call("login_finish", { code: GOOD_CODE })).isError,
    ).toBeFalsy()
  })
})

describe("start_session", () => {
  it("runs the CLI's --cloud with the task on standard input, in a scratch repository", async () => {
    const s = setup()
    const answer = await s.ok("start_session", {
      repo: "kaperkunde/pcp",
      task: "--help; rm -rf / # a task that looks like flags",
    })
    expect(answer).toEqual({
      session_id: "cse_newsession01",
      url: "https://claude.ai/code/cse_newsession01?from=cli",
      title: "Fake task",
    })
    const run = s.cliRuns().find((r) => r.kind === "cloud")!
    expect(run.args).toEqual(["-p", "--cloud", "--output-format", "json"])
    expect(run.task).toBe("--help; rm -rf / # a task that looks like flags\n")
    expect(run.remote).toBe("https://github.com/kaperkunde/pcp.git")
    expect(run.originHead).toBe("ref: refs/remotes/origin/main")
    // The scratch repository is gone afterwards.
    const tmpRoot = (s.cli as unknown as { options: { tmpRoot: string } })
      .options.tmpRoot
    expect(readdirSync(tmpRoot)).toEqual([])
    expect(existsSync(run.cwd as string)).toBe(false)
  })

  it("renews a token close to running out before the CLI runs", async () => {
    const s = setup({ expiresInMs: REFRESH_MARGIN_MS - 1 })
    await s.ok("start_session", { repo: "kaperkunde/pcp", task: "go" })
    expect(s.fake.renewals).toBe(1)
    const run = s.cliRuns().find((r) => r.kind === "cloud")!
    expect(run.accessToken).toBe(s.fake.accessToken)
  })

  it("passes on the CLI's error", async () => {
    const s = setup({ fakeMode: "cloud-fail" })
    expect(
      errorText(
        await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
      ),
    ).toBe(
      "The Claude Code CLI did not start a session: No cloud environment is set up.",
    )
  })

  it("reads the CLI's text answer too", async () => {
    const s = setup({ fakeMode: "cloud-text" })
    expect(
      await s.ok("start_session", { repo: "kaperkunde/pcp", task: "go" }),
    ).toEqual({
      session_id: "cse_textsession01",
      url: "https://claude.ai/code/cse_textsession01",
      title: null,
    })
  })

  it("refuses a repository or branch that is not one, before anything runs", async () => {
    const s = setup()
    for (const [repo, branch] of [
      ["https://github.com/kaperkunde/pcp", "main"],
      ["kaperkunde/../x", "main"],
      ["-x/y", "main"],
      ["kaperkunde/pcp", "--upload-pack=x"],
      ["kaperkunde/pcp", "a..b"],
    ] as const) {
      const result = await s.call("start_session", { repo, task: "x", branch })
      expect(result.isError, `${repo} ${branch}`).toBe(true)
    }
    expect(s.cliRuns()).toHaveLength(0)
  })

  it("says to sign in when signed out, and runs nothing", async () => {
    const s = setup({ signedIn: false })
    expect(
      errorText(
        await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
      ),
    ).toMatch(/login_start/)
    expect(s.cliRuns()).toHaveLength(0)
  })
})

describe("reading the CLI", () => {
  it("takes a sign-in address only on the sign-in hosts, with a PKCE challenge", () => {
    expect(
      loginUrl(
        "visit: https://evil.example/oauth/authorize?code_challenge=x and https://claude.ai/oauth/authorize?code_challenge=y&state=z",
      ),
    ).toBe("https://claude.ai/oauth/authorize?code_challenge=y&state=z")
    expect(
      loginUrl(
        "https://claude.ai.evil.example/oauth/authorize?code_challenge=y",
      ),
    ).toBeUndefined()
    expect(loginUrl("https://claude.ai/oauth/authorize")).toBeUndefined()
  })

  it("masks tokens and codes in what it shows of the CLI's output", () => {
    expect(
      lastWords(
        "ok\nError: token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789 refused\n",
      ),
    ).toBe("Error: token [token] refused")
    expect(lastWords("bad abc#def\n", ["abc#def"])).toBe("bad")
  })

  it("parses only a well-formed start", () => {
    expect(parseStart('{"ok":true,"session_id":"../../x"}')).toBeUndefined()
    expect(
      parseStart(
        '{"ok":true,"session_id":"cse_abcdef123","url":"https://evil.example/"}',
      ),
    ).toEqual({ sessionId: "cse_abcdef123" })
  })
})

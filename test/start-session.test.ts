/* eslint-disable @typescript-eslint/no-explicit-any -- a body read as untrusted JSON, checked by hand */
import { describe, expect, it } from "vitest"

import { REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { EgressError } from "../src/egress.ts"
import { errorText, setup } from "./helpers.ts"

type Created = {
  title: string
  environment_id: string
  events: { payload: Record<string, any> }[]
  config: { sources: Record<string, any>[]; outcomes: Record<string, any>[] }
}

describe("start_session", () => {
  it("creates the session with the task as its first message, and answers id and address", async () => {
    const s = setup()
    const task = "--help; rm -rf / # a task that looks like flags"
    const answer = await s.ok("start_session", {
      repo: "kaperkunde/pcp",
      task,
    })
    expect(s.fake.created).toHaveLength(1)
    const body = s.fake.created[0] as unknown as Created
    // One POST, the first message in its events (as the CLI's --cloud does).
    expect(body.events).toHaveLength(1)
    expect(body.events[0]!.payload).toMatchObject({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: task },
    })
    expect(body.events[0]!.payload.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.title).toBe(task.slice(0, 75))
    expect(answer).toEqual({
      session_id: expect.stringMatching(/^cse_new\d+$/),
      url: `https://claude.ai/code/${answer.session_id}`,
      title: task.slice(0, 75),
    })
    const posts = s.fake.requests.filter((r) => r.method === "POST")
    expect(posts.map((r) => r.path)).toEqual(["/v1/code/sessions"])
    // The session exists, and holds the task as its first message.
    expect(s.fake.sessions.get(answer.session_id as string)).toBeDefined()
    const events = await s.ok("session_status", {
      session_id: answer.session_id,
    })
    expect(JSON.stringify(events)).toContain("rm -rf")
    // The CLI is not started for it.
    expect(s.cliRuns()).toHaveLength(0)
  })

  it("passes the repository, branch and the account's cloud environment on", async () => {
    const s = setup()
    await s.ok("start_session", {
      repo: "kaperkunde/pcp",
      task: "go",
      branch: "develop",
    })
    const body = s.fake.created[0] as unknown as Created
    expect(body.environment_id).toBe("env_01DefaultCloud")
    expect(body.config.sources).toEqual([
      {
        type: "git_repository",
        url: "https://github.com/kaperkunde/pcp",
        revision: "develop",
      },
    ])
    expect(body.config.outcomes).toEqual([
      {
        type: "git_repository",
        git_info: {
          type: "github",
          repo: "kaperkunde/pcp",
          branches: [expect.stringMatching(/^claude\/task-[0-9a-f]{6}$/)],
        },
      },
    ])
  })

  it("runs in the environment it is given", async () => {
    const s = setup()
    await s.ok("start_session", {
      repo: "kaperkunde/pcp",
      task: "go",
      environment_id: "env_02NodeHeavy",
    })
    expect((s.fake.created[0] as unknown as Created).environment_id).toBe(
      "env_02NodeHeavy",
    )
  })

  it("refuses an environment the account does not have, and sends nothing", async () => {
    const s = setup()
    expect(
      errorText(
        await s.call("start_session", {
          repo: "kaperkunde/pcp",
          task: "go",
          environment_id: "env_99Unknown",
        }),
      ),
    ).toMatch(/No environment env_99Unknown/)
    expect(
      errorText(
        await s.call("start_session", {
          repo: "kaperkunde/pcp",
          task: "go",
          environment_id: '{"x":1}',
        }),
      ),
    ).toMatch(/list_environments/)
    expect(s.fake.requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it("says so when the account has no cloud environment to start in", async () => {
    const s = setup()
    s.fake.environments = [
      { kind: "bridge", environment_id: "env_03Laptop", name: "Laptop" },
    ]
    expect(
      errorText(
        await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
      ),
    ).toMatch(/no cloud environment/i)
    expect(s.fake.created).toHaveLength(0)
  })

  it("refuses a task that would be a slash command, a repository or a branch that is not one, and sends nothing", async () => {
    const s = setup()
    for (const args of [
      { repo: "kaperkunde/pcp", task: "/login" },
      { repo: "kaperkunde/pcp", task: "  /config set x" },
      { repo: "kaperkunde/pcp", task: "!cat ~/.claude" },
      { repo: "https://github.com/kaperkunde/pcp", task: "x" },
      { repo: "kaperkunde/../x", task: "x" },
      { repo: "-x/y", task: "x" },
      { repo: "kaperkunde/pcp", task: "x", branch: "--upload-pack=x" },
      { repo: "kaperkunde/pcp", task: "x", branch: "a..b" },
    ]) {
      const result = await s.call("start_session", {
        ...args,
        environment_id: "env_02NodeHeavy",
      })
      expect(result.isError, JSON.stringify(args)).toBe(true)
    }
    expect(s.fake.requests).toHaveLength(0)
  })

  it("says to sign in when signed out, and sends nothing", async () => {
    const s = setup({ signedIn: false })
    expect(
      errorText(
        await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
      ),
    ).toMatch(/login_start/)
    expect(s.fake.requests).toHaveLength(0)
  })

  it("renews a token close to running out first", async () => {
    const s = setup({ expiresInMs: REFRESH_MARGIN_MS - 1 })
    await s.ok("start_session", { repo: "kaperkunde/pcp", task: "go" })
    expect(s.fake.renewals).toBe(1)
    expect(s.fake.created).toHaveLength(1)
  })

  it("maps the API's refusals to clear messages", async () => {
    const s = setup()
    for (const [status, message, expected] of [
      [
        403,
        "no access",
        /refused.*user:sessions:claude_code|GitHub|login_start/s,
      ],
      [
        404,
        "repository not found",
        /not accept|could not be started|repository|environment/i,
      ],
      [422, "bad source", /not accept|could not be started/i],
      [429, "slow down", /Too many requests/],
      [500, "boom", /answered 500/],
    ] as const) {
      s.fake.createFailure = { status, message }
      const text = errorText(
        await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
      )
      expect(text, String(status)).toMatch(expected)
      // A 404 here is not "No such session".
      expect(text, String(status)).not.toMatch(/No such session/)
      // The API's own words are shown for the ones that are about the request.
      if (status === 404 || status === 422) expect(text).toContain(message)
    }
    expect(s.fake.created).toHaveLength(0)
  })

  it("warns that a session may have started when the request got no answer", async () => {
    const s = setup({
      transport: (fake) => async (request) => {
        if (request.method === "POST" && request.path === "/v1/code/sessions")
          throw new EgressError("api.anthropic.com did not answer in time.")
        return fake.transport(request)
      },
    })
    const text = errorText(
      await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
    )
    expect(text).toMatch(/may have started/)
    expect(text).toMatch(/list_sessions/)
  })

  it("refuses an answer that names no usable session", async () => {
    const s = setup({
      transport: (fake) => async (request) => {
        const response = await fake.transport(request)
        if (request.method === "POST" && request.path === "/v1/code/sessions")
          return {
            ...response,
            body: JSON.stringify({ session: { id: "../x" } }),
          }
        return response
      },
    })
    const text = errorText(
      await s.call("start_session", { repo: "kaperkunde/pcp", task: "go" }),
    )
    expect(text).toMatch(/no usable session id/i)
    expect(text).toMatch(/list_sessions/)
  })
})

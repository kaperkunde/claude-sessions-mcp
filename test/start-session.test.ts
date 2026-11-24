/* eslint-disable @typescript-eslint/no-explicit-any -- a body read as untrusted JSON, checked by hand */
import { describe, expect, it } from "vitest"

import { connectorUuid } from "../src/api.ts"
import { REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { EgressError } from "../src/egress.ts"
import { defaultEnvironment } from "../src/tools.ts"
import { errorText, setup } from "./helpers.ts"

type Routine = {
  name: string
  mcp_connections?: { connector_uuid: string; name: string; url: string }[]
  job_config: {
    ccr: {
      environment_id?: string
      self_hosted_runner_pool_id?: string
      session_context: {
        sources: Record<string, any>[]
        outcomes: Record<string, any>[]
      }
      events: { data: Record<string, any> }[]
    }
  }
}

const START = { repo: "kaperkunde/pcp", task: "go" }
const routine = (s: ReturnType<typeof setup>, n = 0) =>
  s.fake.routines[n] as unknown as Routine

describe("start_session", () => {
  it("makes a routine with the task as its first message, runs it, and answers id, routine and connectors", async () => {
    const s = setup()
    const task = "--help; rm -rf / # a task that looks like flags"
    const answer = await s.ok("start_session", { repo: "kaperkunde/pcp", task })
    expect(s.fake.routines).toHaveLength(1)
    const body = routine(s)
    expect(body.job_config.ccr.events).toHaveLength(1)
    expect(body.job_config.ccr.events[0]!.data).toMatchObject({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: task },
    })
    expect(body.job_config.ccr.events[0]!.data.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.name).toBe(task.slice(0, 75))
    expect(answer).toEqual({
      session_id: expect.stringMatching(/^cse_run\d+$/),
      url: `https://claude.ai/code/${answer.session_id}`,
      title: task.slice(0, 75),
      environment_id: "env_01DefaultCloud",
      routine_id: expect.stringMatching(/^trig_/),
      connectors: ["PCP"],
      note: null,
    })
    const posts = s.fake.requests.filter((r) => r.method === "POST")
    expect(posts.map((r) => r.path)).toEqual([
      "/v1/code/triggers",
      `/v1/code/triggers/${answer.routine_id}/run`,
      `/v1/code/triggers/${answer.routine_id}`,
    ])
    expect(posts[1]!.body).toBe("{}")
    expect(s.fake.routineUpdates).toEqual([
      [answer.routine_id, { enabled: false }],
    ])
    // A routine that never fires on its own.
    expect(body).not.toHaveProperty("cron_expression")
    expect(body).not.toHaveProperty("run_once_at")
    const events = await s.ok("session_status", {
      session_id: answer.session_id,
    })
    expect(JSON.stringify(events)).toContain("rm -rf")
    expect(s.cliRuns()).toHaveLength(0)
  })

  it("passes the repository, branch and the account's cloud environment on", async () => {
    const s = setup()
    await s.ok("start_session", { ...START, branch: "develop" })
    const ccr = routine(s).job_config.ccr
    expect(ccr.environment_id).toBe("env_01DefaultCloud")
    expect(ccr.session_context.sources).toEqual([
      {
        type: "git_repository",
        url: "https://github.com/kaperkunde/pcp",
        revision: "develop",
      },
    ])
    expect(ccr.session_context.outcomes).toEqual([
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

  it("attaches the connectors with sanitized, unique names, across pages, skipping the ones it cannot", async () => {
    const s = setup()
    s.fake.connectors = [
      {
        id: "mcpsrv_014Fj7srWvLMyCuRCS8J9W3d",
        display_name: "My PCP v1.2",
        url: "https://a.example/mcp",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        display_name: "My.PCP v1_2",
        url: "https://b.example/mcp",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        display_name: "Gmail (work)",
        url: "https://c.example/mcp",
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        display_name: "日本語",
        url: "https://d.example/mcp",
      },
      {
        id: "00000000-0000-4000-8000-000000000005",
        display_name: "Extra",
        url: "https://e.example/mcp",
        additional_install: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        display_name: "Nope",
        url: "https://f.example/mcp",
        eligible: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        display_name: "Last",
        url: "https://g.example/mcp",
      },
    ]
    const answer = await s.ok("start_session", START)
    expect(routine(s).mcp_connections).toEqual([
      {
        connector_uuid: "1a59c906-04da-521d-bda7-7f71b9f9e01c",
        name: "My_PCP_v1_2",
        url: "https://a.example/mcp",
      },
      {
        connector_uuid: "00000000-0000-4000-8000-000000000002",
        name: "My_PCP_v1_2_2",
        url: "https://b.example/mcp",
      },
      {
        connector_uuid: "00000000-0000-4000-8000-000000000003",
        name: "Gmail_work",
        url: "https://c.example/mcp",
      },
      {
        connector_uuid: "00000000-0000-4000-8000-000000000004",
        name: "connector",
        url: "https://d.example/mcp",
      },
      {
        connector_uuid: "00000000-0000-4000-8000-000000000007",
        name: "Last",
        url: "https://g.example/mcp",
      },
    ])
    expect(answer.connectors).toEqual([
      "My PCP v1.2",
      "My.PCP v1_2",
      "Gmail (work)",
      "日本語",
      "Last",
    ])
    const list = s.fake.requests.find((r) =>
      r.path.startsWith("/v1/mcp_servers"),
    )!
    expect(list.headers["anthropic-beta"]).toBe("mcp-servers-2025-12-04")
    expect(list.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("still makes the routine, without mcp_connections and with a warning, when the connectors cannot be listed", async () => {
    const s = setup()
    s.fake.connectorsFailure = 500
    const answer = await s.ok("start_session", START)
    expect(routine(s)).not.toHaveProperty("mcp_connections")
    expect(answer.connectors).toEqual([])
    expect(answer.note).toMatch(/could not be listed/)
    expect(answer.session_id).toMatch(/^cse_run/)
  })

  it("warns that the session will not have PCP when the account lists no connector", async () => {
    const s = setup()
    s.fake.connectors = []
    const answer = await s.ok("start_session", START)
    expect(routine(s)).not.toHaveProperty("mcp_connections")
    expect(answer.note).toMatch(/will not have PCP or other connectors/)
  })

  it("takes the session id from the run's answer, and from the routine's sessions when it names none", async () => {
    const s = setup()
    const named = await s.ok("start_session", START)
    expect(s.fake.requests.some((r) => r.path.includes("trigger_id"))).toBe(
      false,
    )
    s.fake.runNamesSession = false
    s.fake.runLagPolls = 2
    const found = await s.ok("start_session", START)
    expect(found.session_id).toMatch(/^cse_run/)
    expect(found.session_id).not.toBe(named.session_id)
    expect(
      s.fake.requests.filter((r) => r.path.includes("trigger_id=")),
    ).toHaveLength(3)
  })

  it("answers with the routine when the session is not seen in time", async () => {
    const s = setup()
    s.fake.runNamesSession = false
    s.fake.runLagPolls = 1000
    const answer = await s.ok("start_session", START)
    expect(answer.session_id).toBeNull()
    expect(answer.url).toBeNull()
    expect(answer.routine_id).toMatch(/^trig_/)
    expect(answer.note).toMatch(/list_sessions within a minute/)
    // Bounded: a few polls, then it gives up.
    const polls = s.fake.requests.filter((r) => r.path.includes("trigger_id="))
    expect(polls.length).toBeGreaterThan(1)
    expect(polls.length).toBeLessThan(15)
    expect(s.clock.ms - Date.UTC(2026, 10, 19, 9, 0, 0)).toBeLessThan(60_000)
  })

  it("does not fail when the routine cannot be turned off", async () => {
    const s = setup()
    s.fake.updateFailure = 500
    const answer = await s.ok("start_session", START)
    expect(answer.session_id).toMatch(/^cse_run/)
    expect(s.lines.some((l) => l.includes("routine_not_disabled"))).toBe(true)
    // Never deleted.
    expect(s.fake.requests.some((r) => (r.method as string) === "DELETE")).toBe(
      false,
    )
  })

  it("sends a task that starts with / or ! as it is: it is a JSON message", async () => {
    const s = setup()
    await s.ok("start_session", { ...START, task: "  /login now " })
    await s.ok("start_session", { ...START, task: "!ls" })
    const sent = s.fake.routines.map(
      (_, i) => routine(s, i).job_config.ccr.events[0]!.data.message.content,
    )
    expect(sent).toEqual(["/login now", "!ls"])
  })

  it("sends a self-hosted pool as self_hosted_runner_pool_id", async () => {
    const s = setup()
    s.fake.environments = [
      { kind: "self_hosted_pool", pool_id: "ccpool_01Mine", name: "Mine" },
    ]
    await s.ok("start_session", { ...START, environment_id: "ccpool_01Mine" })
    const ccr = routine(s).job_config.ccr
    expect(ccr.self_hosted_runner_pool_id).toBe("ccpool_01Mine")
    expect(ccr).not.toHaveProperty("environment_id")
  })

  it("finds an environment past the first page", async () => {
    const s = setup()
    s.fake.environments = Array.from({ length: 250 }, (_, i) => ({
      kind: "anthropic_cloud",
      environment_id: `env_${String(i).padStart(4, "0")}`,
      name: `E${i}`,
    }))
    await s.ok("start_session", { ...START, environment_id: "env_0240" })
    expect(routine(s).job_config.ccr.environment_id).toBe("env_0240")
    expect(
      errorText(
        await s.call("start_session", { ...START, environment_id: "env_0999" }),
      ),
    ).toMatch(/No environment env_0999/)
  })

  it("prefers the environment marked default, else the one named Default, else the first", async () => {
    const env = (id: string, name: string, extra = {}) => ({
      kind: "anthropic_cloud",
      environment_id: id,
      name,
      ...extra,
    })
    expect(
      defaultEnvironment([
        env("env_A", "Restricted"),
        env("env_B", "Default"),
        env("env_C", "Mine", { is_default: true }),
      ]),
    ).toBe("env_C")
    expect(
      defaultEnvironment([
        env("env_A", "A"),
        env("env_B", "B", { default: true }),
      ]),
    ).toBe("env_B")
    expect(
      defaultEnvironment([env("env_A", "Restricted"), env("env_B", "Default")]),
    ).toBe("env_B")
    expect(defaultEnvironment([env("env_A", "A"), env("env_B", "B")])).toBe(
      "env_A",
    )
    expect(
      defaultEnvironment([
        { kind: "bridge", environment_id: "env_L", name: "Default" },
      ]),
    ).toBeUndefined()

    const s = setup()
    s.fake.environments = [
      env("env_01Restricted", "Restricted"),
      env("env_02Default", "Default"),
    ]
    const answer = await s.ok("start_session", START)
    expect(answer.environment_id).toBe("env_02Default")
    expect(routine(s).job_config.ccr.environment_id).toBe("env_02Default")
  })

  it("says a session may have started on a 5xx or 408 when the routine is made, and not on a refusal", async () => {
    const s = setup()
    for (const status of [408, 500, 502, 503]) {
      s.fake.createFailure = { status, message: "upstream" }
      const text = errorText(await s.call("start_session", START))
      expect(text, String(status)).toMatch(/may have started/)
      expect(text, String(status)).toMatch(/list_sessions/)
    }
    s.fake.createFailure = { status: 422, message: "bad" }
    expect(errorText(await s.call("start_session", START))).not.toMatch(
      /may have started/,
    )
  })

  it("says a session may have started on a 5xx on the run, naming the routine; a refusal there started nothing", async () => {
    const s = setup()
    for (const status of [408, 500, 503]) {
      s.fake.runFailure = status
      const text = errorText(await s.call("start_session", START))
      expect(text, String(status)).toMatch(/may have started/)
      expect(text, String(status)).toMatch(/list_sessions/)
      expect(text, String(status)).toMatch(/trig_/)
    }
    // The routine is never disabled or deleted by a failed run.
    expect(s.fake.routineUpdates).toHaveLength(0)
    s.fake.runFailure = 422
    const refused = errorText(await s.call("start_session", START))
    expect(refused).not.toMatch(/may have started/)
    expect(refused).toMatch(/did not run, so no session started/)
  })

  it("warns that a session may have started when the run got no answer", async () => {
    const s = setup({
      transport: (fake) => async (request) => {
        if (request.method === "POST" && request.path.endsWith("/run"))
          throw new EgressError("api.anthropic.com did not answer in time.")
        return fake.transport(request)
      },
    })
    const text = errorText(await s.call("start_session", START))
    expect(text).toMatch(/may have started/)
    expect(text).toMatch(/list_sessions/)
  })

  it("runs in the environment it is given", async () => {
    const s = setup()
    await s.ok("start_session", { ...START, environment_id: "env_02NodeHeavy" })
    expect(routine(s).job_config.ccr.environment_id).toBe("env_02NodeHeavy")
  })

  it("refuses an environment the account does not have, and sends nothing", async () => {
    const s = setup()
    expect(
      errorText(
        await s.call("start_session", {
          ...START,
          environment_id: "env_99Unknown",
        }),
      ),
    ).toMatch(/No environment env_99Unknown/)
    expect(
      errorText(
        await s.call("start_session", { ...START, environment_id: '{"x":1}' }),
      ),
    ).toMatch(/list_environments/)
    expect(s.fake.requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it("says so when the account has no cloud environment to start in", async () => {
    const s = setup()
    s.fake.environments = [
      { kind: "bridge", environment_id: "env_03Laptop", name: "Laptop" },
    ]
    expect(errorText(await s.call("start_session", START))).toMatch(
      /no cloud environment/i,
    )
    expect(s.fake.routines).toHaveLength(0)
  })

  it("refuses a blank task, a repository or a branch that is not one, and sends nothing", async () => {
    const s = setup()
    for (const args of [
      { repo: "kaperkunde/pcp", task: "   \n\t " },
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
    expect(errorText(await s.call("start_session", START))).toMatch(
      /login_start/,
    )
    expect(s.fake.requests).toHaveLength(0)
  })

  it("renews a token close to running out first", async () => {
    const s = setup({ expiresInMs: REFRESH_MARGIN_MS - 1 })
    await s.ok("start_session", START)
    expect(s.fake.renewals).toBe(1)
    expect(s.fake.routines).toHaveLength(1)
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
    ] as const) {
      s.fake.createFailure = { status, message }
      const text = errorText(await s.call("start_session", START))
      expect(text, String(status)).toMatch(expected)
      expect(text, String(status)).not.toMatch(/No such session/)
      if (status === 404 || status === 422) expect(text).toContain(message)
    }
    expect(s.fake.routines).toHaveLength(0)
  })

  it("warns that a session may have started when making the routine got no answer", async () => {
    const s = setup({
      transport: (fake) => async (request) => {
        if (request.method === "POST" && request.path === "/v1/code/triggers")
          throw new EgressError("api.anthropic.com did not answer in time.")
        return fake.transport(request)
      },
    })
    const text = errorText(await s.call("start_session", START))
    expect(text).toMatch(/may have started/)
    expect(text).toMatch(/list_sessions/)
  })

  it("refuses an answer that names no usable routine", async () => {
    const s = setup({
      transport: (fake) => async (request) => {
        const response = await fake.transport(request)
        if (request.method === "POST" && request.path === "/v1/code/triggers")
          return { ...response, body: JSON.stringify({ id: "../x" }) }
        return response
      },
    })
    expect(errorText(await s.call("start_session", START))).toMatch(
      /no usable routine id/i,
    )
  })
})

describe("connectorUuid", () => {
  it("decodes a connector id from the connectors list into its UUID, as the CLI does", () => {
    expect(connectorUuid("mcpsrv_014Fj7srWvLMyCuRCS8J9W3d")).toBe(
      "1a59c906-04da-521d-bda7-7f71b9f9e01c",
    )
    expect(connectorUuid("mcprs_014Fj7srWvLMyCuRCS8J9W3d")).toBe(
      "1a59c906-04da-521d-bda7-7f71b9f9e01c",
    )
  })

  it("takes a UUID as it is, in lower case", () => {
    expect(connectorUuid("1A59C906-04DA-521D-BDA7-7F71B9F9E01C")).toBe(
      "1a59c906-04da-521d-bda7-7f71b9f9e01c",
    )
  })

  it("refuses anything else", () => {
    expect(connectorUuid("mcp_01Pcp")).toBeNull()
    expect(connectorUuid("mcpsrv_01")).toBeNull()
    expect(connectorUuid("mcpsrv_01I0O0l")).toBeNull()
    expect(connectorUuid(`mcpsrv_01${"z".repeat(40)}`)).toBeNull()
    expect(connectorUuid(42)).toBeNull()
  })
})

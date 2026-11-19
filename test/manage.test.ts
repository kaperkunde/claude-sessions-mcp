import { describe, expect, it } from "vitest"

import { errorText, setup } from "./helpers.ts"

/** The tools added for managing sessions, each against the fake API. */

const ID = "cse_0123456789abcdef"

type Posted = {
  events: { event_type: string; payload: Record<string, unknown> }[]
}

function lastPosted(s: ReturnType<typeof setup>) {
  return (s.fake.posted.at(-1)!.body as Posted).events[0]!
}

describe("get_session", () => {
  it("answers the record's fields worth showing", async () => {
    const s = setup()
    s.fake.addSession(ID, {
      config: {
        sources: [
          { type: "git_repository", url: "https://github.com/kaperkunde/pcp" },
        ],
        outcomes: [
          {
            type: "git_repository",
            git_info: {
              type: "github",
              repo: "kaperkunde/pcp",
              branches: ["claude/fix-x"],
            },
          },
        ],
        model: "claude-opus-5-5",
      },
      external_metadata: {
        post_turn_summary: { status_detail: "Fixing gate tests" },
      },
      worker_status: "running",
    })
    const { session } = await s.ok("get_session", { session_id: ID })
    expect(session).toEqual({
      id: ID,
      title: `Session ${ID}`,
      status: "active",
      updated_at: "2026-11-18T17:00:00Z",
      repo: "kaperkunde/pcp",
      worker_status: "running",
      environment_id: "env_01DefaultCloud",
      environment_kind: "anthropic_cloud",
      created_at: "2026-11-18T16:00:00Z",
      branch: "claude/fix-x",
      model: "claude-opus-5-5",
      summary: "Fixing gate tests",
      url: `https://claude.ai/code/${ID}`,
      pending_permission: null,
    })
  })
})

describe("session_status", () => {
  it("pages older events by cursor, keeping the state of the newest", async () => {
    const s = setup()
    s.fake.addSession(ID)
    for (let i = 0; i < 12; i++)
      s.fake.addEvent(ID, {
        type: "assistant",
        message: { content: [{ type: "text", text: `step ${i}` }] },
      })
    s.fake.addEvent(ID, { type: "result", subtype: "success" })
    const first = await s.ok("session_status", { session_id: ID, events: 5 })
    expect(first.state).toBe("waiting")
    expect(first.next_cursor).toEqual(expect.any(String))
    const second = await s.ok("session_status", {
      session_id: ID,
      events: 5,
      cursor: first.next_cursor,
    })
    expect(second.state).toBe("waiting")
    expect((second.recent as { text: string }[]).map((r) => r.text)).toEqual([
      "step 7",
      "step 6",
      "step 5",
      "step 4",
      "step 3",
    ])
    const last = await s.ok("session_status", {
      session_id: ID,
      events: 5,
      cursor: second.next_cursor,
    })
    expect(last.next_cursor).toBeNull()
    expect((last.recent as unknown[]).length).toBe(3)
  })

  it("refuses a cursor that is not one", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(
      errorText(
        await s.call("session_status", { session_id: ID, cursor: "1&x=2" }),
      ),
    ).toMatch(/cursor/)
  })

  it("shows the permission prompt it waits on, masked, never the whole input", async () => {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.askPermission(ID, {
      requestId: "req_perm_1",
      toolName: "Bash",
      description: "Run the deploy script",
      input: {
        command:
          "TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123 ./deploy.sh",
        env_dump: "SECRET_ONLY_IN_INPUT",
      },
    })
    const answer = await s.ok("session_status", { session_id: ID })
    expect(answer.state).toBe("needs_permission")
    expect(answer.pending_permission).toEqual({
      request_id: "req_perm_1",
      tool: "Bash",
      description: "Run the deploy script",
      target: "TOKEN=[token] ./deploy.sh",
    })
    expect(JSON.stringify(answer)).not.toContain("SECRET_ONLY_IN_INPUT")
  })
})

describe("answer_permission", () => {
  function waiting() {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.askPermission(ID, {
      requestId: "req_perm_1",
      toolName: "Bash",
      description: "Run the tests",
      input: { command: "pnpm test" },
    })
    return s
  }

  it("allows once with the prompt's own input, as the CLI answers", async () => {
    const s = waiting()
    expect(
      await s.ok("answer_permission", {
        session_id: ID,
        request_id: "req_perm_1",
        decision: "allow",
      }),
    ).toEqual({ sent: true, decision: "allow", tool: "Bash" })
    const event = lastPosted(s)
    expect(event.event_type).toBe("control_response")
    expect(event.payload).toMatchObject({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_perm_1",
        response: {
          behavior: "allow",
          updatedInput: { command: "pnpm test" },
          toolUseID: "toolu_req_perm_1",
          tool_name: "Bash",
        },
      },
    })
    expect(s.fake.sessions.get(ID)!.record.worker_status).toBe("running")
  })

  it("denies with the owner's message", async () => {
    const s = waiting()
    await s.ok("answer_permission", {
      session_id: ID,
      request_id: "req_perm_1",
      decision: "deny",
      message: "Not now, run lint first.",
    })
    expect(lastPosted(s).payload.response).toEqual({
      subtype: "success",
      request_id: "req_perm_1",
      response: {
        behavior: "deny",
        message: "Not now, run lint first.",
        toolUseID: "toolu_req_perm_1",
      },
    })
  })

  it("takes the input from the prompt's event when the record left it out", async () => {
    const s = waiting()
    const metadata = s.fake.sessions.get(ID)!.record.external_metadata as {
      pending_action: Record<string, unknown>
    }
    delete metadata.pending_action.input
    await s.ok("answer_permission", {
      session_id: ID,
      request_id: "req_perm_1",
      decision: "allow",
    })
    expect(lastPosted(s).payload.response).toMatchObject({
      response: { behavior: "allow", updatedInput: { command: "pnpm test" } },
    })
  })

  it("answers only the prompt the owner was shown, while it waits", async () => {
    const s = waiting()
    expect(
      errorText(
        await s.call("answer_permission", {
          session_id: ID,
          request_id: "req_other",
          decision: "allow",
        }),
      ),
    ).toMatch(/no longer waits on that prompt/)
    await s.ok("answer_permission", {
      session_id: ID,
      request_id: "req_perm_1",
      decision: "deny",
    })
    expect(
      errorText(
        await s.call("answer_permission", {
          session_id: ID,
          request_id: "req_perm_1",
          decision: "allow",
        }),
      ),
    ).toMatch(/no longer waits/)
    expect(s.fake.posted).toHaveLength(1)
  })
})

describe("send_message's priority", () => {
  it("goes on the message as the CLI sends it", async () => {
    const s = setup()
    s.fake.addSession(ID)
    await s.ok("send_message", {
      session_id: ID,
      message: "after this",
      priority: "later",
    })
    expect(lastPosted(s).payload.priority).toBe("later")
    await s.ok("send_message", { session_id: ID, message: "plain" })
    expect(lastPosted(s).payload).not.toHaveProperty("priority")
    const result = await s
      .call("send_message", {
        session_id: ID,
        message: "x",
        priority: "urgent",
      })
      .catch((error: Error) => error)
    expect(result).toBeInstanceOf(Error)
  })
})

describe("archive, unarchive and rename", () => {
  it("archives, says when it already was, and unarchives", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(await s.ok("archive_session", { session_id: ID })).toEqual({
      archived: true,
      already: false,
    })
    expect(s.fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/code/sessions/${ID}/archive`,
      body: "{}",
    })
    expect(await s.ok("archive_session", { session_id: ID })).toEqual({
      archived: true,
      already: true,
    })
    expect(await s.ok("unarchive_session", { session_id: ID })).toEqual({
      unarchived: true,
    })
    expect(s.fake.sessions.get(ID)!.record.status).toBe("active")
  })

  it("says to unarchive on claude.ai when it asks for a trusted device", async () => {
    const s = setup()
    s.fake.addSession(ID, { status: "archived" }, { deviceBound: true })
    expect(
      errorText(await s.call("unarchive_session", { session_id: ID })),
    ).toMatch(/trusted device/)
  })

  it("renames with a PUT of the title alone", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(
      await s.ok("rename_session", { session_id: ID, title: "  Gate fixes " }),
    ).toEqual({ title: "Gate fixes" })
    expect(s.fake.requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/v1/code/sessions/${ID}`,
      body: JSON.stringify({ title: "Gate fixes" }),
    })
    expect(s.fake.sessions.get(ID)!.record.title).toBe("Gate fixes")
    for (const title of ["two\nlines", "bidi ‮", "zero​width", "   "]) {
      const result = await s
        .call("rename_session", { session_id: ID, title })
        .catch((error: Error) => error)
      expect(result, JSON.stringify(title)).toBeInstanceOf(Error)
    }
  })
})

describe("environments", () => {
  it("lists them by id, name and kind", async () => {
    const s = setup()
    expect(await s.ok("list_environments")).toEqual({
      environments: [
        { id: "env_01DefaultCloud", name: "Default", kind: "anthropic_cloud" },
        {
          id: "env_02NodeHeavy",
          name: "Node, more memory",
          kind: "anthropic_cloud",
        },
      ],
    })
    expect(s.fake.requests.at(-1)!.path).toBe(
      "/v1/environment_providers?limit=50",
    )
  })

  it("start_session runs in the one named, through the CLI's own setting", async () => {
    const s = setup()
    await s.ok("start_session", {
      repo: "kaperkunde/pcp",
      task: "go",
      environment_id: "env_02NodeHeavy",
    })
    const run = s.cliRuns().find((r) => r.kind === "cloud")!
    expect(run.args).toEqual([
      "-p",
      "--cloud",
      "--output-format",
      "json",
      "--settings",
      JSON.stringify({ remote: { defaultEnvironmentId: "env_02NodeHeavy" } }),
    ])
  })

  it("start_session refuses an environment the account does not have", async () => {
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
    expect(s.cliRuns()).toHaveLength(0)
  })
})

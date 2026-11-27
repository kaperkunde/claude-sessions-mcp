import { describe, expect, it } from "vitest"

import { API_BETA, API_VERSION } from "../src/api.ts"
import { toolSpecs } from "../src/tools.ts"
import { ORG } from "./fake-api.ts"
import { errorText, setup } from "./helpers.ts"

const ID = "cse_0123456789abcdef"

function busySession(s: ReturnType<typeof setup>) {
  s.fake.addSession(ID)
  s.fake.addEvent(ID, { type: "system", subtype: "init", model: "x" })
  s.fake.addEvent(ID, {
    type: "user",
    message: { role: "user", content: "Fix the flaky test in gate.test.ts" },
  })
  s.fake.addEvent(ID, {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "SECRET THOUGHTS" },
        { type: "text", text: "Looking at the gate tests." },
        { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  })
  s.fake.addEvent(ID, {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "TOOL OUTPUT" },
      ],
    },
  })
  s.fake.addEvent(ID, { type: "rate_limit_event", rate_limit_info: {} })
}

describe("the tools", () => {
  it("are seventeen, read tools marked read-only and the rest not", () => {
    const s = setup()
    const specs = toolSpecs(s.deps)
    const tiers = Object.fromEntries(
      specs.map((t) => [t.name, t.annotations.readOnlyHint]),
    )
    expect(tiers).toEqual({
      list_sessions: true,
      get_session: true,
      session_status: true,
      ask_session: true,
      list_environments: true,
      login_status: true,
      send_message: false,
      interrupt_session: false,
      compact_session: false,
      answer_permission: false,
      answer_question: false,
      start_session: false,
      archive_session: false,
      unarchive_session: false,
      rename_session: false,
      login_start: false,
      login_finish: false,
    })
    for (const spec of specs) {
      expect(spec.annotations.destructiveHint, spec.name).toBe(false)
      expect(Object.keys(spec.annotations).sort()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ])
      for (const [key, value] of Object.entries(spec.input.shape))
        expect(
          (value as { description?: string }).description,
          `${spec.name}.${key}`,
        ).toBeTruthy()
    }
  })

  it("list_sessions sends the API's headers and leaves archived ones out", async () => {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.addSession("cse_archived000001", { status: "archived" })
    const answer = await s.ok("list_sessions")
    expect(answer.sessions).toEqual([
      {
        id: ID,
        title: `Session ${ID}`,
        status: "active",
        updated_at: "2026-11-18T17:00:00Z",
        repo: "kaperkunde/pcp",
      },
    ])
    const all = await s.ok("list_sessions", { include_archived: true })
    expect(all.sessions).toHaveLength(2)
    const request = s.fake.requests.at(-1)!
    expect(request).toMatchObject({
      host: "api",
      method: "GET",
      path: "/v1/code/sessions?limit=20",
    })
    expect(request.headers).toMatchObject({
      "anthropic-version": API_VERSION,
      "anthropic-beta": API_BETA,
      "x-organization-uuid": ORG,
    })
  })

  it("session_status summarises the newest events, without thinking or tool results", async () => {
    const s = setup()
    busySession(s)
    const answer = await s.ok("session_status", {
      session_id: `https://claude.ai/code/${ID}`,
    })
    expect(answer.state).toBe("working")
    expect(answer.recent).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Looking at the gate tests.",
        tools: ["Bash"],
      }),
      expect.objectContaining({
        kind: "user",
        text: "Fix the flaky test in gate.test.ts",
      }),
    ])
    const text = JSON.stringify(answer)
    expect(text).not.toContain("SECRET THOUGHTS")
    expect(text).not.toContain("TOOL OUTPUT")
    expect(text).not.toContain("pnpm test")
    expect(s.fake.requests.at(-1)!.path).toBe(
      `/v1/code/sessions/${ID}/events?limit=30&sort_order=desc`,
    )
  })

  it("session_status says waiting after a turn ended, and done when archived", async () => {
    const s = setup()
    busySession(s)
    s.fake.addEvent(ID, {
      type: "result",
      subtype: "success",
      result: "Fixed it.",
    })
    s.fake.addEvent(ID, { type: "prompt_suggestion", suggestion: "push it" })
    const waiting = await s.ok("session_status", { session_id: ID })
    expect(waiting.state).toBe("waiting")
    expect((waiting.recent as unknown[])[0]).toMatchObject({
      kind: "result",
      outcome: "success",
      text: "Fixed it.",
    })
    s.fake.sessions.get(ID)!.record.worker_status = "requires_action"
    expect((await s.ok("session_status", { session_id: ID })).state).toBe(
      "needs_permission",
    )
    s.fake.sessions.get(ID)!.record.status = "archived"
    expect((await s.ok("session_status", { session_id: ID })).state).toBe(
      "done",
    )
  })

  it("ask_session posts a side question and polls until its answer", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { answerAfterPolls: 3 })
    const answer = await s.ok("ask_session", {
      session_id: ID,
      question: "What are you up to?",
    })
    expect(answer).toMatchObject({
      answered: true,
      answer: "Answer to: What are you up to?",
    })
    const posted = s.fake.posted[0]!.body as {
      events: { event_type: string; payload: Record<string, unknown> }[]
    }
    expect(posted.events).toHaveLength(1)
    expect(posted.events[0]!.event_type).toBe("control_request")
    expect(posted.events[0]!.payload).toMatchObject({
      type: "control_request",
      session_id: ID,
      request_id: answer.request_id,
      request: {
        subtype: "side_question",
        question: "What are you up to?",
        history: [],
      },
    })
    // Nothing was added to the conversation.
    expect(
      s.fake.sessions
        .get(ID)!
        .events.filter((e) => e.event_type !== "control_response"),
    ).toHaveLength(0)
  })

  it("ask_session answers answered:false when the session is silent past the time", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { silent: true })
    const started = s.clock.now()
    const answer = await s.ok("ask_session", {
      session_id: ID,
      question: "Anyone there?",
      timeout_seconds: 10,
    })
    expect(answer.answered).toBe(false)
    expect(s.clock.now() - started).toBeLessThanOrEqual(10_000)
  })

  it("ask_session passes on the session's refusal", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const result = await s.call("ask_session", {
      session_id: ID,
      question: "fail",
    })
    expect(errorText(result)).toBe("No context")
  })

  it("send_message posts a user message, after an interrupt when asked", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(
      await s.ok("send_message", { session_id: ID, message: "Also run lint" }),
    ).toEqual({ sent: true, interrupted: null })
    const first = s.fake.posted[0]!.body as {
      events: { event_type: string; payload: Record<string, unknown> }[]
    }
    expect(first.events[0]).toMatchObject({
      event_type: "user",
      payload: {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: "Also run lint" },
      },
    })

    expect(
      await s.ok("send_message", {
        session_id: ID,
        message: "Stop and push",
        interrupt_first: true,
      }),
    ).toEqual({ sent: true, interrupted: true })
    const kinds = s.fake.posted
      .slice(1)
      .map(
        (p) =>
          (p.body as { events: { event_type: string }[] }).events[0]!
            .event_type,
      )
    expect(kinds).toEqual(["control_request", "user"])
    const interrupt = (
      s.fake.posted[1]!.body as {
        events: { payload: { request: Record<string, unknown> } }[]
      }
    ).events[0]!.payload.request
    expect(interrupt).toEqual({
      subtype: "interrupt",
      cancel_queued: true,
      spare_background_tasks: true,
      send_now: true,
    })
  })

  it("interrupt_session says whether the session acknowledged it", async () => {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.addSession("cse_silentsession1", {}, { silent: true })
    expect(await s.ok("interrupt_session", { session_id: ID })).toEqual({
      sent: true,
      acknowledged: true,
    })
    expect(
      await s.ok("interrupt_session", { session_id: "cse_silentsession1" }),
    ).toEqual({ sent: true, acknowledged: false })
  })

  it("explains a device-bound session's 403", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { deviceBound: true })
    const result = await s.call("send_message", {
      session_id: ID,
      message: "hi",
    })
    expect(errorText(result)).toMatch(/bound to another device/)
  })

  it("refuses what is not a session id before anything is sent", async () => {
    const s = setup()
    for (const session_id of [
      "../../v1/oauth/token",
      "cse_",
      "https://evil.example/code/cse_0123456789",
      "cse_0123?limit=1",
    ]) {
      const result = await s.call("session_status", { session_id })
      expect(errorText(result)).toMatch(/not a session id/)
    }
    expect(s.fake.requests).toHaveLength(0)
  })

  it("says to sign in when there is no login, and sends nothing", async () => {
    const s = setup({ signedIn: false })
    const result = await s.call("list_sessions")
    expect(errorText(result)).toMatch(/login_start/)
    expect(s.fake.requests).toHaveLength(0)
    expect(await s.ok("login_status")).toMatchObject({
      signed_in: false,
      email: null,
      login_pending: false,
    })
  })

  it("login_status names the account, never a token", async () => {
    const s = setup()
    const status = await s.ok("login_status")
    expect(status).toMatchObject({
      signed_in: true,
      email: "owner@example.org",
      organization: "Owner's Organization",
      organization_uuid: ORG,
      plan: "max",
      renewable: true,
      login_pending: false,
    })
    expect(JSON.stringify(status)).not.toMatch(/sk-ant-/)
  })
})

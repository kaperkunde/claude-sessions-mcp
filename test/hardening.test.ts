import { EventEmitter } from "node:events"

import { describe, expect, it } from "vitest"

import { START_SESSION_MS } from "../src/cli.ts"
import { REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { EgressError, httpsTransport } from "../src/egress.ts"
import { itemOf } from "../src/events.ts"
import { errorText, GOOD_CODE, setup } from "./helpers.ts"

/** The review's findings on c22e9da, each pinned by a test. */

const ID = "cse_0123456789abcdef"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("API calls do not wait behind the CLI", () => {
  it("reads a fresh token outside the queue while a sign-in finishes", async () => {
    const s = setup({ fakeMode: "slow" })
    s.fake.addSession(ID)
    await s.ok("login_start")
    let finished = false
    const finishing = s.call("login_finish", { code: GOOD_CODE }).then((r) => {
      finished = true
      return r
    })
    // Give the finish time to take its place in the queue.
    await new Promise((r) => setTimeout(r, 200))
    const listed = await s.call("list_sessions")
    expect(listed.isError).toBeFalsy()
    expect(finished).toBe(false)
    expect((await finishing).isError).toBeFalsy()
  })
})

describe("login_start", () => {
  it("leaves one CLI running when it is called twice at once", async () => {
    const s = setup({ signedIn: false })
    const both = await Promise.all([
      s.call("login_start"),
      s.call("login_start"),
    ])
    for (const r of both) expect(r.isError).toBeFalsy()
    const pids = s
      .cliRuns()
      .filter((r) => r.kind === "login")
      .map((r) => r.pid as number)
    expect(pids).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 200))
    expect(pids.filter(alive)).toHaveLength(1)
    expect(
      (await s.call("login_finish", { code: GOOD_CODE })).isError,
    ).toBeFalsy()
  })
})

describe("ask_session in a busy session", () => {
  it("finds the answer however many events follow it", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { answerAfterPolls: 2, noiseAfterAnswer: 150 })
    for (let i = 0; i < 30; i++)
      s.fake.addEvent(ID, {
        type: "assistant",
        message: { content: [{ type: "text", text: `before ${i}` }] },
      })
    const answer = await s.ok("ask_session", {
      session_id: ID,
      question: "status?",
    })
    expect(answer).toMatchObject({
      answered: true,
      answer: "Answer to: status?",
    })
    const polls = s.fake.requests.filter(
      (r) => r.method === "GET" && r.path.includes("sort_order=asc"),
    )
    expect(polls.length).toBeGreaterThan(0)
    for (const poll of polls) expect(poll.path).toMatch(/cursor=\d+/)
  })
})

describe("summaries", () => {
  it("leave out synthetic and meta user messages, which can hold command output", () => {
    const user = (extra: Record<string, unknown>, text = "x") => ({
      event_type: "user",
      payload: {
        type: "user",
        message: { role: "user", content: text },
        ...extra,
      },
    })
    expect(itemOf(user({ isMeta: true }))).toBeUndefined()
    expect(itemOf(user({ isSynthetic: true }))).toBeUndefined()
    expect(itemOf(user({ isCompactSummary: true }))).toBeUndefined()
    expect(itemOf(user({ parent_tool_use_id: "toolu_1" }))).toBeUndefined()
    expect(itemOf(user({ tool_use_result: { stdout: "x" } }))).toBeUndefined()
    for (const text of [
      "<bash-stdout>AWS_SECRET=…</bash-stdout>",
      "<bash-stderr>x</bash-stderr>",
      "<bash-input>env</bash-input>",
      "<local-command-stdout>x</local-command-stdout>",
      "<local-command-stderr>x</local-command-stderr>",
      "<local-command-caveat>x</local-command-caveat>",
      "<command-name>/cost</command-name>",
      "<command-message>x</command-message>",
      "<system-reminder>x</system-reminder>",
      "  <user-prompt-submit-hook>x</user-prompt-submit-hook>",
      "This session is being continued from a previous conversation that ran out of context.",
    ])
      expect(itemOf(user({}, text)), text).toBeUndefined()
    expect(itemOf(user({ parent_tool_use_id: null }, "Fix it"))).toMatchObject({
      kind: "user",
      text: "Fix it",
    })
  })
})

describe("the transport", () => {
  it("gives up on a request at its deadline, whatever trickles in", async () => {
    let destroyed: Error | undefined
    const request = (() => {
      const req = new EventEmitter() as EventEmitter & {
        end(): void
        destroy(error: Error): void
      }
      req.end = () => {}
      req.destroy = (error: Error) => {
        destroyed = error
        req.emit("error", error)
      }
      return req
    }) as unknown as Parameters<typeof httpsTransport>[0] extends infer O
      ? O extends { request?: infer R }
        ? R
        : never
      : never
    const send = httpsTransport({ request })
    const started = Date.now()
    await expect(
      send({
        host: "api",
        method: "GET",
        path: "/v1/code/sessions?limit=1",
        headers: {},
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(EgressError)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(destroyed).toBeInstanceOf(EgressError)
  })

  it("hands ask_session's polls what is left of its time", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { silent: true })
    await s.ok("ask_session", {
      session_id: ID,
      question: "x",
      timeout_seconds: 5,
    })
    const polls = s.fake.requests.filter(
      (r) => r.method === "GET" && r.path.includes("/events"),
    )
    for (const poll of polls) {
      expect(poll.timeoutMs).toBeDefined()
      expect(poll.timeoutMs!).toBeLessThanOrEqual(5000)
    }
  })
})

describe("start_session", () => {
  it("refuses a task that would be a slash command", async () => {
    const s = setup()
    for (const task of ["/login", "  /config set x", "!cat ~/.claude"]) {
      expect(
        errorText(
          await s.call("start_session", { repo: "kaperkunde/pcp", task }),
        ),
      ).toMatch(/slash command|starts with/)
    }
    expect(s.cliRuns()).toHaveLength(0)
  })

  it("renews when the token would lapse while the CLI runs", async () => {
    const s = setup({
      expiresInMs: REFRESH_MARGIN_MS + START_SESSION_MS - 1000,
    })
    await s.ok("start_session", { repo: "kaperkunde/pcp", task: "go" })
    expect(s.fake.renewals).toBe(1)
  })
})

describe("a renewal that gets no answer", () => {
  it("says to sign in again, and never sends that refresh token again", async () => {
    const s = setup({
      expiresInMs: 1000,
      transport: (fake) => async (request) => {
        if (request.host === "auth") {
          // claude.ai rotated the token, but the answer was lost.
          await fake.transport(request)
          throw new EgressError("platform.claude.com did not answer in time.")
        }
        return fake.transport(request)
      },
    })
    s.fake.addSession(ID)
    expect(errorText(await s.call("list_sessions"))).toMatch(/login_start/)
    expect(errorText(await s.call("list_sessions"))).toMatch(/login_start/)
    expect(s.fake.requests.filter((r) => r.host === "auth")).toHaveLength(1)
    expect(s.fake.revoked).toBe(false)
  })
})

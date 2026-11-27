import { describe, expect, it } from "vitest"

import { API_BETA, API_VERSION } from "../src/api.ts"
import { COMPACT_ACK_MS, toolSpecs } from "../src/tools.ts"
import { ORG } from "./fake-api.ts"
import { errorText, setup } from "./helpers.ts"

/**
 * compact_session, against the fake API. The fake mirrors what the CLI
 * does with a user event: with no `anthropic-client-platform` it is text
 * from a peer, with the CLI's own a slash command runs.
 */

const ID = "cse_0123456789abcdef"

type Posted = {
  events: { event_type: string; payload: Record<string, any> }[] // eslint-disable-line @typescript-eslint/no-explicit-any
}

function userPosts(s: ReturnType<typeof setup>) {
  return s.fake.requests.filter(
    (r) => r.method === "POST" && r.path.endsWith("/events"),
  )
}

describe("compact_session", () => {
  it("sends /compact as the CLI's own client, and says the session compacted", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(await s.ok("compact_session", { session_id: ID })).toEqual({
      sent: true,
      command: "/compact",
      compacted: true,
    })
    const posts = userPosts(s)
    expect(posts).toHaveLength(1)
    const request = posts[0]!
    expect(request.path).toBe(`/v1/code/sessions/${ID}/events`)
    expect(request.headers).toMatchObject({
      Authorization: `Bearer ${s.fake.accessToken}`,
      "anthropic-version": API_VERSION,
      "anthropic-beta": API_BETA,
      "x-organization-uuid": ORG,
      "anthropic-client-platform": "claude_code_cli",
    })
    const body = JSON.parse(request.body!) as Posted
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({
      event_type: "user",
      payload: {
        type: "user",
        session_id: ID,
        parent_tool_use_id: null,
        message: { role: "user", content: "/compact" },
      },
    })
    expect(Object.keys(body.events[0]!.payload).sort()).toEqual([
      "message",
      "parent_tool_use_id",
      "session_id",
      "type",
      "uuid",
    ])
  })

  it("passes the instructions as /compact's argument, trimmed", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const answer = await s.ok("compact_session", {
      session_id: ID,
      instructions: "  keep the open TODOs and the failing test names \n",
    })
    expect(answer).toMatchObject({
      command: "/compact keep the open TODOs and the failing test names",
      compacted: true,
    })
    const body = JSON.parse(userPosts(s)[0]!.body!) as Posted
    expect(body.events[0]!.payload.message.content).toBe(
      "/compact keep the open TODOs and the failing test names",
    )
  })

  it("takes a claude.ai/code address and a blank instructions as none", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const answer = await s.ok("compact_session", {
      session_id: `https://claude.ai/code/${ID}`,
      instructions: "   ",
    })
    expect(answer).toMatchObject({ command: "/compact" })
  })

  it("only sees the compaction that follows its own command", async () => {
    const s = setup()
    s.fake.addSession(ID)
    s.fake.addEvent(ID, {
      type: "system",
      subtype: "compact_boundary",
    })
    s.fake.compactAfterPolls = 1_000_000
    const before = s.clock.now()
    const answer = await s.ok("compact_session", { session_id: ID })
    expect(answer).toMatchObject({ sent: true, compacted: false })
    // Bounded: it gave up at its deadline, not before and not long after.
    const waited = s.clock.now() - before
    expect(waited).toBeGreaterThanOrEqual(COMPACT_ACK_MS - 1)
    expect(waited).toBeLessThanOrEqual(COMPACT_ACK_MS + 2000)
  })

  it("is how /compact runs: the same text through send_message does not", async () => {
    const s = setup()
    s.fake.addSession(ID)
    await s.ok("send_message", { session_id: ID, message: "/compact" })
    const [request] = userPosts(s)
    expect(request!.headers).not.toHaveProperty("anthropic-client-platform")
    const page = await s.fake.transport({
      host: "api",
      method: "GET",
      path: `/v1/code/sessions/${ID}/events?limit=10&sort_order=asc`,
      headers: {
        Authorization: `Bearer ${s.fake.accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": API_BETA,
        "x-organization-uuid": ORG,
      },
    })
    expect(page.body).not.toContain("compact_boundary")
  })

  it("is a Write tool: not read-only, not destructive, not idempotent", () => {
    const s = setup()
    const spec = toolSpecs(s.deps).find((t) => t.name === "compact_session")!
    expect(spec.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(spec.description.length).toBeGreaterThan(40)
  })

  it("checks its input before anything is sent", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const refused = async (args: Record<string, unknown>) =>
      s.call("compact_session", args).then(
        (r) => (r.isError ? "tool error" : "ok"),
        () => "invalid",
      )
    expect(await refused({})).toBe("invalid")
    expect(await refused({ session_id: ID, instructions: 5 })).toBe("invalid")
    expect(
      await refused({ session_id: ID, instructions: "x".repeat(2001) }),
    ).toBe("invalid")
    expect(await refused({ session_id: ID, command: "/clear" })).toBe("invalid")
    expect(await refused({ session_id: "not-a-session" })).toBe("tool error")
    expect(s.fake.requests.filter((r) => r.host === "api")).toHaveLength(0)
  })

  it("says so when there is no such session", async () => {
    const s = setup()
    const result = await s.call("compact_session", { session_id: ID })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toMatch(/No such session/)
    expect(userPosts(s)).toHaveLength(0)
  })

  it("says so when the session wants a device's signature", async () => {
    const s = setup()
    s.fake.addSession(ID, {}, { deviceBound: true })
    const result = await s.call("compact_session", { session_id: ID })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toMatch(/another device/)
  })
})

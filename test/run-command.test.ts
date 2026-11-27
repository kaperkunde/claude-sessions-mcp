import { describe, expect, it } from "vitest"

import { API_BETA, API_VERSION } from "../src/api.ts"
import { DISPATCHED_COMMANDS, toolSpecs } from "../src/tools.ts"
import { ORG } from "./fake-api.ts"
import { errorText, setup } from "./helpers.ts"

const ID = "cse_0123456789abcdef"

function posts(s: ReturnType<typeof setup>) {
  return s.fake.requests.filter(
    (r) => r.method === "POST" && r.path.endsWith("/events"),
  )
}

describe("run_command", () => {
  it("sends the command as the CLI's own client", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(
      await s.ok("run_command", { session_id: ID, command: "/model sonnet" }),
    ).toEqual({ sent: true, command: "/model sonnet", compacted: null })
    const [request] = posts(s)
    expect(request!.path).toBe(`/v1/code/sessions/${ID}/events`)
    expect(request!.headers).toMatchObject({
      Authorization: `Bearer ${s.fake.accessToken}`,
      "anthropic-version": API_VERSION,
      "anthropic-beta": API_BETA,
      "x-organization-uuid": ORG,
      "anthropic-client-platform": "claude_code_cli",
    })
    const body = JSON.parse(request!.body!) as {
      events: { event_type: string; payload: Record<string, unknown> }[]
    }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({
      event_type: "user",
      payload: {
        type: "user",
        session_id: ID,
        parent_tool_use_id: null,
        message: { role: "user", content: "/model sonnet" },
      },
    })
    // Nothing but the one POST: no wait for a command with no known sign.
    expect(s.fake.requests.filter((r) => r.method === "GET")).toHaveLength(0)
  })

  it("watches for the compact boundary of /compact", async () => {
    const s = setup()
    s.fake.addSession(ID)
    expect(
      await s.ok("run_command", { session_id: ID, command: "/compact keep x" }),
    ).toEqual({ sent: true, command: "/compact keep x", compacted: true })
  })

  it("does not block commands the session may read as text", async () => {
    const s = setup()
    s.fake.addSession(ID)
    for (const command of ["/clear", "/not-a-command", "/review 12"])
      expect(
        await s.ok("run_command", { session_id: ID, command }),
      ).toMatchObject({ sent: true, command })
    expect(posts(s)).toHaveLength(3)
  })

  it("is marked destructive, and names the commands it knows run", () => {
    const s = setup()
    const spec = toolSpecs(s.deps).find((t) => t.name === "run_command")!
    expect(spec.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    for (const name of DISPATCHED_COMMANDS)
      expect(spec.description).toContain(name)
    expect(DISPATCHED_COMMANDS).toContain("/compact")
  })

  it("checks the command before anything is sent", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const bad = [
      "compact",
      "",
      "/",
      "/ compact",
      " /compact",
      "/compact\n/clear",
      "/compact\r",
      "/comp\u0000act",
      "/compact‮",
      "/" + "x".repeat(2000),
    ]
    for (const command of bad) {
      const result = await s
        .call("run_command", { session_id: ID, command })
        .catch((e: Error) => e)
      expect(result, JSON.stringify(command)).toBeInstanceOf(Error)
    }
    for (const args of [
      { session_id: ID },
      { command: "/compact" },
      { session_id: ID, command: "/compact", extra: 1 },
    ])
      expect(
        await s.call("run_command", args).catch((e: Error) => e),
      ).toBeInstanceOf(Error)
    const refused = await s.call("run_command", {
      session_id: "nope",
      command: "/compact",
    })
    expect(refused.isError).toBe(true)
    expect(s.fake.requests.filter((r) => r.host === "api")).toHaveLength(0)
  })

  it("maps the API's refusals", async () => {
    const s = setup()
    const missing = await s.call("run_command", {
      session_id: ID,
      command: "/usage",
    })
    expect(errorText(missing)).toMatch(/No such session/)
    s.fake.addSession(ID, {}, { deviceBound: true })
    const bound = await s.call("run_command", {
      session_id: ID,
      command: "/usage",
    })
    expect(errorText(bound)).toMatch(/another device/)
  })
})

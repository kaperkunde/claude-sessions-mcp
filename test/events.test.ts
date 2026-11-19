import { describe, expect, it } from "vitest"

import { sessionIdOf } from "../src/api.ts"
import {
  answerOf,
  clean,
  controlResponse,
  itemOf,
  stateOf,
  typeOf,
} from "../src/events.ts"

const wrap = (payload: Record<string, unknown>, seq = 1) => ({
  event_type: payload.type,
  sequence_num: seq,
  payload,
})

describe("reading events", () => {
  it("reads the type from the payload, or from event_type", () => {
    expect(typeOf(wrap({ type: "assistant" }))).toBe("assistant")
    expect(typeOf({ event_type: "user" })).toBe("user")
    expect(typeOf({})).toBeUndefined()
  })

  it("passes over thinking-only turns, tool results, rate limits and control traffic", () => {
    for (const payload of [
      { type: "assistant", message: { content: [{ type: "thinking" }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "x" }] },
      },
      { type: "rate_limit_event" },
      { type: "system", subtype: "init" },
      { type: "control_request", request: { subtype: "side_question" } },
      { type: "stream_event" },
    ])
      expect(itemOf(wrap(payload)), payload.type).toBeUndefined()
  })

  it("cuts long text and drops control characters", () => {
    const item = itemOf(
      wrap({
        type: "assistant",
        message: {
          content: [{ type: "text", text: `a\u0007b\n${"x".repeat(5000)}` }],
        },
      }),
    )!
    expect(item.text!.startsWith("ab\nxxx")).toBe(true)
    expect(item.text!.length).toBeLessThanOrEqual(1201)
    expect(clean("\u001b[31mred", 10)).toBe("[31mred")
  })

  it("works out the state from the newest events", () => {
    const newestFirst = (...types: string[]) =>
      types.map((type, i) => wrap({ type }, 100 - i))
    expect(stateOf(newestFirst("assistant", "result"))).toBe("working")
    expect(stateOf(newestFirst("result", "assistant"))).toBe("waiting")
    expect(stateOf(newestFirst("rate_limit_event", "prompt_suggestion"))).toBe(
      "waiting",
    )
    expect(stateOf(newestFirst("user", "result"))).toBe("working")
    expect(stateOf([])).toBe("unknown")
    expect(stateOf(newestFirst("assistant"), { status: "archived" })).toBe(
      "done",
    )
    expect(
      stateOf(newestFirst("assistant"), { worker_status: "requires_action" }),
    ).toBe("needs_permission")
  })

  it("finds the control_response to one request", () => {
    const events = [
      wrap({
        type: "control_response",
        response: { subtype: "success", request_id: "other" },
      }),
      wrap({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "mine",
          response: { answer: "Hi" },
        },
      }),
    ]
    expect(controlResponse(events, "mine")).toMatchObject({
      request_id: "mine",
    })
    expect(controlResponse(events, "none")).toBeUndefined()
  })

  it("reads an answer under the usual keys, or the error", () => {
    expect(answerOf({ subtype: "success", response: { answer: "A" } })).toEqual(
      {
        ok: true,
        answer: "A",
      },
    )
    expect(answerOf({ subtype: "success", response: { text: "B" } })).toEqual({
      ok: true,
      answer: "B",
    })
    expect(
      answerOf({
        subtype: "success",
        response: {
          content: [
            { type: "text", text: "C" },
            { type: "text", text: "D" },
          ],
        },
      }),
    ).toEqual({ ok: true, answer: "C\nD" })
    expect(answerOf({ subtype: "success", response: "E" })).toEqual({
      ok: true,
      answer: "E",
    })
    expect(answerOf({ subtype: "error", error: "Busy" })).toEqual({
      ok: false,
      error: "Busy",
    })
    expect(answerOf({ subtype: "success", response: {} }).ok).toBe(false)
  })

  it("takes a session id, or a claude.ai/code address that ends in one", () => {
    expect(sessionIdOf("cse_0123456789")).toBe("cse_0123456789")
    expect(sessionIdOf(" session_abcdef123 ")).toBe("session_abcdef123")
    expect(sessionIdOf("https://claude.ai/code/cse_0123456789?from=cli")).toBe(
      "cse_0123456789",
    )
    expect(sessionIdOf("https://claude.ai.evil/code/cse_0123456789")).toBe(
      undefined,
    )
    expect(sessionIdOf("cse_01234/../x")).toBeUndefined()
  })
})

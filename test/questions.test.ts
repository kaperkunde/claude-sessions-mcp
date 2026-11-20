import { describe, expect, it } from "vitest"

import { stateOf } from "../src/events.ts"
import { errorText, setup } from "./helpers.ts"

/**
 * A session waiting on AskUserQuestion: needs_answer, its questions shown
 * as pending_question, and answer_question answering them as the CLI
 * does. And a session whose worker lost contact: stalled.
 */

const ID = "cse_0123456789abcdef"

type Posted = {
  events: { event_type: string; payload: Record<string, unknown> }[]
}

function lastPosted(s: ReturnType<typeof setup>) {
  return (s.fake.posted.at(-1)!.body as Posted).events[0]!
}

const COLOUR = {
  question: "Which colour should the button be?",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Red", description: "Loud" },
    { label: "Blue, dark", description: "Calm" },
  ],
}

const TARGETS = {
  question: "Where should it deploy?",
  header: "Targets",
  multiSelect: true,
  options: [
    { label: "Staging", description: "First" },
    { label: "Blue, dark", description: "The dark pool" },
    { label: 'Say "hi"', description: "Quoted" },
  ],
}

function asking(
  questions: Record<string, unknown>[] = [COLOUR],
  s = setup(),
  extra: Record<string, unknown> = {},
) {
  s.fake.addSession(ID)
  s.fake.askQuestion(ID, {
    requestId: "req_q_1",
    input: { questions, ...extra },
  })
  return s
}

function answer(
  s: ReturnType<typeof setup>,
  answers: Record<string, unknown>[],
  more: Record<string, unknown> = {},
) {
  return s.call("answer_question", {
    session_id: ID,
    request_id: "req_q_1",
    answers,
    ...more,
  })
}

describe("the state", () => {
  it("is needs_answer for a question, before needs_permission", () => {
    expect(
      stateOf([], {
        worker_status: "requires_action",
        external_metadata: {
          pending_action: { request_id: "r", tool_name: "AskUserQuestion" },
        },
      }),
    ).toBe("needs_answer")
    expect(
      stateOf([], {
        worker_status: "requires_action",
        external_metadata: {
          pending_action: { request_id: "r", tool_name: "Bash" },
        },
      }),
    ).toBe("needs_permission")
  })

  it("is stalled while the worker runs but lost contact", () => {
    expect(
      stateOf([], {
        worker_status: "running",
        connection_status: "disconnected",
      }),
    ).toBe("stalled")
    expect(
      stateOf([{ payload: { type: "assistant" } }], {
        worker_status: "running",
        connection_status: "connected",
      }),
    ).toBe("working")
    expect(
      stateOf([{ payload: { type: "result" } }], {
        worker_status: "idle",
        connection_status: "disconnected",
      }),
    ).toBe("waiting")
  })

  it("is needs_answer on a real record, whatever else it says", async () => {
    const s = asking()
    const record = s.fake.sessions.get(ID)!.record
    record.connection_status = "disconnected"
    s.fake.addEvent(ID, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Asking you." }] },
    })
    const status = await s.ok("session_status", { session_id: ID })
    expect(status.state).toBe("needs_answer")
    expect(status.pending_question).not.toBeNull()
    expect(status.pending_permission).toBeNull()
  })

  it("is needs_permission, never needs_answer, for a question it cannot read", async () => {
    const s = asking()
    const pending = (
      s.fake.sessions.get(ID)!.record.external_metadata as {
        pending_action: Record<string, unknown>
      }
    ).pending_action
    pending.request_id = "not an id!"
    const status = await s.ok("session_status", { session_id: ID })
    expect(status.state).toBe("needs_permission")
    expect(status.pending_question).toBeNull()
    expect(status.pending_permission).toBeNull()
    expect(
      stateOf([], {
        worker_status: "requires_action",
        external_metadata: {
          pending_action: { tool_name: "AskUserQuestion" },
        },
      }),
    ).toBe("needs_permission")
  })

  it("is done when archived, even while stalled", () => {
    expect(
      stateOf([{ payload: { type: "assistant" } }], {
        status: "archived",
        worker_status: "running",
        connection_status: "disconnected",
      }),
    ).toBe("done")
  })

  it("shows a stalled session and its connection_status", async () => {
    const s = setup()
    s.fake.addSession(ID, {
      worker_status: "running",
      connection_status: "disconnected",
    })
    s.fake.addEvent(ID, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working." }] },
    })
    const status = await s.ok("session_status", { session_id: ID })
    expect(status.state).toBe("stalled")
    expect(status.pending_question).toBeNull()
    expect(status.pending_permission).toBeNull()
    const detail = (await s.ok("get_session", { session_id: ID })).session as {
      connection_status: string | null
      pending_question: unknown
    }
    expect(detail.connection_status).toBe("disconnected")
    expect(detail.pending_question).toBeNull()
  })

  it("leaves connection_status null when the record has none", async () => {
    const s = setup()
    s.fake.addSession(ID)
    const detail = (await s.ok("get_session", { session_id: ID })).session as {
      connection_status: string | null
    }
    expect(detail.connection_status).toBeNull()
  })
})

describe("pending_question", () => {
  it("shows the questions, never as a permission prompt", async () => {
    const s = asking([COLOUR, TARGETS])
    const status = await s.ok("session_status", { session_id: ID })
    expect(status.state).toBe("needs_answer")
    expect(status.pending_permission).toBeNull()
    const expected = {
      request_id: "req_q_1",
      questions: [
        {
          question: COLOUR.question,
          header: "Colour",
          kind: "choice",
          multi_select: false,
          options: [
            { label: "Red", description: "Loud", preview: null },
            { label: "Blue, dark", description: "Calm", preview: null },
          ],
        },
        {
          question: TARGETS.question,
          header: "Targets",
          kind: "choice",
          multi_select: true,
          options: [
            { label: "Staging", description: "First", preview: null },
            {
              label: "Blue, dark",
              description: "The dark pool",
              preview: null,
            },
            { label: 'Say "hi"', description: "Quoted", preview: null },
          ],
        },
      ],
      input_withheld: null,
    }
    expect(status.pending_question).toEqual(expected)
    const detail = (await s.ok("get_session", { session_id: ID })).session as {
      pending_question: unknown
      pending_permission: unknown
    }
    expect(detail.pending_question).toEqual(expected)
    expect(detail.pending_permission).toBeNull()
  })

  it("reads the questions from the prompt's event when the record has none", async () => {
    const s = asking([COLOUR], setup(), { metadata: { source: "event" } })
    const metadata = s.fake.sessions.get(ID)!.record.external_metadata as {
      pending_action: Record<string, unknown>
    }
    delete metadata.pending_action.input
    const status = await s.ok("session_status", { session_id: ID })
    const pending = status.pending_question as { questions: unknown[] }
    expect(pending.questions).toHaveLength(1)
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Red"] }],
    })
    const sent = lastPosted(s).payload.response as {
      response: { updatedInput: unknown }
    }
    expect(sent.response.updatedInput).toEqual({
      questions: [COLOUR],
      metadata: { source: "event" },
      answers: { [COLOUR.question]: "Red" },
    })
  })

  it("shows a preview indented with tabs or with CRLF line ends", async () => {
    const preview = "func main() {\r\n\tfmt.Println(1)\r\n}"
    const s = asking([
      {
        question: "Which version?",
        header: "Version",
        options: [
          { label: "Go", description: "Tabs", preview },
          { label: "Make", description: "Rules", preview: "all:\n\tgo build" },
        ],
      },
    ])
    const pending = (await s.ok("session_status", { session_id: ID }))
      .pending_question as {
      input_withheld: string | null
      questions: { options: { preview: string | null }[] }[]
    }
    expect(pending.input_withheld).toBeNull()
    expect(pending.questions[0]?.options[0]?.preview).toBe(preview)
  })

  it("shows each question's kind and each option's preview", async () => {
    const s = asking([
      {
        question: "Which layout?",
        header: "Layout",
        kind: "choice",
        options: [
          { label: "Grid", description: "Rows", preview: "[ ][ ]\n[ ][ ]" },
          { label: "List", description: "One column" },
        ],
      },
      { question: "What should it be called?", header: "Name", kind: "text" },
      {
        question: "How many slides?",
        header: "Slides",
        kind: "number",
        min: 1,
        max: 20,
        options: [],
      },
    ])
    const pending = (await s.ok("session_status", { session_id: ID }))
      .pending_question as { questions: unknown[] }
    expect(pending.questions).toEqual([
      {
        question: "Which layout?",
        header: "Layout",
        kind: "choice",
        multi_select: false,
        options: [
          { label: "Grid", description: "Rows", preview: "[ ][ ]\n[ ][ ]" },
          { label: "List", description: "One column", preview: null },
        ],
      },
      {
        question: "What should it be called?",
        header: "Name",
        kind: "text",
        multi_select: false,
        options: [],
      },
      {
        question: "How many slides?",
        header: "Slides",
        kind: "number",
        multi_select: false,
        options: [],
      },
    ])
  })

  for (const [name, question] of [
    ["a kind it does not know", { ...COLOUR, kind: "date" }],
    ["a text question with options", { ...COLOUR, kind: "text" }],
  ] as const) {
    it(`withholds ${name} as unreadable`, async () => {
      const s = asking([question])
      const pending = (await s.ok("session_status", { session_id: ID }))
        .pending_question as { input_withheld: string | null }
      expect(pending.input_withheld).toMatch(/could not be read/)
    })
  }

  for (const [name, questions, reason] of [
    [
      "too long",
      [{ ...COLOUR, header: "x".repeat(5000) }],
      /too long to show whole/,
    ],
    [
      "secret-looking",
      [
        {
          ...COLOUR,
          question:
            "Use the key sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123 for it?",
        },
      ],
      /secret/,
    ],
    [
      "bidi",
      [{ ...COLOUR, question: "Deploy ‮to prod?" }],
      /bidi or zero-width/,
    ],
    [
      "zero-width",
      [
        {
          ...COLOUR,
          options: [
            { label: "Re​d", description: "x" },
            { label: "Blue", description: "y" },
          ],
        },
      ],
      /bidi or zero-width/,
    ],
    [
      "a too long preview's",
      [
        {
          ...COLOUR,
          options: [
            { label: "Red", preview: "x".repeat(5000) },
            { label: "Blue" },
          ],
        },
      ],
      /too long to show whole/,
    ],
    [
      "a secret-looking preview's",
      [
        {
          ...COLOUR,
          options: [
            {
              label: "Red",
              preview: "token = sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123",
            },
            { label: "Blue" },
          ],
        },
      ],
      /secret/,
    ],
    [
      "a zero-width preview's",
      [
        {
          ...COLOUR,
          options: [{ label: "Red", preview: "Re​d" }, { label: "Blue" }],
        },
      ],
      /bidi or zero-width/,
    ],
    [
      "a control character preview's",
      [
        {
          ...COLOUR,
          options: [{ label: "Red", preview: "Red\u0007" }, { label: "Blue" }],
        },
      ],
      /control characters/,
    ],
  ] as const) {
    it(`withholds ${name} questions, which cannot be answered from here`, async () => {
      const s = asking([...questions] as Record<string, unknown>[])
      const status = await s.ok("session_status", { session_id: ID })
      const pending = status.pending_question as {
        questions: unknown[]
        input_withheld: string | null
      }
      expect(status.state).toBe("needs_answer")
      expect(pending.questions).toEqual([])
      expect(pending.input_withheld).toMatch(reason)
      expect(JSON.stringify(status)).not.toContain("sk-ant-")
      const result = await answer(s, [
        { question: COLOUR.question, choices: ["Red"] },
      ])
      expect(errorText(result)).toMatch(/claude\.ai\/code/)
      expect(s.fake.posted).toHaveLength(0)
      // A decline needs nothing shown.
      await s.ok("answer_question", {
        session_id: ID,
        request_id: "req_q_1",
        answers: [],
        decline: "Not from here.",
      })
      expect(s.fake.posted).toHaveLength(1)
    })
  }

  it("withholds questions it cannot read", async () => {
    const s = asking([{ question: "No options at all", options: "x" }])
    const pending = (await s.ok("session_status", { session_id: ID }))
      .pending_question as { input_withheld: string | null }
    expect(pending.input_withheld).toMatch(/could not be read/)
  })
})

describe("answer_question", () => {
  it("sends the chosen label as the CLI answers", async () => {
    const s = asking([COLOUR], setup(), { metadata: { source: "x" } })
    const result = await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Blue, dark"] }],
    })
    expect(result).toEqual({
      sent: true,
      declined: false,
      answers: [{ question: COLOUR.question, answer: "Blue, dark" }],
    })
    const event = lastPosted(s)
    expect(event.event_type).toBe("control_response")
    expect(event.payload.type).toBe("control_response")
    expect(event.payload.response).toEqual({
      subtype: "success",
      request_id: "req_q_1",
      response: {
        behavior: "allow",
        updatedInput: {
          questions: [COLOUR],
          metadata: { source: "x" },
          answers: { [COLOUR.question]: "Blue, dark" },
        },
        toolUseID: "toolu_req_q_1",
      },
    })
    expect(s.fake.sessions.get(ID)!.record.worker_status).toBe("running")
  })

  it("joins several choices with the CLI's join, quoting where it does", async () => {
    const s = asking([COLOUR, TARGETS])
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [
        {
          question: TARGETS.question,
          choices: ["Staging", "Blue, dark", 'Say "hi"'],
        },
        { question: COLOUR.question, choices: ["Red"] },
      ],
    })
    const sent = lastPosted(s).payload.response as {
      response: { updatedInput: { answers: Record<string, string> } }
    }
    expect(sent.response.updatedInput.answers).toEqual({
      [COLOUR.question]: "Red",
      [TARGETS.question]: 'Staging, "Blue, dark", "Say \\"hi\\""',
    })
  })

  it("sends a free answer as typed, only on its own", async () => {
    const s = asking([COLOUR])
    expect(
      errorText(
        await answer(s, [
          { question: COLOUR.question, choices: ["Red"], text: "Green" },
        ]),
      ),
    ).toMatch(/text/)
    expect(s.fake.posted).toHaveLength(0)
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, text: "Green, like grass" }],
    })
    const sent = lastPosted(s).payload.response as {
      response: { updatedInput: { answers: Record<string, string> } }
    }
    expect(sent.response.updatedInput.answers).toEqual({
      [COLOUR.question]: "Green, like grass",
    })
  })

  it("takes text beside choices on a multi_select question, joined as the CLI joins them", async () => {
    const s = asking([TARGETS])
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [
        {
          question: TARGETS.question,
          choices: ["Staging", "Blue, dark"],
          text: "Prod, eu",
        },
      ],
    })
    const sent = lastPosted(s).payload.response as {
      response: { updatedInput: { answers: Record<string, string> } }
    }
    expect(sent.response.updatedInput.answers).toEqual({
      [TARGETS.question]: 'Staging, "Blue, dark", "Prod, eu"',
    })
  })

  it("answers a text or number question with text only", async () => {
    const NAME = { question: "What should it be called?", kind: "text" }
    const COUNT = {
      question: "How many slides?",
      kind: "number",
      min: 1,
      max: 20,
    }
    const s = asking([NAME, COUNT])
    expect(
      errorText(
        await answer(s, [
          { question: NAME.question, choices: ["Deck"] },
          { question: COUNT.question, text: "12" },
        ]),
      ),
    ).toMatch(/text only/)
    expect(s.fake.posted).toHaveLength(0)
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [
        { question: NAME.question, text: "Quarterly, final" },
        { question: COUNT.question, text: "12" },
      ],
    })
    const sent = lastPosted(s).payload.response as {
      response: { updatedInput: { answers: Record<string, string> } }
    }
    expect(sent.response.updatedInput.answers).toEqual({
      [NAME.question]: "Quarterly, final",
      [COUNT.question]: "12",
    })
  })

  it("leaves toolUseID out when the prompt carries no tool_use_id", async () => {
    const s = asking()
    const pending = (
      s.fake.sessions.get(ID)!.record.external_metadata as {
        pending_action: Record<string, unknown>
      }
    ).pending_action
    delete pending.tool_use_id
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Red"] }],
    })
    const sent = lastPosted(s).payload.response as {
      response: Record<string, unknown>
    }
    expect(sent.response).not.toHaveProperty("toolUseID")
  })

  it("answers once when two calls come at once", async () => {
    const s = asking()
    s.fake.lagging = true
    const args = {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Red"] }],
    }
    const results = await Promise.all([
      s.call("answer_question", args),
      s.call("answer_question", args),
    ])
    expect(results.filter((r) => !r.isError)).toHaveLength(1)
    const refused = results.find((r) => r.isError)
    expect(refused && errorText(refused)).toMatch(/already answered/)
    expect(s.fake.posted).toHaveLength(1)
  })

  it("declines with the owner's message", async () => {
    const s = asking()
    expect(
      errorText(
        await answer(s, [{ question: COLOUR.question, choices: ["Red"] }], {
          decline: "No",
        }),
      ),
    ).toMatch(/decline/)
    expect(s.fake.posted).toHaveLength(0)
    const result = await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [],
      decline: "Ask me later.",
    })
    expect(result).toEqual({ sent: true, declined: true, answers: [] })
    expect(lastPosted(s).payload.response).toEqual({
      subtype: "success",
      request_id: "req_q_1",
      response: {
        behavior: "deny",
        message: "Ask me later.",
        toolUseID: "toolu_req_q_1",
      },
    })
  })

  const refusals: [string, Record<string, unknown>[], RegExp][] = [
    ["no answers", [], /every question/],
    [
      "a question left out",
      [{ question: COLOUR.question, choices: ["Red"] }],
      /every question/,
    ],
    [
      "a question answered twice",
      [
        { question: COLOUR.question, choices: ["Red"] },
        { question: COLOUR.question, choices: ["Red"] },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /once/,
    ],
    [
      "a question not asked",
      [
        { question: "Which colour should the button be? ", choices: ["Red"] },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /not one of its questions/,
    ],
    [
      "a choice that is not a label",
      [
        { question: COLOUR.question, choices: ["red"] },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /not one of the labels/,
    ],
    [
      "two choices on a single choice",
      [
        { question: COLOUR.question, choices: ["Red", "Blue, dark"] },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /one choice/,
    ],
    [
      "the same choice twice",
      [
        { question: COLOUR.question, choices: ["Red"] },
        { question: TARGETS.question, choices: ["Staging", "Staging"] },
      ],
      /twice/,
    ],
    [
      "neither choices nor text",
      [
        { question: COLOUR.question },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /choices or text/,
    ],
    [
      "empty choices",
      [
        { question: COLOUR.question, choices: [] },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /choices or text/,
    ],
    [
      "a text that does not show as it is",
      [
        { question: COLOUR.question, text: "Gre​en" },
        { question: TARGETS.question, choices: ["Staging"] },
      ],
      /do not show/,
    ],
    [
      "answers longer than the CLI takes",
      [
        { question: COLOUR.question, text: "x".repeat(20000) },
        { question: TARGETS.question, text: "y".repeat(20000) },
      ],
      /32768/,
    ],
  ]
  for (const [name, answers, reason] of refusals) {
    it(`refuses ${name} before anything is sent`, async () => {
      const s = asking([COLOUR, TARGETS])
      expect(errorText(await answer(s, answers))).toMatch(reason)
      expect(s.fake.posted).toHaveLength(0)
      expect(s.fake.sessions.get(ID)!.record.worker_status).toBe(
        "requires_action",
      )
    })
  }

  it("answers only the live question, and only once", async () => {
    const s = asking()
    expect(
      errorText(
        await s.call("answer_question", {
          session_id: ID,
          request_id: "req_other",
          answers: [{ question: COLOUR.question, choices: ["Red"] }],
        }),
      ),
    ).toMatch(/no longer waits on that question/)
    s.fake.lagging = true
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Red"] }],
    })
    expect(
      errorText(
        await answer(s, [{ question: COLOUR.question, choices: ["Red"] }]),
      ),
    ).toMatch(/already answered/)
    // The answered set is the one answer_permission keeps.
    expect(
      errorText(
        await s.call("answer_permission", {
          session_id: ID,
          request_id: "req_q_1",
          decision: "deny",
        }),
      ),
    ).toMatch(/already answered/)
    expect(s.fake.posted).toHaveLength(1)
  })

  it("can answer again when the answer did not go in", async () => {
    const s = asking()
    s.fake.sessions.get(ID)!.deviceBound = true
    expect(
      (await answer(s, [{ question: COLOUR.question, choices: ["Red"] }]))
        .isError,
    ).toBe(true)
    s.fake.sessions.get(ID)!.deviceBound = false
    await s.ok("answer_question", {
      session_id: ID,
      request_id: "req_q_1",
      answers: [{ question: COLOUR.question, choices: ["Red"] }],
    })
    expect(s.fake.posted).toHaveLength(1)
  })

  it("refuses a permission prompt, and answer_permission refuses a question", async () => {
    const s = asking()
    for (const decision of ["allow", "deny"]) {
      expect(
        errorText(
          await s.call("answer_permission", {
            session_id: ID,
            request_id: "req_q_1",
            decision,
            expected_input: JSON.stringify({ questions: [COLOUR] }),
          }),
        ),
      ).toMatch(/answer_question/)
    }
    const p = setup()
    p.fake.addSession(ID)
    p.fake.askPermission(ID, {
      requestId: "req_perm_1",
      toolName: "Bash",
      description: "Run the tests",
      input: { command: "pnpm test" },
    })
    expect(
      errorText(
        await p.call("answer_question", {
          session_id: ID,
          request_id: "req_perm_1",
          answers: [],
          decline: "no",
        }),
      ),
    ).toMatch(/answer_permission/)
    expect(s.fake.posted).toHaveLength(0)
    expect(p.fake.posted).toHaveLength(0)
  })
})

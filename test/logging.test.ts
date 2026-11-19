import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { REFRESH_MARGIN_MS } from "../src/credentials.ts"
import { redact } from "../src/log.ts"
import { FIRST_ACCESS, FIRST_REFRESH } from "./fake-api.ts"
import { GOOD_CODE, setup } from "./helpers.ts"

const ID = "cse_0123456789abcdef"

describe("tokens and codes", () => {
  it("never reach a log line or an answer, through a whole run", async () => {
    const s = setup({ expiresInMs: REFRESH_MARGIN_MS - 1 })
    s.fake.addSession(ID)
    s.fake.addEvent(ID, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it." }] },
    })
    const answers: unknown[] = []
    answers.push(await s.call("list_sessions"))
    answers.push(await s.call("session_status", { session_id: ID }))
    answers.push(
      await s.call("ask_session", { session_id: ID, question: "status?" }),
    )
    answers.push(
      await s.call("send_message", {
        session_id: ID,
        message: "go on",
        interrupt_first: true,
      }),
    )
    answers.push(await s.call("interrupt_session", { session_id: ID }))
    s.fake.askPermission(ID, {
      requestId: "req_perm_1",
      toolName: "Bash",
      description: "Run it",
      input: { command: "echo hi" },
    })
    answers.push(await s.call("get_session", { session_id: ID }))
    answers.push(
      await s.call("answer_permission", {
        session_id: ID,
        request_id: "req_perm_1",
        decision: "allow",
        expected_input: '{"command":"echo hi"}',
      }),
    )
    answers.push(await s.call("list_environments"))
    answers.push(
      await s.call("rename_session", { session_id: ID, title: "Renamed" }),
    )
    answers.push(await s.call("archive_session", { session_id: ID }))
    answers.push(await s.call("unarchive_session", { session_id: ID }))
    answers.push(
      await s.call("start_session", { repo: "kaperkunde/pcp", task: "x" }),
    )
    answers.push(await s.call("login_status"))
    answers.push(await s.call("login_start"))
    answers.push(await s.call("login_finish", { code: GOOD_CODE }))
    answers.push(await s.call("login_status"))
    // An API failure's words stay out of the log too.
    answers.push(
      await s.call("session_status", { session_id: "cse_missing00" }),
    )

    const onFile = JSON.parse(
      readFileSync(join(s.dir, ".credentials.json"), "utf8"),
    ) as { claudeAiOauth: { accessToken: string; refreshToken: string } }
    const secrets = [
      FIRST_ACCESS,
      FIRST_REFRESH,
      s.fake.accessToken,
      s.fake.refreshToken,
      onFile.claudeAiOauth.accessToken,
      onFile.claudeAiOauth.refreshToken,
      GOOD_CODE,
      "goodcode0123456789",
    ]
    const log = s.lines.join("\n")
    const said = JSON.stringify(answers)
    expect(s.lines.length).toBeGreaterThan(5)
    for (const secret of secrets) {
      expect(log).not.toContain(secret)
      expect(said).not.toContain(secret)
    }
    expect(log).not.toMatch(/sk-ant-/)
    expect(said).not.toMatch(/sk-ant-/)
    // No session text in the log either.
    expect(log).not.toContain("Working on it")
    expect(log).not.toContain("status?")
    expect(log).not.toContain("Renamed")
    expect(log).not.toContain("echo hi")
  })

  it("redact masks tokens, bearer headers and sign-in codes", () => {
    expect(redact("token sk-ant-oat01-abc_DEF-123 ok")).toBe("token [token] ok")
    expect(redact("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer [token]",
    )
    expect(redact(`code ${GOOD_CODE}`)).toBe("code [code]")
    expect(redact("a".repeat(40))).toBe("[token]")
    expect(redact("GET /v1/code/sessions/cse_0123 200")).toBe(
      "GET /v1/code/sessions/cse_0123 200",
    )
  })
})

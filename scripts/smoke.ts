/**
 * The smoke test, against the real sessions API, through a running
 * service (never with a login of its own: the service's login is the only
 * one, and its refresh token rotates). Run it after every Claude Code CLI
 * update, from a checkout, with the service's port reachable:
 *
 *   MCP_URL=http://127.0.0.1:8080/mcp MCP_AUTH_TOKEN=… \
 *   SMOKE_SESSION=cse_… pnpm smoke
 *
 * SMOKE_SESSION is a scratch session of your own (start one on claude.ai/code
 * and leave it idle): the smoke test reads it and asks it a side question,
 * which adds nothing to its conversation. With SMOKE_WRITE=1 it also sends
 * that session a message and interrupts it; with SMOKE_START_REPO=owner/name
 * it starts a new session there (it then works, on your plan: archive it
 * afterwards). Nothing else is touched.
 *
 * Every step prints PASS or FAIL with its time; the exit code is the number
 * of failures.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

const url = process.env.MCP_URL ?? "http://127.0.0.1:8080/mcp"
const token = process.env.MCP_AUTH_TOKEN
const session = process.env.SMOKE_SESSION
const write = process.env.SMOKE_WRITE === "1"
const startRepo = process.env.SMOKE_START_REPO

type Answer = { ok: boolean; data: Record<string, unknown>; text: string }

const client = new Client({ name: "claude-sessions-smoke", version: "1" })
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
  }),
)

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as { type: string; text?: string }[]
  return {
    ok: !result.isError,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: content.map((c) => c.text ?? "").join("\n"),
  }
}

let failures = 0
async function step(
  label: string,
  run: () => Promise<string | false>,
): Promise<void> {
  const started = Date.now()
  let outcome: string | false
  try {
    outcome = await run()
  } catch (error) {
    outcome = false
    console.log(`  ${(error as Error).message}`)
  }
  const ms = Date.now() - started
  if (outcome === false) failures++
  console.log(
    `${outcome === false ? "FAIL" : "PASS"}  ${label} (${ms} ms)${outcome ? `: ${outcome}` : ""}`,
  )
}

function fail(answer: Answer): false {
  console.log(`  ${answer.text}`)
  return false
}

await step("signed in", async () => {
  const status = await call("login_status")
  if (!status.ok || status.data.signed_in !== true) return fail(status)
  return `${String(status.data.email)} (${String(status.data.organization)}), access until ${String(status.data.access_expires_at)}`
})

await step("list_sessions", async () => {
  const list = await call("list_sessions", { limit: 5, include_archived: true })
  if (!list.ok || !Array.isArray(list.data.sessions)) return fail(list)
  return `${list.data.sessions.length} sessions`
})

if (session) {
  await step("session_status", async () => {
    const status = await call("session_status", {
      session_id: session,
      events: 10,
    })
    if (!status.ok) return fail(status)
    return `state ${String(status.data.state)}, ${(status.data.recent as unknown[]).length} items`
  })

  await step("ask_session (side question)", async () => {
    const asked = await call("ask_session", {
      session_id: session,
      question: "Smoke test: reply with the single word pong.",
      timeout_seconds: 90,
    })
    if (!asked.ok) return fail(asked)
    if (asked.data.answered !== true || !asked.data.answer)
      return fail({ ...asked, text: "No answer within 90 seconds." })
    return `answered in ${String(asked.data.waited_seconds)} s: ${String(asked.data.answer).slice(0, 80)}`
  })

  if (write) {
    await step("send_message", async () => {
      const sent = await call("send_message", {
        session_id: session,
        message:
          "Smoke test of claude-sessions-mcp: reply ok and do nothing else.",
      })
      return sent.ok ? "sent" : fail(sent)
    })
    await step("interrupt_session", async () => {
      const stopped = await call("interrupt_session", { session_id: session })
      if (!stopped.ok) return fail(stopped)
      return `acknowledged: ${String(stopped.data.acknowledged)}`
    })
  }
} else {
  console.log("SKIP  session_status and ask_session: set SMOKE_SESSION")
}

if (startRepo) {
  await step("start_session", async () => {
    const started = await call("start_session", {
      repo: startRepo,
      task: "Smoke test of claude-sessions-mcp: reply ok and stop. Change nothing.",
    })
    if (!started.ok) return fail(started)
    return `${String(started.data.session_id)} ${String(started.data.url)}`
  })
}

await client.close()
process.exit(failures)

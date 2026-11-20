import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { API_BETA, API_VERSION } from "../src/api.ts"
import { CLIENT_ID } from "../src/credentials.ts"
import type {
  IncomingResponse,
  OutgoingRequest,
  Transport,
} from "../src/egress.ts"

/**
 * An in-process fake of the two hosts the service dials: the sessions API
 * and the sign-in's token address. It checks what they check (the bearer
 * token and its expiry, the version, beta and organization headers, the
 * refresh grant and its client id), rotates the refresh token on every
 * use and, as a real OAuth server does, revokes the whole login when a
 * refresh token is used twice. Sessions answer side questions and
 * interrupts with a control_response a poll or two later.
 */

export const ORG = "3c0f2d4e-1111-4222-8333-944455556666"
export const EMAIL = "owner@example.org"
export const FIRST_ACCESS =
  "sk-ant-oat01-firstaccesstokenAAAAAAAAAAAAAAAAAAAAAAAA"
export const FIRST_REFRESH =
  "sk-ant-ort01-firstrefreshtokenBBBBBBBBBBBBBBBBBBBBBBBB"

export type FakeEvent = Record<string, unknown>

type FakeSession = {
  record: Record<string, unknown>
  events: FakeEvent[]
  deviceBound?: boolean
  /** Polls of the events before a side question is answered. */
  answerAfterPolls: number
  /** Never answer control requests. */
  silent?: boolean
  pending: { requestId: string; due: number; response: unknown }[]
  polls: number
  /** Events the session writes right after it answers (a busy session). */
  noiseAfterAnswer: number
}

function json(status: number, body: unknown): IncomingResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

function error(status: number, message: string) {
  return json(status, { type: "error", error: { type: "error", message } })
}

export class FakeAnthropic {
  requests: OutgoingRequest[] = []
  posted: { session: string; body: unknown }[] = []
  accessToken = FIRST_ACCESS
  refreshToken = FIRST_REFRESH
  /** Refresh tokens used before; one more use revokes the login. */
  usedRefresh = new Set<string>()
  revoked = false
  renewals = 0
  accessLifetimeMs = 8 * 60 * 60 * 1000
  accessExpiresAt: number
  /** Answer the next N API calls 401 whatever the token. */
  force401 = 0
  /** The record keeps showing an answered prompt, as a lagging worker. */
  lagging = false
  /** Every events page is the first, with a next_cursor (a broken API). */
  stuckCursor = false
  /** Listing sessions answers 403 (a login without the sessions scope). */
  forbidList = false
  /** A renewal answers 200 with this body instead of the tokens. */
  renewalBody: string | undefined
  sessions = new Map<string, FakeSession>()
  environments: Record<string, unknown>[] = [
    {
      kind: "anthropic_cloud",
      environment_id: "env_01DefaultCloud",
      name: "Default",
    },
    {
      kind: "anthropic_cloud",
      environment_id: "env_02NodeHeavy",
      name: "Node, more memory",
    },
  ]
  private seq = 1000
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
    this.accessExpiresAt = now() + this.accessLifetimeMs
  }

  addSession(
    id: string,
    record: Record<string, unknown> = {},
    options: Partial<
      Pick<
        FakeSession,
        "deviceBound" | "answerAfterPolls" | "silent" | "noiseAfterAnswer"
      >
    > = {},
  ) {
    this.sessions.set(id, {
      record: {
        id,
        title: `Session ${id}`,
        status: "active",
        worker_status: "idle",
        environment_id: "env_01DefaultCloud",
        environment_kind: "anthropic_cloud",
        created_at: "2026-11-18T16:00:00Z",
        updated_at: "2026-11-18T17:00:00Z",
        config: {
          sources: [
            {
              type: "git_repository",
              url: "https://github.com/kaperkunde/pcp",
            },
          ],
        },
        ...record,
      },
      events: [],
      answerAfterPolls: options.answerAfterPolls ?? 1,
      deviceBound: options.deviceBound,
      silent: options.silent,
      pending: [],
      polls: 0,
      noiseAfterAnswer: options.noiseAfterAnswer ?? 0,
    })
  }

  /** Appends an event as the API stores one: {event_type, payload, …}. */
  addEvent(id: string, payload: Record<string, unknown>) {
    const session = this.sessions.get(id)!
    session.events.push({
      id: `evt_${this.seq}`,
      sequence_num: this.seq++,
      created_at: new Date(this.now()).toISOString(),
      event_type: payload.type,
      payload,
    })
  }

  transport: Transport = async (request) => {
    this.requests.push(request)
    if (request.host === "auth") return this.token(request)
    return this.api(request)
  }

  private token(request: OutgoingRequest): IncomingResponse {
    if (request.method !== "POST" || request.path !== "/v1/oauth/token")
      return error(404, "not found")
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>
    if (body.grant_type !== "refresh_token" || body.client_id !== CLIENT_ID)
      return error(400, "invalid_request")
    const given = body.refresh_token as string
    if (this.usedRefresh.has(given)) {
      // Reuse: the whole login is revoked.
      this.revoked = true
      return error(400, "invalid_grant: refresh token reused")
    }
    if (this.revoked || given !== this.refreshToken)
      return error(400, "invalid_grant")
    this.usedRefresh.add(given)
    this.renewals++
    if (this.renewalBody !== undefined)
      return { status: 200, headers: {}, body: this.renewalBody }
    this.accessToken = `sk-ant-oat01-renewed${this.renewals}accesstokenCCCCCCCCCCCCCCCCCCCC`
    this.refreshToken = `sk-ant-ort01-renewed${this.renewals}refreshtokenDDDDDDDDDDDDDDDDDDDD`
    this.accessExpiresAt = this.now() + this.accessLifetimeMs
    return json(200, {
      token_type: "Bearer",
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_in: this.accessLifetimeMs / 1000,
      scope: body.scope,
    })
  }

  private api(request: OutgoingRequest): IncomingResponse {
    const h = request.headers
    if (this.force401 > 0) {
      this.force401--
      return error(401, "invalid token")
    }
    if (
      this.revoked ||
      h.Authorization !== `Bearer ${this.accessToken}` ||
      this.now() >= this.accessExpiresAt
    )
      return error(401, "OAuth token has expired")
    if (h["anthropic-version"] !== API_VERSION) return error(400, "version")
    if (h["anthropic-beta"] !== API_BETA) return error(400, "beta")
    if (h["x-organization-uuid"] !== ORG) return error(403, "organization")

    const url = new URL(request.path, "https://api.invalid")
    if (url.pathname === "/v1/environment_providers") {
      if (request.method !== "GET") return error(405, "method")
      const limit = Number(url.searchParams.get("limit") ?? "20")
      return json(200, {
        environments: this.environments.slice(0, limit),
        has_more: false,
        last_id: this.environments.at(-1)?.environment_id ?? null,
      })
    }
    const parts = url.pathname.split("/").filter(Boolean) // v1 code sessions [id] [events|archive|unarchive]
    if (parts.length === 3 && request.method === "GET") {
      if (this.forbidList) return error(403, "missing scope")
      const limit = Number(url.searchParams.get("limit") ?? "20")
      const data = [...this.sessions.values()]
        .map((s) => s.record)
        .slice(0, limit)
      return json(200, { data, has_more: false })
    }
    const id = parts[3]!
    const session = this.sessions.get(id)
    if (!session) return error(404, "session not found")
    // The real API wraps one session's record (seen live, 2026-11-20):
    // { response_shape: { id, title, status, … } }; the list gives them bare.
    if (parts.length === 4 && request.method === "GET")
      return json(200, { response_shape: session.record })
    if (parts.length === 4 && request.method === "PUT") {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>
      if (
        Object.keys(body).join() !== "title" ||
        typeof body.title !== "string"
      )
        return error(400, "only title")
      session.record.title = body.title
      return json(200, session.record)
    }
    if (parts[4] === "archive" && request.method === "POST") {
      if (session.record.status === "archived")
        return error(409, "already archived")
      session.record.status = "archived"
      return json(200, {})
    }
    if (parts[4] === "unarchive" && request.method === "POST") {
      if (session.deviceBound)
        return error(403, "untrusted device: elevated auth required")
      session.record.status = "active"
      return json(200, {})
    }
    if (parts[4] !== "events") return error(404, "not found")
    if (request.method === "GET") {
      session.polls++
      for (const p of session.pending.filter((p) => p.due <= session.polls)) {
        this.addEvent(id, {
          type: "control_response",
          response: p.response,
        })
        for (let i = 0; i < session.noiseAfterAnswer; i++)
          this.addEvent(id, {
            type: "assistant",
            message: { content: [{ type: "text", text: `noise ${i}` }] },
          })
      }
      session.pending = session.pending.filter((p) => p.due > session.polls)
      const limit = Number(url.searchParams.get("limit") ?? "100")
      const desc = url.searchParams.get("sort_order") === "desc"
      const cursor = url.searchParams.get("cursor")
      const at = cursor === null ? undefined : Number(cursor)
      const all = desc
        ? [...session.events]
            .reverse()
            .filter((e) => at === undefined || (e.sequence_num as number) < at)
        : session.events.filter(
            (e) => at === undefined || (e.sequence_num as number) > at,
          )
      if (this.stuckCursor)
        return json(200, {
          data: session.events.slice(0, 1).map((e) => {
            const { sequence_num: _seq, ...rest } = e
            return rest
          }),
          next_cursor: "1",
        })
      const page = all.slice(0, limit)
      const more = all.length > page.length
      return json(200, {
        data: page,
        next_cursor: more ? String(page.at(-1)!.sequence_num) : null,
      })
    }
    // POST events
    const body = JSON.parse(request.body ?? "{}") as {
      events?: { event_type?: string; payload?: Record<string, unknown> }[]
    }
    if (!Array.isArray(body.events) || body.events.length === 0)
      return error(400, "events is required")
    for (const [i, e] of body.events.entries())
      if (!e.event_type)
        return error(400, `events[${i}]: event_type is required`)
    if (session.deviceBound)
      return error(403, "This session requires a device signature")
    this.posted.push({ session: id, body })
    for (const e of body.events) {
      const payload = e.payload ?? {}
      if (e.event_type === "user") {
        this.addEvent(id, payload)
        continue
      }
      if (e.event_type === "control_response") {
        const response = payload.response as Record<string, unknown>
        const pending = (
          session.record.external_metadata as
            { pending_action?: { request_id?: string } } | undefined
        )?.pending_action
        if (
          !this.lagging &&
          pending &&
          response.request_id === pending.request_id
        ) {
          session.record.worker_status = "running"
          delete (session.record.external_metadata as Record<string, unknown>)
            .pending_action
        }
        this.addEvent(id, payload)
        continue
      }
      if (e.event_type !== "control_request" || session.silent) continue
      const req = payload.request as Record<string, unknown>
      const requestId = payload.request_id as string
      if (req.subtype === "side_question") {
        const question = req.question as string
        session.pending.push({
          requestId,
          due: session.polls + session.answerAfterPolls,
          response:
            question === "fail"
              ? { subtype: "error", request_id: requestId, error: "No context" }
              : {
                  subtype: "success",
                  request_id: requestId,
                  response: { answer: `Answer to: ${question}` },
                },
        })
      } else if (req.subtype === "interrupt") {
        session.pending.push({
          requestId,
          due: session.polls + 1,
          response: { subtype: "success", request_id: requestId },
        })
      }
    }
    return json(200, {})
  }

  /** Puts a permission prompt on a session, as a worker waiting on one. */
  askPermission(
    id: string,
    prompt: {
      requestId: string
      toolName: string
      description: string
      input: Record<string, unknown>
    },
  ) {
    const session = this.sessions.get(id)!
    session.record.worker_status = "requires_action"
    session.record.external_metadata = {
      ...(session.record.external_metadata as object | undefined),
      pending_action: {
        request_id: prompt.requestId,
        tool_use_id: `toolu_${prompt.requestId}`,
        tool_name: prompt.toolName,
        display_tool_name: prompt.toolName,
        action_description: prompt.description,
        input: prompt.input,
      },
    }
    this.addEvent(id, {
      type: "control_request",
      request_id: prompt.requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: prompt.toolName,
        tool_use_id: `toolu_${prompt.requestId}`,
        input: prompt.input,
      },
    })
  }

  /**
   * Puts a question on a session, as a worker waiting on AskUserQuestion:
   * the same record and control_request as a permission prompt, with the
   * question tool's name and its input ({questions: […]}).
   */
  askQuestion(
    id: string,
    prompt: { requestId: string; input: Record<string, unknown> },
  ) {
    this.askPermission(id, {
      requestId: prompt.requestId,
      toolName: "AskUserQuestion",
      description: "Asks the user a question",
      input: prompt.input,
    })
  }
}

/** Writes a login into a CLI config folder, as the CLI keeps it. */
export function writeLogin(
  dir: string,
  login: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    org?: string | null
  } = {},
) {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: login.accessToken ?? FIRST_ACCESS,
        refreshToken: login.refreshToken ?? FIRST_REFRESH,
        expiresAt: login.expiresAt ?? Date.now() + 8 * 60 * 60 * 1000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      numStartups: 3,
      oauthAccount:
        login.org === null
          ? undefined
          : {
              accountUuid: "acc-1",
              emailAddress: EMAIL,
              organizationUuid: login.org ?? ORG,
              organizationName: "Owner's Organization",
            },
    }),
    { mode: 0o600 },
  )
}

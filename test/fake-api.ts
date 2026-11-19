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
  sessions = new Map<string, FakeSession>()
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
      Pick<FakeSession, "deviceBound" | "answerAfterPolls" | "silent">
    > = {},
  ) {
    this.sessions.set(id, {
      record: {
        id,
        title: `Session ${id}`,
        session_status: "active",
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
    const parts = url.pathname.split("/").filter(Boolean) // v1 code sessions [id] [events]
    if (parts.length === 3 && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "20")
      const data = [...this.sessions.values()]
        .map((s) => s.record)
        .slice(0, limit)
      return json(200, { data, has_more: false })
    }
    const id = parts[3]!
    const session = this.sessions.get(id)
    if (!session) return error(404, "session not found")
    if (parts.length === 4 && request.method === "GET")
      return json(200, session.record)
    if (parts[4] !== "events") return error(404, "not found")
    if (request.method === "GET") {
      session.polls++
      for (const p of session.pending.filter((p) => p.due <= session.polls)) {
        this.addEvent(id, {
          type: "control_response",
          response: p.response,
        })
      }
      session.pending = session.pending.filter((p) => p.due > session.polls)
      const limit = Number(url.searchParams.get("limit") ?? "20")
      const desc = url.searchParams.get("sort_order") === "desc"
      const events = desc ? [...session.events].reverse() : session.events
      return json(200, { data: events.slice(0, limit) })
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

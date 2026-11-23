import { randomBytes, randomUUID } from "node:crypto"

import { RenewalError, SignedOut, type Credentials } from "./credentials.ts"
import type { HostKey, Transport } from "./egress.ts"
import type { Logger } from "./log.ts"
import { redact } from "./log.ts"

/**
 * Claude Code's sessions API, as the CLI uses it (an unofficial API,
 * versioned by its beta header; see README.md, "The API it relies on").
 * Every request carries the login's access token, the API version, the
 * beta and the organization. A 401 renews the login once and sends the
 * request again.
 */

export const API_VERSION = "2023-06-01"
export const API_BETA = "ccr-byoc-2025-07-29"

export type ApiEvent = Record<string, unknown>

export class ApiError extends Error {
  override name = "ApiError"
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A session id as the API names them (cse_…, or session_…). */
export const SESSION_ID = /^(?:cse|session)_[A-Za-z0-9]{6,120}$/

/**
 * The session id in what the owner or an assistant gives: an id, or a
 * claude.ai/code address that ends in one.
 */
export function sessionIdOf(value: string): string | undefined {
  const trimmed = value.trim()
  if (SESSION_ID.test(trimmed)) return trimmed
  const match =
    /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9]{6,120})(?:[/?#].*)?$/.exec(
      trimmed,
    )
  return match?.[1]
}

/** The API's own words for a failure, masked and cut short. */
function apiMessage(body: string): string | undefined {
  try {
    const data = JSON.parse(body) as { error?: { message?: unknown } }
    const message = data.error?.message
    if (typeof message === "string" && message.trim())
      return redact(message.trim()).slice(0, 200)
  } catch {
    // not JSON
  }
  return undefined
}

function failure(
  status: number,
  body: string,
  kind: "session" | "events" | "create",
): ApiError {
  const said = apiMessage(body)
  const suffix = said ? ` (${said})` : ""
  const events = kind === "events"
  if (kind === "create") {
    switch (status) {
      case 400:
      case 404:
      case 409:
      case 422:
        return new ApiError(
          status,
          `The sessions API did not accept the new session (${status})${suffix}. Check that the repository is connected to the owner's Claude account on GitHub (claude.ai/code), and that the environment exists (list_environments). Nothing was started.`,
        )
    }
  }
  switch (status) {
    case 403:
      return new ApiError(
        status,
        events
          ? `The session refused this${suffix}. A session bound to another device (one started from a laptop rather than in the cloud) accepts only events signed on that device: message it from there or from the Claude app.`
          : `The sessions API refused this (403)${suffix}. The sign-in may lack the user:sessions:claude_code scope: sign in again with login_start.`,
      )
    case 404:
      return new ApiError(status, `No such session${suffix}.`)
    case 429:
      return new ApiError(
        status,
        `Too many requests to the sessions API${suffix}. Try again in a minute.`,
      )
    default:
      return new ApiError(
        status,
        `The sessions API answered ${status}${suffix}.`,
      )
  }
}

export type SessionsApiOptions = {
  transport: Transport
  credentials: Credentials
  logger: Logger
  now?: () => number
}

export class SessionsApi {
  private readonly transport: Transport
  private readonly credentials: Credentials
  private readonly logger: Logger
  private readonly now: () => number

  constructor(options: SessionsApiOptions) {
    this.transport = options.transport
    this.credentials = options.credentials
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  private async call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    options: {
      timeoutMs?: number
      accept?: number[]
      kind?: "session" | "events" | "create"
    } = {},
  ): Promise<{ status: number; data: unknown }> {
    let rejected: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const { accessToken, organizationUuid } =
        await this.credentials.token(rejected)
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": API_BETA,
        "x-organization-uuid": organizationUuid,
        Accept: "application/json",
      }
      if (body !== undefined) headers["Content-Type"] = "application/json"
      const host: HostKey = "api"
      const started = this.now()
      const response = await this.transport({
        host,
        method,
        path,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      })
      this.logger.info("api_request", {
        method,
        // Ids only: the path holds no text of a session.
        path: path.replace(/\?.*$/, ""),
        status: response.status,
        ms: this.now() - started,
      })
      if (response.status === 401) {
        if (attempt === 0) {
          rejected = accessToken
          continue
        }
        throw new SignedOut(
          "The sessions API refused the sign-in even after it was renewed. Sign in again with login_start.",
        )
      }
      const accepted =
        (response.status >= 200 && response.status <= 299) ||
        (options.accept ?? []).includes(response.status)
      if (!accepted)
        throw failure(response.status, response.body, options.kind ?? "session")
      if (!response.body || response.status > 299)
        return { status: response.status, data: {} }
      try {
        return {
          status: response.status,
          data: JSON.parse(response.body) as unknown,
        }
      } catch {
        throw new ApiError(
          response.status,
          "The sessions API gave an answer that is not JSON.",
        )
      }
    }
    throw new ApiError(401, "The sessions API refused the sign-in.")
  }

  async listSessions(limit: number): Promise<Record<string, unknown>[]> {
    const { data } = await this.call("GET", `/v1/code/sessions?limit=${limit}`)
    return objects((data as { data?: unknown }).data)
  }

  async getSession(id: string): Promise<Record<string, unknown>> {
    const { data } = await this.call("GET", `/v1/code/sessions/${id}`)
    return sessionRecord(data)
  }

  /**
   * A page of events. `desc`: newest first, older than `cursor` (a
   * next_cursor from the page before) when given. `asc`: oldest first,
   * after `cursor` (a sequence number), as the CLI pages forward.
   */
  async events(
    id: string,
    page: {
      order: "asc" | "desc"
      limit: number
      cursor?: string
      timeoutMs?: number
    },
  ): Promise<{ events: ApiEvent[]; nextCursor: string | null }> {
    const query = new URLSearchParams({
      limit: String(page.limit),
      sort_order: page.order,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    })
    const { data } = await this.call(
      "GET",
      `/v1/code/sessions/${id}/events?${query.toString()}`,
      undefined,
      page.timeoutMs !== undefined ? { timeoutMs: page.timeoutMs } : {},
    )
    const next = (data as { next_cursor?: unknown }).next_cursor
    return {
      events: objects((data as { data?: unknown }).data),
      nextCursor:
        typeof next === "string" && CURSOR.test(next)
          ? next
          : typeof next === "number"
            ? String(next)
            : null,
    }
  }

  /** The newest `limit` events, newest first. */
  async newestEvents(id: string, limit: number): Promise<ApiEvent[]> {
    return (await this.events(id, { order: "desc", limit })).events
  }

  /** Posts events, each as the API takes them: {event_type, payload}. */
  async postEvents(
    id: string,
    events: { event_type: string; payload: Record<string, unknown> }[],
    timeoutMs?: number,
  ): Promise<void> {
    await this.call(
      "POST",
      `/v1/code/sessions/${id}/events`,
      { events },
      { kind: "events", ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    )
  }

  /**
   * Starts a session on a GitHub repository, as the CLI's interactive
   * --cloud does (Claude Code 2.1.327 to 2.1.330): POST /v1/code/sessions
   * with the title, the environment, the task as the one first event
   * ({payload: <a user message>}, in the create body: the CLI posts no
   * later event) and the config: the repository and the branch to start
   * from as the source, the repository and the branch the session works on
   * as the outcome. The answer is {session: {id, title, …}}.
   */
  async createSession(input: {
    repo: string
    branch: string
    task: string
    environmentId: string
  }): Promise<{ id: string; title: string | null }> {
    const title = input.task.replace(/\s+/g, " ").trim().slice(0, 75)
    let data: unknown
    try {
      ;({ data } = await this.call(
        "POST",
        "/v1/code/sessions",
        {
          title,
          environment_id: input.environmentId,
          events: [
            {
              payload: {
                uuid: randomUUID(),
                session_id: "",
                type: "user",
                parent_tool_use_id: null,
                message: { role: "user", content: input.task },
              },
            },
          ],
          config: {
            sources: [
              {
                type: "git_repository",
                url: `https://github.com/${input.repo}`,
                revision: input.branch,
              },
            ],
            outcomes: [
              {
                type: "git_repository",
                git_info: {
                  type: "github",
                  repo: input.repo,
                  // The CLI's own fallback name when it has none made.
                  branches: [`claude/task-${randomBytes(3).toString("hex")}`],
                },
              },
            ],
          },
        },
        { kind: "create" },
      ))
    } catch (error) {
      if (
        error instanceof ApiError ||
        error instanceof SignedOut ||
        error instanceof RenewalError
      )
        throw error
      // The request may have been received: say so, so it is not repeated.
      throw new ApiError(
        0,
        "The sessions API gave no answer, so a session may have started all the same: check list_sessions before trying again, so it is not started twice.",
      )
    }
    const session = (data as { session?: unknown }).session
    const id =
      session && typeof session === "object"
        ? (session as { id?: unknown }).id
        : undefined
    if (typeof id !== "string" || !SESSION_ID.test(id)) {
      throw new ApiError(
        200,
        "The sessions API answered with no usable session id, so a session may have started all the same: check list_sessions before trying again.",
      )
    }
    const named = (session as { title?: unknown }).title
    return {
      id,
      title: typeof named === "string" ? redact(named).slice(0, 200) : null,
    }
  }

  /** Archives a session: true, or false when it already was. */
  async archive(id: string): Promise<boolean> {
    const { status } = await this.call(
      "POST",
      `/v1/code/sessions/${id}/archive`,
      {},
      { accept: [409] },
    )
    return status !== 409
  }

  async unarchive(id: string): Promise<void> {
    await this.call("POST", `/v1/code/sessions/${id}/unarchive`, {})
  }

  /** Sets a session's title, as the CLI does (PUT with the title alone). */
  async rename(id: string, title: string): Promise<void> {
    await this.call("PUT", `/v1/code/sessions/${id}`, { title })
  }

  /** The cloud environments the account can start sessions in. */
  async environments(limit: number): Promise<Record<string, unknown>[]> {
    const { data } = await this.call(
      "GET",
      `/v1/environment_providers?limit=${limit}`,
    )
    return objects((data as { environments?: unknown }).environments)
  }
}

/** A cursor as the API hands them out, safe to send back in a query. */
export const CURSOR = /^[A-Za-z0-9_.~=+/-]{1,512}$/

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : []
}

/**
 * One session's record out of the answer to `GET /v1/code/sessions/{id}`.
 * The API wraps it (`{ response_shape: { id, title, … } }`), while the
 * list gives records bare; a bare record is taken as it is.
 */
export function sessionRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  const record = data as Record<string, unknown>
  if (typeof record.id === "string") return record
  const inner = record.response_shape
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : {}
}

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
/** The beta of the connectors list (`GET /v1/mcp_servers`). */
export const MCP_SERVERS_BETA = "mcp-servers-2025-12-04"
/** The beta of the routines API (`/v1/code/triggers`, and a routine's runs), as the CLI sends it. */
export const TRIGGERS_BETA = "ccr-triggers-2026-01-30"

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
    // A timeout or a server error: the request may have been taken.
    if (status === 408 || status >= 500)
      return new ApiError(
        status,
        `The sessions API answered ${status}${suffix}, so a session may have started all the same: check list_sessions before trying again, so it is not started twice.`,
      )
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
      beta?: string
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
        "anthropic-beta": options.beta ?? API_BETA,
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
   * The account's claude.ai connectors (`GET /v1/mcp_servers`, its own
   * beta), as a routine names them: id, name and address. Rows that are
   * only an additional install, or not eligible, are left out. Pages are
   * followed a few times (`next_page`).
   */
  async connectors(): Promise<
    { id: string; displayName: string; url: string }[]
  > {
    const found: { id: string; displayName: string; url: string }[] = []
    let page: string | undefined
    for (let n = 0; n < 5; n++) {
      const { data } = await this.call(
        "GET",
        `/v1/mcp_servers?limit=1000${page !== undefined ? `&page=${page}` : ""}`,
        undefined,
        { beta: MCP_SERVERS_BETA },
      )
      for (const row of objects((data as { data?: unknown }).data)) {
        if (row.additional_install === true || row.eligible === false) continue
        const { id, url } = row
        const name = row.display_name ?? row.name
        if (
          typeof id !== "string" ||
          !id ||
          typeof url !== "string" ||
          !url ||
          typeof name !== "string"
        )
          continue
        found.push({
          id: id.slice(0, 200),
          displayName: name.trim().slice(0, 120) || "connector",
          url: url.slice(0, 2000),
        })
      }
      const next = (data as { next_page?: unknown }).next_page
      if (typeof next !== "string" || !CURSOR.test(next)) break
      page = next
    }
    return found
  }

  /**
   * Makes a routine (the API's trigger) that starts a session with the
   * task as its first message, as claude.ai's own routines do. It has no
   * schedule, so it only ever runs when it is run. `connections` name the
   * connectors it attaches; none lets the server attach the account's.
   */
  async createRoutine(input: {
    repo: string
    branch: string
    task: string
    environmentId: string
    connections?: { connector_uuid: string; name: string; url: string }[]
  }): Promise<string> {
    const title = input.task.replace(/\s+/g, " ").trim().slice(0, 75)
    const { data } = await this.createCall("/v1/code/triggers", {
      name: title,
      job_config: {
        ccr: {
          ...(input.environmentId.startsWith("ccpool_")
            ? { self_hosted_runner_pool_id: input.environmentId }
            : { environment_id: input.environmentId }),
          session_context: {
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
                  branches: [`claude/task-${randomBytes(3).toString("hex")}`],
                },
              },
            ],
          },
          events: [
            {
              data: {
                uuid: randomUUID(),
                session_id: "",
                type: "user",
                parent_tool_use_id: null,
                message: { role: "user", content: input.task },
              },
            },
          ],
        },
      },
      ...(input.connections?.length
        ? { mcp_connections: input.connections }
        : {}),
    })
    const record = data as { id?: unknown; trigger?: { id?: unknown } }
    const id = record.trigger?.id ?? record.id
    if (typeof id !== "string" || !ROUTINE_ID.test(id))
      throw new ApiError(
        200,
        "The sessions API answered with no usable routine id. Nothing was started.",
      )
    return id
  }

  /**
   * Runs a routine into a fresh session: the session's id when the answer
   * names one, else null (see routineSessions).
   */
  async runRoutine(routineId: string): Promise<string | null> {
    const { data } = await this.createCall(
      `/v1/code/triggers/${routineId}/run`,
      {},
    )
    return sessionIdIn(data)
  }

  /** The ids of the sessions a routine started, as the sessions list gives them. */
  async routineSessions(routineId: string): Promise<string[]> {
    const { data } = await this.call(
      "GET",
      `/v1/code/sessions?trigger_id=${routineId}&limit=5`,
      undefined,
      { beta: TRIGGERS_BETA },
    )
    return objects((data as { data?: unknown }).data)
      .map((r) => sessionIdIn(r))
      .filter((id): id is string => id !== null)
  }

  /** Turns a routine off, so it shows as done. It is never deleted: that deletes its sessions. */
  async disableRoutine(routineId: string): Promise<void> {
    await this.call(
      "POST",
      `/v1/code/triggers/${routineId}`,
      { enabled: false },
      { beta: TRIGGERS_BETA },
    )
  }

  /** A POST whose failure may mean it was taken all the same. */
  private async createCall(
    path: string,
    body: unknown,
  ): Promise<{ status: number; data: unknown }> {
    try {
      return await this.call("POST", path, body, {
        kind: "create",
        beta: TRIGGERS_BETA,
      })
    } catch (error) {
      if (
        error instanceof ApiError ||
        error instanceof SignedOut ||
        error instanceof RenewalError
      )
        throw error
      throw new ApiError(
        0,
        "The sessions API gave no answer, so a session may have started all the same: check list_sessions before trying again, so it is not started twice.",
      )
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

  /** Every environment, paged as the CLI pages them (100 a page, after_id). */
  async allEnvironments(): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page++) {
      const { data } = await this.call(
        "GET",
        `/v1/environment_providers?limit=100${after !== undefined ? `&after_id=${after}` : ""}`,
      )
      const body = data as { has_more?: unknown; last_id?: unknown }
      const found = objects((data as { environments?: unknown }).environments)
      all.push(...found)
      if (
        body.has_more !== true ||
        found.length === 0 ||
        typeof body.last_id !== "string" ||
        !CURSOR.test(body.last_id)
      )
        break
      after = body.last_id
    }
    return all
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

/** A routine's id as the API names them (trig_…). */
export const ROUTINE_ID = /^[A-Za-z0-9_-]{3,128}$/

/**
 * A session's id in a record or an answer, found defensively: `id`,
 * `session_id`, or a nested `session`.
 */
export function sessionIdIn(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const candidate of [
    record.session_id,
    record.id,
    (record.session as { id?: unknown } | undefined)?.id,
    (record.response_shape as { id?: unknown } | undefined)?.id,
  ])
    if (typeof candidate === "string" && SESSION_ID.test(candidate))
      return candidate
  return null
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

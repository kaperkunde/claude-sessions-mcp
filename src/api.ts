import type { Credentials } from "./credentials.ts"
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

function failure(status: number, body: string): ApiError {
  const said = apiMessage(body)
  const suffix = said ? ` (${said})` : ""
  switch (status) {
    case 403:
      return new ApiError(
        status,
        `The session refused this${suffix}. A session bound to another device (one started from a laptop rather than in the cloud) accepts only events signed on that device: message it from there or from the Claude app.`,
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
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
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
      })
      this.logger.info("api_request", {
        method,
        // Ids only: the path holds no text of a session.
        path: path.replace(/\?.*$/, ""),
        status: response.status,
        ms: this.now() - started,
      })
      if (response.status === 401 && attempt === 0) {
        rejected = accessToken
        continue
      }
      if (response.status < 200 || response.status > 299)
        throw failure(response.status, response.body)
      if (!response.body) return {}
      try {
        return JSON.parse(response.body) as unknown
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
    const data = (await this.call(
      "GET",
      `/v1/code/sessions?limit=${limit}`,
    )) as { data?: unknown }
    return Array.isArray(data.data)
      ? data.data.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object",
        )
      : []
  }

  async getSession(id: string): Promise<Record<string, unknown>> {
    const data = await this.call("GET", `/v1/code/sessions/${id}`)
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {}
  }

  /** The newest `limit` events, newest first. */
  async newestEvents(id: string, limit: number): Promise<ApiEvent[]> {
    const data = (await this.call(
      "GET",
      `/v1/code/sessions/${id}/events?limit=${limit}&sort_order=desc`,
    )) as { data?: unknown }
    return Array.isArray(data.data)
      ? data.data.filter(
          (item): item is ApiEvent => !!item && typeof item === "object",
        )
      : []
  }

  /** Posts events, each as the API takes them: {event_type, payload}. */
  async postEvents(
    id: string,
    events: { event_type: string; payload: Record<string, unknown> }[],
  ): Promise<void> {
    await this.call("POST", `/v1/code/sessions/${id}/events`, { events })
  }
}

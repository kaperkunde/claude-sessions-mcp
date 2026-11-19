import { randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Transport } from "./egress.ts"
import type { Logger } from "./log.ts"
import type { Serial } from "./serial.ts"

/**
 * The claude.ai login, as the Claude Code CLI keeps it in its config
 * folder: `.credentials.json` (claudeAiOauth: the access token, the
 * refresh token, when the access token expires, its scopes) and
 * `.claude.json` (oauthAccount: the account's email, its organization).
 *
 * Nothing here hands a token to anything but the sessions API's request
 * (api.ts) and the renewal below; no tool answers one and no log line
 * holds one.
 *
 * Renewal is the CLI's own flow (the refresh grant at the sign-in's token
 * address, the CLI's client id and scopes), made here before the access
 * token runs out, and again once when the API refuses it. The refresh
 * token rotates on every use, so a renewal runs only inside the Serial
 * that the CLI's runs share (cli.ts), and reads the file again first: a
 * refresh token is never sent twice, whoever renewed last.
 */

/** The Claude Code CLI's OAuth client id (public, the CLI sends it too). */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
/** Renew when less than this is left of the access token. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

export type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  /** Milliseconds since the epoch. */
  expiresAt?: number
  scopes?: string[]
  subscriptionType?: string
}

export type Account = {
  email?: string
  organizationName?: string
  organizationUuid?: string
}

/** Not signed in, or the sign-in is gone: the owner signs in again. */
export class SignedOut extends Error {
  override name = "SignedOut"
}

/** The token address refused or failed, for another reason. */
export class RenewalError extends Error {
  override name = "RenewalError"
}

export const CREDENTIALS_FILE = ".credentials.json"
export const ACCOUNT_FILE = ".claude.json"

function readJson(file: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export type CredentialsOptions = {
  dir: string
  transport: Transport
  serial: Serial
  logger: Logger
  now?: () => number
}

export class Credentials {
  readonly dir: string
  readonly serial: Serial
  private readonly transport: Transport
  private readonly logger: Logger
  private readonly now: () => number

  constructor(options: CredentialsOptions) {
    this.dir = options.dir
    this.transport = options.transport
    this.serial = options.serial
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  private get credentialsFile() {
    return join(this.dir, CREDENTIALS_FILE)
  }

  /** The login as the file has it now, or undefined. */
  tokens(): OAuthTokens | undefined {
    const file = readJson(this.credentialsFile)
    const oauth = file?.claudeAiOauth
    if (!oauth || typeof oauth !== "object") return undefined
    const o = oauth as Record<string, unknown>
    const accessToken = str(o.accessToken)
    if (!accessToken) return undefined
    return {
      accessToken,
      refreshToken: str(o.refreshToken),
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : undefined,
      scopes: Array.isArray(o.scopes)
        ? o.scopes.filter((s): s is string => typeof s === "string")
        : undefined,
      subscriptionType: str(o.subscriptionType),
    }
  }

  /** The signed-in account: email and organization, never a token. */
  account(): Account {
    const file = readJson(join(this.dir, ACCOUNT_FILE))
    const account = file?.oauthAccount
    if (!account || typeof account !== "object") return {}
    const a = account as Record<string, unknown>
    return {
      email: str(a.emailAddress),
      organizationName: str(a.organizationName),
      organizationUuid: str(a.organizationUuid),
    }
  }

  /**
   * A usable access token and the organization it acts for. Renews first
   * when the token is about to run out, or when `rejected` (a token the API
   * just refused) is still the one on file.
   */
  token(
    rejected?: string,
  ): Promise<{ accessToken: string; organizationUuid: string }> {
    return this.serial.run(() => this.tokenInLine(rejected))
  }

  /**
   * As token(), for a caller already in the Serial's line (cli.ts, before
   * it runs the CLI, so the CLI finds a fresh token and does not renew it
   * itself while it runs).
   */
  async tokenInLine(
    rejected?: string,
  ): Promise<{ accessToken: string; organizationUuid: string }> {
    const tokens = this.tokens()
    if (!tokens) {
      throw new SignedOut(
        "The service is not signed in to claude.ai. Sign in with login_start (see its description).",
      )
    }
    const organizationUuid = this.account().organizationUuid
    if (!organizationUuid) {
      throw new SignedOut(
        "The sign-in names no organization. Sign in again with login_start.",
      )
    }
    const expiring =
      tokens.expiresAt !== undefined &&
      tokens.expiresAt - this.now() < REFRESH_MARGIN_MS
    if (expiring || (rejected !== undefined && rejected === tokens.accessToken))
      return { accessToken: await this.renew(tokens), organizationUuid }
    return { accessToken: tokens.accessToken, organizationUuid }
  }

  private async renew(tokens: OAuthTokens): Promise<string> {
    if (!tokens.refreshToken) {
      throw new SignedOut(
        "The sign-in cannot be renewed. Sign in again with login_start.",
      )
    }
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
    }
    if (tokens.scopes && tokens.scopes.length > 0)
      body.scope = tokens.scopes.join(" ")
    const started = this.now()
    const response = await this.transport({
      host: "auth",
      method: "POST",
      path: "/v1/oauth/token",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })
    this.logger.info("login_renewal", {
      status: response.status,
      ms: this.now() - started,
    })
    if (response.status === 400 || response.status === 401) {
      throw new SignedOut(
        "Claude no longer accepts this sign-in (it was signed out, or renewed somewhere else). Sign in again with login_start.",
      )
    }
    if (response.status !== 200) {
      throw new RenewalError(
        `Renewing the claude.ai sign-in failed (${response.status}). Try again in a minute.`,
      )
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(response.body) as Record<string, unknown>
    } catch {
      throw new RenewalError("Renewing the claude.ai sign-in gave no answer.")
    }
    const accessToken = str(data.access_token)
    const expiresIn = data.expires_in
    if (!accessToken || typeof expiresIn !== "number") {
      throw new RenewalError("Renewing the claude.ai sign-in gave no token.")
    }
    this.write({
      accessToken,
      refreshToken: str(data.refresh_token) ?? tokens.refreshToken,
      expiresAt: this.now() + expiresIn * 1000,
    })
    return accessToken
  }

  /**
   * Writes the renewed tokens into the CLI's file, keeping every other
   * field as it was: whole, mode 0600, by a rename.
   */
  private write(update: Pick<OAuthTokens, "accessToken"> & OAuthTokens) {
    const file = readJson(this.credentialsFile) ?? {}
    const oauth =
      file.claudeAiOauth && typeof file.claudeAiOauth === "object"
        ? (file.claudeAiOauth as Record<string, unknown>)
        : {}
    const next = {
      ...file,
      claudeAiOauth: {
        ...oauth,
        accessToken: update.accessToken,
        refreshToken: update.refreshToken,
        expiresAt: update.expiresAt,
      },
    }
    const part = `${this.credentialsFile}.${randomBytes(6).toString("hex")}.part`
    writeFileSync(part, JSON.stringify(next), { mode: 0o600 })
    renameSync(part, this.credentialsFile)
  }
}

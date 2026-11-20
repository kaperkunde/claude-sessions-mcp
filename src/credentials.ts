import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
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
/** How long a renewal request may take, all of it. */
export const RENEWAL_TIMEOUT_MS = 20_000

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

/** A JSON file as an object; "unreadable" for one that does not parse. */
function readJsonFile(
  file: string,
): Record<string, unknown> | undefined | "unreadable" {
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
      : "unreadable"
  } catch {
    return "unreadable"
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const value = readJsonFile(file)
  return value === "unreadable" ? undefined : value
}

/** A file the CLI may be writing as we read it: read once more. */
async function readSettled(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  const first = readJsonFile(file)
  if (first !== "unreadable") return first
  await new Promise((resolve) => setTimeout(resolve, 50))
  return readJson(file)
}

type Fresh = { accessToken: string; organizationUuid: string }

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

const LOST_RENEWAL =
  "Renewing the claude.ai sign-in got no usable answer, and claude.ai may have renewed it all the same, which leaves this service with a used-up sign-in. Sign in again with login_start."

/**
 * Beside the login: the SHA-256 of a refresh token whose renewal was sent
 * and got no usable answer, so it is never sent again, also after a
 * restart. Never the token itself.
 */
export const LOST_REFRESH_FILE = ".claude-sessions-lost-refresh"

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export class Credentials {
  /** The digest of a refresh token whose renewal was lost: never sent again. */
  private lostRefresh: string | undefined
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
  tokens(
    file: Record<string, unknown> | undefined = readJson(this.credentialsFile),
  ): OAuthTokens | undefined {
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
   * A usable access token and the organization it acts for. A token on
   * file that is not about to run out (and is not `rejected`, a token the
   * API just refused) is read outside the queue, so API calls never wait
   * behind a CLI run; only a renewal takes its place in the queue.
   */
  async token(rejected?: string): Promise<Fresh> {
    const file = await readSettled(this.credentialsFile)
    const ready = this.usable(this.tokens(file), rejected, REFRESH_MARGIN_MS)
    if (ready) return ready
    return this.serial.run(() => this.tokenInLine(rejected))
  }

  /** The token on file and its organization, if it needs no renewal. */
  private usable(
    tokens: OAuthTokens | undefined,
    rejected: string | undefined,
    marginMs: number,
  ): Fresh | undefined {
    if (!tokens) return undefined
    const organizationUuid = this.account().organizationUuid
    if (!organizationUuid) return undefined
    if (rejected !== undefined && rejected === tokens.accessToken)
      return undefined
    if (
      tokens.expiresAt !== undefined &&
      tokens.expiresAt - this.now() < marginMs
    )
      return undefined
    return { accessToken: tokens.accessToken, organizationUuid }
  }

  /**
   * As token(), for a caller already in the Serial's line. cli.ts passes a
   * margin as long as its run may take, so the CLI finds a token that lasts
   * the whole run and never renews it itself meanwhile.
   */
  async tokenInLine(
    rejected?: string,
    marginMs: number = REFRESH_MARGIN_MS,
  ): Promise<Fresh> {
    const tokens = this.tokens(await readSettled(this.credentialsFile))
    if (!tokens) {
      throw new SignedOut(
        "The service is not signed in to claude.ai. With PCP, the owner signs in on PCP's sign-in page (PCP's connect_account hands the link); otherwise sign in with login_start and login_finish.",
      )
    }
    const organizationUuid = this.account().organizationUuid
    if (!organizationUuid) {
      throw new SignedOut(
        "The sign-in names no organization. Sign in again with login_start.",
      )
    }
    const ready = this.usable(tokens, rejected, marginMs)
    if (ready) return ready
    return { accessToken: await this.renew(tokens), organizationUuid }
  }

  private async renew(tokens: OAuthTokens): Promise<string> {
    const refreshToken = tokens.refreshToken
    if (!refreshToken) {
      throw new SignedOut(
        "The sign-in cannot be renewed. Sign in again with login_start.",
      )
    }
    if (this.isLost(refreshToken)) {
      // Sent once already, and the answer was lost: claude.ai may have
      // rotated it, and a refresh token sent twice can end the login.
      throw new SignedOut(LOST_RENEWAL)
    }
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }
    if (tokens.scopes && tokens.scopes.length > 0)
      body.scope = tokens.scopes.join(" ")
    const started = this.now()
    let response
    try {
      response = await this.transport({
        host: "auth",
        method: "POST",
        path: "/v1/oauth/token",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        timeoutMs: RENEWAL_TIMEOUT_MS,
      })
    } catch {
      this.lose(refreshToken)
    }
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
    // A 200 means claude.ai took the refresh token: from here on, an
    // answer that cannot be used or kept leaves a used-up sign-in.
    let data: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(response.body)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        data = parsed as Record<string, unknown>
    } catch {
      data = undefined
    }
    const accessToken = str(data?.access_token)
    const expiresIn = data?.expires_in
    if (!data || !accessToken || typeof expiresIn !== "number")
      this.lose(refreshToken)
    try {
      this.write({
        accessToken,
        refreshToken: str(data.refresh_token) ?? refreshToken,
        expiresAt: this.now() + expiresIn * 1000,
      })
    } catch {
      this.lose(refreshToken)
    }
    return accessToken
  }

  private isLost(refreshToken: string): boolean {
    if (this.lostRefresh === undefined) {
      try {
        this.lostRefresh = readFileSync(
          join(this.dir, LOST_REFRESH_FILE),
          "utf8",
        ).trim()
      } catch {
        this.lostRefresh = ""
      }
    }
    return this.lostRefresh !== "" && this.lostRefresh === digest(refreshToken)
  }

  /** Marks a refresh token as sent and lost, here and on disk; throws. */
  private lose(refreshToken: string): never {
    this.lostRefresh = digest(refreshToken)
    try {
      writeFileSync(join(this.dir, LOST_REFRESH_FILE), this.lostRefresh, {
        mode: 0o600,
      })
    } catch {
      this.logger.error("lost_refresh_unwritable")
    }
    this.logger.warn("login_renewal_lost")
    throw new SignedOut(LOST_RENEWAL)
  }

  /**
   * Writes the renewed tokens into the CLI's file, keeping every other
   * field as it was: whole, mode 0600, on disk (fsync) before the rename.
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
    let fd: number | undefined
    try {
      fd = openSync(part, "wx", 0o600)
      writeSync(fd, JSON.stringify(next))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(part, this.credentialsFile)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(part)
      } catch {
        // already gone
      }
      throw error
    }
  }
}

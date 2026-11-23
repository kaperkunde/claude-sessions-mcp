import { spawn } from "node:child_process"

import type { Credentials } from "./credentials.ts"
import { SIGN_IN_HOSTS } from "./egress.ts"
import type { Logger } from "./log.ts"
import { redact } from "./log.ts"

/**
 * The only module that starts a process: the Claude Code CLI (pinned in
 * the image), for the claude.ai sign-in only: a session is started through
 * the sessions API (api.ts), as `claude -p --cloud` cannot start one. Every process is started with
 * an argument list (never a shell), a fixed set of environment variables
 * (never the MCP token), a time limit and bounded output.
 *
 * Whatever runs the CLI with the login runs in the Credentials' Serial,
 * after the access token was renewed if it was close to running out, so
 * the CLI never renews it at the same time as this service.
 */

export const LOGIN_URL_WAIT_MS = 30_000
export const LOGIN_TTL_MS = 15 * 60 * 1000
export const LOGIN_FINISH_MS = 60_000
export const MAX_OUTPUT_BYTES = 256 * 1024

/** A failure the assistant can act on: answered as a tool error. */
export class CliRefusal extends Error {
  override name = "CliRefusal"
}

export type CliOptions = {
  /** The CLI: a program, then arguments put before the CLI's own. */
  bin: string
  baseArgs?: string[]
  /** CLAUDE_CONFIG_DIR. */
  configDir: string
  credentials: Credentials
  logger: Logger
  now?: () => number
  /** The environment handed on to the CLI, from the service's own. */
  env?: Record<string, string | undefined>
}

/** The variables the CLI gets: its own settings, and a proxy if one is set. */
const PASSED_ON = [
  "PATH",
  "LANG",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]

type Child = {
  write(text: string): void
  /** Closes its standard input. */
  end(): void
  wait(): Promise<{ code: number | null; output: string }>
  kill(): void
  output(): string
  onOutput(listener: () => void): void
  running(): boolean
}

/** The sign-in code's shape: code#state, as the CLI asks for it. */
export const SIGN_IN_CODE = /^[A-Za-z0-9_-]{8,512}#[A-Za-z0-9_-]{8,256}$/

/** owner/name on GitHub. */
export const GITHUB_REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
/** A cloud environment's id, as list_environments answers them. */
export const ENVIRONMENT_ID = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/
/** A branch name, conservatively. */
export const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/**
 * What start_session checks before anything else: a repository, a branch,
 * and a task that the CLI takes as a message (not / or !, a slash or a
 * shell command).
 */
export function checkStart(repo: string, task: string, branch: string): void {
  if (/^\s*[/!]/.test(task)) {
    throw new CliRefusal(
      "The task starts with / or !, which the CLI would take as a slash command or a shell command rather than the session's first message: start it with a word.",
    )
  }
  if (!GITHUB_REPO.test(repo))
    throw new CliRefusal("repo is a GitHub repository, as owner/name.")
  if (!BRANCH.test(branch))
    throw new CliRefusal("branch is a branch name, like main.")
}

/** The sign-in address in the CLI's output, if it names an allowed host. */
export function loginUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let url: URL
    try {
      url = new URL(match[0])
    } catch {
      continue
    }
    if (
      url.protocol === "https:" &&
      (SIGN_IN_HOSTS as readonly string[]).includes(url.hostname) &&
      url.pathname.includes("/oauth/authorize") &&
      url.searchParams.has("code_challenge")
    )
      return url.toString()
  }
  return undefined
}

/** The last line of the CLI's output worth showing, masked. */
export function lastWords(output: string, without: string[] = []): string {
  let text = output
  for (const secret of without) if (secret) text = text.split(secret).join("")
  const lines = redact(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^Paste code here if prompted >/, "").trim())
    .filter(Boolean)
  return (lines.at(-1) ?? "").slice(0, 300).replace(/[.\s]+$/, "")
}

export class Cli {
  private readonly options: CliOptions
  private readonly now: () => number
  private loginLine: Promise<unknown> = Promise.resolve()
  private pending:
    | { child: Child; url: string; expiresAt: number; timer: NodeJS.Timeout }
    | undefined

  constructor(options: CliOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  private environment(): Record<string, string> {
    const source = this.options.env ?? process.env
    const env: Record<string, string> = {}
    for (const name of PASSED_ON) {
      const value = source[name]
      if (value !== undefined) env[name] = value
    }
    return {
      ...env,
      HOME: source.HOME ?? "/home/claude",
      CLAUDE_CONFIG_DIR: this.options.configDir,
      // The version in the image is the one that was tested: no updates,
      // no telemetry, no error reports, no browser to open.
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      BROWSER: "true",
    }
  }

  private start(
    program: string,
    args: string[],
    cwd?: string,
    extraEnv: Record<string, string> = {},
  ): Child {
    const proc = spawn(program, args, {
      cwd,
      env: { ...this.environment(), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    let output = ""
    let exited: { code: number | null } | undefined
    const listeners: (() => void)[] = []
    const take = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES)
        output += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES)
      for (const listener of listeners) listener()
    }
    proc.stdout.on("data", take)
    proc.stderr.on("data", take)
    proc.stdin.on("error", () => {})
    const done = new Promise<{ code: number | null; output: string }>(
      (resolve) => {
        proc.on("error", () => {
          exited = { code: -1 }
          resolve({ code: -1, output })
        })
        proc.on("close", (code) => {
          exited = { code }
          resolve({ code, output })
        })
      },
    )
    return {
      write: (text) => {
        proc.stdin.write(text)
      },
      end: () => {
        proc.stdin.end()
      },
      wait: () => done,
      kill: () => {
        if (!exited) proc.kill("SIGKILL")
      },
      output: () => output,
      onOutput: (listener) => listeners.push(listener),
      running: () => exited === undefined,
    }
  }

  private claude(args: string[], cwd?: string): Child {
    return this.start(
      this.options.bin,
      [...(this.options.baseArgs ?? []), ...args],
      cwd,
    )
  }

  private async within<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout: () => void,
  ): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        onTimeout()
        resolve(undefined)
      }, ms)
      timer.unref()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Whether a sign-in waits for its code, and until when. */
  loginPending(): { expiresAt: number } | undefined {
    if (!this.pending || !this.pending.child.running()) return undefined
    return { expiresAt: this.pending.expiresAt }
  }

  private dropPending() {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.child.kill()
    this.pending = undefined
  }

  /**
   * Starts the CLI's sign-in (`claude auth login --claudeai`) and answers
   * the address the owner signs in at. The CLI stays running, waiting for
   * the code that page shows, for LOGIN_TTL_MS; a new start ends an
   * earlier one.
   */
  loginStart(): Promise<{ url: string; expiresAt: number }> {
    // One at a time: a second start ends the first's CLI only once the
    // first has one, so no CLI is left running unowned.
    const result = this.loginLine.then(() => this.loginStartNow())
    this.loginLine = result.catch(() => undefined)
    return result
  }

  private async loginStartNow(): Promise<{ url: string; expiresAt: number }> {
    this.dropPending()
    const child = this.claude(["auth", "login", "--claudeai"])
    const found = await this.within(
      new Promise<string | undefined>((resolve) => {
        const look = () => {
          const url = loginUrl(child.output())
          if (url) resolve(url)
        }
        child.onOutput(look)
        look()
        void child.wait().then(() => resolve(loginUrl(child.output())))
      }),
      LOGIN_URL_WAIT_MS,
      () => child.kill(),
    )
    if (!found || !child.running()) {
      child.kill()
      const said = lastWords(child.output())
      this.options.logger.warn("login_start_failed")
      throw new CliRefusal(
        `The Claude Code CLI did not offer a sign-in address${said ? `: ${said}` : ""}.`,
      )
    }
    const expiresAt = this.now() + LOGIN_TTL_MS
    const timer = setTimeout(() => {
      // This sign-in's own CLI, whatever is pending by now.
      child.kill()
      if (this.pending?.child === child) this.pending = undefined
    }, LOGIN_TTL_MS)
    timer.unref()
    this.pending = { child, url: found, expiresAt, timer }
    this.options.logger.info("login_started")
    return { url: found, expiresAt }
  }

  /**
   * Hands the waiting sign-in its code and waits for the CLI to finish:
   * it exchanges the code and writes the login into its config folder. In
   * the Serial, so nothing renews the old login meanwhile. The code is
   * never logged and never answered.
   */
  async loginFinish(code: string): Promise<void> {
    const pending = this.pending
    if (!pending || !pending.child.running()) {
      this.dropPending()
      throw new CliRefusal(
        "No sign-in is waiting for a code: call login_start first, then use the code from that sign-in (a code works only once, with the sign-in that showed it).",
      )
    }
    const trimmed = code.trim()
    if (!SIGN_IN_CODE.test(trimmed)) {
      throw new CliRefusal(
        "That does not look like the whole code: copy all of it from the sign-in page, including the # in the middle.",
      )
    }
    this.pending = undefined
    clearTimeout(pending.timer)
    const { child } = pending
    const result = await this.options.credentials.serial.run(async () => {
      child.write(`${trimmed}\n`)
      return this.within(child.wait(), LOGIN_FINISH_MS, () => child.kill())
    })
    if (!result || result.code !== 0) {
      const said = lastWords(child.output(), [trimmed])
      this.options.logger.warn("login_finish_failed", {
        exit: result?.code ?? "timeout",
      })
      throw new CliRefusal(
        `The sign-in did not finish${said ? `: ${said}` : ""}. Codes expire within minutes and work once: call login_start again and use the new code.`,
      )
    }
    if (!this.options.credentials.tokens()) {
      throw new CliRefusal(
        "The CLI finished the sign-in but left no login in its config folder.",
      )
    }
    this.options.logger.info("login_finished")
  }
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach } from "vitest"

import { SessionsApi } from "../src/api.ts"
import { Cli } from "../src/cli.ts"
import { Credentials } from "../src/credentials.ts"
import type { Transport } from "../src/egress.ts"
import { createLogger, type Logger } from "../src/log.ts"
import { Serial } from "../src/serial.ts"
import { runTool, toolSpecs, type ToolDeps } from "../src/tools.ts"
import { FakeAnthropic, writeLogin } from "./fake-api.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-test-"))
  dirs.push(dir)
  return dir
}

export const FAKE_CLI = join(import.meta.dirname, "fake-claude.mjs")
export const GOOD_CODE = "goodcode0123456789#FAKESTATE0123456789"

/** A clock the test moves by hand; sleeping moves it. */
export class Clock {
  ms = Date.UTC(2026, 10, 19, 9, 0, 0)
  now = () => this.ms
  advance(ms: number) {
    this.ms += ms
  }
  sleep = async (ms: number) => {
    this.ms += ms
  }
}

/** Captures every log line. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  return { logger: createLogger((line) => lines.push(line)), lines }
}

export type Setup = {
  fake: FakeAnthropic
  clock: Clock
  dir: string
  lines: string[]
  logger: Logger
  deps: ToolDeps
  credentials: Credentials
  cli: Cli
  /** Calls a tool as the MCP server would: input checked, then run. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  /** The structured answer of a call that must succeed. */
  ok(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  /** The fake CLI's recorded runs. */
  cliRuns(): Record<string, unknown>[]
}

export function setup(
  options: {
    signedIn?: boolean
    expiresInMs?: number
    fakeMode?: string
    dir?: string
    transport?: (fake: FakeAnthropic) => Transport
  } = {},
): Setup {
  const clock = new Clock()
  const fake = new FakeAnthropic(clock.now)
  const dir = options.dir ?? tempDir()
  if (options.signedIn !== false) {
    writeLogin(dir, {
      expiresAt: clock.now() + (options.expiresInMs ?? 8 * 60 * 60 * 1000),
    })
    fake.accessExpiresAt =
      clock.now() + (options.expiresInMs ?? 8 * 60 * 60 * 1000)
  }
  const { logger, lines } = capturingLogger()
  const transport = options.transport ? options.transport(fake) : fake.transport
  const credentials = new Credentials({
    dir,
    transport,
    serial: new Serial(),
    logger,
    now: clock.now,
  })
  const api = new SessionsApi({
    transport,
    credentials,
    logger,
    now: clock.now,
  })
  const cli = new Cli({
    bin: process.execPath,
    baseArgs: [
      FAKE_CLI,
      ...(options.fakeMode ? [`--fake-mode=${options.fakeMode}`] : []),
    ],
    configDir: dir,
    credentials,
    logger,
    now: clock.now,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      MCP_AUTH_TOKEN: "must-never-reach-the-cli-0123456789",
    },
  })
  const deps: ToolDeps = {
    api,
    cli,
    credentials,
    logger,
    now: clock.now,
    sleep: clock.sleep,
  }
  const specs = toolSpecs(deps)
  async function call(name: string, args: Record<string, unknown> = {}) {
    const spec = specs.find((s) => s.name === name)
    if (!spec) throw new Error(`no tool ${name}`)
    const parsed = spec.input.parse(args) as Record<string, unknown>
    return runTool(spec, parsed, logger)
  }
  return {
    fake,
    clock,
    dir,
    lines,
    logger,
    deps,
    credentials,
    cli,
    call,
    async ok(name, args) {
      const result = await call(name, args)
      if (result.isError)
        throw new Error(
          `${name} failed: ${(result.content[0] as { text: string }).text}`,
        )
      return result.structuredContent as Record<string, unknown>
    },
    cliRuns() {
      try {
        return readFileSync(join(dir, "fake-cli-runs.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      } catch {
        return []
      }
    },
  }
}

/** The text of an error answer. */
export function errorText(result: CallToolResult): string {
  if (!result.isError) throw new Error("expected an error answer")
  return (result.content[0] as { text: string }).text
}

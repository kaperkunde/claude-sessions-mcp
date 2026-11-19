/**
 * The one logger. It writes one JSON line per event to standard error: an
 * event name and a few fields the caller picks (a tool, a status, a
 * duration). It never takes a request or response body, a session's text,
 * a sign-in address or code, and every string field passes `redact` first,
 * so a token that slips into a field is masked before it is written.
 */

export type LogFields = Record<string, string | number | boolean | undefined>

export type Logger = {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** claude.ai's OAuth tokens: sk-ant-oat01-…, sk-ant-ort01-… and the like. */
const ANTHROPIC_TOKEN = /sk-ant-[A-Za-z0-9]+-[A-Za-z0-9_-]+/g
/** A sign-in code as the owner pastes it: code#state. */
const SIGN_IN_CODE = /[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]{8,}/g
/** A long run of hex, of letters and digits, or of base64. */
const TOKEN = /(?:[A-Za-z0-9_-]{32,}|[A-Za-z0-9+/]{60,}={0,2})/g
/** A Bearer header's value. */
const BEARER = /Bearer\s+\S+/gi
/** A PEM block. */
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g

/** Masks what must never reach a log or an error: tokens, codes, keys. */
export function redact(text: string): string {
  return text
    .replace(PEM, "[key]")
    .replace(BEARER, "Bearer [token]")
    .replace(ANTHROPIC_TOKEN, "[token]")
    .replace(SIGN_IN_CODE, "[code]")
    .replace(TOKEN, "[token]")
}

/** Where lines go; standard error unless a test hands its own. */
export type Sink = (line: string) => void

export function createLogger(
  sink: Sink = (line) => process.stderr.write(`${line}\n`),
): Logger {
  function write(level: string, event: string, fields: LogFields = {}) {
    const line: Record<string, string | number | boolean> = {
      time: new Date().toISOString(),
      level,
      event,
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      line[key] = typeof value === "string" ? redact(value) : value
    }
    sink(JSON.stringify(line))
  }
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  }
}

/** A logger that drops everything (for tests that do not look). */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

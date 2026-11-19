import type { ApiEvent } from "./api.ts"
import { redact } from "./log.ts"

/**
 * Reading a session's events. An event is `{event_type, payload, …}`, and
 * its payload is a message of Claude Code's stream (`assistant`, `user`,
 * `result`, `system`, `prompt_suggestion`, `control_request`,
 * `control_response`, `rate_limit_event`, …). The reading is lenient:
 * a field it does not know is passed over, never an error.
 *
 * What comes back is picked: an assistant's text and the names of the
 * tools it used, the text a person sent, the end of a turn. Never
 * thinking, tool inputs or tool results. Text is written by the session
 * (and by whatever it read), so it is data, never instructions.
 */

export const MAX_ITEM_CHARS = 1200
export const MAX_ANSWER_CHARS = 8000

export type Item = {
  seq?: number
  at?: string
  kind: "assistant" | "user" | "result"
  text?: string
  tools?: string[]
  /** For a result: success, error_max_turns, … */
  outcome?: string
}

export type State =
  "working" | "waiting" | "needs_permission" | "done" | "unknown"

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : undefined
}

/** Control characters out (but line breaks), cut to `max`. */
export function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
  return visible.length > max ? `${visible.slice(0, max)}…` : visible
}

export function payloadOf(event: ApiEvent): Obj {
  return obj(event.payload) ?? event
}

export function typeOf(event: ApiEvent): string | undefined {
  const type = payloadOf(event).type
  if (typeof type === "string") return type
  return typeof event.event_type === "string" ? event.event_type : undefined
}

function blocks(message: unknown): unknown[] {
  const content = obj(message)?.content
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

function texts(message: unknown): string {
  return blocks(message)
    .map(obj)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => (b!.text as string).trim())
    .filter(Boolean)
    .join("\n")
}

function toolNames(message: unknown): string[] {
  return blocks(message)
    .map(obj)
    .filter((b) => b?.type === "tool_use" && typeof b.name === "string")
    .map((b) => clean(b!.name as string, 80))
}

function meta(event: ApiEvent): Pick<Item, "seq" | "at"> {
  const seq = event.sequence_num
  const at = event.created_at
  return {
    ...(typeof seq === "number" ? { seq } : {}),
    ...(typeof at === "string" ? { at: clean(at, 40) } : {}),
  }
}

/** One event as an item, or undefined for one that is passed over. */
export function itemOf(event: ApiEvent): Item | undefined {
  const payload = payloadOf(event)
  switch (typeOf(event)) {
    case "assistant": {
      const text = texts(payload.message)
      const tools = toolNames(payload.message)
      if (!text && tools.length === 0) return undefined // thinking only
      return {
        ...meta(event),
        kind: "assistant",
        ...(text ? { text: clean(text, MAX_ITEM_CHARS) } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      }
    }
    case "user": {
      // Only what a person sent: never a tool's result (a user message
      // too), a subagent's prompt, or what Claude Code adds itself (meta
      // and synthetic messages, compact summaries, command output).
      if (!personSent(payload)) return undefined
      const text = texts(payload.message)
      if (!text || SYNTHETIC_TEXT.test(text)) return undefined
      return { ...meta(event), kind: "user", text: clean(text, MAX_ITEM_CHARS) }
    }
    case "result": {
      const result = payload.result
      return {
        ...meta(event),
        kind: "result",
        ...(typeof payload.subtype === "string"
          ? { outcome: clean(payload.subtype, 60) }
          : {}),
        ...(typeof result === "string" && result.trim()
          ? { text: clean(result.trim(), MAX_ITEM_CHARS) }
          : {}),
      }
    }
    default:
      return undefined
  }
}

/** Text Claude Code writes into a user message itself, by its opening. */
const SYNTHETIC_TEXT =
  /^\s*(?:<(?:bash-stdout|bash-stderr|bash-input|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|task-notification)\b|This session is being continued from a previous conversation)/

/** Whether a user message is one a person sent. */
function personSent(payload: Obj): boolean {
  if (payload.isMeta === true || payload.isSynthetic === true) return false
  if (payload.isCompactSummary === true) return false
  if (payload.isVisibleInTranscriptOnly === true) return false
  if (
    payload.parent_tool_use_id !== undefined &&
    payload.parent_tool_use_id !== null
  )
    return false
  if (payload.tool_use_result !== undefined) return false
  return true
}

const TURN_ENDS = new Set(["result", "prompt_suggestion"])
const ACTIVITY = new Set(["assistant", "user"])

/**
 * What the session is doing, from its newest events (newest first) and
 * its own record: done when archived; needs_permission when it waits on a
 * permission prompt; waiting when its newest turn ended (a result or a
 * prompt suggestion is newer than any message); working when a message is
 * newer than the last turn's end.
 */
export function stateOf(
  newestFirst: ApiEvent[],
  session: Record<string, unknown> = {},
): State {
  const status = session.status ?? session.session_status
  if (status === "archived") return "done"
  if (session.worker_status === "requires_action") return "needs_permission"
  for (const event of newestFirst) {
    const type = typeOf(event)
    if (type === undefined) continue
    if (TURN_ENDS.has(type)) return "waiting"
    if (ACTIVITY.has(type)) {
      // A tool's result is still the turn at work.
      return "working"
    }
  }
  return "unknown"
}

export function summarise(newestFirst: ApiEvent[]): Item[] {
  const items: Item[] = []
  for (const event of newestFirst) {
    const item = itemOf(event)
    if (item) items.push(item)
  }
  return items
}

/** The control_response to request `id` among the events, if there. */
export function controlResponse(
  events: ApiEvent[],
  requestId: string,
): Obj | undefined {
  for (const event of events) {
    if (typeOf(event) !== "control_response") continue
    const payload = payloadOf(event)
    const response = obj(payload.response)
    const id = response?.request_id ?? payload.request_id
    if (id === requestId) return response ?? payload
  }
  return undefined
}

const ANSWER_KEYS = ["answer", "text", "response", "content", "result"]

function textIn(value: unknown, depth: number): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (depth > 3) return undefined
  if (Array.isArray(value)) {
    const joined = value
      .map((part) => textIn(part, depth + 1))
      .filter(Boolean)
      .join("\n")
    return joined || undefined
  }
  const o = obj(value)
  if (!o) return undefined
  for (const key of ANSWER_KEYS) {
    const found = textIn(o[key], depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * A side question's answer from its control_response: `{subtype:
 * "success", request_id, response: {…}}`, the text found under the usual
 * keys; or the error for `subtype: "error"`.
 */
export function answerOf(
  response: Obj,
): { ok: true; answer: string } | { ok: false; error: string } {
  if (response.subtype === "error") {
    const error = typeof response.error === "string" ? response.error : ""
    return {
      ok: false,
      error: clean(error || "The session could not answer.", 400),
    }
  }
  const answer = textIn(response.response ?? response, 0)
  if (!answer) return { ok: false, error: "The session answered nothing." }
  return { ok: true, answer: clean(answer, MAX_ANSWER_CHARS) }
}

/** A permission prompt a session waits on, as the owner is shown it. */
export type PendingPermission = {
  request_id: string
  /** The tool it wants to use. */
  tool: string
  /** What it wants to do, in the session's words, masked and cut short. */
  description: string | null
  /** The command or file it names, masked and cut short. */
  target: string | null
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/

function shown(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  return redact(clean(value.trim(), max))
}

/**
 * The permission prompt the session's record says it waits on
 * (`worker_status` requires_action, `external_metadata.pending_action`),
 * or undefined. Never the tool's whole input: its description, and the
 * command or file it names, masked.
 */
export function pendingPermission(
  session: Record<string, unknown>,
): PendingPermission | undefined {
  if (session.worker_status !== "requires_action") return undefined
  const pending = obj(obj(session.external_metadata)?.pending_action)
  if (!pending) return undefined
  const requestId = pending.request_id
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
    return undefined
  const tool = [pending.display_tool_name, pending.tool_name].find(
    (name): name is string => typeof name === "string" && TOOL_NAME.test(name),
  )
  const input = obj(pending.input)
  return {
    request_id: requestId,
    tool: tool ?? "a tool",
    description: shown(pending.action_description, 300),
    target:
      shown(input?.command, 300) ??
      shown(input?.file_path, 300) ??
      shown(input?.url, 300) ??
      shown(input?.path, 300),
  }
}

import type { ApiEvent } from "./api.ts"
import { holdsSecret, redact } from "./log.ts"

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

/**
 * A permission prompt a session waits on, as the session's record has it
 * (`worker_status` requires_action, `external_metadata.pending_action`).
 */
export type PendingAction = {
  requestId: string
  /** The tool, as shown. */
  tool: string
  /** The tool's own name, as the answer names it. */
  toolName: string | undefined
  toolUseId: string | undefined
  description: string | null
  /** The tool input on the record, if it carries one. */
  input: Record<string, unknown> | undefined
}

/** A permission prompt as the owner (and an assistant) is shown it. */
export type PermissionView = {
  request_id: string
  tool: string
  description: string | null
  /**
   * The whole tool input, as the JSON text answer_permission sends and
   * takes back as expected_input; null when it is withheld.
   */
  input: string | null
  /** Why the input is not shown (and the prompt cannot be allowed here). */
  input_withheld: string | null
}

/** The most of an input shown, and so allowed, whole. */
export const MAX_SHOWN_INPUT_CHARS = 4000

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/
/** Format characters (bidi, zero-width): text that shows otherwise than it is. */
const FORMAT = /\p{Cf}/u

function shown(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  return redact(clean(value.trim(), max))
}

export function pendingAction(
  session: Record<string, unknown>,
): PendingAction | undefined {
  if (session.worker_status !== "requires_action") return undefined
  const pending = obj(obj(session.external_metadata)?.pending_action)
  if (!pending) return undefined
  const requestId = pending.request_id
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
    return undefined
  const tool = [pending.display_tool_name, pending.tool_name].find(
    (name): name is string => typeof name === "string" && TOOL_NAME.test(name),
  )
  return {
    requestId,
    tool: tool ?? "a tool",
    toolName:
      typeof pending.tool_name === "string" && TOOL_NAME.test(pending.tool_name)
        ? pending.tool_name
        : undefined,
    toolUseId:
      typeof pending.tool_use_id === "string" &&
      REQUEST_ID.test(pending.tool_use_id)
        ? pending.tool_use_id
        : undefined,
    description: shown(pending.action_description, 300),
    input: obj(pending.input),
  }
}

/**
 * The prompt as shown: the exact input that an allow would send, as JSON
 * text, whole or not at all. Withheld (and so never allowed from here)
 * when it is missing, longer than MAX_SHOWN_INPUT_CHARS, holds something
 * that looks like a secret, or has characters that do not show as they
 * are.
 */
export function permissionView(
  action: PendingAction,
  input: Record<string, unknown> | undefined,
): PermissionView {
  const base = {
    request_id: action.requestId,
    tool: action.tool,
    description: action.description,
  }
  const withheld = (reason: string): PermissionView => ({
    ...base,
    input: null,
    input_withheld: reason,
  })
  if (!input) return withheld("The prompt's input could not be read.")
  const text = JSON.stringify(input)
  if (text.length > MAX_SHOWN_INPUT_CHARS)
    return withheld(
      `The input is too long to show whole (${text.length} characters; at most ${MAX_SHOWN_INPUT_CHARS}).`,
    )
  if (holdsSecret(text))
    return withheld(
      "The input looks like it holds a secret, so it is not shown.",
    )
  if (FORMAT.test(text))
    return withheld(
      "The input has characters that do not show as they are (bidi or zero-width).",
    )
  return { ...base, input: text, input_withheld: null }
}

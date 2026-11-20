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
  | "working"
  | "waiting"
  | "needs_permission"
  | "needs_answer"
  | "stalled"
  | "done"
  | "unknown"

/**
 * The tool a session asks its person questions with. Its prompt comes as
 * a permission prompt for this tool, and is answered with the answers in
 * its input (answer_question), never allowed as it is.
 */
export const QUESTION_TOOL = "AskUserQuestion"

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
 * its own record: done when archived; needs_answer when it waits on a
 * question (QUESTION_TOOL, read by pendingAction), needs_permission when
 * it waits on any other permission prompt or one it cannot read; stalled when its worker runs but lost contact (the
 * CLI's own "lost contact with the cloud environment": worker running,
 * connection disconnected); waiting when its newest turn ended (a result
 * or a prompt suggestion is newer than any message); working when a
 * message is newer than the last turn's end.
 */
export function stateOf(
  newestFirst: ApiEvent[],
  session: Record<string, unknown> = {},
): State {
  const status = session.status ?? session.session_status
  if (status === "archived") return "done"
  if (session.worker_status === "requires_action") {
    // The same prompt pending_question and pending_permission read: a
    // question only when it can be shown as one, else (one it cannot read
    // included) needs_permission, as before questions were told apart.
    const action = pendingAction(session)
    return action && isQuestion(action) ? "needs_answer" : "needs_permission"
  }
  if (
    session.worker_status === "running" &&
    session.connection_status === "disconnected"
  )
    return "stalled"
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
  const reason = withheldReason(input)
  if (reason) return withheld(reason)
  return { ...base, input: JSON.stringify(input), input_withheld: null }
}

/**
 * Why an input is not shown whole, or undefined when it is: longer than
 * MAX_SHOWN_INPUT_CHARS as JSON text, something that looks like a secret,
 * or characters that do not show as they are.
 */
function withheldReason(input: Record<string, unknown>): string | undefined {
  const text = JSON.stringify(input)
  if (text.length > MAX_SHOWN_INPUT_CHARS)
    return `The input is too long to show whole (${text.length} characters; at most ${MAX_SHOWN_INPUT_CHARS}).`
  if (holdsSecret(text))
    return "The input looks like it holds a secret, so it is not shown."
  if (FORMAT.test(text))
    return "The input has characters that do not show as they are (bidi or zero-width)."
  return undefined
}

/** Whether a prompt is a question (QUESTION_TOOL), not a permission. */
export function isQuestion(action: PendingAction): boolean {
  return action.toolName === QUESTION_TOOL
}

export type QuestionView = {
  request_id: string
  /** Every question, as asked; empty when withheld. */
  questions: {
    question: string
    header: string | null
    /**
     * How it is answered: choice (among its options, the default), text
     * or number (words or a number of the owner's, no options).
     */
    kind: QuestionKind
    multi_select: boolean
    options: {
      label: string
      description: string | null
      /** What the option would look like (code, a mock-up), as asked. */
      preview: string | null
    }[]
  }[]
  /** Why the questions are not shown (and cannot be answered here). */
  input_withheld: string | null
}

type Question = QuestionView["questions"][number]

/** How a question is answered, as the CLI's tool takes `kind`. */
export const QUESTION_KINDS = ["choice", "text", "number"] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

function isKind(value: unknown): value is QuestionKind {
  return (QUESTION_KINDS as readonly unknown[]).includes(value)
}

/** The most questions one prompt asks, as the CLI's tool takes them. */
export const MAX_QUESTIONS = 4
/** The most an answer may hold in all, as the CLI's check takes it. */
export const MAX_ANSWER_TOTAL_CHARS = 32768

/** Control characters but a line break: text that shows otherwise. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

/** A question's own text, exactly as asked; undefined if it is not one. */
function exact(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * The questions in a question prompt's input ({questions: [{question,
 * header, kind, options: [{label, description, preview}], multiSelect}]}),
 * exactly as asked, or why they cannot be shown. A text or number
 * question has no options and is not multiSelect, as the CLI's tool
 * takes it; a kind it does not know cannot be read.
 */
function readQuestions(
  input: Record<string, unknown>,
): { questions: Question[] } | { reason: string } {
  const unreadable = { reason: "The questions could not be read." }
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTIONS)
    return unreadable
  const questions: Question[] = []
  for (const item of raw) {
    const q = obj(item)
    const question = exact(q?.question)
    if (!q || !question) return unreadable
    if (q.header !== undefined && typeof q.header !== "string")
      return unreadable
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
      return unreadable
    const kind = q.kind ?? "choice"
    if (!isKind(kind)) return unreadable
    const rawOptions = q.options ?? (kind === "choice" ? undefined : [])
    if (!Array.isArray(rawOptions)) return unreadable
    if (kind !== "choice" && (rawOptions.length > 0 || q.multiSelect === true))
      return unreadable
    const options: Question["options"] = []
    for (const o of rawOptions.map(obj)) {
      const label = exact(o?.label)
      if (!o || !label) return unreadable
      if (o.description !== undefined && typeof o.description !== "string")
        return unreadable
      if (o.preview !== undefined && typeof o.preview !== "string")
        return unreadable
      options.push({
        label,
        description: (o.description as string | undefined) ?? null,
        preview: (o.preview as string | undefined) ?? null,
      })
    }
    if (new Set(options.map((o) => o.label)).size !== options.length)
      return { reason: "Two options of a question have the same label." }
    questions.push({
      question,
      header: (q.header as string | undefined) ?? null,
      kind,
      multi_select: q.multiSelect === true,
      options,
    })
  }
  if (new Set(questions.map((q) => q.question)).size !== questions.length)
    return { reason: "Two of its questions have the same text." }
  const shownText = questions.flatMap((q) => [
    q.question,
    q.header ?? "",
    ...q.options.flatMap((o) => [
      o.label,
      o.description ?? "",
      o.preview ?? "",
    ]),
  ])
  if (shownText.some((text) => CONTROL.test(text)))
    return {
      reason:
        "The questions have characters that do not show as they are (control characters).",
    }
  return { questions }
}

/**
 * A question prompt as shown: its questions exactly as asked, whole or
 * not at all, withheld as a permission prompt's input is (and then never
 * answered from here).
 */
export function questionView(
  action: PendingAction,
  input: Record<string, unknown> | undefined,
): QuestionView {
  const withheld = (reason: string): QuestionView => ({
    request_id: action.requestId,
    questions: [],
    input_withheld: reason,
  })
  if (!input) return withheld("The prompt's input could not be read.")
  const reason = withheldReason(input)
  if (reason) return withheld(reason)
  const read = readQuestions(input)
  if ("reason" in read) return withheld(read.reason)
  return {
    request_id: action.requestId,
    questions: read.questions,
    input_withheld: null,
  }
}

/** One answer as answer_question takes it. */
export type QuestionAnswer = {
  question: string
  choices?: string[]
  text?: string
}

/**
 * Several choices as one answer, as the CLI joins them: ", " between,
 * and a choice that holds ", " or a double quote as a JSON string.
 */
export function joinChoices(choices: string[]): string {
  return choices
    .map((c) => (c.includes(", ") || c.includes('"') ? JSON.stringify(c) : c))
    .join(", ")
}

/**
 * The answers to send ({question text: answer}) for the questions shown,
 * or why they cannot be sent: every question answered once, by its exact
 * text; a choice question with choices among its labels (one unless it
 * is multi_select) or a free text (the "Other" answer), the text alone
 * unless it is multi_select, where it joins the choices as one more item
 * (the CLI takes up to its options and one); a text or number question
 * with text only; within the CLI's length.
 */
export function questionAnswers(
  questions: Question[],
  answers: QuestionAnswer[],
):
  { ok: true; answers: Record<string, string> } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  const quote = (text: string) => `"${clean(text, 200)}"`
  const out: Record<string, string> = {}
  for (const given of answers) {
    const question = questions.find((q) => q.question === given.question)
    if (!question)
      return fail(
        `${quote(given.question)} is not one of its questions: give each question's text exactly as pending_question shows it.`,
      )
    if (Object.hasOwn(out, question.question))
      return fail(
        `${quote(question.question)} is answered more than once: answer each question once.`,
      )
    const choices = given.choices ?? []
    const text = given.text
    if (question.kind !== "choice" && choices.length > 0)
      return fail(
        `${quote(question.question)} is a ${question.kind} question with no options: answer it with text only.`,
      )
    if (text !== undefined && choices.length > 0 && !question.multi_select)
      return fail(
        `text is the free answer and goes alone: answer ${quote(question.question)} with choices or text, not both (both only on a multi_select question).`,
      )
    if (text !== undefined) {
      if (!text.trim())
        return fail(
          question.kind === "choice"
            ? `Answer ${quote(question.question)} with choices or text.`
            : `Answer ${quote(question.question)} with text.`,
        )
      if (CONTROL.test(text) || FORMAT.test(text))
        return fail(
          `The answer to ${quote(question.question)} has characters that do not show as they are (control, bidi or zero-width).`,
        )
      if (choices.length === 0) {
        out[question.question] = text
        continue
      }
    }
    if (choices.length === 0)
      return fail(
        question.kind === "choice"
          ? `Answer ${quote(question.question)} with choices or text.`
          : `Answer ${quote(question.question)} with text.`,
      )
    const labels = question.options.map((o) => o.label)
    const unknown = choices.find((c) => !labels.includes(c))
    if (unknown !== undefined)
      return fail(
        `${quote(unknown)} is not one of the labels of ${quote(question.question)}: choose labels exactly as shown, or answer with text.`,
      )
    if (new Set(choices).size !== choices.length)
      return fail(`A choice is given twice for ${quote(question.question)}.`)
    if (!question.multi_select && choices.length > 1)
      return fail(
        `${quote(question.question)} takes one choice (it is not multi_select).`,
      )
    out[question.question] = question.multi_select
      ? joinChoices(text === undefined ? choices : [...choices, text])
      : choices[0]!
  }
  const missing = questions.find((q) => !Object.hasOwn(out, q.question))
  if (missing)
    return fail(
      `Answer every question it asks, each once: ${quote(missing.question)} has no answer.`,
    )
  const total = Object.values(out).reduce((sum, a) => sum + a.length, 0)
  if (total > MAX_ANSWER_TOTAL_CHARS)
    return fail(
      `The answers are longer than the session takes (${total} characters; at most ${MAX_ANSWER_TOTAL_CHARS} in all).`,
    )
  return { ok: true, answers: out }
}

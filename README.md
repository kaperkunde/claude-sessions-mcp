# claude-sessions-mcp

An MCP server for one owner's Claude Code cloud sessions (claude.ai/code),
made to run as a [PCP](https://pcp.gg) service. Any assistant connected to
PCP, a voice chat with no Claude Code tools included, can list your
sessions, see what one is doing, ask it a quick side question without
derailing it, send it a message, interrupt it, answer its permission
prompt or the questions it asks you, archive, unarchive or rename it, or start a new one in the cloud
environment of your choice. It all
runs on your own claude.ai plan (Pro or Max), not API credits.

Kaperkunde keeps it, for kaperkunde/pcp#157. TypeScript, Node 24, two
runtime dependencies (`@modelcontextprotocol/server` and `zod`), and the
Claude Code CLI pinned beside it.

**Personal use only.** It signs in with _your_ claude.ai account and acts
as you. Run it for yourself, on a PCP of your own. A hosted PCP for other
people must not offer it: it would be one person signing in to another's
claude.ai.

**An unofficial API.** The sessions API it calls is the one the Claude Code
CLI uses (`/v1/code/sessions…`, beta `ccr-byoc-2025-07-29`). It is not
documented and may change with any CLI release, which is why the CLI is
pinned in the image and why there is a smoke test to run after updating it
(below). It is not made, endorsed or supported by Anthropic.

## Tools

| Tool                | Tier  | Suggested level | What it does                                                                                                                                                                                                                                                                                            |
| ------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`     | Read  | allowed         | Your sessions, newest first: id (`cse_…`), title, status, last change, repository. Archived ones only with `include_archived`.                                                                                                                                                                          |
| `get_session`       | Read  | allowed         | One session's details: title, status, what its worker is doing, repository and branch, model, environment, created and last changed, its connection status, its latest summary, its address, and the permission prompt or questions it waits on. The API names no pull requests, so none are given.     |
| `session_status`    | Read  | allowed         | What one session is doing: `state` (below), the permission prompt or questions it waits on, and its newest `events` (default 30) summarised; `cursor` (the answer's `next_cursor`) reads older ones. Never thinking, tool inputs or tool results.                                                       |
| `ask_session`       | Read  | allowed         | A side question, as `/btw` in the terminal: the session answers from its whole context, without tools, and nothing is added to its conversation. Waits up to `timeout_seconds` (default 45, at most 120).                                                                                               |
| `list_environments` | Read  | allowed         | The cloud environments your account can start sessions in, as `/remote-env` lists them: id, name, kind.                                                                                                                                                                                                 |
| `login_status`      | Read  | allowed         | Whether the service is signed in and as whom (email, organization, plan), when the access token lapses, whether a sign-in waits for its code. Never a token.                                                                                                                                            |
| `send_message`      | Write | **ask**         | A message into the session's conversation, as if you typed it; a busy session takes it at its next step, or as `priority` says (`now`, `next`, `later`). `interrupt_first` stops the current turn first.                                                                                                |
| `interrupt_session` | Write | **ask**         | Stops the current turn (as Esc does) and drops queued messages; background tasks keep running.                                                                                                                                                                                                          |
| `answer_permission` | Write | **ask**         | Allows once (with `expected_input`, the shown input echoed back exactly), or denies with a message, the permission prompt a session waits on: only the one `request_id` names, only while it still waits on it, and only once.                                                                          |
| `answer_question`   | Write | **ask**         | Answers the questions a session asks you (`AskUserQuestion`), or declines them with a message: every question once, by its exact text, with `choices` among its labels (one unless `multi_select`) or your own `text`; only the one `request_id` names, only while it still waits on it, and only once. |
| `start_session`     | Write | **ask**         | A new cloud session on a GitHub `repo` (owner/name) with `task` as its first message, through `claude --cloud`, in your default cloud environment or the one `environment_id` names. `branch` is the repository's default branch (`main` if left out).                                                  |
| `archive_session`   | Write | **ask**         | Archives a session, as on claude.ai/code: it stops and leaves the list. Nothing is deleted.                                                                                                                                                                                                             |
| `unarchive_session` | Write | **ask**         | Brings an archived session back. claude.ai may ask for a trusted device for this; it then says to do it on claude.ai/code.                                                                                                                                                                              |
| `rename_session`    | Write | **ask**         | Sets a session's title (one line, up to 200 characters).                                                                                                                                                                                                                                                |
| `login_start`       | Write | allowed         | Starts the claude.ai sign-in and answers the address you sign in at. Changes nothing until it is finished.                                                                                                                                                                                              |
| `login_finish`      | Write | **blocked**     | Finishes the sign-in with your code. Only through the wrapper below, which hands it the code as a PCP secret.                                                                                                                                                                                           |

Read tools state `readOnlyHint: true`, the others `false`; none is
destructive. Every tool states all four annotations, takes a closed
snake_case input whose every property is described, and answers JSON as
`structuredContent` with an output schema.

In PCP, a Write tool at **ask** means PCP asks you before each call:
nothing is sent to a session, interrupted, allowed, answered, started,
archived or renamed without your yes.

Every request a tool makes is one the pinned CLI (2.1.327) makes itself:
the paths, bodies and fields were read out of its bundle, not guessed
(see "The API it relies on"). What the CLI does not do, the service does
not offer: there is no tool to delete a session, and no pull-request
links, which the session record does not carry.

### Permission prompts

When a session waits on a permission prompt (its worker is
`requires_action`), `session_status` and `get_session` show it as
`pending_permission`: the prompt's `request_id`, the tool, the session's
own description of what it wants, and **the whole tool input it would run
with**, as JSON text (`input`): exactly what an allow sends, taken from
the session's record or, when the record has none, from the prompt's own
event. The input is withheld (`input` null, `input_withheld` says why)
when it cannot be read, is longer than 4,000 characters, looks like it
holds a secret (a key, a token, a Bearer value), or has characters that
do not show as they are (bidi, zero-width). A withheld prompt cannot be
allowed from here: answer it on claude.ai/code.

`answer_permission` answers it as the CLI does, with a `control_response`:
deny (with your message), or allow this once, which needs
`expected_input`: the shown `input`, echoed back. It is sent only when it
is, character for character, the input the session would run with, so
PCP's approval page, which shows a call's arguments, shows you exactly
what you allow. It reads the session again first and refuses when that
prompt is no longer the one it waits on, and it answers a prompt once:
the service remembers the prompts it answered (the newest 1,000) and
refuses a second answer, even while the record still shows the prompt.
A prompt is claimed before the session is read, so two answers sent at
once post once, and given back when the answer is refused or does not go
in.

### Questions

When a session asks you something (Claude Code's `AskUserQuestion`: one
to four questions, each with a short heading and options), its worker is
`requires_action` on a prompt for that tool. `session_status` and
`get_session` then show it as `pending_question`, never as
`pending_permission`: the prompt's `request_id` and each question exactly
as asked, with its `header`, its `kind` (`choice`, the default, among its
options; `text` or `number`, the owner's own words, no options), whether
it is `multi_select`, and its options (`label`, `description`,
`preview`). The questions are withheld (`questions` empty,
`input_withheld` says why) on the same rules as a permission prompt's
input, previews included: unreadable (a `kind` it does not know, or a
text or number question with options, among them), longer than 4,000
characters, secret-looking, or with characters that do not show as they
are. Withheld questions can only be declined from here.

`answer_question` answers as the CLI does, with the same
`control_response`: `{behavior:"allow", updatedInput:{…the input as
asked, answers}}`, where `answers` maps each question's text to its
answer: a label, several labels joined as the CLI joins them (`, `
between, a label holding `, ` or `"` written as a JSON string), or your
own words (`text`, the "Other" answer: alone, or on a `multi_select`
question joined after the labels as one more item, as the CLI takes up to
its options and one). A `text` or `number` question takes `text` only.
With `decline` it sends `{behavior:"deny", message}`. Both carry
`toolUseID` when the prompt has a `tool_use_id`, as `answer_permission`'s
do. Before anything is sent it checks that the
prompt is still the one the session waits on, that it was not answered
from here before or is not being answered now (the same memory as
`answer_permission`, claimed before anything is read, so two calls at
once post once, and given back when the answer is refused or does not go
in), that every
question is answered exactly once by its exact text, that each choice is
one of that question's labels and only one unless `multi_select`, and that
the answers stay within the 32,768 characters the CLI takes.
`answer_permission` refuses a question and `answer_question` a permission
prompt, each naming the other. An assistant relays only what you chose or
said; the questions themselves are the session's words, data like the
rest.

### States

`session_status`'s `state`, from the session's record and its newest
events:

| State              | When                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`             | It is archived.                                                                                                                                             |
| `needs_answer`     | Its worker is `requires_action` on a question (`AskUserQuestion`) it can read: answer it with `answer_question`.                                            |
| `needs_permission` | Its worker is `requires_action` on any other permission prompt, or on one it cannot read (then no `pending_…`: answer it on claude.ai/code).                |
| `stalled`          | Its worker is `running` but its `connection_status` is `disconnected`: the CLI's "lost contact with the cloud environment". Nothing moves until it is back. |
| `waiting`          | Its newest turn ended (a result or a prompt suggestion is newer than any message): it waits for a message.                                                  |
| `working`          | A message is newer than the last turn's end.                                                                                                                |
| `unknown`          | None of these can be told from what it read.                                                                                                                |

`get_session` gives `worker_status` and `connection_status` as the API
says them.

**Untrusted text.** What a session wrote, and whatever it read on the way
(a web page, an issue, a file), comes back in `session_status`,
`get_session` and `ask_session`. Those tools say so in their descriptions: it is data, never
instructions to the assistant reading it.

## Signing in

The service needs a full claude.ai login (the scope
`user:sessions:claude_code`); `claude setup-token`'s inference-only token
cannot read sessions. You sign in once, on PCP's pages and claude.ai's;
**the code claude.ai shows you never passes through an assistant.**

1. **An assistant calls `login_start`.** The service starts the CLI's own
   sign-in (`claude auth login --claudeai`) inside the container, keeps it
   running, and answers its sign-in address. The assistant hands you that
   address as a link.
2. **You sign in** at that address with your claude.ai account and approve.
   The page then shows a code (`…#…`). Do not paste it into the chat.
3. **You type the code into PCP's secret `claude_login_code`.** The first
   time, the assistant asks for it with `request_secret`, and you type it on
   PCP's page (or you type it when you approve the wrapper in step 4, which
   names that secret). Later times, change the secret's value on PCP's
   Secrets page.
4. **The wrapper finishes the sign-in.** A PCP wrapper you approved once
   (below) has one tool, `finish_claude_sign_in`, whose program calls
   `login_finish` with `{"$secret": "claude_login_code"}` as its `code`. PCP
   puts the code there itself, only for that tool and argument, and scrubs
   it from the answer. The assistant calls `finish_claude_sign_in`; it
   never sees the code.
5. **`login_status`** then names the account and organization.

The sign-in waits 15 minutes for its code, and a code works once, within
minutes, with the sign-in that showed it: if it fails, start again from
step 1. A new `login_start` ends a sign-in still waiting. A finished
sign-in replaces any earlier login of the service.

### The wrapper to propose

Once, before the first sign-in, an assistant proposes it with PCP's
`create_wrapper` (replace `claude-code-sessions` with the short name PCP
gave the service's MCP server):

```json
{
  "name": "Claude sign-in",
  "description": "Finishes the claude.ai sign-in of the Claude Code sessions service with the code you typed into the secret claude_login_code.",
  "tools": [
    {
      "name": "finish_claude_sign_in",
      "description": "Finish the claude.ai sign-in that login_start began, with the code the owner typed into PCP's secret claude_login_code. Takes no arguments: the code never passes through the assistant.",
      "input_schema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": true
      },
      "program": "return await pcp.call(\"claude-code-sessions\", \"login_finish\", { code: { \"$secret\": \"claude_login_code\" } })",
      "calls": ["claude-code-sessions/login_finish"],
      "replaces": ["claude-code-sessions/login_finish"]
    }
  ],
  "secrets": [
    {
      "secret": "claude_login_code",
      "tool": "claude-code-sessions/login_finish",
      "argument": "/code"
    }
  ],
  "call_levels": "approved",
  "tool_access": [
    { "tools": ["finish_claude_sign_in"], "access": "allowed", "tier": "write" }
  ]
}
```

With `call_levels` `"approved"`, your approval of the wrapper is what lets
it call `login_finish`, so `login_finish` itself can stay **blocked** for
every token: no assistant can call it directly, with a code typed into a
chat or otherwise.

## The login, and its renewal

The login is the CLI's own, in its config folder `/home/claude/.claude`
(`CLAUDE_CONFIG_DIR`), a named volume: `.credentials.json` (the access
token, the refresh token, when the access token expires) and `.claude.json`
(the account's email and organization). It never leaves the container: no
tool answers a token, takes one, or logs one, and the CLI is started with
its own settings only (never `MCP_AUTH_TOKEN`).

The access token lasts hours; the service renews it with the CLI's own
refresh flow (the refresh grant at `platform.claude.com/v1/oauth/token`,
the CLI's client id and scopes) when less than five minutes are left, and
once more when the API answers 401. **The refresh token rotates on every
use, and a refresh token used twice can end the login**, so:

- an API call reads a token that needs no renewal straight from the file,
  so it never waits behind a CLI run; every renewal, the sign-in's finish
  and every CLI run that uses the login (`start_session`) go through one
  queue, one at a time;
- each renewal reads the file again first, so a token the CLI renewed is
  taken as it is; a renewed token is written whole, synced to disk, then
  renamed into place;
- before the CLI runs, the token is renewed if it would lapse before the
  run's time limit is up, so the CLI never renews it itself;
- a renewal that gets no usable answer (none, one that is not JSON or has
  no token, or one that cannot be written down), after which claude.ai may
  have rotated the token all the same, is never sent again: the refresh
  token's SHA-256 is kept beside the login
  (`.claude-sessions-lost-refresh`), so a restart remembers it too, and
  tools say to sign in again with `login_start`;
- a 401 that comes again after a renewal also says to sign in again, and a
  403 outside a session's events says the sign-in may lack the
  `user:sessions:claude_code` scope;
- **one container owns the login.** Never copy the volume to another
  container or machine, never mount it twice, and do not run `claude` by
  hand in the container while the service runs: two holders of one refresh
  token log each other out.

If claude.ai no longer takes the login (you signed out everywhere, or it
was renewed elsewhere), tools answer "Sign in again with login_start".

## The API it relies on

Base `https://api.anthropic.com`, on every request:

```
Authorization: Bearer <claudeAiOauth.accessToken>
anthropic-version: 2023-06-01
anthropic-beta: ccr-byoc-2025-07-29
x-organization-uuid: <oauthAccount.organizationUuid>
```

| Tool                | Request                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`     | `GET /v1/code/sessions?limit=N`                                                                                                                                                                                                                                                                                                         |
| `get_session`       | `GET /v1/code/sessions/{id}`                                                                                                                                                                                                                                                                                                            |
| `session_status`    | `GET /v1/code/sessions/{id}` and `GET /v1/code/sessions/{id}/events?limit=N&sort_order=desc` (`&cursor=` the last answer's `next_cursor` for older events)                                                                                                                                                                              |
| `ask_session`       | the newest event's `sequence_num` noted, then `POST /v1/code/sessions/{id}/events` with `{"events":[{"event_type":"control_request","payload":{…,"request":{"subtype":"side_question","question":…,"history":[]}}}]}`, then `…/events?sort_order=asc&cursor=<seq>` paged forward until the `control_response` with its `request_id`     |
| `send_message`      | the same POST with `event_type` `user`: `{type:"user", parent_tool_use_id:null, message:{role:"user", content}, priority?}`                                                                                                                                                                                                             |
| `interrupt_session` | a `control_request` `{subtype:"interrupt", cancel_queued:true, spare_background_tasks:true, send_now:true}`, as the CLI sends it; its `control_response` awaited for 15 seconds                                                                                                                                                         |
| `answer_permission` | a `control_response` `{subtype:"success", request_id, response:{behavior:"allow", updatedInput, toolUseID, tool_name}}` or `{behavior:"deny", message, toolUseID}`, for the prompt in the record's `external_metadata.pending_action`                                                                                                   |
| `answer_question`   | the same `control_response` `{subtype:"success", request_id, response:{behavior:"allow", updatedInput:{…input, answers:{<question>: <answer>}}, toolUseID}}` or `{behavior:"deny", message, toolUseID}`, for a `pending_action` whose `tool_name` is `AskUserQuestion`                                                                  |
| `archive_session`   | `POST /v1/code/sessions/{id}/archive` with `{}` (409: it already was)                                                                                                                                                                                                                                                                   |
| `unarchive_session` | `POST /v1/code/sessions/{id}/unarchive` with `{}`                                                                                                                                                                                                                                                                                       |
| `rename_session`    | `PUT /v1/code/sessions/{id}` with `{"title": …}`                                                                                                                                                                                                                                                                                        |
| `list_environments` | `GET /v1/environment_providers?limit=N`                                                                                                                                                                                                                                                                                                 |
| `start_session`     | `claude -p --cloud --output-format json`, the task on standard input, in a scratch git repository whose `origin` is `https://github.com/<repo>.git` (the CLI takes the session's repository from there); with `environment_id`, `--settings {"remote":{"defaultEnvironmentId":…}}`, the setting `/remote-env` writes, for that run only |

**Device-bound sessions.** A session bound to another machine (one started
from a laptop rather than in the cloud) may refuse events without that
device's signature (403). `send_message`, `interrupt_session` and
`ask_session` then say so; message it from that device or the Claude app.

**start_session and the CLI's own tools.** A task that starts with `/` or
`!` is refused, since the CLI would take it as a slash or shell command.
The CLI cannot be started with no local tools here: in 2.1.327 `--tools`,
`--permission-mode` and `--disallowedTools` are handed on to the cloud
session (they would limit it, not the local run), and `--restricted`,
`--bare` and `--permission-prompts none` are refused with `--cloud`. So
the service relies on print mode's own rule (a tool that needs a
permission prompt is denied, with no one to answer) and an empty scratch
folder as the working directory; files outside it, the login included,
need a prompt.

Every request has a deadline (45 seconds at most, however slowly its
bytes come in). `ask_session` and `interrupt_session` set theirs when they
start, and every request they make (the newest event, the POST, each
poll) gets only what is left; a page whose cursor does not move ends the
paging until the next poll. If the CLI runs past `start_session`'s time
limit, the answer says a session may have started: check `list_sessions`
before trying again.

`ask_session` usually answers in about ten seconds. If your PCP gives the
service a shorter time limit than `timeout_seconds`, raise the limit on the
service's page in PCP.

## After a CLI update

The CLI version is pinned in the `Dockerfile` (`CLAUDE_CODE_VERSION`, with
the npm integrity of its native musl package for each platform, checked at
build). To move to a new version, change all three, build, launch the new
image, sign in if needed, and run the smoke test against it:

```sh
ssh -L 8080:127.0.0.1:<the service's published port> <your SSH server>
MCP_URL=http://127.0.0.1:8080/mcp MCP_AUTH_TOKEN=<the service's token> \
SMOKE_SESSION=cse_<a scratch session of yours> pnpm smoke
```

It goes through the running service (it never holds a login of its own),
checks the sign-in, lists sessions, reads the scratch session and asks it
a side question; with `SMOKE_WRITE=1` it also messages and interrupts that
session, and with `SMOKE_START_REPO=owner/name` it starts a session there
(archive it afterwards). Each step prints PASS or FAIL; the exit code counts
the failures. Make the scratch session on claude.ai/code and leave it idle.

## Environment

| Variable                           |                      | What it is                                                                                                                                                                                  |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`                   | **secret, required** | Every MCP request must send `Authorization: Bearer <token>`. PCP sends it for you (`registers.auth`). At least 16 characters. Without it the service does not start, unless `MCP_AUTH=off`. |
| `MCP_AUTH`                         | plain, optional      | `off` serves the tools with no token, to anything that reaches the port; only for a test on a machine of your own.                                                                          |
| `MCP_ALLOWED_HOSTS`                | plain, optional      | `Host` values accepted besides loopback, comma separated (`192.0.2.10:8080`, `host:*`, `*`): the address you publish on, if it is not 127.0.0.1.                                            |
| `CLAUDE_CONFIG_DIR`                |                      | The CLI's config folder, holding the login: `/home/claude/.claude`, a named volume.                                                                                                         |
| `CLAUDE_BIN`                       |                      | The CLI: `/usr/local/bin/claude`.                                                                                                                                                           |
| `MCP_PORT`, `MCP_HOST`, `MCP_PATH` |                      | Where it listens: `8080`, `0.0.0.0` (inside the container), `/mcp`.                                                                                                                         |

There is no variable for the login: you sign in through the tools above.

## Where it connects

The service itself (`src/egress.ts`, the only module that opens a
connection) dials two hosts on port 443: `api.anthropic.com` (the sessions
API, paths under `/v1/code/sessions` and `/v1/environment_providers` only)
and `platform.claude.com` (the
token address, `/v1/oauth/token` only, to renew the login). Each host has
its own allow-list of paths; a request names a host key and a path, never a
URL; redirects are not followed; no proxy variable is read; certificates
are checked; answers are capped at 8 MiB. ESLint and `test/egress.test.ts`
keep every other module from dialling, a code convention, not a sandbox.

The Claude Code CLI, which the service runs for the sign-in and for
`start_session` (`src/cli.ts`, the only module that starts a process,
always with an argument list and never a shell), makes its own connections
to Anthropic's hosts, as it does on any machine; its updater, telemetry and
error reports are off (`DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`). `start_session` runs git only to make the
scratch repository; it fetches nothing.

## Logs

One JSON line per event on standard error: the event, and for a request
its method, path (ids only), status and time. Never a body, a header, a
token, the sign-in address or code, or a session's text: the logger takes
picked fields only and masks tokens and codes in every one of them
(`src/log.ts`; `test/logging.test.ts` runs every tool and checks the log
and the answers). The MCP side logs nothing per request.

## With PCP

PCP runs it as a service on one of your SSH servers, with the Docker or
Podman there, and adds it as an MCP server. The definition, in the
[pcp-gg-common](https://github.com/kaperkunde/pcp-gg-common) format
(`pcp_format` 4, since PCP sends `MCP_AUTH_TOKEN` as a header), is
[docs/pcp-service.yaml](docs/pcp-service.yaml): port 8080, the volume
`claude` at `/home/claude/.claude`, the health check at `/health`, and the
MCP server at `/mcp` with `MCP_AUTH_TOKEN` as its bearer token.

The levels to propose with it (`tool_access` on `register_server`):

```json
[
  {
    "tools": [
      "list_sessions",
      "get_session",
      "session_status",
      "ask_session",
      "list_environments",
      "login_status"
    ],
    "access": "allowed",
    "tier": "read"
  },
  {
    "tools": [
      "send_message",
      "interrupt_session",
      "answer_permission",
      "answer_question",
      "start_session",
      "archive_session",
      "unarchive_session",
      "rename_session"
    ],
    "access": "ask",
    "tier": "write"
  },
  { "tools": ["login_start"], "access": "allowed", "tier": "write" },
  { "tools": ["login_finish"], "access": "blocked", "tier": "write" }
]
```

Then the wrapper above, then the sign-in.

## Running it yourself

```sh
docker run -d --name claude-sessions -p 127.0.0.1:8080:8080 \
  -v claude-sessions-login:/home/claude/.claude -e MCP_AUTH_TOKEN \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/kaperkunde/claude-sessions-mcp@sha256:<digest>
```

Without PCP there is no secret binding: you would call `login_finish` with
the code yourself, from your own MCP client.

`GET /health` answers `{"status":"ok"}`; every other path but `/mcp`
answers 404.

## The image

Built on GitHub's own runners by `.github/workflows/image.yml` for
linux/amd64 and linux/arm64, pushed to
`ghcr.io/kaperkunde/claude-sessions-mcp` (`main`, `latest` and
`sha-<commit>` on every push to main; `<version>` on a `v*` tag), signed
with cosign keyless and with GitHub's build provenance attested beside it.
Refer to it by the digest the run prints. Check it:

```sh
cosign verify ghcr.io/kaperkunde/claude-sessions-mcp@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/kaperkunde/claude-sessions-mcp/\.github/workflows/image\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/kaperkunde/claude-sessions-mcp@sha256:<digest> --repo kaperkunde/claude-sessions-mcp
```

Node 24 on Alpine, the base pinned by digest; production dependencies from
the lock file only; the CLI's native binary from npm, checked against the
pinned integrity, with no install script run; git; no npm, npx, corepack
or yarn left in it; runs as uid 10001.

## Developing

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

The tests never reach Anthropic. They run against an in-process fake of
the sessions API and the token address (`test/fake-api.ts`), which checks
the headers, expires tokens, rotates the refresh token and revokes the
login when one is used twice; and against a fake CLI run as a real child
process (`test/fake-claude.mjs`), which prints a sign-in address, reads the
code and writes a login as the CLI does, and answers `--cloud` as the CLI
does. They cover every tool: the summaries and states, paging, the side
question in a busy session, messages (with priority) and interrupts,
permission prompts and questions, stalled sessions, archive, unarchive
and rename, environments, the 403
of a device-bound session,
renewal (before expiry, on a 401, once for calls at the same time, over
days), the sign-in, `start_session`, the HTTP side, the logs, the egress
rules and the definition against the code.

## Licence

MIT, see [LICENSE](LICENSE). The Claude Code CLI in the image is
Anthropic's, under its own terms.

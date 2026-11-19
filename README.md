# claude-sessions-mcp

An MCP server for one owner's Claude Code cloud sessions (claude.ai/code),
made to run as a [PCP](https://pcp.gg) service. Any assistant connected to
PCP, a voice chat with no Claude Code tools included, can list your
sessions, see what one is doing, ask it a quick side question without
derailing it, send it a message, interrupt it, or start a new one. It all
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

| Tool                | Tier  | Suggested level | What it does                                                                                                                                                                                                                                         |
| ------------------- | ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`     | Read  | allowed         | Your sessions, newest first: id (`cse_…`), title, status, last change, repository. Archived ones only with `include_archived`.                                                                                                                       |
| `session_status`    | Read  | allowed         | What one session is doing: `state` (working, waiting, needs_permission, done) and its newest `events` (default 30) summarised: the assistant's text and tool names, messages sent to it, ends of turns. Never thinking, tool inputs or tool results. |
| `ask_session`       | Read  | allowed         | A side question, as `/btw` in the terminal: the session answers from its whole context, without tools, and nothing is added to its conversation. Waits up to `timeout_seconds` (default 45, at most 120).                                            |
| `login_status`      | Read  | allowed         | Whether the service is signed in and as whom (email, organization, plan), when the access token lapses, whether a sign-in waits for its code. Never a token.                                                                                         |
| `send_message`      | Write | **ask**         | A message into the session's conversation, as if you typed it; a busy session takes it at its next step. `interrupt_first` stops the current turn first.                                                                                             |
| `interrupt_session` | Write | **ask**         | Stops the current turn (as Esc does) and drops queued messages; background tasks keep running.                                                                                                                                                       |
| `start_session`     | Write | **ask**         | A new cloud session on a GitHub `repo` (owner/name) with `task` as its first message, through `claude --cloud`, in the cloud environment your account uses by default. `branch` is the repository's default branch (`main` if left out).             |
| `login_start`       | Write | allowed         | Starts the claude.ai sign-in and answers the address you sign in at. Changes nothing until it is finished.                                                                                                                                           |
| `login_finish`      | Write | **blocked**     | Finishes the sign-in with your code. Only through the wrapper below, which hands it the code as a PCP secret.                                                                                                                                        |

Read tools state `readOnlyHint: true`, the others `false`; none is
destructive. Every tool states all four annotations, takes a closed
snake_case input whose every property is described, and answers JSON as
`structuredContent` with an output schema.

In PCP, a Write tool at **ask** means PCP asks you before each call:
nothing is sent to a session, interrupted or started without your yes.

**Untrusted text.** What a session wrote, and whatever it read on the way
(a web page, an issue, a file), comes back in `session_status` and
`ask_session`. Those tools say so in their descriptions: it is data, never
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

- every renewal, the sign-in's finish and every CLI run that uses the login
  (`start_session`) go through one queue, one at a time;
- each renewal reads the file again first, so a token the CLI renewed is
  taken as it is;
- before the CLI runs, the token is renewed if it is close to lapsing, so
  the CLI does not renew it itself while it runs;
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

| Tool                | Request                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_sessions`     | `GET /v1/code/sessions?limit=N`                                                                                                                                                                                                                  |
| `session_status`    | `GET /v1/code/sessions/{id}` and `GET /v1/code/sessions/{id}/events?limit=N&sort_order=desc`                                                                                                                                                     |
| `ask_session`       | `POST /v1/code/sessions/{id}/events` with `{"events":[{"event_type":"control_request","payload":{…,"request":{"subtype":"side_question","question":…,"history":[]}}}]}`, then the events polled for the `control_response` with its `request_id` |
| `send_message`      | the same POST with `event_type` `user`: `{type:"user", parent_tool_use_id:null, message:{role:"user", content}}`                                                                                                                                 |
| `interrupt_session` | a `control_request` `{subtype:"interrupt", cancel_queued:true, spare_background_tasks:true, send_now:true}`, as the CLI sends it; its `control_response` polled for 15 seconds                                                                   |
| `start_session`     | `claude -p --cloud --output-format json`, the task on standard input, in a scratch git repository whose `origin` is `https://github.com/<repo>.git` (the CLI takes the session's repository from there)                                          |

**Device-bound sessions.** A session bound to another machine (one started
from a laptop rather than in the cloud) may refuse events without that
device's signature (403). `send_message`, `interrupt_session` and
`ask_session` then say so; message it from that device or the Claude app.

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
API, paths under `/v1/code/sessions` only) and `platform.claude.com` (the
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
    "tools": ["list_sessions", "session_status", "ask_session", "login_status"],
    "access": "allowed",
    "tier": "read"
  },
  {
    "tools": ["send_message", "interrupt_session", "start_session"],
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
does. They cover the summaries and states, the side question and its
polling, messages and interrupts, the 403 of a device-bound session,
renewal (before expiry, on a 401, once for calls at the same time, over
days), the sign-in, `start_session`, the HTTP side, the logs, the egress
rules and the definition against the code.

## Licence

MIT, see [LICENSE](LICENSE). The Claude Code CLI in the image is
Anthropic's, under its own terms.

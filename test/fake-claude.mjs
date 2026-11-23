// A fake of the Claude Code CLI for the tests, run as a real child
// process: `auth login --claudeai` prints a sign-in address and reads the
// code from standard input as the CLI does. Every run is recorded in <CLAUDE_CONFIG_DIR>/fake-cli-runs.jsonl.
//
// The first argument may be --fake-mode=<mode>: no-url, slow (a sign-in that takes 1.5 s to finish).
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const mode = args[0]?.startsWith("--fake-mode=")
  ? args.shift().slice("--fake-mode=".length)
  : ""
const dir = process.env.CLAUDE_CONFIG_DIR
const STATE = "FAKESTATE0123456789"
const GOOD_CODE = `goodcode0123456789#${STATE}`

function record(entry) {
  appendFileSync(
    join(dir, "fake-cli-runs.jsonl"),
    JSON.stringify({
      args,
      pid: process.pid,
      cwd: process.cwd(),
      env: Object.keys(process.env).sort(),
      ...entry,
    }) + "\n",
  )
}

if (args[0] === "auth" && args[1] === "login") {
  record({ kind: "login" })
  if (mode === "no-url") {
    process.stderr.write("Error: something went wrong\n")
    process.exit(1)
  }
  process.stdout.write("Opening browser to sign in…\n")
  process.stdout.write(
    `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnop&code_challenge_method=S256&state=${STATE}\n`,
  )
  process.stdout.write("Paste code here if prompted > ")
  const lines = createInterface({ input: process.stdin })
  for await (const raw of lines) {
    const line = raw.trim()
    if (!line.includes("#")) {
      process.stdout.write(
        "That doesn't look like the full code. Copy all of it, including the # in the middle.\n",
      )
      continue
    }
    if (line === GOOD_CODE) {
      if (mode === "slow") await new Promise((r) => setTimeout(r, 1500))
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat01-fromloginEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
            refreshToken:
              "sk-ant-ort01-fromloginFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
            scopes: ["user:inference", "user:sessions:claude_code"],
            subscriptionType: "max",
          },
        }),
        { mode: 0o600 },
      )
      writeFileSync(
        join(dir, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            emailAddress: "owner@example.org",
            organizationUuid: "3c0f2d4e-1111-4222-8333-944455556666",
            organizationName: "Owner's Organization",
          },
        }),
      )
      process.stdout.write("Login successful.\n", () => process.exit(0))
      break
    }
    // As the real CLI may: the failure names what it was given.
    process.stdout.write(
      `Couldn't log in: Request failed with status code 400 for ${line}\n`,
      () => process.exit(1),
    )
    break
  }
  // The write's callback ends the process.
  await new Promise(() => {})
}

process.stderr.write(`fake claude: unknown arguments ${args.join(" ")}\n`)
process.exit(2)

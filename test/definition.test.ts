import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG_DIR, loadConfig } from "../src/config.ts"

/**
 * docs/pcp-service.yaml is the PCP service definition (pcp_format 4, as
 * kaperkunde/pcp-gg-common holds them), and the Dockerfile builds what it
 * runs. Both are checked here against what the code reads and serves, so
 * they do not drift apart.
 */

const ROOT = join(import.meta.dirname, "..")
const yaml = readFileSync(join(ROOT, "docs", "pcp-service.yaml"), "utf8")
const config = readFileSync(join(ROOT, "src", "config.ts"), "utf8")
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8")
const defaults = loadConfig({ MCP_AUTH: "off" })

describe("the PCP service definition", () => {
  it("names only variables the service reads", () => {
    const names = [...yaml.matchAll(/^ {2}- name: ([A-Z_]+)$/gm)].map(
      (m) => m[1],
    )
    expect(names).toContain("MCP_AUTH_TOKEN")
    for (const name of names) expect(config, name).toContain(`"${name}"`)
  })

  it("matches the default port, the MCP path and the health path", () => {
    expect(yaml).toContain(`- container: ${defaults.port}`)
    expect(yaml).toMatch(
      new RegExp(
        `registers:\\n  kind: mcp\\n  port: ${defaults.port}\\n  path: ${defaults.path}\\n`,
      ),
    )
    expect(yaml).toMatch(
      new RegExp(
        `health:\\n  kind: http\\n  port: ${defaults.port}\\n  path: /health\\n`,
      ),
    )
  })

  it("keeps the login in the volume, where the image points the CLI", () => {
    expect(yaml).toMatch(
      new RegExp(
        `volumes:\\n {2}- name: claude\\n {4}path: ${DEFAULT_CONFIG_DIR}\\n`,
      ),
    )
    expect(dockerfile).toContain(`CLAUDE_CONFIG_DIR=${DEFAULT_CONFIG_DIR}`)
  })

  it("has PCP send the MCP token the service checks", () => {
    expect(yaml).toMatch(/^pcp_format: 4$/m)
    expect(yaml).toMatch(
      /auth:\n {4}env: MCP_AUTH_TOKEN\n {4}header: Authorization\n {4}template: Bearer \{\{secret\}\}\n/,
    )
  })

  it("pins the image by digest and follows the latest tag", () => {
    expect(yaml).toMatch(
      /^image: ghcr\.io\/kaperkunde\/claude-sessions-mcp@sha256:[0-9a-f]{64}$/m,
    )
    expect(yaml).toMatch(
      /^source: ghcr\.io\/kaperkunde\/claude-sessions-mcp:latest$/m,
    )
  })
})

describe("the image", () => {
  it("pins the Claude Code CLI by version and checks each platform's package", () => {
    expect(dockerfile).toMatch(/^ARG CLAUDE_CODE_VERSION=2\.1\.327$/m)
    expect(dockerfile).toMatch(
      /^ARG CLAUDE_CODE_SHA512_X64=sha512-[A-Za-z0-9+/=]{88}$/m,
    )
    expect(dockerfile).toMatch(
      /^ARG CLAUDE_CODE_SHA512_ARM64=sha512-[A-Za-z0-9+/=]{88}$/m,
    )
    expect(dockerfile).toContain("DISABLE_AUTOUPDATER=1")
  })
})

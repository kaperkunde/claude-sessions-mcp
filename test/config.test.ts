import { describe, expect, it } from "vitest"

import { ConfigError, DEFAULT_CONFIG_DIR, loadConfig } from "../src/config.ts"

const TOKEN = "a-long-enough-token-123"

describe("the configuration", () => {
  it("has defaults for everything but the MCP token", () => {
    expect(loadConfig({ MCP_AUTH_TOKEN: TOKEN })).toEqual({
      configDir: DEFAULT_CONFIG_DIR,
      claudeBin: "claude",
      host: "0.0.0.0",
      port: 8080,
      path: "/mcp",
      authToken: TOKEN,
      allowedHosts: [],
    })
  })

  it("fails closed without a token, unless MCP_AUTH=off", () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(loadConfig({ MCP_AUTH: "off" }).authToken).toBeUndefined()
    expect(() =>
      loadConfig({ MCP_AUTH: "off", MCP_AUTH_TOKEN: TOKEN }),
    ).toThrow(/choose one/)
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short" })).toThrow(/16/)
  })

  it.each([
    ["CLAUDE_CONFIG_DIR", "relative/dir"],
    ["CLAUDE_CONFIG_DIR", "/data/../etc"],
    ["CLAUDE_BIN", "claude; rm -rf /"],
    ["MCP_PORT", "99999"],
    ["MCP_PATH", "no-slash"],
  ])("refuses %s=%j, naming the variable and not the value", (name, value) => {
    let message = ""
    try {
      loadConfig({ MCP_AUTH_TOKEN: TOKEN, [name]: value })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(name)
    expect(message).not.toContain(value)
  })

  it("reads MCP_ALLOWED_HOSTS as a list", () => {
    expect(
      loadConfig({
        MCP_AUTH_TOKEN: TOKEN,
        MCP_ALLOWED_HOSTS: " 192.0.2.10:8080, Host:* ",
      }).allowedHosts,
    ).toEqual(["192.0.2.10:8080", "host:*"])
  })
})

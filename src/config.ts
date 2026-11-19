/**
 * Everything the service reads from its environment, checked once at
 * start. A bad value stops it with a message that names the variable,
 * never its value.
 */
export type Config = {
  /**
   * The Claude Code CLI's config folder (CLAUDE_CONFIG_DIR, which the CLI
   * reads too): the login (`.credentials.json`) and the account
   * (`.claude.json`). A named volume, never shared with another container.
   */
  configDir: string
  /** The Claude Code CLI. */
  claudeBin: string
  host: string
  port: number
  path: string
  /** The bearer token every MCP request must send, when set. */
  authToken?: string
  /** Host header values accepted besides loopback. */
  allowedHosts: string[]
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

type Env = Record<string, string | undefined>

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

export const DEFAULT_CONFIG_DIR = "/home/claude/.claude"

export function loadConfig(env: Env = process.env): Config {
  const configDir = trimmed(env, "CLAUDE_CONFIG_DIR") ?? DEFAULT_CONFIG_DIR
  if (!configDir.startsWith("/") || configDir.includes("..")) {
    throw new ConfigError("CLAUDE_CONFIG_DIR is an absolute path.")
  }

  const claudeBin = trimmed(env, "CLAUDE_BIN") ?? "claude"
  if (!/^[A-Za-z0-9._/-]+$/.test(claudeBin)) {
    throw new ConfigError("CLAUDE_BIN is a program name or an absolute path.")
  }

  const port = Number(trimmed(env, "MCP_PORT") ?? "8080")
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("MCP_PORT is a port number.")
  }

  const path = trimmed(env, "MCP_PATH") ?? "/mcp"
  if (!/^\/[A-Za-z0-9._~-]+$/.test(path)) {
    throw new ConfigError("MCP_PATH is a path such as /mcp.")
  }

  const authToken = trimmed(env, "MCP_AUTH_TOKEN")
  if (authToken !== undefined && authToken.length < 16) {
    throw new ConfigError("MCP_AUTH_TOKEN is at least 16 characters.")
  }
  // Fail closed: without a token the tools answer whoever reaches the
  // port, so that takes an explicit MCP_AUTH=off.
  const auth = trimmed(env, "MCP_AUTH")
  if (auth !== undefined && auth !== "off") {
    throw new ConfigError("MCP_AUTH is off, or left unset.")
  }
  if (authToken === undefined && auth !== "off") {
    throw new ConfigError(
      "MCP_AUTH_TOKEN is not set: set it to a long random secret (PCP sends it for you), or set MCP_AUTH=off to serve the tools without one.",
    )
  }
  if (authToken !== undefined && auth === "off") {
    throw new ConfigError(
      "MCP_AUTH=off and MCP_AUTH_TOKEN are both set: choose one.",
    )
  }

  const allowedHosts = (trimmed(env, "MCP_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  return {
    configDir,
    claudeBin,
    host: trimmed(env, "MCP_HOST") ?? "0.0.0.0",
    port,
    path,
    authToken,
    allowedHosts,
  }
}

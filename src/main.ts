import { accessSync, constants, mkdirSync } from "node:fs"

import { SessionsApi } from "./api.ts"
import { Cli } from "./cli.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { Credentials } from "./credentials.ts"
import { httpsTransport } from "./egress.ts"
import { createMcpHttpServer } from "./http.ts"
import { createLogger } from "./log.ts"
import { Serial } from "./serial.ts"

/**
 * Starts the service: reads the environment, checks the CLI's config
 * folder (the login's volume) can be written, and listens. Nothing is
 * dialled at start; a missing login shows on the first call (and in
 * login_status).
 */

const logger = createLogger()

let config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error("config_invalid", { message: error.message })
    process.exit(2)
  }
  throw error
}

try {
  mkdirSync(config.configDir, { recursive: true, mode: 0o700 })
  accessSync(config.configDir, constants.W_OK)
} catch {
  logger.error("config_dir_unwritable", { dir: config.configDir })
  process.exit(2)
}

const transport = httpsTransport()
const credentials = new Credentials({
  dir: config.configDir,
  transport,
  serial: new Serial(),
  logger,
})
const api = new SessionsApi({ transport, credentials, logger })
const cli = new Cli({
  bin: config.claudeBin,
  configDir: config.configDir,
  credentials,
  logger,
})

if (!config.authToken) {
  logger.warn("mcp_auth_off", {
    message: "MCP_AUTH=off: anything that reaches the port can use the tools.",
  })
}

const server = createMcpHttpServer(
  config,
  { api, cli, credentials, logger },
  logger,
)

server.listen(config.port, config.host, () => {
  logger.info("listening", {
    host: config.host,
    port: config.port,
    path: config.path,
    signed_in: credentials.tokens() !== undefined,
  })
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

import { Agent, request as httpsRequest } from "node:https"

/**
 * The only place this service opens a connection. It dials two hosts:
 * Anthropic's API, for the Claude Code sessions API (`/v1/code/sessions…`),
 * and the claude.ai sign-in's token address, to renew the login. A host is
 * picked by name from HOSTS and is never taken from a request, a response
 * or an argument: a request names a host key and a path, and each host has
 * its own allow-list of paths. Redirects are not followed (node:https does
 * not), no proxy is consulted (the agent is this module's own), certificates
 * are checked, and an answer stops at MAX_RESPONSE_BYTES.
 *
 * The Claude Code CLI the service runs for a sign-in and to start a session
 * makes its own connections; that is the CLI's doing, not this module's
 * (README.md, "Where it connects").
 *
 * ESLint keeps node:https, node:net, node:tls and fetch out of every other
 * module, and test/egress.test.ts checks the same on the sources.
 */

export const HOSTS = {
  /** The sessions API. */
  api: "api.anthropic.com",
  /** The claude.ai sign-in's token address (refresh only). */
  auth: "platform.claude.com",
} as const

export type HostKey = keyof typeof HOSTS

/**
 * Never dialled by this service: the hosts a sign-in address from the CLI
 * may name before it is handed to the owner (cli.ts loginUrl).
 */
export const SIGN_IN_HOSTS = [
  "claude.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
] as const

export type OutgoingRequest = {
  host: HostKey
  method: "GET" | "POST"
  /** The path and query. Never a URL. */
  path: string
  headers: Record<string, string>
  body?: string
}

export type IncomingResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type Transport = (request: OutgoingRequest) => Promise<IncomingResponse>

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000

const QUERY = "(?:\\?[A-Za-z0-9\\-_.~=&]*)?"
const PATHS: Record<HostKey, RegExp> = {
  api: new RegExp(
    `^/v1/code/sessions(?:/[A-Za-z0-9_-]{1,128}(?:/events)?)?${QUERY}$`,
  ),
  auth: /^\/v1\/oauth\/token$/,
}

export class EgressError extends Error {
  override name = "EgressError"
}

/** Whether a path may be sent to that host. */
export function safePath(host: HostKey, path: string): boolean {
  const pattern = PATHS[host]
  return (
    pattern !== undefined &&
    pattern.test(path) &&
    !path.includes("//") &&
    !path.includes("..")
  )
}

/** The headers sent: a body says its length, so it goes out in one piece. */
export function wireHeaders(outgoing: OutgoingRequest): Record<string, string> {
  if (outgoing.body === undefined) return outgoing.headers
  return {
    ...outgoing.headers,
    "Content-Length": String(Buffer.byteLength(outgoing.body, "utf8")),
  }
}

/** The transport to the two hosts above. */
export function httpsTransport(): Transport {
  // Our own agent: no global agent another module could have changed, and
  // node:https never reads HTTP(S)_PROXY. Certificates are checked against
  // the system's roots, said outright.
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
    rejectUnauthorized: true,
  })

  return (outgoing) =>
    new Promise<IncomingResponse>((resolve, reject) => {
      const host = HOSTS[outgoing.host]
      if (!host || !safePath(outgoing.host, outgoing.path)) {
        reject(new EgressError("Refused a request this service does not make."))
        return
      }
      const req = httpsRequest(
        {
          host,
          servername: host,
          port: 443,
          method: outgoing.method,
          path: outgoing.path,
          headers: wireHeaders(outgoing),
          agent,
          rejectUnauthorized: true,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new EgressError("The answer was too large."))
              return
            }
            chunks.push(chunk)
          })
          res.on("end", () => {
            const headers: Record<string, string> = {}
            for (const [name, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headers[name] = value
              else if (Array.isArray(value)) headers[name] = value.join(", ")
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          })
          res.on("error", reject)
        },
      )
      req.on("timeout", () =>
        req.destroy(new EgressError(`${host} did not answer in time.`)),
      )
      req.on("error", reject)
      req.end(outgoing.body)
    })
}

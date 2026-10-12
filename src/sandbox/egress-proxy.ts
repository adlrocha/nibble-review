#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

/** By default a sandboxed Agent may reach HTTPS model APIs only. */
const DEFAULT_ALLOWED_PORTS: readonly number[] = [443]

/** Splits a CONNECT authority (`host:port`, IPv6 in brackets) into its parts. */
export function parseAuthority(authority: string | undefined): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/u.exec(authority || "")
  const host = (match?.[1] || match?.[2] || "").toLowerCase()
  const port = Number(match?.[3])
  return host && Number.isInteger(port) && port > 0 && port <= 65_535 ? { host, port } : null
}

/** True when the sandbox may open a tunnel to this authority. */
export function isAllowed(
  authority: string | undefined,
  allowHosts: ReadonlySet<string>,
  allowPorts: readonly number[] = DEFAULT_ALLOWED_PORTS
): boolean {
  const parsed = parseAuthority(authority)
  return Boolean(parsed && allowPorts.includes(parsed.port) && allowHosts.has(parsed.host))
}

/**
 * Creates an HTTPS-only forward proxy that tunnels CONNECT requests to an
 * exact host allowlist and refuses everything else, including plain HTTP.
 * Paired with a Docker `--internal` network it is the sandbox's only route out.
 */
export function createEgressProxy(options: {
  allowHosts: readonly string[]
  allowPorts?: readonly number[]
  log?: (line: string) => void
}): Server {
  const allowHosts = new Set(options.allowHosts.map(host => host.trim().toLowerCase()).filter(Boolean))
  const allowPorts = options.allowPorts || DEFAULT_ALLOWED_PORTS
  const log = options.log || (() => {})
  const server = createServer((request, response) => {
    log(`deny http ${request.method} ${request.url}`)
    response
      .writeHead(403, { "content-type": "text/plain" })
      .end("nibble-review sandbox: only HTTPS CONNECT is allowed\n")
  })
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    if (!isAllowed(request.url, allowHosts, allowPorts)) {
      log(`deny connect ${request.url}`)
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    const target = parseAuthority(request.url)
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    log(`allow connect ${request.url}`)
    const upstream = connect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(client)
      client.pipe(upstream)
    })
    const close = () => {
      upstream.destroy()
      client.destroy()
    }
    upstream.on("error", () => {
      if (client.writable) {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      }
      close()
    })
    client.on("error", close)
  })
  return server
}

function main(): void {
  const { values } = parseArgs({
    options: { allow: { type: "string" }, port: { type: "string", default: "3128" } },
    strict: true
  })
  const allowHosts = (values.allow || "").split(",").filter(Boolean)
  if (allowHosts.length === 0) {
    throw new Error("--allow host[,host...] is required")
  }
  const server = createEgressProxy({ allowHosts, log: line => process.stderr.write(`[egress] ${line}\n`) })
  server.listen(Number(values.port), "0.0.0.0", () => {
    process.stderr.write(`[egress] allowing ${allowHosts.join(", ")} on :${values.port}\n`)
  })
}

const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}

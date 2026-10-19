import assert from "node:assert/strict"
import { request } from "node:http"
import { connect, createServer as createTcpServer } from "node:net"
import test from "node:test"

import { createEgressProxy, isAllowed, parseAuthority } from "../dist/sandbox/egress-proxy.js"
import { modelApiHost } from "../dist/sandbox/model-host.js"
import { DEFAULT_REVIEW_MODEL } from "../dist/config.js"

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}

/** Sends a raw CONNECT and resolves with the proxy's status line plus any tunneled bytes. */
function connectThrough(proxyPort, authority, payload = "") {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    let data = ""
    let sent = false
    socket.on("data", chunk => {
      data += chunk
      if (!sent && data.includes("200 Connection Established") && payload) {
        sent = true
        socket.write(payload)
      }
      if (data.includes("ECHO:")) socket.end()
    })
    socket.on("end", () => resolve(data))
    socket.on("close", () => resolve(data))
    socket.on("error", reject)
  })
}

test("authority parsing accepts host:port and bracketed IPv6 only", () => {
  assert.deepEqual(parseAuthority("API.Example.com:443"), { host: "api.example.com", port: 443 })
  assert.deepEqual(parseAuthority("[::1]:443"), { host: "::1", port: 443 })
  for (const bad of [undefined, "", "example.com", "example.com:0", "example.com:99999", "a b:443", "http://x:443"]) {
    assert.equal(parseAuthority(bad), null, String(bad))
  }
})

test("allowlist requires an exact host and an allowed port", () => {
  const hosts = new Set(["opencode.ai"])
  assert.equal(isAllowed("opencode.ai:443", hosts), true)
  assert.equal(isAllowed("OPENCODE.AI:443", hosts), true)
  assert.equal(isAllowed("opencode.ai:80", hosts), false)
  assert.equal(isAllowed("evil.opencode.ai:443", hosts), false)
  assert.equal(isAllowed("opencode.ai.evil.com:443", hosts), false)
  assert.equal(isAllowed("registry.npmjs.org:443", hosts), false)
})

test("the proxy tunnels to an allowed host and refuses everything else", async t => {
  const upstream = createTcpServer()
  upstream.on("connection", socket => socket.on("data", chunk => socket.write(`ECHO:${chunk}`)))
  const upstreamPort = await listen(upstream)
  const denied = []
  const proxy = createEgressProxy({
    allowHosts: ["127.0.0.1"],
    allowPorts: [upstreamPort],
    log: line => denied.push(line)
  })
  const proxyPort = await listen(proxy)
  t.after(() => {
    proxy.close()
    upstream.close()
  })

  const allowed = await connectThrough(proxyPort, `127.0.0.1:${upstreamPort}`, "hello")
  assert.match(allowed, /200 Connection Established/u)
  assert.match(allowed, /ECHO:hello/u)

  assert.match(await connectThrough(proxyPort, "localhost:" + upstreamPort), /403 Forbidden/u)
  assert.match(await connectThrough(proxyPort, `127.0.0.1:${upstreamPort + 1}`), /403 Forbidden/u)

  const plain = await new Promise(resolve => {
    request({ host: "127.0.0.1", port: proxyPort, path: "http://example.com/", method: "GET" }, response =>
      resolve(response.statusCode)
    ).end()
  })
  assert.equal(plain, 403)
  assert.ok(denied.some(line => line.startsWith("deny connect localhost")))
})

test("model hosts come from pi's catalog and unknown models fail loudly", () => {
  assert.equal(modelApiHost(DEFAULT_REVIEW_MODEL), "opencode.ai")
  assert.equal(modelApiHost("anthropic/claude-haiku-5-5"), "api.anthropic.com")
  assert.throws(() => modelApiHost("deepseek-v4-flash"), /provider\/model/u)
  assert.throws(() => modelApiHost("nope/not-a-model"), /egress-allow/u)
})

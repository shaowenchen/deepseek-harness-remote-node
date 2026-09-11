/**
 * What the agent tells you when it cannot connect.
 *
 * This suite exists because the most useful diagnostic this process can produce
 * is the one it used to throw away. A misconfigured proxy used to be
 * indistinguishable from an absent network: every failure collapsed into
 * `disconnected; reconnecting in Nms`, which says nothing about which layer
 * refused or what to do about it.
 *
 * The second thing pinned here is a hang. A server that answers with an HTTP
 * error instead of upgrading does not produce a WebSocket `close` — it produces
 * `unexpected-response`, and a loop that only listens for `close` stops dead:
 * no reconnect, no log, no exit. Two of the tests below fail on that.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { NodeAgent } from '../src/agent.ts'

let http: Server
let port: number
const sockets: Socket[] = []

beforeEach(async () => {
  sockets.length = 0
  http = createServer()
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  port = (http.address() as { port: number }).port
})

afterEach(async () => {
  // A server that answers without upgrading leaves the socket to us; without
  // this the process would not exit.
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
})

/**
 * Start an agent whose reconnects are fast, and collect what it logs.
 *
 * The reconnect floor is deliberately tiny so a second attempt is observable
 * within the test's lifetime — proving the loop SURVIVED the failure rather
 * than merely reporting it once.
 * @param handler - what the server should do with each request.
 * @returns the collected log lines and a stop function.
 */
function runAgent(handler: (socket: Socket, status: number) => void): {
  lines: string[]
  stop: () => void
  waitFor: (needle: string, timeoutMs?: number) => Promise<string>
} {
  const lines: string[] = []
  http.on('request', (req, res) => {
    const socket = req.socket
    sockets.push(socket)
    // A bare HTTP answer with no upgrade: the shape a misconfigured proxy or a
    // missing route produces.
    const status = req.url === '/missing' ? 404 : 502
    handler(socket, status)
    res.writeHead(status).end()
  })

  const agent = new NodeAgent({
    url: `ws://127.0.0.1:${port}/missing`,
    nodeId: 'diagnostics-test',
    credential: 'test-credential',
    cwd: process.cwd(),
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    log: (message) => { lines.push(message) },
  })
  agent.start()

  return {
    lines,
    stop: () => agent.stop(),
    waitFor: async (needle: string, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = lines.find((line) => line.includes(needle))
        if (found) return found
        await new Promise((resolve) => { setTimeout(resolve, 10) })
      }
      assert.fail(`timed out waiting for a log line containing ${JSON.stringify(needle)}.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`)
    },
  }
}

describe('connection diagnostics: a failure says what went wrong', () => {
  it('names the HTTP status and where to look, instead of only "disconnected"', async () => {
    const agent = runAgent((_socket, status) => void status)
    try {
      const line = await agent.waitFor('HTTP 404')
      // The status alone is not actionable, so the message must also say which
      // layer it implicates — a path the host never registered.
      assert.match(line, /no node channel is registered at this path/)
    } finally {
      agent.stop()
    }
  })

  it('logs the attempt before it is made, so a silent hang is visible', async () => {
    const agent = runAgent((_socket, status) => void status)
    try {
      await agent.waitFor('connecting to ws://127.0.0.1')
    } finally {
      agent.stop()
    }
  })

  it('keeps reconnecting after a failure that never became a WebSocket close', async () => {
    const agent = runAgent((_socket, status) => void status)
    try {
      // Two attempts is the assertion that matters. A response arriving without
      // an upgrade produces `unexpected-response`, and a loop that ignores it
      // (or that drains the response without tearing the socket down) makes
      // exactly one attempt and then stops forever.
      await agent.waitFor('reconnecting')
      const attempts = () => agent.lines.filter((l) => l.includes('connecting to')).length
      const deadline = Date.now() + 5000
      while (attempts() < 2 && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      assert.ok(
        attempts() >= 2,
        `expected a second attempt after the failure.\nGot:\n${agent.lines.map((l) => `  ${l}`).join('\n')}`,
      )
    } finally {
      agent.stop()
    }
  })

  it('reports a refused connection as such, not as a generic drop', async () => {
    const lines: string[] = []
    // Port 1 is reserved and nothing listens there, so this is the one failure
    // that is reliable without a server.
    const agent = new NodeAgent({
      url: 'ws://127.0.0.1:1/node/v1',
      nodeId: 'diagnostics-test',
      credential: 'test-credential',
      cwd: process.cwd(),
      reconnectMinMs: 100_000,
      reconnectMaxMs: 100_000,
      log: (message) => { lines.push(message) },
    })
    agent.start()
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !lines.some((l) => l.includes('refused'))) {
        await new Promise((resolve) => { setTimeout(resolve, 10) })
      }
      assert.ok(
        lines.some((l) => l.includes('connection refused')),
        `expected the refusal to be named.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`,
      )
    } finally {
      agent.stop()
    }
  })
})

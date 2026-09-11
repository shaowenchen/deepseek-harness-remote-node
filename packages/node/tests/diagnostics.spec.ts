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
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('the working directory is created where the work happens', () => {
  it('creates the configured cwd on startup, including missing parents', async () => {
    // A missing working directory is not a degraded mode: the first command
    // fails with ENOENT, and Node reports that as `spawn <program> ENOENT` —
    // naming the EXECUTABLE, not the directory. Telling an operator to mkdir it
    // by hand is a step that silently costs a whole session when missed, so the
    // agent does it. This asserts the effect, not the log line.
    const base = await mkdtemp(join(tmpdir(), 'dsh-cwd-'))
    const target = join(base, 'deep', 'nested')
    const lines: string[] = []
    const agent = new NodeAgent({
      url: 'ws://127.0.0.1:1/node/v1', // unreachable: creation must not wait on it
      credential: 'x',
      cwd: target,
      reconnectMinMs: 100_000,
      log: (m) => { lines.push(m) },
    })
    agent.start()
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try {
          await stat(target)
          break
        } catch {
          await new Promise((r) => { setTimeout(r, 25) })
        }
      }
      const info = await stat(target)
      assert.ok(info.isDirectory(), 'the configured cwd must exist as a directory')
      assert.ok(
        lines.some((l) => l.includes('created working directory')),
        `expected the creation to be reported.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`,
      )
    } finally {
      agent.stop()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('leaves an existing directory alone', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-cwd-'))
    const marker = join(base, 'keep-me.txt')
    await writeFile(marker, 'mine\n')
    const lines: string[] = []
    const agent = new NodeAgent({
      url: 'ws://127.0.0.1:1/node/v1',
      credential: 'x',
      cwd: base,
      reconnectMinMs: 100_000,
      log: (m) => { lines.push(m) },
    })
    agent.start()
    try {
      await new Promise((r) => { setTimeout(r, 300) })
      assert.equal(await readFile(marker, 'utf8'), 'mine\n', 'contents must be untouched')
      assert.ok(
        !lines.some((l) => l.includes('created working directory')),
        'an existing directory must not be reported as created',
      )
    } finally {
      agent.stop()
      await rm(base, { recursive: true, force: true })
    }
  })
})

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

  it('keeps the event loop alive between attempts, so a reconnect actually happens', async () => {
    // The failure this pins is silent: the reconnect timer was `unref()`d, and
    // between attempts the socket that was holding the event loop open is gone
    // — so Node found an empty loop and exited mid-reconnect. The log said
    // "reconnecting in Nms" and then the process was simply not there any more,
    // which reads as a crash with no error rather than as an unref.
    //
    // A real child process is the only way to observe this: in-process, the
    // test runner's own handles keep the loop alive and the unref is invisible.
    // The TS entry point, not the built `lib/agent-cli.js`: CI runs the tests
    // BEFORE `npm run build`, so `lib/` does not exist yet and spawning into it
    // failed with MODULE_NOT_FOUND — a green test locally and a red one in CI.
    // Node executes the `.ts` source directly, so this has no such ordering
    // dependency and no build step to remember.
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'src', 'agent-cli.ts'),
        '--url', 'ws://127.0.0.1:1/node/v1', '--credential', 'x',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output: string[] = []
    child.stdout.on('data', (b: Buffer) => output.push(b.toString()))
    child.stderr.on('data', (b: Buffer) => output.push(b.toString()))

    let exited: number | null | undefined
    child.on('exit', (code) => { exited = code })

    try {
      // Long enough to cover several reconnect windows (the floor is ~250ms).
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && exited === undefined) {
        await new Promise((resolve) => { setTimeout(resolve, 50) })
      }
      assert.equal(
        exited,
        undefined,
        `the agent exited on its own instead of continuing to reconnect (code ${exited}).\nGot:\n${output.join('')}`,
      )
      const attempts = output.join('').match(/connecting to/g)?.length ?? 0
      assert.ok(attempts >= 2, `expected repeated attempts, saw ${attempts}.\nGot:\n${output.join('')}`)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('the exit status says whether restarting could help', () => {
  /**
   * Run one CLI process against a server that refuses every registration, and
   * report how it ended.
   * @param code - the refusal code the server answers with.
   * @returns the exit code and everything the process printed.
   */
  async function runCliUntilExit(code: 'auth' | 'protocol'): Promise<{ code: number | null; output: string }> {
    const { WebSocketServer } = await import('ws')
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => { server.once('listening', () => resolve()) })
    const address = server.address() as { port: number }
    server.on('connection', (socket: import('ws').WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'refused', code, message: `test refusal: ${code}` }))
        socket.close(1008, code)
      })
    })

    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'src', 'agent-cli.ts'),
        '--url', `ws://127.0.0.1:${address.port}/node/v1`, '--credential', 'x',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output: string[] = []
    child.stdout.on('data', (b: Buffer) => output.push(b.toString()))
    child.stderr.on('data', (b: Buffer) => output.push(b.toString()))

    const code2 = await new Promise<number | null>((resolve) => {
      child.on('exit', (status) => resolve(status))
      setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 8000).unref?.()
    })
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    return { code: code2, output: output.join('') }
  }

  it('exits 1 on a refusal retrying cannot fix, so on-failure restarts do not loop', async () => {
    // The status is the whole contract with a service manager: `on-failure`
    // restarts a crash and correctly does not restart this. Before, the refusal
    // path drained the event loop and Node exited 0 — so a supervisor set to
    // `on-failure` would sit on a dead node, and the one set to `always` would
    // hammer the host forever.
    const { code, output } = await runCliUntilExit('auth')
    assert.equal(code, 1, `a terminal refusal must exit 1.\nGot:\n${output}`)
    // The reason must survive to stderr. This is why the CLI awaits the agent's
    // lifetime instead of calling `process.exit`: the status has to be returned,
    // not thrown, or the diagnostic races the exit that kills it.
    assert.ok(
      output.includes('refused [auth]'),
      `expected the refusal reason on stderr.\nGot:\n${output}`,
    )
  })

  it('exits 1 on a protocol mismatch too, and does not retry either', async () => {
    const { code, output } = await runCliUntilExit('protocol')
    assert.equal(code, 1, `a protocol refusal must exit 1.\nGot:\n${output}`)
    assert.equal(
      output.match(/connecting to/g)?.length ?? 0,
      1,
      `a protocol refusal must not be retried.\nGot:\n${output}`,
    )
  })
})

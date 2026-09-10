/**
 * The safety property this whole design rests on: a node that goes away is a
 * FAILED execution world, never a silent fallback to the host machine.
 *
 * If a drop were ever allowed to degrade into "use the local filesystem", an
 * agent would start editing the harness host's files while the user believes it
 * is working on the remote machine. That is the most dangerous failure this
 * feature can have, so it gets its own suite rather than a case in a larger one.
 *
 * These run over a real HTTP server, a real upgrade, and real sockets, because
 * the property is about what crosses the wire when a connection dies.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import { NodeAgent } from '../src/agent.ts'
import { encodeControl } from '../src/protocol.ts'
import { NodeError, NodeRegistry } from '../src/index.ts'

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

/** A stand-in for the webserver service the registry injects. */
function fakeWebServer(): { service: unknown; upgrades: Map<string, UpgradeHandler> } {
  const upgrades = new Map<string, UpgradeHandler>()
  return {
    upgrades,
    service: {
      registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
        upgrades.set(route.path, route.handler)
        return () => { upgrades.delete(route.path) }
      },
    },
  }
}

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let http: Server
let port: number
let upgrades: Map<string, UpgradeHandler>
/** A throwaway directory standing in for the remote machine's workspace. */
let world: string
/** Every upgraded socket, so teardown can force them shut. */
const sockets: Socket[] = []

/** Register a fake webserver, then the registry, on a fresh context. */
async function mount(cwd = '/srv/workspace'): Promise<void> {
  const fake = fakeWebServer()
  upgrades = fake.upgrades
  ctx = new Context()
  // A Cordis service must be *provided* to exist; assigning the property is
  // refused by design.
  ctx.provide('webServer', fake.service as never)
  fiber = await ctx.plugin(NodeRegistry, { cwd })
}

beforeEach(async () => {
  sockets.length = 0
  world = await mkdtemp(join(tmpdir(), 'dsh-node-world-'))
  await writeFile(join(world, 'data.txt'), 'remote file\n')
  await mkdir(join(world, 'sub'))
  http = createServer()
  // The registry's own WebSocketServer performs the upgrade, so hand it the
  // RAW socket. Upgrading here first would leave it a WebSocket, not a socket.
  http.on('upgrade', (req, socket, head) => {
    sockets.push(socket)
    const handler = upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (!handler) { socket.destroy(); return }
    handler(req, socket, head)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  port = (http.address() as { port: number }).port
})

afterEach(async () => {
  await fiber?.dispose()
  // Upgraded sockets leave the HTTP server's tracking, so destroy them
  // explicitly; otherwise close() waits forever on connections that never end.
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
  await rm(world, { recursive: true, force: true })
})

/** Poll until a condition holds, or fail the test. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Connect and register an agent-shaped client, returning the answer frame. */
async function registerNode(nodeId = 'build-01', protocolVersion = 1) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node/v1`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const answer = new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'ready' || frame.type === 'refused') resolve(frame)
    })
  })
  ws.send(encodeControl({
    type: 'hello',
    protocolVersion,
    nodeId,
    credential: 'test-credential',
    agentVersion: '0.1.0-test',
    platform: 'linux',
    arch: 'x64',
    capabilities: [],
  }))
  return { ws, frame: await answer }
}

describe('fail-closed: an absent node is never the host', () => {
  it('refuses to open a stream when no node has registered', async () => {
    await mount()
    assert.equal(ctx.nodeRegistry.current, undefined)

    assert.throws(
      () => ctx.nodeRegistry.open('fs.readText', { path: '/etc/hostname' }),
      (error: unknown) => {
        assert.ok(error instanceof NodeError, 'must be a NodeError')
        assert.equal(error.code, 'disconnected')
        return true
      },
      'opening against no node must refuse, never fall back to the host',
    )
  })

  it('refuses a unary invoke when no node has registered', async () => {
    await mount()
    await assert.rejects(
      () => ctx.nodeRegistry.invoke('fs.stat', { path: '/tmp' }),
      (error: unknown) => {
        assert.ok(error instanceof NodeError)
        assert.equal(error.code, 'disconnected')
        return true
      },
    )
  })

  it('tells the caller the world ended when the node drops mid-stream', async () => {
    await mount()
    const { ws, frame } = await registerNode()
    assert.equal(frame.type, 'ready')
    assert.ok(ctx.nodeRegistry.current, 'node must be registered')

    // Open a stream the agent will never answer, then kill the socket. The
    // caller must learn the truth rather than hang forever.
    const stream = ctx.nodeRegistry.open('fs.streamText', { path: '/big' })
    const settled = stream.result.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    ws.terminate()

    const outcome = await settled
    assert.ok(outcome instanceof NodeError, 'stream must reject, not resolve')
    assert.equal(outcome.code, 'disconnected')
    assert.equal(ctx.nodeRegistry.current, undefined, 'registry must forget the node')
  })

  it('emits node/disconnected once for a registered node that drops', async () => {
    await mount()
    const seen: number[] = []
    ctx.on('node/disconnected', (generation: number) => { seen.push(generation) })

    const { ws, frame } = await registerNode()
    const generation = frame.generation as number
    ws.terminate()

    await waitFor(() => seen.length > 0, 'the disconnect event')
    assert.deepEqual(seen, [generation])
  })

  it('does not emit node/disconnected for a socket that never registered', async () => {
    await mount()
    const seen: number[] = []
    ctx.on('node/disconnected', () => { seen.push(1) })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/node/v1`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.terminate()

    await new Promise((resolve) => { setTimeout(resolve, 100) })
    assert.deepEqual(seen, [], 'an unregistered socket is not a lost execution world')
  })
})

describe('single-slot registration', () => {
  it('refuses a second node while one is registered', async () => {
    await mount()
    const first = await registerNode('build-01')
    assert.equal(first.frame.type, 'ready')

    const second = await registerNode('build-02')
    assert.equal(second.frame.type, 'refused')
    assert.equal(second.frame.code, 'busy')
    assert.equal(ctx.nodeRegistry.current?.nodeId, 'build-01', 'the first node keeps the slot')
  })

  it('refuses a protocol version this host does not speak', async () => {
    await mount()
    const { frame } = await registerNode('future', 999)
    assert.equal(frame.type, 'refused')
    assert.equal(frame.code, 'protocol')
  })

  it('accepts a fresh node after the previous one drops', async () => {
    await mount()
    const first = await registerNode('build-01')
    first.ws.terminate()
    await waitFor(() => ctx.nodeRegistry.current === undefined, 'the slot to free')

    const second = await registerNode('build-02')
    assert.equal(second.frame.type, 'ready', 'the slot must free on disconnect')
    assert.ok(
      (second.frame.generation as number) > (first.frame.generation as number),
      'a reconnection is a new generation',
    )
    assert.equal(ctx.nodeRegistry.current?.nodeId, 'build-02')
  })
})

describe('agent integration', () => {
  it('registers the real agent against the real registry', async () => {
    await mount(world)
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-01',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      assert.equal(ctx.nodeRegistry.current?.nodeId, 'agent-01')
      // The registry reports the cwd the HOST configured, not one the agent
      // claims: the host owns which directory is the execution world.
      assert.equal(ctx.nodeRegistry.current?.cwd, world)
      // The agent advertises exactly what it implements — never more, or the
      // host would promise the model work the node cannot do.
      assert.ok(ctx.nodeRegistry.current?.capabilities.includes('fs.list'))
      assert.ok(!ctx.nodeRegistry.current?.capabilities.includes('proc.spawn'))
    } finally {
      agent.stop()
    }
  })

  it('answers an unimplemented operation with a typed refusal, not a hang', async () => {
    await mount()
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-02',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      await assert.rejects(
        () => ctx.nodeRegistry.invoke('proc.spawn', { argv: ['echo', 'hi'] }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          // Process operations are not implemented yet; the honest answer is
          // `unsupported`, and it must arrive rather than hang.
          assert.equal(error.code, 'unsupported')
          return true
        },
      )
    } finally {
      agent.stop()
    }
  })

  it('round-trips real filesystem work to the node', async () => {
    await mount()
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-03',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      const node = ctx.nodeRegistry

      // Write, then read back: the content must be what the NODE stored.
      await node.invoke('fs.writeText', { path: join(world, 'sub/out.txt'), content: 'hello from the host' })
      const read = await node.invoke<string>('fs.readText', { path: join(world, 'sub/out.txt') })
      assert.equal(read, 'hello from the host')

      // Listing is content-free and stably ordered.
      const entries = await node.invoke<Array<{ name: string; kind: string }>>('fs.list', { path: world })
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ['data.txt', 'sub'],
        'entries must be sorted by name',
      )
      assert.equal(entries.find((entry) => entry.name === 'sub')?.kind, 'directory')

      // A stat reports the facts the local backend would report.
      const info = await node.invoke<{ kind: string; text: boolean; size: number }>(
        'fs.stat', { path: join(world, 'data.txt') },
      )
      assert.equal(info.kind, 'file')
      assert.equal(info.text, true)
      assert.equal(info.size, 12)

      // A missing target is `not-found`, not an internal error.
      await assert.rejects(
        () => node.invoke('fs.readText', { path: join(world, 'nope.txt') }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'not-found')
          return true
        },
      )
    } finally {
      agent.stop()
    }
  })

  it('fails an in-flight operation when the node drops, rather than hanging', async () => {
    await mount()
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-04',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      const stream = ctx.nodeRegistry.open('fs.streamText', { path: join(world, 'big') })
      const settled = stream.result.catch((error: unknown) => error)
      agent.stop()
      const outcome = await settled
      assert.ok(outcome instanceof NodeError, 'the caller must be told, not left waiting')
      assert.equal(outcome.code, 'disconnected')
    } finally {
      agent.stop()
    }
  })
})

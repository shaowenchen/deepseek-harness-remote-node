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
import { ptyAvailable } from '../src/tty-ops.ts'
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
async function mount(cwd = '/srv/workspace', config: Record<string, unknown> = {}): Promise<void> {
  const fake = fakeWebServer()
  upgrades = fake.upgrades
  ctx = new Context()
  // A Cordis service must be *provided* to exist; assigning the property is
  // refused by design.
  ctx.provide('webServer', fake.service as never)
  fiber = await ctx.plugin(NodeRegistry, { cwd, ...config })
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

/** Resolve a path through the node, returning its stable target key. */
async function keyOf(
  node: { invoke: <T>(op: never, args: unknown) => Promise<T> },
  path: string,
): Promise<string> {
  const resolved = await node.invoke<{ targetKey: string }>('fs.resolve' as never, { path })
  return resolved.targetKey
}

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
      assert.ok(ctx.nodeRegistry.current?.capabilities.includes('proc.spawn'))
      // Terminals are conditional on a usable PTY substrate, so the advertised
      // list must track what THIS machine can actually do rather than a
      // build-time constant.
      assert.equal(
        ctx.nodeRegistry.current?.capabilities.includes('tty.open'),
        ptyAvailable(),
      )
    } finally {
      agent.stop()
    }
  })

  it('answers an operation it cannot perform with a typed refusal, not a hang', async () => {
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
      // A terminal on a machine with no PTY substrate is the unimplemented
      // case, and it must arrive as a typed `unsupported` rather than hanging.
      // Where the substrate IS present, the equivalent honest answer comes from
      // a request the node refuses on policy — either way the property under
      // test is the same: a failure crosses the wire instead of stalling.
      const rejectsTyped = (expected: string) => (error: unknown) => {
        assert.ok(error instanceof NodeError)
        assert.equal(error.code, expected)
        return true
      }
      if (ptyAvailable()) {
        await assert.rejects(
          () => ctx.nodeRegistry.invoke('tty.open', { argv: [], cwd: world, rows: 24, cols: 80, graceMs: 1000 }),
          rejectsTyped('policy'),
        )
      } else {
        await assert.rejects(
          () => ctx.nodeRegistry.invoke('tty.open', { argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 1000 }),
          rejectsTyped('unsupported'),
        )
      }
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

      // Resolve, then address the target by key: resolution is its own step so
      // identity is established once and reused, not re-derived per operation.
      const resolved = await node.invoke<{ targetKey: string; displayPath: string }>(
        'fs.resolve', { path: join(world, 'sub/out.txt') },
      )
      assert.equal(resolved.displayPath, join(world, 'sub/out.txt'))

      // Write, then read back: the content must be what the NODE stored.
      const written = await node.invoke<{ operation: string; after: string }>('fs.writeText', {
        targetKey: resolved.targetKey, displayPath: resolved.displayPath, content: 'hello from the host',
      })
      assert.equal(written.operation, 'create', 'a new file is a create')
      assert.equal(written.after, 'hello from the host')

      const read = await node.invoke<string>(
        'fs.readText', { targetKey: resolved.targetKey, displayPath: resolved.displayPath },
      )
      assert.equal(read, 'hello from the host')

      // A second write reports an update and carries the previous content as
      // the contextual-diff basis.
      const rewritten = await node.invoke<{ operation: string; before: string | null }>('fs.writeText', {
        targetKey: resolved.targetKey, displayPath: resolved.displayPath, content: 'second write',
      })
      assert.equal(rewritten.operation, 'update')
      assert.equal(rewritten.before, 'hello from the host', 'the diff basis is the previous content')

      // Listing is content-free, stably ordered, and returns resolved children.
      const entries = await node.invoke<Array<{ name: string; type: string }>>(
        'fs.list', { targetKey: await keyOf(node, world), displayPath: world },
      )
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ['data.txt', 'sub'],
        'entries must be sorted by name',
      )
      assert.equal(entries.find((entry) => entry.name === 'sub')?.type, 'directory')

      // A stat reports the facts the local backend would report, plus the
      // version a guarded write compares against.
      const info = await node.invoke<{ type: string; size: number; version: string }>(
        'fs.stat', { targetKey: await keyOf(node, join(world, 'data.txt')) },
      )
      assert.equal(info.type, 'file')
      assert.equal(info.size, 12)
      assert.ok(info.version.length > 0, 'a stat must carry a freshness token')

      // Absence from `stat` is `undefined` — a caller legitimately probes for a
      // target that does not exist yet…
      assert.equal(await node.invoke('fs.stat', { targetKey: join(world, 'nope.txt') }), undefined)

      // …but a read of a missing file is `FS_NOT_FOUND`, since the file is
      // required for the operation to mean anything.
      await assert.rejects(
        () => node.invoke('fs.readText', { targetKey: join(world, 'nope.txt'), displayPath: join(world, 'nope.txt') }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_NOT_FOUND')
          return true
        },
      )
    } finally {
      agent.stop()
    }
  })

  it('enforces write guards on the node, where the file actually is', async () => {
    await mount()
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-05',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      const node = ctx.nodeRegistry
      const path = join(world, 'guarded.txt')
      const key = await keyOf(node, path)

      // createIfAbsent succeeds once, then refuses. The guard is checked ON the
      // node immediately before publication, so no window exists between the
      // check and the write for another writer to slip through.
      await node.invoke('fs.writeText', {
        targetKey: key, displayPath: path, content: 'first', expected: { kind: 'createIfAbsent' },
      })
      await assert.rejects(
        () => node.invoke('fs.writeText', {
          targetKey: key, displayPath: path, content: 'second', expected: { kind: 'createIfAbsent' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_NOT_OBSERVED', 'creating over an existing file must refuse')
          return true
        },
      )

      // replaceIfVersion passes against the current version and refuses a stale
      // one — the mechanism that prevents a lost update.
      const info = await node.invoke<{ version: string }>('fs.stat', { targetKey: key })
      await node.invoke('fs.writeText', {
        targetKey: key, displayPath: path, content: 'third',
        expected: { kind: 'replaceIfVersion', version: info.version },
      })
      await assert.rejects(
        () => node.invoke('fs.writeText', {
          targetKey: key, displayPath: path, content: 'fourth',
          expected: { kind: 'replaceIfVersion', version: info.version },
        }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_STALE_VERSION', 'a stale version must refuse the write')
          return true
        },
      )
      // The refusal left the guarded write's content intact, not clobbered.
      assert.equal(await node.invoke<string>('fs.readText', { targetKey: key, displayPath: path }), 'third')
    } finally {
      agent.stop()
    }
  })

  it('edits literal text on the node and refuses an ambiguous match', async () => {
    await mount()
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'agent-06',
      credential: 'test-credential',
      cwd: world,
    })
    agent.start()
    try {
      await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
      const node = ctx.nodeRegistry
      const path = join(world, 'edit.txt')
      const key = await keyOf(node, path)
      await node.invoke('fs.writeText', {
        targetKey: key, displayPath: path, content: 'alpha\nbeta\nalpha\n',
      })

      // Two matches without replaceAll is refused rather than guessed at:
      // silently editing the first is how a model corrupts a file it misread.
      await assert.rejects(
        () => node.invoke('fs.editText', {
          targetKey: key, displayPath: path,
          edit: { oldString: 'alpha', newString: 'gamma', replaceAll: false },
        }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_AMBIGUOUS_EDIT')
          return true
        },
      )

      // A search string that is not there is a different, also-typed failure.
      await assert.rejects(
        () => node.invoke('fs.editText', {
          targetKey: key, displayPath: path,
          edit: { oldString: 'not-present', newString: 'x', replaceAll: false },
        }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_EDIT_NOT_FOUND')
          return true
        },
      )

      // replaceAll applies every match and reports both sides of the change.
      const applied = await node.invoke<{ before: string; after: string }>('fs.editText', {
        targetKey: key, displayPath: path,
        edit: { oldString: 'alpha', newString: 'gamma', replaceAll: true },
      })
      assert.equal(applied.before, 'alpha\nbeta\nalpha\n')
      assert.equal(applied.after, 'gamma\nbeta\ngamma\n')

      // A stale version refuses BEFORE matching, so the caller learns the file
      // moved rather than that their search text is now wrong.
      await assert.rejects(
        () => node.invoke('fs.editText', {
          targetKey: key, displayPath: path,
          edit: { oldString: 'gamma', newString: 'delta', replaceAll: false },
          expected: { version: 'stale-version' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof NodeError)
          assert.equal(error.code, 'FS_STALE_VERSION')
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

/**
 * A refusal is not one thing. `busy` describes a slot that is still held and
 * will free itself; `protocol` and `auth` describe this process as configured
 * and never will. Treating them alike is what turned a momentary race into a
 * node that stayed down until a human noticed — and if a supervisor was
 * restarting it, into one that never came back at all.
 *
 * These drive a real agent against a server that refuses on purpose, because
 * the property is what the process DOES after the refusal: wait and dial again,
 * or stop and say why.
 */
describe('a refusal is answered according to whether retrying can help', () => {
  it('retries a busy refusal rather than exiting, and registers when the slot frees', async () => {
    await mount(world, { credential: 'test-credential' })
    const lines: string[] = []
    // The registry holds the slot with a real incumbent, so every connection
    // this agent makes is refused `busy` — exactly a duplicate's view of the
    // world. What must NOT happen is the agent giving up.
    const incumbent = await registerNode('contended')
    assert.equal(incumbent.frame.type, 'ready')
    const heldGeneration = incumbent.frame.generation as number

    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'contended',
      credential: 'test-credential',
      cwd: world,
      reconnectMinMs: 100_000,
      reconnectMaxMs: 100_000,
      busyRetryMs: 50,
      log: (message) => { lines.push(message) },
    })
    agent.start()
    try {
      // The refusal must be SURVIVED, not merely reported. Under the old
      // behaviour the agent called `stop()` here and was gone.
      await waitFor(
        () => lines.some((l) => l.includes('refused [busy]')),
        'the busy refusal to be logged',
      )
      const attempts = () => lines.filter((l) => l.includes('connecting to')).length
      await waitFor(() => attempts() >= 2, 'a second attempt after the busy refusal')

      // Now free the slot and let the retry succeed. This is the whole point:
      // the node comes back on its own, with no restart. The generation is what
      // proves the takeover — the nodeId alone is 'contended' throughout, since
      // the incumbent registered under it too.
      incumbent.ws.terminate()
      await waitFor(
        () => (ctx.nodeRegistry.current?.generation ?? 0) > heldGeneration,
        'the retrying agent to take the freed slot',
        10_000,
      )
      assert.equal(ctx.nodeRegistry.current?.nodeId, 'contended')
      assert.ok(
        !lines.some((l) => l.includes('shutting down')),
        `the agent must not have stopped.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`,
      )
    } finally {
      agent.stop()
      incumbent.ws.terminate()
    }
  })

  it('stops on an auth refusal, which retrying cannot fix, and says why', async () => {
    await mount(world, { credential: 'the-real-credential' })
    const lines: string[] = []
    const terminal: string[] = []
    const agent = new NodeAgent({
      url: `ws://127.0.0.1:${port}/node/v1`,
      nodeId: 'wrong-credential',
      credential: 'not-the-real-credential',
      cwd: world,
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
      busyRetryMs: 50,
      log: (message) => { lines.push(message) },
      onTerminalRefusal: (code) => { terminal.push(code) },
    })
    agent.start()
    try {
      await waitFor(() => terminal.length > 0, 'the refusal to be reported as terminal')
      assert.deepEqual(terminal, ['auth'])
      // A bad credential does not become good by retrying, so the agent must
      // NOT keep dialling — otherwise it hammers the host forever.
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      const attempts = lines.filter((l) => l.includes('connecting to')).length
      assert.equal(
        attempts,
        1,
        `a terminal refusal must not be retried.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`,
      )
      // And the reason must be on the record, since the host's side of it is on
      // a machine the operator may not be looking at.
      assert.ok(
        lines.some((l) => l.includes('refused [auth]') && l.includes('invalid credential')),
        `expected the refusal reason to be logged.\nGot:\n${lines.map((l) => `  ${l}`).join('\n')}`,
      )
    } finally {
      agent.stop()
    }
  })
})

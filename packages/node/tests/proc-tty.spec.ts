/**
 * The process and terminal families, end to end: a real agent on a real socket
 * running real processes on the node's own machine.
 *
 * These exist because the interesting failures in this layer are all about
 * process TREES and about bytes that arrive after the call that started them.
 * A test that mocked `child_process` would pass while a helper process survived
 * a terminate, or while a terminal's first prompt was dropped — so nothing here
 * is mocked except the transport between the two halves, which is a real HTTP
 * server and a real upgrade.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { NodeAgent } from '../src/agent.ts'
import { ptyAvailable } from '../src/tty-ops.ts'
import { NodeRegistry } from '../src/index.ts'
import type { NodeStream } from '../src/index.ts'

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

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
let agent: NodeAgent
let http: Server
let port: number
let upgrades: Map<string, UpgradeHandler>
let world: string
const sockets: Socket[] = []

/** Register a fake webserver, then the registry, on a fresh context. */
async function mount(): Promise<void> {
  const fake = fakeWebServer()
  upgrades = fake.upgrades
  ctx = new Context()
  ctx.provide('webServer', fake.service as never)
  fiber = await ctx.plugin(NodeRegistry, { cwd: '/' })
}

/** Start an agent against the mounted registry and wait for registration. */
async function connect(nodeId = 'proc-node'): Promise<void> {
  agent = new NodeAgent({
    url: `ws://127.0.0.1:${port}/node/v1`,
    nodeId,
    credential: 'test-credential',
    cwd: world,
    // The default heartbeat cadence is fine for these tests; the reconnect
    // floor is raised so a deliberately dropped node does not come straight
    // back and confuse a teardown assertion.
    reconnectMinMs: 60_000,
  })
  agent.start()
  await waitFor(() => ctx.nodeRegistry.current !== undefined, 'the agent to register')
}

/** Poll until a condition holds, or fail the test. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Wait for a process to reach a settled outcome through `proc.wait`. */
async function waitPid(pid: number): Promise<{ exitCode: number | null; signal: string | null }> {
  return await ctx.nodeRegistry.invoke('proc.wait', { pid })
}

beforeEach(async () => {
  sockets.length = 0
  world = await mkdtemp(join(tmpdir(), 'dsh-proc-world-'))
  await writeFile(join(world, 'marker.txt'), 'hello\n')
  http = createServer()
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
  agent?.stop()
  await fiber?.dispose()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
  await rm(world, { recursive: true, force: true })
})

describe('proc.*: real processes on the node', () => {
  it('resolves an executable in the node\'s own namespace', async () => {
    await mount()
    await connect()
    const resolved = await ctx.nodeRegistry.invoke<string>('proc.resolve', { command: 'sh' })
    assert.ok(resolved.endsWith('/sh'), `expected an absolute sh path, got ${resolved}`)
  })

  it('refuses a relative executable path rather than guessing a base', async () => {
    await mount()
    await connect()
    await assert.rejects(
      () => ctx.nodeRegistry.invoke('proc.resolve', { command: './local-tool' }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'policy')
        return true
      },
    )
  })

  it('spawns into a usable directory when the host sends a path that does not exist here', async () => {
    // The failure this pins is actively misleading, which is why it gets its
    // own case. A `cwd` that does not exist produces `spawn <program> ENOENT`
    // from Node — naming the EXECUTABLE, not the directory. In the field that
    // read as "bash is not installed on the node" on a machine where bash was
    // sitting at /usr/bin/bash, and the actual cause (the harness host had sent
    // its own macOS `/Users/...` workspace to a Linux node) stayed invisible.
    //
    // The host always sends its own notion of the workspace, so this is not an
    // edge case — it is the ordinary path for any session started on the host.
    await mount()
    await connect()
    const started = await ctx.nodeRegistry.invoke<{ pid: number }>('proc.spawn', {
      argv: ['/bin/sh', '-c', 'pwd'],
      // A path that cannot exist on this machine, in the shape the host sends.
      cwd: '/nonexistent-host-workspace/deepseek-harness-remote-node',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 2000,
    })
    const outcome = await waitPid(started.pid)
    assert.equal(outcome.exitCode, 0, 'the spawn must succeed rather than fail as a missing executable')
    const stdout = await ctx.nodeRegistry.invoke<{ text: string }>('proc.read', { pid: started.pid, stream: 'stdout' })
    // It ran in the agent's own directory — the world the node's operator set
    // up. `realpath` on both sides because macOS resolves the tmpdir through
    // the `/private` symlink and `pwd` reports the resolved form.
    assert.equal(
      await realpath(stdout.text.trim()),
      await realpath(world),
      'the fallback is the registered working directory',
    )
  })

  it('honours a working directory that really does exist on the node', async () => {
    // The other half of the rule: the fallback must not become a silent
    // override. A caller naming a directory that exists here meant it.
    await mount()
    await connect()
    const sub = join(world, 'sub')
    await mkdir(sub, { recursive: true })
    const started = await ctx.nodeRegistry.invoke<{ pid: number }>('proc.spawn', {
      argv: ['/bin/sh', '-c', 'pwd'],
      cwd: sub,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 2000,
    })
    await waitPid(started.pid)
    const stdout = await ctx.nodeRegistry.invoke<{ text: string }>('proc.read', { pid: started.pid, stream: 'stdout' })
    assert.equal(await realpath(stdout.text.trim()), await realpath(sub))
  })

  it('spawns a process, collects its output, and reports its exit code', async () => {
    await mount()
    await connect()
    const started = await ctx.nodeRegistry.invoke<{ pid: number; collected: { stdout: boolean } }>(
      'proc.spawn',
      {
        argv: ['/bin/sh', '-c', 'printf "%s" "out-here"; printf "%s" "err-here" 1>&2; exit 3'],
        cwd: world,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 2000,
      },
    )
    assert.ok(started.pid > 0, 'a real pid must come back')
    assert.equal(started.collected.stdout, true)

    const outcome = await waitPid(started.pid)
    assert.equal(outcome.exitCode, 3, 'the real exit code crosses the wire')

    const stdout = await ctx.nodeRegistry.invoke<{ text: string; lossy: boolean }>(
      'proc.read', { pid: started.pid, stream: 'stdout' },
    )
    const stderr = await ctx.nodeRegistry.invoke<{ text: string }>(
      'proc.read', { pid: started.pid, stream: 'stderr' },
    )
    assert.equal(stdout.text, 'out-here')
    assert.equal(stderr.text, 'err-here')
    assert.equal(stdout.lossy, false)
  })

  it('reads collected output incrementally without consuming it', async () => {
    await mount()
    await connect()
    const { pid } = await ctx.nodeRegistry.invoke<{ pid: number }>('proc.spawn', {
      argv: ['/bin/sh', '-c', 'printf "abcdefghij"'],
      cwd: world,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: 'pipe' },
      graceMs: 2000,
    })
    await waitPid(pid)

    const first = await ctx.nodeRegistry.invoke<{ text: string; nextOffset: number }>(
      'proc.read', { pid, stream: 'stdout', fromByte: 0 },
    )
    assert.equal(first.text, 'abcdefghij')
    // The same offset read twice returns the same bytes: readers are
    // non-consuming, so two consumers cannot eat each other's output.
    const again = await ctx.nodeRegistry.invoke<{ text: string }>(
      'proc.read', { pid, stream: 'stdout', fromByte: 0 },
    )
    assert.equal(again.text, 'abcdefghij')

    const delta = await ctx.nodeRegistry.invoke<{ text: string }>(
      'proc.read', { pid, stream: 'stdout', fromByte: first.nextOffset },
    )
    assert.equal(delta.text, '', 'an offset at the end yields nothing new')
  })

  it('keeps the tail and reports loss when the in-memory cap overflows', async () => {
    await mount()
    await connect()
    // Two writes with a pause between them, so the output arrives as separate
    // chunks. A single chunk would be retained whole regardless of the cap —
    // the window is trimmed from the head only between chunks — and the test
    // would pass without ever exercising the overflow path.
    const { pid } = await ctx.nodeRegistry.invoke<{ pid: number }>('proc.spawn', {
      argv: ['/bin/sh', '-c', 'printf "%s" "aaaaaaaaaa"; sleep 0.2; printf "%s" "bbbbbbbbbb"'],
      cwd: world,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 5 }, stderr: 'pipe' },
      graceMs: 2000,
    })
    await waitPid(pid)
    const read = await ctx.nodeRegistry.invoke<{ text: string; lossy: boolean }>(
      'proc.read', { pid, stream: 'stdout', fromByte: 0 },
    )
    assert.equal(read.lossy, true, 'a dropped head must be reported, not hidden')
    // The window is trimmed to EXACTLY the cap, so the tail is the last five
    // bytes. Matching the local backend here is the point: a caller must not be
    // able to tell which machine ran the process from what it reads back.
    assert.equal(read.text, 'bbbbb')
  })

  it('writes to a spawned process\'s stdin', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('proc.spawn', {
      argv: ['/bin/sh', '-c', 'read line; printf "got:%s" "$line"'],
      cwd: world,
      stdio: { stdin: 'pipe', stdout: { maxBytes: 65536 }, stderr: 'pipe' },
      graceMs: 2000,
    })
    const started = await stream.result as { pid: number }
    stream.write(new TextEncoder().encode('ping\n'))
    const outcome = await waitPid(started.pid)
    assert.equal(outcome.exitCode, 0)
    const read = await ctx.nodeRegistry.invoke<{ text: string }>(
      'proc.read', { pid: started.pid, stream: 'stdout' },
    )
    assert.equal(read.text, 'got:ping')
  })

  it('kills the whole process tree, not just the direct child', async () => {
    await mount()
    await connect()
    // The shell spawns a helper that writes to a file after a delay. If the
    // terminate only signals the direct child, the helper survives and the
    // marker appears — which is the failure this test exists to catch.
    const marker = join(world, 'survivor.txt')
    const { pid } = await ctx.nodeRegistry.invoke<{ pid: number }>('proc.spawn', {
      argv: [
        '/bin/sh', '-c',
        `sh -c 'sleep 1; printf survived > ${marker}' & sleep 30`,
      ],
      cwd: world,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'pipe' },
      graceMs: 200,
    })
    // Wait until the helper really exists before killing the tree.
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    await ctx.nodeRegistry.invoke('proc.signal', { pid, signal: 'SIGTERM' })
    await waitPid(pid)
    // Well past the helper's 1s delay: if it survived, it has written by now.
    await new Promise((resolve) => { setTimeout(resolve, 1200) })
    await assert.rejects(
      () => import('node:fs/promises').then((fs) => fs.stat(marker)),
      'the grandchild must not outlive the terminated tree',
    )
  })

  it('refuses to signal a process it does not own', async () => {
    await mount()
    await connect()
    await assert.rejects(
      () => ctx.nodeRegistry.invoke('proc.signal', { pid: 999_999, signal: 'SIGTERM' }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'not-found')
        return true
      },
    )
  })

  it('fails an in-flight wait when the node drops, rather than hanging', async () => {
    await mount()
    await connect()
    const stream: NodeStream = ctx.nodeRegistry.open('proc.spawn', {
      argv: ['/bin/sh', '-c', 'sleep 30'],
      cwd: world,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2000,
    })
    const { pid } = await stream.result as { pid: number }
    const waiting = waitPid(pid)
    // Drop the node out from under the wait.
    agent.stop()
    await assert.rejects(waiting, (error: unknown) => {
      assert.equal((error as { code: string }).code, 'disconnected')
      return true
    })
  })
})

describe('tty.*: real terminals on the node', { skip: !ptyAvailable() }, () => {
  it('opens a terminal, streams output, and closes it', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('tty.open', {
      argv: ['/bin/sh'],
      cwd: world,
      rows: 24,
      cols: 80,
      graceMs: 2000,
    })
    const opened = await stream.result as { pid: number }
    assert.ok(opened.pid > 0)

    // Collect terminal output as it arrives, on the stream that opened it.
    const chunks: string[] = []
    const collected = (async () => {
      for await (const { kind, bytes } of stream.tagged) {
        assert.equal(kind, 'opaque')
        chunks.push(Buffer.from(bytes).toString('utf8'))
        if (chunks.join('').includes('TERM_MARK')) break
      }
    })()

    await ctx.nodeRegistry.invoke('tty.write', { pid: opened.pid, data: 'printf "TERM_MARK\\n"\n' })
    await Promise.race([
      collected,
      new Promise((_, reject) => { setTimeout(() => reject(new Error('no terminal output arrived')), 5000) }),
    ])
    assert.ok(chunks.join('').includes('TERM_MARK'), 'the terminal must echo and run what was written')

    await ctx.nodeRegistry.invoke('tty.close', { pid: opened.pid })
  })

  it('resizes a terminal and reports the operation is acknowledged', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('tty.open', {
      argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 2000,
    })
    const { pid } = await stream.result as { pid: number }
    // A resize is fire-and-forget: what must be observable is that it is
    // accepted for a live terminal and refused for an unknown one.
    await ctx.nodeRegistry.invoke('tty.resize', { pid, rows: 40, cols: 120 })
    await assert.rejects(
      () => ctx.nodeRegistry.invoke('tty.resize', { pid: 999_999, rows: 40, cols: 120 }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'not-found')
        return true
      },
    )
    await ctx.nodeRegistry.invoke('tty.close', { pid })
  })

  it('delivers a foreground signal to the terminal, not the shell', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('tty.open', {
      argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 2000,
    })
    const { pid } = await stream.result as { pid: number }
    // Start a long-running foreground command, then interrupt it. The shell
    // must survive to report the next prompt, which is the observable
    // difference between signalling the foreground group and killing the pty.
    await ctx.nodeRegistry.invoke('tty.write', { pid, data: 'sleep 30\n' })
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    const group = await ctx.nodeRegistry.invoke<number>('tty.signal', { pid, signal: 'SIGINT' })
    assert.ok(group > 0, 'the signal must name the group it reached')

    const chunks: string[] = []
    const collected = (async () => {
      for await (const { bytes } of stream.tagged) {
        chunks.push(Buffer.from(bytes).toString('utf8'))
        if (chunks.join('').includes('AFTER_SIGNAL')) break
      }
    })()
    await ctx.nodeRegistry.invoke('tty.write', { pid, data: 'printf "AFTER_SIGNAL\\n"\n' })
    await Promise.race([
      collected,
      new Promise((_, reject) => { setTimeout(() => reject(new Error('shell did not survive the signal')), 5000) }),
    ])
    await ctx.nodeRegistry.invoke('tty.close', { pid })
  })

  it('reports foreground facts without inventing certainty it does not have', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('tty.open', {
      argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 2000,
    })
    const { pid } = await stream.result as { pid: number }
    const facts = await ctx.nodeRegistry.invoke<{ processGroupId: number; inputWaiting: boolean }>(
      'tty.inspect', { pid },
    )
    assert.equal(typeof facts.processGroupId, 'number')
    assert.equal(typeof facts.inputWaiting, 'boolean')
    await ctx.nodeRegistry.invoke('tty.close', { pid })
  })

  it('ends a terminal\'s output stream when the terminal exits', async () => {
    await mount()
    await connect()
    const stream = ctx.nodeRegistry.open('tty.open', {
      argv: ['/bin/sh', '-c', 'printf "bye\\n"'], cwd: world, rows: 24, cols: 80, graceMs: 2000,
    })
    const { pid } = await stream.result as { pid: number }
    const outcome = await ctx.nodeRegistry.invoke<{ exitCode: number | null }>('tty.wait', { pid })
    assert.equal(outcome.exitCode, 0)
    await ctx.nodeRegistry.invoke('tty.close', { pid })
  })
})

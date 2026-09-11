/**
 * The claim this package makes is that `ctx.subprocess` behaves the same
 * whether it is served by the host's own machine or by a remote node. That
 * claim is only worth anything if it is checked against the real local backend
 * rather than against a description of it, so these tests run BOTH providers
 * over the same operations and compare what a caller observes.
 *
 * The node side is real: a real HTTP server, a real upgrade, a real
 * `NodeAgent`, and a real `NodeRegistry`. The local side is the harness's own
 * `dsh-subprocess-local`. Mocking either would test the mock.
 *
 * The one place the two legitimately differ is a path: each provider resolves
 * executables in its own namespace. Both run on this machine here, so the same
 * absolute `/bin/sh` is valid in both — which is exactly what makes the
 * comparison meaningful.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NodeAgent, NodeRegistry } from '../src/index.ts'
import NodeSubprocessRuntime from '../src/subprocess-node.ts'

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let http: Server
let port: number
let registry: NodeRegistry
let local: SubprocessRuntime
let node: SubprocessRuntime
let world: string
let agent: NodeAgent
const sockets: Socket[] = []

/** Poll until a condition holds, or fail the test. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Read a collect-mode stream to the end, after the process has settled. */
function collectedText(handle: SubprocessHandle, which: 'stdout' | 'stderr'): string {
  const reader = handle.collected[which]
  assert.ok(reader, `${which} must be collected`)
  return reader.readFrom(0).text
}

beforeEach(async () => {
  sockets.length = 0
  world = await mkdtemp(join(tmpdir(), 'dsh-subprocess-parity-'))

  // The reference backend lives on its OWN context: both providers register as
  // `ctx.subprocess`, and a context can hold exactly one. Two separate worlds
  // is also the honest model — the point of this package is that the node's
  // machine and the host's are different places.
  const localCtx = new Context()
  await localCtx.plugin(LocalSubprocessRuntime as never, {})
  local = localCtx.subprocess as unknown as SubprocessRuntime

  const upgrades = new Map<string, UpgradeHandler>()
  ctx = new Context()
  ctx.provide('webServer', {
    registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
      upgrades.set(route.path, route.handler)
      return () => { upgrades.delete(route.path) }
    },
  } as never)

  http = createServer()
  http.on('upgrade', (req, socket, head) => {
    sockets.push(socket)
    const handler = upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (!handler) { socket.destroy(); return }
    handler(req, socket, head)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  port = (http.address() as { port: number }).port

  fiber = await ctx.plugin(NodeRegistry, { cwd: world })
  await ctx.plugin(NodeSubprocessRuntime as never, {})
  registry = ctx.nodeRegistry as NodeRegistry
  node = ctx.subprocess as unknown as SubprocessRuntime

  agent = new NodeAgent({
    url: `ws://127.0.0.1:${port}/node/v1`,
    nodeId: 'subprocess-parity-01',
    credential: 'test-credential',
    cwd: world,
  })
  agent.start()
  await waitFor(() => registry.current !== undefined, 'the agent to register')
})

afterEach(async () => {
  agent?.stop()
  await fiber?.dispose()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
  await rm(world, { recursive: true, force: true })
})

describe('ctx.subprocess parity: the remote world behaves like the local one', () => {
  it('resolves an executable to a usable path in both worlds', async () => {
    const [localPath, nodePath] = await Promise.all([
      local.resolveExecutable('sh'),
      node.resolveExecutable('sh'),
    ])
    assert.ok(localPath.endsWith('/sh'), `local resolved ${localPath}`)
    assert.ok(nodePath.endsWith('/sh'), `node resolved ${nodePath}`)
  })

  it('runs a command and reports the same exit code and output', async () => {
    const spec = {
      argv: ['/bin/sh', '-c', 'printf "%s" "same-text"; exit 7'],
      cwd: world,
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
    }
    const localHandle = local.spawn(spec)
    const nodeHandle = node.spawn(spec)
    const [localOutcome, nodeOutcome] = await Promise.all([localHandle.done, nodeHandle.done])

    assert.equal(nodeOutcome.exitCode, localOutcome.exitCode)
    assert.equal(nodeOutcome.exitCode, 7)
    assert.equal(collectedText(nodeHandle, 'stdout'), collectedText(localHandle, 'stdout'))
    assert.equal(collectedText(nodeHandle, 'stdout'), 'same-text')
  })

  it('separates stderr from stdout the same way', async () => {
    const spec = {
      argv: ['/bin/sh', '-c', 'printf out; printf err 1>&2'],
      cwd: world,
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
    }
    const localHandle = local.spawn(spec)
    const nodeHandle = node.spawn(spec)
    await Promise.all([localHandle.done, nodeHandle.done])
    assert.equal(collectedText(nodeHandle, 'stdout'), collectedText(localHandle, 'stdout'))
    assert.equal(collectedText(nodeHandle, 'stderr'), collectedText(localHandle, 'stderr'))
    assert.equal(collectedText(nodeHandle, 'stdout'), 'out')
    assert.equal(collectedText(nodeHandle, 'stderr'), 'err')
  })

  it('reports the tail and the loss flag the same way when the cap overflows', async () => {
    // Two writes with a pause: the window trims only between chunks, so a
    // single chunk would be retained whole and never exercise the overflow.
    const spec = {
      argv: ['/bin/sh', '-c', 'printf "%s" "aaaaa"; sleep 0.2; printf "%s" "bbbbb"'],
      cwd: world,
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: 4 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 2000,
    }
    const localHandle = local.spawn(spec)
    const nodeHandle = node.spawn(spec)
    await Promise.all([localHandle.done, nodeHandle.done])

    const localRead = localHandle.collected.stdout!.readFrom(0)
    const nodeRead = nodeHandle.collected.stdout!.readFrom(0)
    assert.equal(nodeRead.lossy, localRead.lossy)
    assert.equal(nodeRead.text, localRead.text)
  })

  it('delivers stdin to the child in both worlds', async () => {
    const spec = {
      argv: ['/bin/sh', '-c', 'read line; printf "got:%s" "$line"'],
      cwd: world,
      stdio: {
        stdin: 'pipe' as const,
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 2000,
    }
    const localHandle = local.spawn(spec)
    const nodeHandle = node.spawn(spec)
    localHandle.stdin!.write('ping\n')
    nodeHandle.stdin!.write('ping\n')
    await Promise.all([localHandle.done, nodeHandle.done])
    assert.equal(collectedText(nodeHandle, 'stdout'), collectedText(localHandle, 'stdout'))
    assert.equal(collectedText(nodeHandle, 'stdout'), 'got:ping')
  })

  it('runs a piped stdout as a raw stream in both worlds', async () => {
    const spec = {
      argv: ['/bin/sh', '-c', 'printf "%s" "streamed-bytes"'],
      cwd: world,
      stdio: {
        stdin: 'ignore' as const,
        stdout: 'pipe' as const,
        stderr: 'pipe' as const,
      },
      graceMs: 2000,
    }
    const localHandle = local.spawn(spec)
    const nodeHandle = node.spawn(spec)
    const read = async (handle: SubprocessHandle): Promise<string> => {
      const chunks: Buffer[] = []
      for await (const chunk of handle.stdout!) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    }
    const [localText, nodeText] = await Promise.all([read(localHandle), read(nodeHandle)])
    assert.equal(nodeText, localText)
    assert.equal(nodeText, 'streamed-bytes')
  })

  it('terminates a process tree, not just the direct child, in both worlds', async () => {
    // The shell spawns a helper that writes to a file after a delay. A
    // terminate that only signals the root leaves the helper to write it.
    for (const provider of [{ name: 'local', runtime: () => local }, { name: 'node', runtime: () => node }]) {
      const marker = join(world, `survivor-${provider.name}.txt`)
      const handle = provider.runtime().spawn({
        argv: ['/bin/sh', '-c', `sh -c 'sleep 1; printf survived > ${marker}' & sleep 30`],
        cwd: world,
        stdio: {
          stdin: 'ignore' as const,
          stdout: { maxBytes: 4096 },
          stderr: { maxBytes: 4096 },
        },
        graceMs: 200,
      })
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      handle.terminate()
      await handle.done
      await new Promise((resolve) => { setTimeout(resolve, 1200) })
      await assert.rejects(
        () => import('node:fs/promises').then((fs) => fs.stat(marker)),
        `${provider.name}: the grandchild must not outlive the terminated tree`,
      )
    }
  })

  it('refuses every operation when no node is registered', async () => {
    agent.stop()
    await waitFor(() => registry.current === undefined, 'the node to go away')
    // The safety property: an absent node must fail, never run locally.
    assert.throws(
      () => node.spawn({
        argv: ['/bin/sh', '-c', 'printf unsafe'],
        cwd: world,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 1000,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'disconnected')
        return true
      },
    )
    await assert.rejects(
      () => node.resolveExecutable('sh'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'disconnected')
        return true
      },
    )
    await assert.rejects(
      () => node.spawnTerminal({
        argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 1000,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'disconnected')
        return true
      },
    )
  })
})

describe('spawnTerminal parity: a real terminal in both worlds', () => {
  it('runs a command on a terminal and returns its exit code', async () => {
    // A terminal is only meaningful with a PTY on the node, so this is skipped
    // where the agent has no substrate rather than degraded into a pipe — a
    // pipe would change how the user's shell behaves without saying so.
    const caps = registry.current?.capabilities ?? []
    if (!caps.includes('tty.open')) return

    const spec = {
      argv: ['/bin/sh', '-c', 'printf "terminal-text\\n"'],
      cwd: world,
      rows: 24,
      cols: 80,
      graceMs: 2000,
    }
    const terminal = await node.spawnTerminal(spec)
    assert.ok(terminal.pid > 0)

    const chunks: Buffer[] = []
    for await (const chunk of terminal.output) chunks.push(Buffer.from(chunk))
    const outcome = await terminal.done
    assert.equal(outcome.exitCode, 0)
    assert.ok(
      Buffer.concat(chunks).toString('utf8').includes('terminal-text'),
      'a terminal carries what the command printed',
    )
    await terminal.terminate()
  })

  it('writes to a terminal and reads the echo back', async () => {
    const caps = registry.current?.capabilities ?? []
    if (!caps.includes('tty.open')) return

    const terminal = await node.spawnTerminal({
      argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 2000,
    })
    const seen: string[] = []
    const reading = (async () => {
      for await (const chunk of terminal.output) {
        seen.push(Buffer.from(chunk).toString('utf8'))
        if (seen.join('').includes('ECHO_BACK')) break
      }
    })()
    await terminal.write('printf "ECHO_BACK\\n"\n')
    await Promise.race([
      reading,
      new Promise((_, reject) => { setTimeout(() => reject(new Error('no terminal output arrived')), 5000) }),
    ])
    assert.ok(seen.join('').includes('ECHO_BACK'))
    await terminal.terminate()
  })

  it('terminates the terminal session, ending its output', async () => {
    const caps = registry.current?.capabilities ?? []
    if (!caps.includes('tty.open')) return

    const terminal = await node.spawnTerminal({
      argv: ['/bin/sh'], cwd: world, rows: 24, cols: 80, graceMs: 500,
    })
    await terminal.terminate()
    // After teardown the session is gone: the node refuses further writes,
    // which is the observable proof that terminate reached the real process.
    await assert.rejects(
      () => terminal.write('printf "too-late"\n'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'not-found')
        return true
      },
    )
  })
})

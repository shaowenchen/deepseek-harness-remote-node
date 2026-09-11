/**
 * The claim this package makes is that `ctx.fs` behaves the same whether it is
 * served by the host's own filesystem or by a remote node. That claim is only
 * worth anything if it is checked against the real local backend rather than
 * against a description of it, so these tests run BOTH providers over the same
 * operations and compare what a caller observes.
 *
 * Where the two legitimately differ — the local backend realpaths a temp dir
 * that may itself be a symlink, so target keys differ — the comparison is on
 * observable behaviour (codes, values, outcomes), not on opaque tokens.
 *
 * The node side is real: a real HTTP server, a real upgrade, a real
 * `NodeAgent`, and a real `NodeRegistry`. Mocking the channel would test the
 * mock.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { FsError, type FsErrorCode, type FsTarget } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { NodeAgent, NodeRegistry } from '../src/index.ts'
import NodeFileSystem from '../src/fs-node.ts'

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let http: Server
let port: number
let registry: NodeRegistry
let local: LocalFileSystem
let node: NodeFileSystem
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

/** Capture a thrown FsError's code, or undefined when nothing was thrown. */
async function codeOf(run: () => Promise<unknown>): Promise<FsErrorCode | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    assert.ok(error instanceof FsError, `expected an FsError, got ${String(error)}`)
    return error.code
  }
}

beforeEach(async () => {
  sockets.length = 0
  world = await mkdtemp(join(tmpdir(), 'dsh-fs-parity-'))

  // The reference backend lives on its OWN context: both providers register as
  // `ctx.fs`, and a context can hold exactly one. Two separate worlds is also
  // the honest model — the whole point of this package is that the node's
  // filesystem and the host's are different places.
  const localCtx = new Context()
  await localCtx.plugin(LocalFileSystem, { cwd: world })
  local = localCtx.fs as unknown as LocalFileSystem

  // A fake webServer so the registry can bind its upgrade route, exactly as the
  // node package's own suite does.
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
  await ctx.plugin(NodeFileSystem, {})
  registry = ctx.nodeRegistry as NodeRegistry
  // The adapter registers itself as ctx.fs, which is the seam being implemented.
  node = ctx.fs as unknown as NodeFileSystem

  agent = new NodeAgent({
    url: `ws://127.0.0.1:${port}/node/v1`,
    nodeId: 'parity-01',
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

describe('ctx.fs parity: the remote world behaves like the local one', () => {
  it('reads the same text, and both report an absent file the same way', async () => {
    await writeFile(join(world, 'a.txt'), 'hello\nworld\n')
    const [localTarget, nodeTarget] = await Promise.all([
      local.resolve('a.txt'), node.resolve('a.txt'),
    ])
    assert.equal(await local.readText(localTarget), await node.readText(nodeTarget))

    // Both expose absence as a read failure with the same code.
    const [localTarget2, nodeTarget2] = await Promise.all([
      local.resolve('nope.txt'), node.resolve('nope.txt'),
    ])
    assert.equal(
      await codeOf(() => local.readText(localTarget2)),
      await codeOf(() => node.readText(nodeTarget2)),
    )
    assert.equal(await codeOf(() => node.readText(nodeTarget2)), 'FS_NOT_FOUND')
  })

  it('agrees on stat metadata for a file and a directory', async () => {
    await writeFile(join(world, 'a.txt'), 'x'.repeat(42))
    await mkdir(join(world, 'd'))

    for (const [name, expectedType] of [['a.txt', 'file'], ['d', 'directory']] as const) {
      const [lt, nt] = await Promise.all([local.resolve(name), node.resolve(name)])
      const [li, ni] = await Promise.all([local.stat(lt), node.stat(nt)])
      assert.ok(li && ni, `${name} must be present in both`)
      assert.equal(ni.type, li.type, `${name} type must match`)
      assert.equal(ni.type, expectedType)
      assert.equal(ni.size, li.size, `${name} size must match`)
    }

    // Absence is `undefined` from stat in both worlds, never a throw.
    const [lt, nt] = await Promise.all([local.resolve('gone'), node.resolve('gone')])
    assert.equal(await local.stat(lt), undefined)
    assert.equal(await node.stat(nt), undefined)
  })

  it('rejects binary files with the same code', async () => {
    await writeFile(join(world, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]))
    const [lt, nt] = await Promise.all([local.resolve('bin.dat'), node.resolve('bin.dat')])
    assert.equal(await codeOf(() => local.readText(lt)), 'FS_NOT_TEXT')
    assert.equal(await codeOf(() => node.readText(nt)), 'FS_NOT_TEXT')
  })

  it('rejects a directory read as a non-regular file, in both worlds', async () => {
    await mkdir(join(world, 'd'))
    const [lt, nt] = await Promise.all([local.resolve('d'), node.resolve('d')])
    const code = await codeOf(() => node.readText(nt))
    assert.equal(code, await codeOf(() => local.readText(lt)))
    assert.equal(code, 'FS_NOT_REGULAR_FILE')
  })

  it('lists the same entries in the same order', async () => {
    await writeFile(join(world, 'b.txt'), 'b')
    await writeFile(join(world, 'a.txt'), 'a')
    await mkdir(join(world, 'c'))
    const [lt, nt] = await Promise.all([local.resolve('.'), node.resolve('.')])
    const [le, ne] = await Promise.all([local.listDir(lt), node.listDir(nt)])
    assert.deepEqual(
      ne.map((e) => [e.name, e.type]),
      le.map((e) => [e.name, e.type]),
      'names and types must match, in the same order',
    )
    assert.deepEqual(ne.map((e) => e.name), ['a.txt', 'b.txt', 'c'])
  })

  it('reports the same code when listing a file', async () => {
    await writeFile(join(world, 'a.txt'), 'a')
    const [lt, nt] = await Promise.all([local.resolve('a.txt'), node.resolve('a.txt')])
    const code = await codeOf(() => node.listDir(nt))
    assert.equal(code, await codeOf(() => local.listDir(lt)))
    assert.equal(code, 'FS_NOT_DIRECTORY')
  })

  it('writes, and both report create then update with the prior content', async () => {
    // A distinct filename per world: the local backend and the node are pointed
    // at the same directory here, so sharing a path would let one world's write
    // be the other's update and make the comparison meaningless.
    const [lt, nt] = await Promise.all([
      local.resolve('w-local.txt'), node.resolve('w-node.txt'),
    ])
    const lw = await local.writeText(lt, 'first')
    const nw = await node.writeText(nt, 'first')
    assert.equal(nw.operation, lw.operation)
    assert.equal(nw.operation, 'create')
    assert.equal(nw.after, lw.after)
    // A create has no prior content in either world.
    assert.equal(nw.before, lw.before)
    assert.equal(nw.before, null)

    const lw2 = await local.writeText(lt, 'second')
    const nw2 = await node.writeText(nt, 'second')
    assert.equal(nw2.operation, 'update')
    assert.equal(nw2.operation, lw2.operation)
    assert.equal(nw2.before, 'first', 'the diff basis is the previous content')
    assert.equal(nw2.before, lw2.before)
    assert.equal(await readFile(join(world, 'w-node.txt'), 'utf8'), 'second')
    assert.equal(await readFile(join(world, 'w-local.txt'), 'utf8'), 'second')
  })

  it('refuses createIfAbsent over an existing file with the same code', async () => {
    const [lt, nt] = await Promise.all([local.resolve('g.txt'), node.resolve('g.txt')])
    await local.writeText(lt, 'x')
    await node.writeText(nt, 'x')
    assert.equal(
      await codeOf(() => local.writeText(lt, 'y', { kind: 'createIfAbsent' })),
      await codeOf(() => node.writeText(nt, 'y', { kind: 'createIfAbsent' })),
    )
    assert.equal(await codeOf(() => node.writeText(nt, 'y', { kind: 'createIfAbsent' })), 'FS_NOT_OBSERVED')
  })

  it('refuses a stale version with the same code, and does not clobber', async () => {
    const [lt, nt] = await Promise.all([local.resolve('s.txt'), node.resolve('s.txt')])
    const lw = await local.writeText(lt, 'v1')
    const nw = await node.writeText(nt, 'v1')

    // Advance the file past the returned version in each world.
    await local.writeText(lt, 'v2')
    await node.writeText(nt, 'v2')

    const staleLocal = { kind: 'replaceIfVersion' as const, version: lw.version }
    const staleNode = { kind: 'replaceIfVersion' as const, version: nw.version }
    assert.equal(
      await codeOf(() => local.writeText(lt, 'v3', staleLocal)),
      await codeOf(() => node.writeText(nt, 'v3', staleNode)),
    )
    assert.equal(await codeOf(() => node.writeText(nt, 'v3', staleNode)), 'FS_STALE_VERSION')
    assert.equal(await readFile(join(world, 's.txt'), 'utf8'), 'v2', 'a refused write must not clobber')
  })

  it('edits with the same outcome, and the same refusal for an ambiguous match', async () => {
    const content = 'alpha\nbeta\nalpha\n'
    const [lt, nt] = await Promise.all([local.resolve('e.txt'), node.resolve('e.txt')])
    await local.writeText(lt, content)
    await node.writeText(nt, content)

    const edit = { oldString: 'alpha', newString: 'gamma', replaceAll: false }
    assert.equal(
      await codeOf(() => local.editText(lt, edit)),
      await codeOf(() => node.editText(nt, edit)),
    )
    assert.equal(await codeOf(() => node.editText(nt, edit)), 'FS_AMBIGUOUS_EDIT')

    const all = { oldString: 'alpha', newString: 'gamma', replaceAll: true }
    const [le, ne] = await Promise.all([local.editText(lt, all), node.editText(nt, all)])
    assert.equal(ne.before, le.before)
    assert.equal(ne.after, le.after)
    assert.equal(ne.after, 'gamma\nbeta\ngamma\n')
    assert.equal(await readFile(join(world, 'e.txt'), 'utf8'), 'gamma\nbeta\ngamma\n')
  })

  it('reports a missing search string identically', async () => {
    const [lt, nt] = await Promise.all([local.resolve('m.txt'), node.resolve('m.txt')])
    await local.writeText(lt, 'abc\n')
    await node.writeText(nt, 'abc\n')
    const edit = { oldString: 'zzz', newString: 'y', replaceAll: false }
    assert.equal(
      await codeOf(() => local.editText(lt, edit)),
      await codeOf(() => node.editText(nt, edit)),
    )
    assert.equal(await codeOf(() => node.editText(nt, edit)), 'FS_EDIT_NOT_FOUND')
  })

  it('preserves CRLF line endings through an edit, like the local backend', async () => {
    const crlf = 'one\r\ntwo\r\nthree\r\n'
    const [lt, nt] = await Promise.all([local.resolve('crlf.txt'), node.resolve('crlf.txt')])
    await writeFile(join(world, 'crlf.txt'), crlf)
    void lt

    // The search text is written with LF while the file stores CRLF: both
    // backends normalize before matching, so the model need not know the style.
    const edit = { oldString: 'two\n', newString: 'TWO\n', replaceAll: false }
    await node.editText(nt, edit)
    assert.equal(
      await readFile(join(world, 'crlf.txt'), 'utf8'),
      'one\r\nTWO\r\nthree\r\n',
      'the file keeps its original line endings',
    )
  })

  it('honours readBytes caps with the same code', async () => {
    await writeFile(join(world, 'big.txt'), 'x'.repeat(100))
    const [lt, nt] = await Promise.all([local.resolve('big.txt'), node.resolve('big.txt')])
    const [lb, nb] = await Promise.all([
      local.readBytes(lt, undefined, 1000),
      node.readBytes(nt, undefined, 1000),
    ])
    assert.deepEqual(Buffer.from(nb), Buffer.from(lb))

    assert.equal(
      await codeOf(() => local.readBytes(lt, undefined, 10)),
      await codeOf(() => node.readBytes(nt, undefined, 10)),
    )
    assert.equal(await codeOf(() => node.readBytes(nt, undefined, 10)), 'FS_TOO_LARGE')
  })

  it('agrees on lstat for a symlink', async () => {
    await writeFile(join(world, 'target.txt'), 'x')
    await symlink(join(world, 'target.txt'), join(world, 'link.txt'))

    const [li, ni] = await Promise.all([
      local.lstat('link.txt'), node.lstat('link.txt'),
    ])
    assert.ok(li && ni)
    assert.equal(ni.type, li.type)
    assert.equal(ni.type, 'symlink')
    // A symlink is not a regular file, so reading it as text is refused — but
    // through the resolution rules, which follow the link. Both must agree.
    const [lt, nt] = await Promise.all([local.resolve('link.txt'), node.resolve('link.txt')])
    assert.equal(await local.readText(lt), await node.readText(nt))
  })

  it('shares one identity across two paths to the same file', async () => {
    await writeFile(join(world, 'real.txt'), 'x')
    await symlink(join(world, 'real.txt'), join(world, 'alias.txt'))
    // resolve() follows symlinks, so an alias and its target are ONE target:
    // that is what makes a stale guard taken on one path protect the other.
    const [viaReal, viaAlias] = await Promise.all([
      node.resolve('real.txt'), node.resolve('alias.txt'),
    ])
    assert.equal(String(viaAlias.targetKey), String(viaReal.targetKey))
  })

  it('keeps a target key stable for a file that does not exist yet', async () => {
    // Identity must survive creation, or a guarded create could never match the
    // observation taken before the file existed.
    const before = await node.resolve('later/created.txt')
    await node.writeText(before, 'x')
    const after = await node.resolve('later/created.txt')
    assert.equal(String(after.targetKey), String(before.targetKey))
  })

  it('agrees on containment', async () => {
    await mkdir(join(world, 'd'))
    const [lt, nt] = await Promise.all([local.resolve('.'), node.resolve('.')])
    const [lc, nc] = await Promise.all([local.resolve('d'), node.resolve('d')])
    assert.equal(node.contains(nt, nc), local.contains(lt, lc))
    assert.equal(node.contains(nt, nc), true)
    assert.equal(node.contains(nc, nt), local.contains(lc, lt))
  })

  it('refuses every operation when no node is registered', async () => {
    agent.stop()
    await waitFor(() => registry.current === undefined, 'the node to drop')

    // This is the safety property: the remote world must fail, never silently
    // become the host's own filesystem.
    for (const run of [
      () => node.readText({ targetKey: join(world, 'a.txt'), displayPath: 'a.txt' } as FsTarget),
      () => node.writeText({ targetKey: join(world, 'a.txt'), displayPath: 'a.txt' } as FsTarget, 'x'),
      () => node.listDir({ targetKey: world, displayPath: '.' } as FsTarget),
      () => node.resolve('a.txt'),
      () => node.stat({ targetKey: world, displayPath: '.' } as FsTarget),
    ]) {
      const code = await codeOf(run)
      assert.equal(code, 'disconnected', 'a dropped node must refuse, never fall back to the host')
    }
  })
})

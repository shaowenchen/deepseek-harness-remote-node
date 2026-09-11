/**
 * Credential verification: the check that was designed for, carried in the
 * protocol as the `auth` refusal code, and — until now — never implemented.
 *
 * Before this, `credential` crossed the wire and was never read. Registration
 * was gated only by protocol version and the single-slot rule, so anything that
 * could reach `/node/v1` got a shell and a filesystem on the node machine. The
 * suite exists because that is a security property, and security properties
 * that are "obviously working" have a way of being untested.
 *
 * The comparison is constant-time, and the tests pin that too: comparing raw
 * buffers would leak the credential's LENGTH through a separate fast path, so
 * both sides are hashed before `timingSafeEqual`. That is not observable by
 * timing in a unit test — what IS observable, and what is asserted here, is
 * that a wrong-length credential takes the same code path and is rejected
 * without throwing (raw `timingSafeEqual` throws on a length mismatch).
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import { encodeControl } from '../src/protocol.ts'
import { NodeRegistry } from '../src/index.ts'
import { credentialMatches, expectedCredential } from '../src/auth.ts'

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let http: Server
let port: number
let upgrades: Map<string, UpgradeHandler>
const sockets: Socket[] = []

/** Mount a registry with the given credential config. */
async function mount(config: { credential?: string } = {}): Promise<void> {
  upgrades = new Map()
  ctx = new Context()
  ctx.provide('webServer', {
    registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
      upgrades.set(route.path, route.handler)
      return () => { upgrades.delete(route.path) }
    },
  } as never)
  fiber = await ctx.plugin(NodeRegistry, { cwd: '/srv/workspace', ...config })
}

/**
 * Send a hello and return the host's answer frame.
 * @param credential - the credential to present.
 * @param nodeId - the node identity to claim.
 * @returns the `ready` or `refused` frame.
 */
async function hello(credential: string, nodeId = 'auth-test'): Promise<Record<string, unknown>> {
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
    protocolVersion: 1,
    nodeId,
    credential,
    agentVersion: '0.1.0-test',
    platform: 'linux',
    arch: 'x64',
    capabilities: [],
  }))
  return await answer
}

beforeEach(async () => {
  sockets.length = 0
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
  await fiber?.dispose()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
})

describe('the comparison itself', () => {
  it('accepts an exact match and rejects everything else', () => {
    assert.equal(credentialMatches('s3cret-token', 's3cret-token'), true)
    assert.equal(credentialMatches('s3cret-toke', 's3cret-token'), false)
    assert.equal(credentialMatches('s3cret-tokeN', 's3cret-token'), false)
    assert.equal(credentialMatches('', 's3cret-token'), false)
    assert.equal(credentialMatches('S3CRET-TOKEN', 's3cret-token'), false)
  })

  it('rejects a wrong-LENGTH credential without throwing', () => {
    // The reason both sides are hashed. `timingSafeEqual` throws
    // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on a length mismatch, so a raw
    // comparison would need a length check first — a separate, very fast step
    // that leaks the secret's length. Hashing collapses both to 32 bytes.
    assert.equal(credentialMatches('a', 'a-much-longer-expected-credential'), false)
    assert.equal(credentialMatches('a-much-longer-than-expected!!', 'short'), false)
  })

  it('handles non-ASCII without throwing on byte length', () => {
    // Hashing operates on UTF-8 bytes, so a multi-byte credential is fine where
    // a raw Buffer comparison of `.length` (UTF-16 units) would mismatch.
    assert.equal(credentialMatches('密码-token', '密码-token'), true)
    assert.equal(credentialMatches('密码-token', '密码-toke'), false)
  })
})

describe('config resolution', () => {
  it('prefers the plugin config, and reports where the value came from', async () => {
    const got = await expectedCredential('from-config', async () => 'from-service')
    assert.deepEqual(got, { kind: 'value', value: 'from-config', source: 'plugin config' })
  })

  it('falls back to the credentials service', async () => {
    const got = await expectedCredential(undefined, async () => 'from-service')
    assert.deepEqual(got, { kind: 'value', value: 'from-service', source: 'credentials service' })
  })

  it('is unset when neither route supplies a value', async () => {
    assert.deepEqual(await expectedCredential(undefined, undefined), { kind: 'unset' })
    assert.deepEqual(await expectedCredential('', async () => undefined), { kind: 'unset' })
    // An empty environment variable resolves to '', which must read as unset —
    // otherwise every agent is rejected with 'invalid credential', a message
    // that says nothing about the real problem.
    assert.deepEqual(await expectedCredential('', async () => ''), { kind: 'unset' })
  })

  it('treats an unresolvable reference as configured, not as absent', async () => {
    // A credentials service that throws must not be read as "no credential
    // required" — that would turn a storage fault into an open door.
    const got = await expectedCredential(undefined, async () => { throw new Error('vault down') })
    assert.equal(got.kind, 'value')
    if (got.kind === 'value') assert.equal(got.value, '')
  })
})

describe('registration against a configured credential', () => {
  it('admits the right credential', async () => {
    await mount({ credential: 'right-credential' })
    const answer = await hello('right-credential')
    assert.equal(answer.type, 'ready')
  })

  it('refuses a wrong credential with the `auth` code', async () => {
    await mount({ credential: 'right-credential' })
    const answer = await hello('wrong-credential')
    assert.equal(answer.type, 'refused')
    assert.equal(answer.code, 'auth')
  })

  it('refuses an empty credential', async () => {
    await mount({ credential: 'right-credential' })
    const answer = await hello('')
    assert.equal(answer.type, 'refused')
    assert.equal(answer.code, 'auth')
  })

  it('does not let a refused peer occupy the slot', async () => {
    // The property that matters: a failed verification must leave the registry
    // unregistered, so a legitimate node can still connect afterwards.
    await mount({ credential: 'right-credential' })
    await hello('wrong-credential')
    assert.equal(ctx.nodeRegistry.current, undefined, 'a refused peer must not register')

    const answer = await hello('right-credential')
    assert.equal(answer.type, 'ready', 'the slot must still be free for the real node')
    assert.equal(ctx.nodeRegistry.current?.nodeId, 'auth-test')
  })
})

describe('registration with nothing configured', () => {
  it('admits any credential, which is the pre-verification behaviour', async () => {
    // Deliberate: an existing deployment must keep working across this upgrade.
    // The warning it prints is what makes the state visible.
    await mount()
    const answer = await hello('anything-at-all')
    assert.equal(answer.type, 'ready')
  })
})

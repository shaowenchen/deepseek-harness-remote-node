/**
 * The node registry: one remote machine registered as this process's execution
 * world, reachable over an inbound WebSocket the node itself dials.
 *
 * This service owns identity, the channel, liveness, and generation. It owns no
 * filesystem or process meaning — the `./fs` and `./subprocess` entry points
 * translate the capability seams onto {@link NodeRegistry.open}. That split is
 * the same one the E2B family uses: one lifecycle owner, two adapters, neither
 * creating its own world.
 *
 * A disconnected node is a FAILED execution world, not a fallback to the host.
 * {@link NodeRegistry.open} refuses with `disconnected` when no node is
 * registered, which is what keeps an adapter from silently mutating host files
 * that the user believes are remote.
 * @module @shaowenchen/deepseek-harness-remote-node
 */

import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  NODE_CHANNEL_PATH,
  NODE_PROTOCOL_VERSION,
  decodeControl,
  decodePayload,
  encodeControl,
  encodePayload,
  isAgentFrame,
  type NodeErrorCode,
  type NodeOperation,
  type NodeRefusalCode,
  type PayloadKind,
} from './protocol.ts'

export * from './protocol.ts'

// The agent is exported from the package root as well as being the `dsh-node`
// binary: this package ships both halves of the channel, and an embedder that
// wants to drive an agent in-process (a test, or a supervisor) should not have
// to reach through a private path to do it.
export * from './agent.ts'

/** Plugin configuration. */
export interface Config {
  /** Upgrade path the owner claims. @default '/node/v1' */
  path?: string
  /** Absolute working directory of the execution world on the node. */
  cwd: string
  /** Ping cadence and pong deadline in milliseconds. @default 2000 */
  heartbeatIntervalMs?: number
  /**
   * What happens to processes the node still owns when the channel drops.
   * `orphan` leaves them running and reports them as orphaned; `terminate`
   * asks the agent to reap them. @default 'orphan'
   */
  onDisconnect?: 'orphan' | 'terminate'
}

/** A registered node and the facts the adapters read. */
export interface NodeDescriptor {
  nodeId: string
  agentVersion: string
  platform: string
  arch: string
  capabilities: readonly string[]
  /** Absolute working directory of the execution world. */
  cwd: string
  /** Increments on every reconnection. */
  generation: number
}

/** One in-flight logical stream. */
export interface NodeStream {
  /** Payload frames arriving for this stream, ending when it settles. */
  readonly chunks: AsyncIterable<Uint8Array>
  /**
   * Payload frames tagged with the channel they arrived on.
   *
   * Same bytes as {@link chunks}, but a consumer that must tell a process's
   * stderr from its stdout reads this instead. Both iterators share one queue,
   * so a consumer chooses one of them and never both.
   */
  readonly tagged: AsyncIterable<{ kind: PayloadKind; bytes: Uint8Array }>
  /** Settles with the operation's result, or rejects with {@link NodeError}. */
  readonly result: Promise<unknown>
  /** Cancels the stream; the peer answers `op.error` code `cancelled`. */
  cancel(): void
  /** Writes to the peer's stdin channel for this stream. */
  write(bytes: Uint8Array): void
}

/** Thrown by every registry failure that crosses to a caller. */
export class NodeError extends Error {
  readonly code: NodeErrorCode

  constructor(
    code: NodeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'NodeError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nodeRegistry: NodeRegistry
  }

  interface Events {
    /**
     * The registered node went away. Emitted once per connection that reached
     * `ready`; a socket that never registered emits nothing.
     * @param generation - the generation that ended.
     * @param disposition - what the node was told to do with its processes.
     * @mode emit
     */
    'node/disconnected'(generation: number, disposition: 'orphan' | 'terminate'): void
  }
}

/**
 * Owns the one registered remote execution world.
 *
 * Registration is deliberately single-slot: two agents driving one machine
 * would corrupt each other, so a second connection for the same node id is
 * refused rather than merged.
 */
export class NodeRegistry extends Service {
  static Config: Schema<Config> = Schema.object({
    path: Schema.string().default(NODE_CHANNEL_PATH),
    cwd: Schema.string().required(),
    heartbeatIntervalMs: Schema.number().default(DEFAULT_HEARTBEAT_INTERVAL_MS),
    onDisconnect: Schema.union(['orphan', 'terminate']).default('orphan'),
  })

  private readonly path: string
  private readonly cwd: string
  private readonly heartbeatIntervalMs: number
  private readonly onDisconnect: 'orphan' | 'terminate'

  private descriptor: NodeDescriptor | undefined
  private socket: WebSocket | undefined
  private generation = 0
  private nextStreamId = 1
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private awaitingPong = false

  /** Per-stream plumbing, keyed by stream id. Lives for that stream only. */
  private readonly streams = new Map<number, StreamPlumbing>()

  /**
   * Report one lifecycle fact on stderr.
   *
   * Deliberately not `ctx.logger`: that service buffers into an in-memory ring
   * with no console exporter in the shipped profiles, so a message sent there
   * is stored and never shown. An operator watching a host needs these on the
   * terminal or in the service journal, which is stderr.
   * @param message - the line to report.
   */
  private note(message: string): void {
    process.stderr.write(`${message}\n`)
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'nodeRegistry')
    this.path = config.path ?? NODE_CHANNEL_PATH
    this.cwd = config.cwd
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.onDisconnect = config.onDisconnect ?? 'orphan'

    const server = new WebSocketServer({ noServer: true })

    // The webserver is a peer service, not an assumption: injecting keeps this
    // plugin loadable in a composition that has no HTTP carrier at all (a
    // headless agent node), where it simply never binds.
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const route: WebUpgradeRoute = {
          path: this.path,
          handler: (req, socket, head) => {
            server.handleUpgrade(req, socket as Duplex, head, (ws) => { this.adopt(ws) })
          },
        }
        const dispose = webCtx.webServer.registerUpgrade(route)
        return () => {
          dispose()
          server.close()
        }
      }, `dsh-node: ${this.path} WebSocket`)
    })

    ctx.effect(() => () => { this.stopHeartbeat() })
  }

  /** The registered node, or `undefined` when no node is connected. */
  get current(): NodeDescriptor | undefined {
    return this.descriptor
  }

  /** The current connection generation; stale handles compare against it. */
  get currentGeneration(): number {
    return this.generation
  }

  /**
   * Open one logical stream against the registered node.
   *
   * Refuses with `disconnected` when no node is registered. That refusal is the
   * safety property of this whole design: an adapter must never read an absent
   * execution world as "use the host instead".
   * @param op - the operation to perform.
   * @param args - operation arguments.
   * @returns the stream delivering payload frames and the terminal result.
   */
  open(op: NodeOperation, args: unknown): NodeStream {
    const socket = this.socket
    if (!socket || !this.descriptor || socket.readyState !== socket.OPEN) {
      throw new NodeError('disconnected', `node is not connected; cannot perform ${op}`)
    }

    const streamId = this.nextStreamId++
    const plumbing = new StreamPlumbing()
    this.streams.set(streamId, plumbing)

    socket.send(encodeControl({ type: 'op.open', streamId, op, args }))

    return {
      chunks: plumbing.chunks(),
      tagged: plumbing.tagged(),
      result: plumbing.result,
      cancel: () => {
        // Only the socket that opened this stream may cancel it; a reconnected
        // generation must not receive a stale cancel.
        if (this.socket === socket && socket.readyState === socket.OPEN) {
          socket.send(encodeControl({ type: 'op.cancel', streamId }))
        }
      },
      write: (bytes: Uint8Array) => {
        if (this.socket === socket && socket.readyState === socket.OPEN) {
          socket.send(encodePayload(streamId, 'stdin', bytes), { binary: true })
        }
      },
    }
  }

  /**
   * Run a unary operation and await its result.
   *
   * Deliberately waits on `result` ALONE and does not drain the payload
   * iterator. `result` already carries every failure path — an `op.error` frame
   * and a mid-stream disconnect both reject it — while the payload is not
   * something a unary caller asked for. Draining it would be worse than
   * pointless: a stream whose payload outlives its reply (`payloadContinues`,
   * which a `proc.spawn` with a piped stream sets) does not end until that
   * stream closes, so awaiting the drain would block for as long as a remote
   * process chooses to keep its pipe open.
   *
   * An operation with a payload to read uses {@link open} instead; this is for
   * the answer-only case.
   *
   * A caller-supplied signal bounds only the WAIT. The cancellation does not
   * reach the node, so an abandoned operation still completes there; what the
   * signal guarantees is that this caller stops waiting, which is what it can
   * observe. Aborting does not kill anything — teardown is an explicit signal.
   * @param op - the operation to perform.
   * @param args - operation arguments.
   * @param signal - aborts the wait.
   * @returns the operation's decoded result.
   */
  async invoke<T>(op: NodeOperation, args: unknown, signal?: AbortSignal): Promise<T> {
    const stream = this.open(op, args)
    const settled = stream.result as Promise<T>
    if (!signal) return await settled
    if (signal.aborted) {
      stream.cancel()
      throw new NodeError('cancelled', `${op} aborted before it completed`)
    }
    return await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          stream.cancel()
          reject(new NodeError('cancelled', `${op} aborted`))
        }, { once: true })
      }),
    ])
  }

  /** @internal Adopt a freshly upgraded socket as the node channel. */
  private adopt(socket: WebSocket): void {
    let registered = false

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        const frame = decodePayload(bytes)
        if (!frame) return
        this.streams.get(frame.streamId)?.push(frame.bytes, frame.kind)
        return
      }

      const frame = decodeControl(data.toString())
      if (!frame || !isAgentFrame(frame)) {
        // A frame only the host may send arriving from an agent is a confused
        // peer; a malformed one is a protocol fault. Both close.
        socket.close(1002, 'malformed frame')
        return
      }

      switch (frame.type) {
        case 'hello': {
          if (frame.protocolVersion !== NODE_PROTOCOL_VERSION) {
            this.refuse(socket, 'protocol', `host speaks protocol ${NODE_PROTOCOL_VERSION}`)
            return
          }
          if (this.socket && this.socket !== socket && this.socket.readyState === socket.OPEN) {
            this.refuse(socket, 'busy', `node ${frame.nodeId} already has an active connection`)
            return
          }
          this.generation += 1
          this.descriptor = {
            nodeId: frame.nodeId,
            agentVersion: frame.agentVersion,
            platform: frame.platform,
            arch: frame.arch,
            capabilities: frame.capabilities,
            cwd: this.cwd,
            generation: this.generation,
          }
          this.socket = socket
          registered = true
          this.startHeartbeat(socket)
          // Announced here as well as in the agent's own log, because this is
          // the host side of the answer to "which machine is my execution
          // world?" — and the agent's log lives on a machine the operator may
          // not be looking at.
          //
          // Written to stderr rather than `ctx.logger`: that service is a ring
          // buffer with no console sink in the shipped profiles, so an
          // `info()` there is captured for inspection and printed nowhere —
          // it reads as logging while being invisible in a terminal or a
          // service journal. stderr is where this process's own diagnostics
          // already go.
          this.note(
            `dsh-node: ${frame.nodeId} registered (generation ${this.generation}, `
            + `${frame.platform}/${frame.arch}, ${frame.capabilities.length} operations, cwd ${this.cwd})`,
          )
          socket.send(encodeControl({
            type: 'ready',
            generation: this.generation,
            cwd: this.cwd,
            home: this.cwd,
          }))
          return
        }

        case 'pong':
          this.awaitingPong = false
          return

        case 'op.end': {
          const plumbing = this.streams.get(frame.streamId)
          if (plumbing) {
            // A stream whose payload outlives its reply stays registered: the
            // result is published, but the iterator keeps yielding until the
            // producer sends `op.payloadEnd`. Anything else settles wholly here.
            if (!frame.payloadContinues) this.streams.delete(frame.streamId)
            plumbing.resolve(frame.result)
            if (frame.payloadContinues) plumbing.holdPayload()
          }
          return
        }

        case 'op.payloadEnd': {
          // Ends the reader without touching the result: a terminal's output is
          // over, but the operation that opened it already succeeded.
          const plumbing = this.streams.get(frame.streamId)
          if (plumbing) {
            this.streams.delete(frame.streamId)
            plumbing.endPayload()
          }
          return
        }

        case 'op.error': {
          const plumbing = this.streams.get(frame.streamId)
          if (plumbing) {
            this.streams.delete(frame.streamId)
            plumbing.reject(new NodeError(frame.code, frame.message))
          }
          return
        }

        default:
          // A host-only frame arriving from an agent means a confused peer.
          socket.close(1002, `unexpected frame ${(frame as { type: string }).type}`)
      }
    })

    const gone = () => {
      if (this.socket !== socket) return
      this.forget(registered)
    }
    socket.on('close', gone)
    socket.on('error', gone)
  }

  /** @internal Send a refusal, then close. */
  private refuse(socket: WebSocket, code: NodeRefusalCode, message: string): void {
    // A refusal is invisible from the node's side once it reconnects and starts
    // retrying, so the reason is recorded here — this is the host that decided.
    this.note(`dsh-node: refused a connection [${code}]: ${message}`)
    socket.send(encodeControl({ type: 'refused', code, message }))
    socket.close(1008, code)
  }

  /**
   * @internal Probe liveness on the configured cadence.
   *
   * A peer that has not answered the previous ping by the next interval is
   * terminated. The interval is therefore both the cadence and the deadline —
   * a deployment whose event loop or network can stall longer than this must
   * raise `heartbeatIntervalMs` rather than expect a longer grace period.
   */
  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.awaitingPong = false
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== socket.OPEN) return
      if (this.awaitingPong) {
        socket.terminate()
        return
      }
      this.awaitingPong = true
      socket.send(encodeControl({ type: 'ping' }))
    }, this.heartbeatIntervalMs)
    // Never hold the process open for a liveness probe.
    this.heartbeat.unref?.()
  }

  /** @internal */
  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.awaitingPong = false
  }

  /**
   * @internal Drop the current node and fail every in-flight stream.
   *
   * Failing rather than dropping is the point: a caller waiting on a stream
   * must learn the world went away, not hang.
   */
  private forget(registered: boolean): void {
    const generation = this.generation
    const nodeId = this.descriptor?.nodeId
    this.socket = undefined
    this.descriptor = undefined
    this.stopHeartbeat()
    for (const [, plumbing] of this.streams) {
      plumbing.reject(new NodeError(
        'disconnected',
        `node disconnected (generation ${generation})`,
      ))
    }
    const failed = this.streams.size
    this.streams.clear()
    if (registered) {
      // Logged with the count of streams this drop failed, because that number
      // is the difference between "a node went away quietly" and "work was in
      // flight and just got rejected" — and the execution world is now EMPTY,
      // which every later operation will report as `node is not connected`.
      this.note(
        `dsh-node: ${nodeId ?? 'node'} disconnected (generation ${generation}, `
        + `${failed} stream${failed === 1 ? '' : 's'} failed; execution world is now empty)`,
      )
      this.ctx.emit('node/disconnected', generation, this.onDisconnect)
    }
  }
}

/**
 * One logical stream's queue and terminal settlement.
 *
 * Kept as an object rather than a captured closure so a disconnect can settle
 * it from outside the iterator, which is what makes a dropped node reject its
 * callers instead of leaving them suspended.
 *
 * The promise and its settle functions are wired in the constructor on purpose:
 * as class fields, a bare declaration would run its `undefined` initializer
 * after the promise executor and clobber the captured callbacks.
 */
class StreamPlumbing {
  readonly result: Promise<unknown>

  private readonly queue: { kind: PayloadKind; bytes: Uint8Array }[] = []
  private notify: (() => void) | undefined
  private settled = false
  /** The result arrived, but payload frames are still expected. */
  private pendingPayload = false
  /** The producer signalled that no more payload will arrive. */
  private payloadEnded = false
  private failure: NodeError | undefined
  private readonly settleResolve: (value: unknown) => void
  private readonly settleReject: (error: NodeError) => void

  constructor() {
    let resolve!: (value: unknown) => void
    let reject!: (error: NodeError) => void
    this.result = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
    this.settleResolve = resolve
    this.settleReject = reject
    // A stream whose payload frames a caller consumes may never have its
    // `result` awaited; mark it handled so a mid-stream failure surfaces to the
    // caller through the iterator rather than as an unhandled rejection.
    void this.result.catch(() => {})
  }

  push(bytes: Uint8Array, kind: PayloadKind = 'opaque'): void {
    this.queue.push({ kind, bytes })
    this.wake()
  }

  /**
   * Mark that the result is published while payload frames keep coming.
   *
   * Set when an `op.end` arrived with `payloadContinues`: the stream stays
   * registered so later frames still route here, and its iterators must not end
   * merely because the result settled.
   */
  holdPayload(): void {
    this.pendingPayload = true
    this.wake()
  }

  /** End the payload without a second result; the producer is finished. */
  endPayload(): void {
    this.pendingPayload = false
    this.payloadEnded = true
    this.wake()
  }

  resolve(value: unknown): void {
    if (this.settled) return
    this.settled = true
    this.settleResolve(value)
    this.wake()
  }

  reject(error: NodeError): void {
    if (this.settled) return
    this.settled = true
    this.failure = error
    this.settleReject(error)
    this.wake()
  }

  /**
   * The shared cursor over queued frames.
   *
   * Both public iterators read this one queue, so whichever a caller picks
   * advances the single stream. A caller that read both would see each frame
   * once, split arbitrarily between them — which is why the seam documents
   * choosing one.
   */
  private cursor<Out>(project: (frame: { kind: PayloadKind; bytes: Uint8Array }) => Out): AsyncIterable<Out> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Out>> => {
          for (;;) {
            const frame = this.queue.shift()
            if (frame) return { done: false, value: project(frame) }
            if (this.failure) throw this.failure
            // A settled result normally ends the stream — unless the producer
            // said its payload outlives the reply, in which case the iterator
            // waits for the explicit end rather than closing on the result.
            if (this.settled && (!this.pendingPayload || this.payloadEnded)) {
              return { done: true, value: undefined as never }
            }
            await new Promise<void>((resolve) => { this.notify = resolve })
          }
        },
      }),
    }
  }

  chunks(): AsyncIterable<Uint8Array> {
    return this.cursor((frame) => frame.bytes)
  }

  tagged(): AsyncIterable<{ kind: PayloadKind; bytes: Uint8Array }> {
    return this.cursor((frame) => frame)
  }

  private wake(): void {
    const pending = this.notify
    this.notify = undefined
    pending?.()
  }
}

export default NodeRegistry

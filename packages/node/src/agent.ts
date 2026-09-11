/**
 * The node agent: the process that runs on the remote machine and makes it an
 * execution world.
 *
 * It dials OUT to the harness host, so the remote machine needs no inbound
 * port, no public address, and no NAT traversal. Once registered it answers
 * operation requests by running them locally.
 *
 * Two properties this process owns, both of which the host cannot enforce for
 * it:
 *
 * 1. **It outlives a dropped channel.** A network blip must not kill a running
 *    build, so the process keeps running and the host never reattaches to a
 *    previous generation's handles. Processes it still owns after a drop are
 *    reported as orphaned rather than pretended alive.
 * 2. **It enforces its own sandbox.** Confinement is same-world only; a remote
 *    node replaces the capability rather than registering into `ctx.sandbox`.
 *    What this agent enforces is what the deployment gets.
 * @module @shaowenchen/dsh-node-agent
 */

import { hostname, platform, arch, homedir } from 'node:os'
import { WebSocket } from 'ws'
import {
  NODE_PROTOCOL_VERSION,
  PAYLOAD_KIND,
  decodeControl,
  encodeControl,
  encodePayload,
  isHostFrame,
  type HostFrame,
  type NodeErrorCode,
  type NodeOperation,
  type PayloadKind,
} from './protocol.ts'
import {
  NodeOpError,
  containsPath,
  editText,
  listDir,
  lstatPath,
  readBytes,
  readText,
  resolveTarget,
  statTarget,
  writeText,
} from './fs-ops.ts'
import {
  OutputCollector,
  privateSpillDir,
  resolveExecutable,
  spawnProcess,
  type ProcHandle,
} from './proc-ops.ts'
import { openTerminal, ptyAvailable, type TtyHandle } from './tty-ops.ts'

/** Options for one agent connection. */
export interface AgentOptions {
  /** `ws://` or `wss://` URL of the harness host's node channel. */
  url: string
  /** Node identity registered with the host. Defaults to the machine hostname. */
  nodeId?: string
  /** Long-lived credential obtained from `dsh node enroll`. */
  credential: string
  /** Absolute working directory of the execution world. */
  cwd: string
  /** Agent build version reported in `hello`. */
  agentVersion?: string
  /** Reconnect backoff floor in milliseconds. @default 500 */
  reconnectMinMs?: number
  /** Reconnect backoff ceiling in milliseconds. @default 10000 */
  reconnectMaxMs?: number
  /**
   * What to do with locally owned processes when the channel drops.
   * `orphan` leaves them running; `terminate` reaps them.
   * @default 'orphan'
   */
  onDisconnect?: 'orphan' | 'terminate'
  /** Observation sink; the CLI wires this to stderr. */
  log?: (message: string) => void
}

/**
 * The operations this agent build implements, advertised at registration.
 *
 * Kept beside `execute` on purpose: a capability list maintained separately
 * from the switch that fulfils it drifts, and a drifted list is worse than no
 * list — the host would promise the model work the node cannot do.
 *
 * `tty.*` is conditional on a usable PTY substrate. This agent is deployed to
 * machines that are not all alike: some have the native `node-pty` build and
 * some do not. Advertising terminals that cannot be opened would turn a clean
 * `unsupported` refusal into a failed call the model has to interpret, so the
 * list tells the truth about THIS machine.
 */
function implementedOperations(): string[] {
  const operations = [
    'fs.resolve',
    'fs.stat',
    'fs.lstat',
    'fs.readText',
    'fs.streamText',
    'fs.readBytes',
    'fs.writeText',
    'fs.editText',
    'fs.list',
    'fs.contains',
    'fs.paths',
    'proc.resolve',
    'proc.spawn',
    'proc.read',
    'proc.signal',
    'proc.wait',
  ]
  if (ptyAvailable()) {
    operations.push('tty.open', 'tty.write', 'tty.resize', 'tty.signal', 'tty.inspect', 'tty.wait', 'tty.close')
  }
  return operations
}

/**
 * One operation's outcome: a JSON result, plus the payload channel its
 * continuous output travels on when the operation opened one.
 *
 * A `proc.spawn` or `tty.open` returns the channel name rather than a callback
 * because the agent, not this function, owns the socket: the operation decides
 * WHAT to stream, and the connection decides where to put it.
 */
interface OpOutcome {
  result: unknown
  /** Payload channel this stream's bytes travel on, for its whole lifetime. */
  payloadKind?: PayloadKind
}

/**
 * The process and terminal handles this agent currently owns, keyed by the
 * stream that opened them.
 *
 * Held so a later `proc.read` / `proc.signal` / `tty.write` can find the handle
 * by the pid the host names, and so a disconnect can decide what to reap.
 */
interface LiveHandles {
  procs: Map<number, ProcHandle>
  ttys: Map<number, TtyHandle>
}

/**
 * Implements operations against the local machine, and owns the processes and
 * terminals they start.
 *
 * `fs.*` runs over `node:fs/promises` with the semantics of dsh's own local
 * backend: targets carry a realpath-derived identity, mutations are atomic, and
 * guards are checked here rather than by the host so the read→check→write
 * window cannot be interleaved.
 *
 * The live-handle tables are the reason this is a class. A process outlives the
 * stream that opened it — the host reads its output, signals it, and waits for
 * it on later streams — so the handle cannot be scoped to one call. Holding them
 * here also gives the agent one place to ask "what am I still running?", which
 * is what a disconnect policy needs.
 */
class World implements LiveHandles {
  readonly procs = new Map<number, ProcHandle>()
  readonly ttys = new Map<number, TtyHandle>()

  /**
   * Which stream carries each live terminal's output.
   *
   * Terminal output is genuinely push-shaped — the seam exposes it as a
   * `Readable` — so the agent forwards each chunk as it arrives, long after the
   * `tty.open` stream itself has ended. The frames carry a stream id the
   * terminal does not know about, so `tty.open` records it HERE, synchronously,
   * before any output can arrive: a shell prints its prompt immediately, and a
   * mapping installed after the spawn returns would drop it.
   */
  readonly ttyStreams = new Map<number, number>()

  /**
   * The process each stdin-bearing stream writes to.
   *
   * A `proc.spawn` with `stdin: 'pipe'` exposes the child's stdin as a
   * `Writable` on the host; writes travel back as payload frames on the `stdin`
   * channel, and only the stream that opened the process can address it.
   */
  readonly stdinStreams = new Map<number, number>()

  /**
   * Which stream carries each live pipe-mode output channel.
   *
   * A `pipe`-mode stdout/stderr is handed to the caller as a raw `Readable`, so
   * those bytes are forwarded as they arrive — keyed by `pid:kind` because one
   * process can have both streams piped and they travel on the same host stream.
   */
  readonly pipeStreams = new Map<string, number>()

  private readonly spillDir = privateSpillDir()

  /**
   * Called when a stream's payload producer finishes.
   *
   * Set by the connection, which owns the socket the frame must go out on. A
   * terminal's output outlives its opening reply, so the host only learns the
   * output is over from this signal — without it a reader would wait forever on
   * a terminal that has already exited.
   */
  onPayloadEnd: ((streamId: number) => void) | undefined

  /**
   * Run one operation.
   *
   * `streamId` is the host stream that opened it, recorded by the operations
   * whose output outlives their reply.
   * @param op - the operation name.
   * @param args - operation arguments from the host.
   * @param cwd - the execution world's working directory.
   * @param streamId - the host stream this operation opened.
   * @param emit - delivers a payload chunk, tagged with the pid that produced it.
   * @returns the operation's result and, when it streams, its payload channel.
   */
  async execute(
    op: NodeOperation,
    args: unknown,
    cwd: string,
    streamId: number,
    emit: (sourcePid: number, kind: PayloadKind, bytes: Uint8Array) => void,
  ): Promise<OpOutcome> {
    const a = (args ?? {}) as Record<string, never>
    // Every fs.* operation addresses a target the host already resolved, so the
    // display path travels with it rather than being re-derived here: the host
    // chose it, and error messages must name the path the caller knows.
    const targetKey = a['targetKey'] as never
    const displayPath = (a['displayPath'] as never) ?? targetKey

    switch (op) {
      case 'fs.resolve':
        return { result: await resolveTarget(cwd, a['path'] as never) }

      case 'fs.stat':
        // Absence is `undefined`, not a failure: a caller legitimately probes
        // for a target that is not there yet.
        return { result: await statTarget(targetKey as never) }

      case 'fs.lstat':
        return { result: await lstatPath(a['path'] as never, cwd) }

      case 'fs.readText':
      case 'fs.streamText':
        // Streaming is a payload-frame concern; this build returns the whole
        // text and the adapter chunks it. Correctness first, framing later.
        return { result: await readText(targetKey as never, displayPath as never) }

      case 'fs.readBytes':
        return { result: await readBytes(targetKey as never, displayPath as never, Number(a['maxBytes'])) }

      case 'fs.list':
        return { result: await listDir(targetKey as never, displayPath as never) }

      case 'fs.writeText':
        return {
          result: await writeText(
            targetKey as never,
            displayPath as never,
            a['content'] as never,
            a['expected'] as never,
          ),
        }

      case 'fs.editText':
        return {
          result: await editText(
            targetKey as never,
            displayPath as never,
            a['edit'] as never,
            a['expected'] as never,
          ),
        }

      case 'fs.contains':
        return { result: containsPath(a['parentKey'] as never, a['childKey'] as never) }

      case 'fs.paths':
        // The facts only the node can answer: the absolute path a subprocess
        // can open, and the canonical file: URL. Both are derived from the
        // target key, which IS an absolute path in this world.
        return {
          result: {
            processPath: String(targetKey),
            fileUrl: new URL(`file://${String(targetKey)}`).href,
          },
        }

      // ── processes ──
      case 'proc.resolve':
        return { result: await resolveExecutable(a['command'] as never, a['env'] as never) }

      case 'proc.spawn': {
        const handle = spawnProcess(
          a as never,
          this.spillDir,
          // A `pipe`-mode stream is forwarded live — the seam hands those to the
          // caller as a raw `Readable`. Collect-mode bytes are NOT forwarded:
          // they stay in the node's window for offset-addressed `proc.read`.
          (which, bytes) => {
            const kind: PayloadKind = which === 'stdout' ? 'stdout' : 'stderr'
            emit(handle.pid, kind, bytes)
          },
        )
        this.procs.set(handle.pid, handle)
        if (handle.stdin !== undefined) this.stdinStreams.set(streamId, handle.pid)
        // The stream ids a pipe-mode channel travels on, so the sink knows where
        // to put the frames it forwards.
        const piped: PayloadKind[] = []
        if (a['stdio'] !== undefined) {
          const stdio = a['stdio'] as unknown as { stdout: unknown; stderr: unknown }
          if (stdio.stdout === 'pipe') piped.push('stdout')
          if (stdio.stderr === 'pipe') piped.push('stderr')
        }
        for (const kind of piped) this.pipeStreams.set(`${handle.pid}:${kind}`, streamId)
        // A pipe-mode stream also ends when the process exits, so the reader
        // terminates on the real event rather than on the outcome.
        if (piped.length > 0) {
          void handle.done.then(() => {
            for (const kind of piped) {
              const stream = this.pipeStreams.get(`${handle.pid}:${kind}`)
              if (stream === undefined) continue
              this.pipeStreams.delete(`${handle.pid}:${kind}`)
              this.onPayloadEnd?.(stream)
            }
          })
        }
        return {
          result: {
            pid: handle.pid,
            // Reported rather than assumed: this is what the node is ACTUALLY
            // collecting, which is the fact the adapter needs before it builds
            // readers. `piped` and the stdin flag are deliberately absent — the
            // host derives both from the spec it sent, and echoing them back
            // would be a second source of truth for the same thing.
            collected: {
              stdout: handle.collected.stdout !== undefined,
              stderr: handle.collected.stderr !== undefined,
            },
          },
          payloadKind: piped.length > 0 ? piped[0] : undefined,
        }
      }

      case 'proc.read': {
        const handle = this.procs.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown process ${String(a['pid'])}`)
        const which = a['stream'] === 'stderr' ? handle.collected.stderr : handle.collected.stdout
        if (!which) {
          throw new NodeOpError('policy', `stream ${String(a['stream'])} is not being collected`)
        }
        return { result: which.readFrom(Number(a['fromByte'] ?? 0)) }
      }

      case 'proc.signal': {
        const handle = this.procs.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown process ${String(a['pid'])}`)
        // Signalled via the handle, never a bare `process.kill(pid)`: the tree
        // is what a caller means, and signalling only the root leaves helpers
        // behind — the exact failure this whole module exists to prevent.
        handle.signal(a['signal'] as never)
        return { result: null }
      }

      case 'proc.wait': {
        const handle = this.procs.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown process ${String(a['pid'])}`)
        const outcome = await handle.done
        // Deliberately NOT deleted here. Collected output stays readable after
        // exit — that is the seam's contract, and the batch shape is "wait,
        // then read everything" — so the handle is released only when the
        // collector is dropped or the world is reaped.
        return { result: outcome }
      }

      // ── terminals ──
      case 'tty.open': {
        const handle = openTerminal(a as never)
        this.ttys.set(handle.pid, handle)
        // The stream id is recorded BEFORE the spawn's reply is sent and before
        // any listener is attached: a shell prints its prompt immediately, so a
        // mapping installed any later would drop the first output the user sees.
        this.ttyStreams.set(handle.pid, streamId)
        // A terminal's output is genuinely push-shaped — the seam exposes a
        // `Readable` — so each chunk is forwarded as it arrives, tagged with the
        // pid whose stream carries it.
        handle.onData((bytes) => emit(handle.pid, 'opaque', bytes))
        // ...and the reader is told when the output is over. A terminal that
        // exits ends its stream; without this the host would hold the reader
        // open forever on a terminal that is already gone.
        void handle.done.then(() => {
          this.ttyStreams.delete(handle.pid)
          this.onPayloadEnd?.(streamId)
        })
        return {
          payloadKind: 'opaque',
          result: { pid: handle.pid },
        }
      }

      case 'tty.write': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        handle.write(String(a['data']))
        return { result: null }
      }

      case 'tty.resize': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        handle.resize(Number(a['rows']), Number(a['cols']))
        return { result: null }
      }

      case 'tty.signal': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        return { result: handle.signalForeground(String(a['signal'])) }
      }

      case 'tty.inspect': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        // The substrate this agent targets cannot prove whether the foreground
        // group is waiting on input, so the honest answer is `false` with the
        // group that will receive a signal — not a guess dressed as a fact.
        return { result: { processGroupId: handle.pid, inputWaiting: false } }
      }

      case 'tty.wait': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        // Kept for the same reason as `proc.wait`: a terminal that has exited
        // is still addressable (its output stream ends, its outcome is
        // readable), and `tty.close` is the verb that releases it.
        return { result: await handle.done }
      }

      case 'tty.close': {
        const handle = this.ttys.get(Number(a['pid']))
        if (!handle) throw new NodeOpError('not-found', `unknown terminal ${String(a['pid'])}`)
        this.ttys.delete(handle.pid)
        await handle.terminate()
        return { result: null }
      }

      default:
        throw new NodeOpError('unsupported', `agent does not implement ${op} yet`)
    }
  }

  /**
   * Write bytes to one live process's stdin.
   * @param pid - the process to write to.
   * @param bytes - the bytes to deliver.
   */
  writeStdin(pid: number, bytes: Uint8Array): void {
    this.procs.get(pid)?.stdin?.write(Buffer.from(bytes))
  }

  /** Reap every process and terminal this world still owns. */
  async reapAll(): Promise<void> {
    for (const handle of this.procs.values()) handle.terminate()
    for (const handle of this.ttys.values()) await handle.terminate()
    this.procs.clear()
    this.ttys.clear()
  }
}

/**
 * One agent connection, reconnecting until {@link NodeAgent.stop}.
 */
export class NodeAgent {
  private readonly opts: Required<Omit<AgentOptions, 'log'>> & Pick<AgentOptions, 'log'>
  private socket: WebSocket | undefined
  private stopping = false
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  /**
   * The processes and terminals this agent owns.
   *
   * Deliberately NOT rebuilt per connection: a process outlives the channel
   * that started it, which is what lets a reconnect find a still-running build
   * instead of reporting it gone. Replacing this on reconnect would make every
   * process invisible to the host that just came back.
   */
  private readonly world = new World()

  constructor(options: AgentOptions) {
    this.world.onPayloadEnd = (streamId) => {
      // Resolved against the live socket at fire time, never captured: a
      // terminal that outlived a reconnect must not write into the dead one.
      const socket = this.socket
      if (!socket || socket.readyState !== socket.OPEN) return
      socket.send(encodeControl({ type: 'op.payloadEnd', streamId }))
    }
    this.opts = {
      nodeId: options.nodeId ?? hostname(),
      agentVersion: options.agentVersion ?? '0.1.0',
      reconnectMinMs: options.reconnectMinMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 10_000,
      onDisconnect: options.onDisconnect ?? 'orphan',
      url: options.url,
      credential: options.credential,
      cwd: options.cwd,
      log: options.log,
    }
  }

  /** Connect, and keep reconnecting until {@link stop}. */
  start(): void {
    this.stopping = false
    this.connect()
  }

  /** Stop reconnecting and close the current socket. */
  stop(): void {
    this.stopping = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.socket?.close(1000, 'agent stopping')
    this.socket = undefined
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  private connect(): void {
    if (this.stopping) return
    const socket = new WebSocket(this.opts.url)
    this.socket = socket

    socket.on('open', () => {
      socket.send(encodeControl({
        type: 'hello',
        protocolVersion: NODE_PROTOCOL_VERSION,
        nodeId: this.opts.nodeId,
        credential: this.opts.credential,
        agentVersion: this.opts.agentVersion,
        platform: platform(),
        arch: arch(),
        // Advertise exactly what this machine can do. A host that trusts this
        // list refuses the rest early; overstating it would turn a clean
        // refusal into a failed call the model has to interpret.
        capabilities: implementedOperations(),
      }))
    })

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        this.onPayload(data)
        return
      }
      const frame = decodeControl(data.toString())
      if (!frame || !isHostFrame(frame)) {
        // An agent-direction frame arriving here means a confused peer.
        socket.close(1002, 'malformed frame')
        return
      }
      void this.handle(socket, frame)
    })

    const dropped = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      // A terminal's output has nowhere to go once the channel is gone, so its
      // forwarding is stopped here. The terminals themselves are governed by
      // `onDisconnect`, exactly like ordinary processes: a dropped channel is
      // not a reason to kill the user's shell.
      this.world.ttyStreams.clear()
      this.world.stdinStreams.clear()
      this.world.pipeStreams.clear()
      if (this.opts.onDisconnect === 'terminate') void this.world.reapAll()
      this.scheduleReconnect()
    }
    socket.on('close', dropped)
    socket.on('error', dropped)
  }

  /**
   * Deliver one binary payload frame to the producer waiting for it.
   *
   * Only terminals are push-shaped in this protocol; a frame on any other
   * channel has no registered producer and is dropped rather than guessed at.
   * @param data - the raw binary message.
   */
  private onPayload(data: Buffer | ArrayBuffer | Buffer[]): void {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (bytes.length < 5) return
    const kind = bytes.readUInt8(4)
    const payload = bytes.subarray(5)
    if (kind === PAYLOAD_KIND.stdin) {
      // `proc.spawn` with `stdin: 'pipe'` exposes a Writable, so writes arrive
      // as payload frames on this channel and are matched to the process by the
      // stream that owns it.
      const streamId = bytes.readUInt32BE(0)
      const pid = this.world.stdinStreams.get(streamId)
      if (pid !== undefined) this.world.writeStdin(pid, payload)
    }
  }

  private async handle(socket: WebSocket, frame: HostFrame): Promise<void> {
    switch (frame.type) {
      case 'ping':
        socket.send(encodeControl({ type: 'pong' }))
        return

      case 'ready':
        this.attempt = 0
        this.log(`registered as ${this.opts.nodeId} (generation ${frame.generation}, cwd ${frame.cwd})`)
        return

      case 'refused':
        // A refusal is terminal for this credential: reconnecting would only
        // repeat it. Surface it and stop rather than hammering the host.
        this.log(`registration refused [${frame.code}]: ${frame.message}`)
        this.stop()
        return

      case 'op.open': {
        try {
          const outcome = await this.world.execute(
            frame.op,
            frame.args,
            this.opts.cwd,
            frame.streamId,
            // Terminal output is pushed for the whole life of the terminal, so
            // the sink resolves the live socket per chunk rather than capturing
            // it: a reconnect must never write frames into a dead socket.
            (sourcePid, kind, bytes) => {
              // A terminal is keyed by pid alone; a piped process stream is keyed
              // by pid AND channel, because one process can pipe both.
              const key = `${sourcePid}:${kind}`
              const streamId = this.world.pipeStreams.get(key) ?? this.world.ttyStreams.get(sourcePid)
              if (streamId === undefined) return
              this.sendPayload(streamId, kind, bytes)
            },
          )
          socket.send(encodeControl({
            type: 'op.end',
            streamId: frame.streamId,
            result: outcome.result,
            // A terminal's reply opens a stream that outlives it: output keeps
            // arriving until the terminal exits, so the host's reader must stay
            // open and be ended by `op.payloadEnd` rather than by this frame.
            ...outcome.payloadKind !== undefined ? { payloadContinues: true } : {},
          }))
        } catch (error) {
          const code = (error as { nodeErrorCode?: NodeErrorCode }).nodeErrorCode ?? 'internal'
          const message = error instanceof Error ? error.message : String(error)
          socket.send(encodeControl({ type: 'op.error', streamId: frame.streamId, code, message }))
        }
        return
      }

      case 'op.cancel':
        // Cancellation stops a stream from being written to, but deliberately
        // does NOT kill what it was reading: the seam's contract is that a
        // caller abandoning a read does not terminate the process it was
        // watching. Teardown is `proc.signal` / `tty.close`, explicitly.
        for (const [pid, streamId] of this.world.ttyStreams) {
          if (streamId === frame.streamId) this.world.ttyStreams.delete(pid)
        }
        this.world.stdinStreams.delete(frame.streamId)
        return
    }
  }

  /** @internal Send one payload frame on the live socket, if there is one. */
  private sendPayload(streamId: number, kind: PayloadKind, bytes: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) return
    socket.send(encodePayload(streamId, kind, bytes), { binary: true })
  }

  private scheduleReconnect(): void {
    if (this.stopping) return
    const ceiling = Math.min(
      this.opts.reconnectMaxMs,
      this.opts.reconnectMinMs * 2 ** this.attempt,
    )
    // Jitter across the full window so a fleet of agents that lost one host
    // does not return in lockstep.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2)
    this.attempt += 1
    this.log(`disconnected; reconnecting in ${Math.round(delay)}ms`)
    this.retry = setTimeout(() => { this.connect() }, delay)
    this.retry.unref?.()
  }
}

/** Facts the agent reports at registration. */
export interface AgentIdentity {
  nodeId: string
  platform: string
  arch: string
  home: string
  protocolVersion: number
}

/**
 * Describe this machine without connecting, for `dsh-node join` to print.
 * @returns local facts the host will see at registration.
 */
export function describeAgent(): AgentIdentity {
  return {
    nodeId: hostname(),
    platform: platform(),
    arch: arch(),
    home: homedir(),
    protocolVersion: NODE_PROTOCOL_VERSION,
  }
}

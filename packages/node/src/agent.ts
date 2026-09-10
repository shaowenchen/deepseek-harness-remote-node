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
  decodeControl,
  encodeControl,
  isHostFrame,
  type HostFrame,
  type NodeErrorCode,
  type NodeOperation,
} from './protocol.ts'
import {
  NodeOpError,
  copyPath,
  listDirectory,
  readTextFile,
  removePath,
  resolvePath,
  statPath,
  writeTextFile,
} from './fs-ops.ts'

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
 */
const IMPLEMENTED_OPERATIONS: string[] = [
  'fs.resolve',
  'fs.stat',
  'fs.lstat',
  'fs.readText',
  'fs.streamText',
  'fs.list',
  'fs.writeText',
  'fs.copy',
  'fs.remove',
]

/**
 * Implements one operation against the local machine.
 *
 * `fs.*` is implemented over `node:fs/promises`. `proc.*` and `tty.*` still
 * answer `unsupported`, honestly: a host that trusts the advertised
 * capabilities will refuse those early rather than hang on them.
 * @param op - the requested operation.
 * @param args - operation arguments from the host.
 * @param cwd - the execution world's working directory.
 * @returns the operation result.
 */
async function execute(
  op: NodeOperation,
  args: unknown,
  cwd: string,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, never>

  switch (op) {
    case 'fs.resolve':
      return await resolvePath(a['path'] as never, cwd)
    case 'fs.stat':
      return await statPath(a['path'] as never, true)
    case 'fs.lstat':
      return await statPath(a['path'] as never, false)
    case 'fs.readText':
    case 'fs.streamText':
      // Streaming is a payload-frame concern; P1 returns the whole text and
      // the adapter chunks it. Correctness first, framing later.
      return await readTextFile(a['path'] as never)
    case 'fs.list':
      return await listDirectory(a['path'] as never)
    case 'fs.writeText':
      return await writeTextFile(a['path'] as never, a['content'] as never)
    case 'fs.copy':
      return await copyPath(a['from'] as never, a['to'] as never)
    case 'fs.remove':
      return await removePath(a['path'] as never, Boolean(a['recursive']))
    default:
      throw new NodeOpError('unsupported', `agent does not implement ${op} yet`)
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

  constructor(options: AgentOptions) {
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
        // Advertise exactly what `execute` implements. A host that trusts this
        // list refuses the rest early; overstating it would turn a clean
        // refusal into a failed call the model has to interpret.
        capabilities: IMPLEMENTED_OPERATIONS,
      }))
    })

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return // agent sends no payload frames in P0
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
      this.scheduleReconnect()
    }
    socket.on('close', dropped)
    socket.on('error', dropped)
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
          const result = await execute(frame.op, frame.args, this.opts.cwd)
          socket.send(encodeControl({ type: 'op.end', streamId: frame.streamId, result }))
        } catch (error) {
          const code = (error as { nodeErrorCode?: NodeErrorCode }).nodeErrorCode ?? 'internal'
          const message = error instanceof Error ? error.message : String(error)
          socket.send(encodeControl({ type: 'op.error', streamId: frame.streamId, code, message }))
        }
        return
      }

      case 'op.cancel':
        // P0 has no cancellable work. P1 onward routes this to the in-flight op.
        return
    }
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

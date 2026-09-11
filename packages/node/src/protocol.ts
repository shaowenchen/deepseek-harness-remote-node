/**
 * The `/node/v1` wire protocol shared by the harness host (registry owner) and
 * the node agent running on a remote machine.
 *
 * One WebSocket carries every logical stream, multiplexed by `streamId`.
 * Control frames are JSON text; payload frames are binary. The split is
 * deliberate: path and file bytes travel on the binary side so a remote path
 * never passes through a text channel where an encoding could reinterpret it.
 *
 * The frame vocabulary intentionally mirrors the shape the browser Remote mux
 * already uses (open / data / end / error / cancel, one `ready` opening item,
 * a generation number), so a reader who knows that transport recognizes this
 * one instead of learning a second set of rules.
 * @module @shaowenchen/deepseek-harness-remote-node/protocol
 */

/** Protocol version. A mismatch is refused rather than negotiated. */
export const NODE_PROTOCOL_VERSION = 1

/** The upgrade path the owner registers and the agent dials. */
export const NODE_CHANNEL_PATH = '/node/v1'

/** Ping cadence in milliseconds before deployment override. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000

/**
 * How long a refused-but-retryable agent waits before dialling again, in
 * milliseconds.
 *
 * A `busy` refusal means another connection holds the single slot and has not
 * been reaped yet, not that this one is unwelcome. The host frees that slot on
 * two events, and the agent cannot see either: a clean close (immediate), or
 * the heartbeat giving up on an unresponsive peer — one interval to send the
 * ping, another to terminate when no `pong` comes back, so up to
 * `2 × heartbeatIntervalMs`. Retrying sooner than that guarantees a second
 * refusal, which is how a restart turns into a refusal loop.
 *
 * The default assumes the default cadence. A deployment that raises
 * `heartbeatIntervalMs` should raise this to match: it is the one number on the
 * agent side that has to stay in step with the host's.
 */
export const DEFAULT_BUSY_RETRY_MS = 5000

// ── frame types ─────────────────────────────────────────────────────────────

/** First frame the agent sends; carries identity and requests registration. */
export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  nodeId: string
  credential: string
  /** Agent build version, for diagnostics and refusal records. */
  agentVersion: string
  platform: string
  arch: string
  /** Operation families this agent implements, so a host can fail early. */
  capabilities: string[]
}

/** Opens a logical stream. */
export interface OpOpenFrame {
  type: 'op.open'
  streamId: number
  op: NodeOperation
  args: unknown
}

/** Cancels one logical stream. The peer answers with `op.error` code `cancelled`. */
export interface OpCancelFrame {
  type: 'op.cancel'
  streamId: number
}

/** Closes one logical stream successfully. */
export interface OpEndFrame {
  type: 'op.end'
  streamId: number
  result: unknown
  /**
   * Whether payload frames keep arriving after this reply.
   *
   * A `tty.open` reply is not the end of its stream: the terminal goes on
   * producing output for as long as it lives, so the host must keep its payload
   * iterator open and end it on {@link OpPayloadEndFrame} instead. A `false` or
   * absent flag means the reply settles the whole stream, which is the shape
   * every unary operation has.
   */
  payloadContinues?: boolean
}

/**
 * Ends a stream's payload without a result change.
 *
 * Sent when a long-lived payload producer finishes — a terminal exits — so the
 * host's reader terminates on the real event rather than on a timeout or a
 * disconnect.
 */
export interface OpPayloadEndFrame {
  type: 'op.payloadEnd'
  streamId: number
}

/** Fails one logical stream. */
export interface OpErrorFrame {
  type: 'op.error'
  streamId: number
  code: NodeErrorCode
  message: string
}

/** Liveness probe. The peer must answer before the next interval elapses. */
export interface PingFrame {
  type: 'ping'
}

/** Liveness answer. */
export interface PongFrame {
  type: 'pong'
}

// ── payload frames ──────────────────────────────────────────────────────────

/**
 * Which logical channel a binary payload frame belongs to.
 *
 * A stream carries at most one payload channel, but the channel is named
 * explicitly rather than inferred from the operation because the two process
 * families disagree about direction: a `proc.*` stdin frame travels host→node
 * while its stdout travels node→host, and a reader must be able to tell a
 * process's stderr from its stdout without consulting the operation that opened
 * the stream. `opaque` is the channel for payload a caller interprets itself.
 */
export const PAYLOAD_KIND = {
  opaque: 0,
  stdout: 1,
  stderr: 2,
  stdin: 3,
} as const

/** One payload channel name. */
export type PayloadKind = keyof typeof PAYLOAD_KIND

/**
 * The number assigned to an unknown kind, so a decoder can reject it rather
 * than silently treating a future channel as `opaque`.
 */
const KNOWN_KINDS: readonly number[] = Object.values(PAYLOAD_KIND)

/**
 * Build one binary payload frame: a 4-byte big-endian stream id, a 1-byte kind,
 * then the bytes.
 *
 * The stream id is fixed-width so a frame can be routed without parsing the
 * payload, and the kind is a separate byte rather than a prefix on the payload
 * so a payload is never reinterpreted to find its own channel.
 * @param streamId - the logical stream this payload belongs to.
 * @param kind - the payload channel.
 * @param bytes - the payload.
 * @returns the frame to send as one binary WebSocket message.
 */
export function encodePayload(streamId: number, kind: PayloadKind, bytes: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + bytes.length)
  frame.writeUInt32BE(streamId, 0)
  frame.writeUInt8(PAYLOAD_KIND[kind], 4)
  frame.set(bytes, 5)
  return frame
}

/**
 * Decode one binary payload frame.
 * @param frame - the received binary message.
 * @returns the stream id, channel, and payload; or undefined when the frame is
 *   too short or names a channel this protocol does not know.
 */
export function decodePayload(
  frame: Uint8Array,
): { streamId: number; kind: PayloadKind; bytes: Uint8Array } | undefined {
  if (frame.length < 5) return undefined
  const view = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  const kindCode = view.readUInt8(4)
  if (!KNOWN_KINDS.includes(kindCode)) return undefined
  const kind = (Object.keys(PAYLOAD_KIND) as PayloadKind[])
    .find((name) => PAYLOAD_KIND[name] === kindCode)!
  return { streamId: view.readUInt32BE(0), kind, bytes: view.subarray(5) }
}

/**
 * The single opening item of a node connection, sent by the host once the
 * agent is registered. Carries the generation and the execution-world facts
 * every adapter needs, exactly as the browser `$events` stream opens with its
 * own `ready`.
 */
export interface ReadyFrame {
  type: 'ready'
  /** Increments on every reconnection; stale adapter handles compare against it. */
  generation: number
  /** Absolute working directory of the execution world on the node. */
  cwd: string
  /** Node's home directory, for path display. */
  home: string
}

/** Registration refusal, sent instead of `ready`. The host then closes. */
export interface RefusedFrame {
  type: 'refused'
  code: NodeRefusalCode
  message: string
}

/** Frames the agent sends to the host. */
export type AgentFrame =
  | HelloFrame
  | OpEndFrame
  | OpErrorFrame
  | OpPayloadEndFrame
  | PongFrame

/** Frames the host sends to the agent. */
export type HostFrame =
  | ReadyFrame
  | RefusedFrame
  | OpOpenFrame
  | OpCancelFrame
  | PingFrame

/** Either direction. */
export type NodeFrame = AgentFrame | HostFrame

// ── operations ──────────────────────────────────────────────────────────────

/**
 * The operation vocabulary. v1 is deliberately narrow: exactly the methods the
 * two capability seams require, and nothing speculative.
 *
 * `fs.*` maps onto `ctx.fs`; `proc.*` and `tty.*` map onto `ctx.subprocess`.
 * There is no `node.*` control operation here — registration and liveness are
 * connection-level concerns, not streams.
 *
 * The `fs.*` set is shaped by `FileSystem` rather than by convenience: targets
 * are resolved separately from use, guards and edits are their own operations
 * so they can run in one critical section ON the node, and `readBytes` carries
 * its own cap so an unbounded file can never be buffered across the wire.
 */
export type NodeOperation =
  // ── filesystem (ctx.fs) ──
  | 'fs.resolve'
  | 'fs.stat'
  | 'fs.lstat'
  | 'fs.readText'
  | 'fs.streamText'
  | 'fs.readBytes'
  | 'fs.writeText'
  | 'fs.editText'
  | 'fs.list'
  | 'fs.contains'
  | 'fs.paths'
  // ── ordinary processes (ctx.subprocess.spawn) ──
  | 'proc.resolve'
  | 'proc.spawn'
  | 'proc.read'
  | 'proc.signal'
  | 'proc.wait'
  // ── terminals (ctx.subprocess.spawnTerminal) ──
  | 'tty.open'
  | 'tty.write'
  | 'tty.resize'
  | 'tty.signal'
  | 'tty.inspect'
  | 'tty.wait'
  | 'tty.close'

/** Operation family, so a host can fail early against `capabilities`. */
export function operationFamily(op: NodeOperation): 'fs' | 'proc' | 'tty' {
  if (op.startsWith('fs.')) return 'fs'
  if (op.startsWith('proc.')) return 'proc'
  return 'tty'
}

// ── failures ────────────────────────────────────────────────────────────────

/**
 * Failure codes. `disconnected` is the one that carries the safety property:
 * an adapter that cannot reach its execution world must surface this, never
 * quietly fall back to the host machine.
 */
export type NodeErrorCode =
  /** The node channel is absent or the generation changed under this call. */
  | 'disconnected'
  /** The agent does not implement this operation. */
  | 'unsupported'
  /** The operation was cancelled by its caller. */
  | 'cancelled'
  /** The node's own policy refused the operation (see the sandbox rules). */
  | 'policy'
  /** The requested path or process does not exist. */
  | 'not-found'
  /** The operation exceeded its deadline. */
  | 'timeout'
  /** The agent failed internally. */
  | 'internal'

/** Why a registration was refused. */
export type NodeRefusalCode =
  /** Protocol version this host does not speak. */
  | 'protocol'
  /** Unknown node id, or a credential that does not verify. */
  | 'auth'
  /**
   * Another connection for this node id is already active.
   *
   * The only refusal in this set that is not terminal: the condition is
   * temporal, and the connection that holds the slot may be a dead one the host
   * has merely not reaped yet. An agent that treats it as terminal strands the
   * node for as long as whatever supervises it takes to restart the process —
   * and if that supervisor is itself the thing creating the duplicate, forever.
   * See {@link DEFAULT_BUSY_RETRY_MS}.
   */
  | 'busy'

// ── process and terminal arguments ──────────────────────────────────────────

/**
 * One output stream's disposition, mirroring `SubprocessOutputMode`.
 *
 * `inherit` cannot cross a wire — the node's own stdout is not the host's — so
 * it is refused rather than silently reinterpreted as something else.
 */
export type NodeOutputMode =
  | 'pipe'
  | {
      /** In-memory cap in bytes; overflow keeps the TAIL. */
      maxBytes: number
      /** Whole-stream byte cap for a spill file, when one should be kept. */
      spillMaxBytes?: number
    }

/** Per-stream stdio dispositions, mirroring `SubprocessStdio`. */
export interface NodeStdio {
  stdin: 'ignore' | 'pipe' | { readonly data: string }
  stdout: NodeOutputMode
  stderr: NodeOutputMode
}

/** `proc.resolve` arguments. */
export interface ProcResolveArgs {
  command: string
  env?: Readonly<Record<string, string>>
}

/** `proc.spawn` arguments: a fully-specified request, no defaults applied. */
export interface ProcSpawnArgs {
  argv: readonly string[]
  cwd: string
  stdio: NodeStdio
  /** TERM→KILL escalation grace, in milliseconds. */
  graceMs: number
  env?: NodeJS.ProcessEnv
}

/**
 * `proc.spawn`'s result, delivered once the child is live.
 *
 * `done` is a separate stream from the output: the host needs the pid and the
 * stream ids before it can read anything, and waiting for exit to learn them
 * would make a streaming consumer impossible.
 */
export interface ProcSpawnResult {
  /** Process id of the tree root; -1 when the spawn itself failed. */
  pid: number
  /** Whether the agent is collecting on stdout / stderr, so the host knows to read. */
  collected: { stdout: boolean; stderr: boolean }
  /** Payload channel each collected stream is delivered on. */
  kinds: { stdout: PayloadKind; stderr: PayloadKind }
}

/** `proc.wait` and `tty.wait` result: the closed process's exit facts. */
export interface NodeProcessOutcome {
  exitCode: number | null
  signal: string | null
}

/** One incremental collected-output read, mirroring `SubprocessOutputRead`. */
export interface NodeOutputRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

/** `proc.signal` arguments. */
export interface ProcSignalArgs {
  pid: number
  signal: NodeJS.Signals
}

/** `tty.open` arguments, mirroring `SubprocessTerminalSpawnSpec`. */
export interface TtyOpenArgs {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string>
  rows: number
  cols: number
  graceMs: number
}

/** `tty.open`'s result. */
export interface TtyOpenResult {
  pid: number
  /** Payload channel terminal output arrives on. */
  kind: PayloadKind
}

/** `tty.resize` arguments. */
export interface TtyResizeArgs {
  pid: number
  rows: number
  cols: number
}

/** `tty.signal` arguments. */
export interface TtySignalArgs {
  pid: number
  signal: string
}

/** Foreground process-group facts, mirroring `SubprocessTerminalForeground`. */
export interface TtyForeground {
  processGroupId: number
  inputWaiting: boolean
}

// ── frames on the wire ──────────────────────────────────────────────────────

/**
 * Encode a control frame. Binary payloads never go through here.
 * @param frame - the control frame to encode.
 * @returns the JSON text sent as one text frame.
 */
export function encodeControl(frame: NodeFrame): string {
  return JSON.stringify(frame)
}

/**
 * Decode one text frame into a control frame, or `undefined` when the text is
 * not a well-formed frame of this protocol. Callers treat `undefined` as a
 * protocol fault and close the connection; a malformed peer is not something
 * this transport tries to recover from.
 *
 * The result is the full union: direction is checked separately with
 * {@link isHostFrame} or {@link isAgentFrame}, because a peer that sends a
 * frame only its counterpart may send is confused and must be closed, not
 * accommodated.
 * @param text - the received text frame.
 * @returns the decoded frame, or undefined when it is not one.
 */
export function decodeControl(text: string): NodeFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const type = (parsed as { type?: unknown }).type
  if (typeof type !== 'string') return undefined
  return parsed as NodeFrame
}

const HOST_FRAME_TYPES = new Set(['ready', 'refused', 'op.open', 'op.cancel', 'ping'])
const AGENT_FRAME_TYPES = new Set(['hello', 'op.end', 'op.error', 'op.payloadEnd', 'pong'])

/**
 * Whether a decoded frame is one only the host may send.
 * @param frame - a decoded frame.
 * @returns true when the frame belongs to the host direction.
 */
export function isHostFrame(frame: NodeFrame): frame is HostFrame {
  return HOST_FRAME_TYPES.has(frame.type)
}

/**
 * Whether a decoded frame is one only an agent may send.
 * @param frame - a decoded frame.
 * @returns true when the frame belongs to the agent direction.
 */
export function isAgentFrame(frame: NodeFrame): frame is AgentFrame {
  return AGENT_FRAME_TYPES.has(frame.type)
}

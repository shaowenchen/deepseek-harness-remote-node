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
 * @module @shaowenchen/dsh-node/protocol
 */

/** Protocol version. A mismatch is refused rather than negotiated. */
export const NODE_PROTOCOL_VERSION = 1

/** The upgrade path the owner registers and the agent dials. */
export const NODE_CHANNEL_PATH = '/node/v1'

/** Ping cadence in milliseconds before deployment override. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000

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
  | 'proc.write'
  | 'proc.signal'
  | 'proc.wait'
  // ── terminals (ctx.subprocess.spawnTerminal) ──
  | 'tty.open'
  | 'tty.write'
  | 'tty.resize'
  | 'tty.signal'
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
  /** Another connection for this node id is already active. */
  | 'busy'

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
const AGENT_FRAME_TYPES = new Set(['hello', 'op.end', 'op.error', 'pong'])

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

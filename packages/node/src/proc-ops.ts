/**
 * The node's process core: real process trees on the remote machine, with the
 * same observable semantics as dsh's own local backend.
 *
 * Three properties drive the shape of this module, and all three are the ones
 * a naive `child_process.spawn` gets wrong:
 *
 * 1. **Termination is tree-scoped.** A child that spawns helpers leaves them
 *    behind if only the direct pid is signalled: killing `npm run build` while
 *    `esbuild` keeps running is the ordinary failure. So every child is spawned
 *    `detached` and signalled as a process GROUP (`-pid`), with the direct child
 *    as the fallback when the group is already gone. Windows has no POSIX groups
 *    and terminates the tree via `taskkill /T` instead.
 *
 * 2. **Collected output is bounded, offset-addressed, and non-consuming.** Two
 *    independent readers must be able to read one stream without eating each
 *    other's bytes, so a collector keeps a byte-indexed window and hands out
 *    deltas. Overflow keeps the TAIL (the diagnostic end of a build log) and
 *    reports that it dropped the head rather than silently truncating; a spill
 *    file keeps the complete stream recoverable when the caller asked for one.
 *
 * 3. **This file is self-contained.** It runs on a remote machine that has Node
 *    and nothing else — no `@deepseek-ai/*` packages, no dsh. The failure
 *    vocabulary below is a local string union mirroring `NodeErrorCode`, exactly
 *    as `fs-ops.ts` mirrors `FsErrorCode`, so the adapter forwards a code
 *    instead of translating it through a second place that can disagree.
 *
 * A process handle outlives the channel that spawned it: this module holds no
 * reference to the socket. That is what lets a network blip leave a running
 * build alone, and it is why the host has to fail its own callers explicitly
 * rather than being told by the node that nothing is running any more.
 * @module @shaowenchen/deepseek-harness-remote-node-agent/proc-ops
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdtempSync, type WriteStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { NodeOpError } from './fs-ops.ts'

/** Largest delay one Node timer can represent, mirroring the seam's own bound. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * How long a process may keep the outcome open after its root exited.
 *
 * A descendant that inherited an output descriptor keeps the pipe open, so
 * waiting for `close` alone can hang forever on a process that has plainly
 * finished. Past this grace the stream is sealed with whatever arrived.
 */
const DEFAULT_PIPE_DRAIN_MS = 250

// ── collected output ────────────────────────────────────────────────────────

/**
 * One bounded, offset-addressed output window.
 *
 * Reads are whole-stream byte coordinates owned by the caller: `readFrom(0)`
 * after settlement is the batch result, and a later `readFrom(nextOffset)`
 * returns only what arrived since. Nothing is consumed, so a second reader
 * starting at 0 sees the same bytes.
 */
export class OutputCollector {
  private readonly chunks: Buffer[] = []
  /** Bytes currently retained in the in-memory window. */
  private retained = 0
  /** Bytes dropped from the HEAD of the stream by the cap. */
  private dropped = 0
  /** Every byte ever received, retained or not: the whole-stream length. */
  private total = 0
  private sealed = false
  private spill: WriteStream | undefined
  private spilled = 0
  private spillBroke = false
  private spillPath: string | undefined
  private readonly maxBytes: number
  private readonly spillCap: number
  /**
   * Called with every chunk that arrives, for a consumer that forwards bytes
   * live rather than reading the window later. Set by the agent once the stream
   * that carries this output exists.
   */
  onChunk: ((bytes: Buffer) => void) | undefined

  /**
   * @param maxBytes - in-memory cap; overflow keeps the tail.
   * @param spillMaxBytes - whole-stream cap when a spill file should be kept.
   * @param label - stream name, used to name the spill file.
   * @param spillDir - directory for spill files.
   */
  constructor(
    maxBytes: number,
    spillMaxBytes: number | undefined,
    label: string,
    spillDir: string,
  ) {
    this.maxBytes = maxBytes
    this.spillCap = spillMaxBytes ?? 0
    if (spillMaxBytes === undefined) return
    const path = join(spillDir, `${label}.log`)
    this.spillPath = path
    this.spill = createWriteStream(path, { flags: 'w' })
    // A spill file is a diagnostic convenience, never a reason to disturb the
    // process being observed: an unwritable temp directory degrades to
    // in-memory-only collection rather than failing the spawn.
    this.spill.on('error', () => { this.spillBroke = true })
  }

  /**
   * Append one chunk, trimming the in-memory window and feeding the spill.
   *
   * Trimming is to EXACTLY the cap, slicing inside a chunk when it straddles
   * the boundary. Keeping whole chunks instead would retain more than the caller
   * asked for and, more importantly, would return a different tail than the
   * harness's own local backend for the same stream — and this module's whole
   * contract is that a caller cannot tell which machine ran the process.
   * @param chunk - bytes that arrived on the stream.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.retained += chunk.length
    this.onChunk?.(chunk)
    while (this.retained > this.maxBytes) {
      const head = this.chunks[0]!
      const excess = this.retained - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retained -= head.length
        this.dropped += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retained -= excess
        this.dropped += excess
      }
    }
    if (this.spill && !this.spillBroke) {
      if (this.spilled + chunk.length > this.spillCap) {
        // The stream outgrew its spill cap, so the file now holds a partial
        // prefix. Offering it as "the complete stream" would be a silent lie,
        // so the spill is abandoned and never advertised again.
        this.spillBroke = true
        this.spill.end()
        this.spill = undefined
      } else {
        this.spilled += chunk.length
        this.spill.write(chunk)
      }
    }
  }

  /** Stop accepting spill writes; the retained window stays readable. */
  seal(): void {
    if (this.sealed) return
    this.sealed = true
    this.spill?.end()
    this.spill = undefined
    if (this.spillBroke) this.spillPath = undefined
  }

  /**
   * Read everything retained since a whole-stream offset.
   *
   * Non-consuming: the same offset may be read again, and two readers with
   * independent cursors never interfere.
   * @param fromByte - the offset to resume from (a prior read's `nextOffset`).
   * @returns the delta text, the next offset, and whether the head was lost.
   */
  readFrom(fromByte: number): {
    text: string
    nextOffset: number
    lossy: boolean
    spillPath?: string
  } {
    const spill = this.spillPath !== undefined ? { spillPath: this.spillPath } : {}
    const windowStart = this.dropped
    // An offset below the retained window slid out of the head: return the
    // whole window and say so, rather than pretending the gap was read.
    if (fromByte < windowStart) {
      return {
        text: Buffer.concat(this.chunks).toString('utf8'),
        nextOffset: this.total,
        lossy: true,
        ...spill,
      }
    }
    const skip = fromByte - windowStart
    let offset = 0
    const parts: Buffer[] = []
    for (const chunk of this.chunks) {
      const end = offset + chunk.length
      if (end > skip) parts.push(skip > offset ? chunk.subarray(skip - offset) : chunk)
      offset = end
    }
    return { text: Buffer.concat(parts).toString('utf8'), nextOffset: this.total, lossy: false, ...spill }
  }
}

// ── process trees ───────────────────────────────────────────────────────────

/**
 * Terminate one Windows process tree with `taskkill /T /F`.
 *
 * Delivery races tree exit, so an absent tree, a nonzero status, or a missing
 * `taskkill` must stay a no-op: teardown is idempotent by contract.
 * @param pid - root process id; non-positive is a no-op.
 */
function taskkillTree(pid: number): void {
  if (pid <= 0) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/**
 * Signal a detached process tree.
 *
 * POSIX signals the negative process-group id and falls back to the direct
 * child when the group is already gone. Windows terminates the tree via
 * `taskkill` (Node maps every signal onto TerminateProcess).
 * @param platform - the node's platform.
 * @param pid - tree root.
 * @param signal - the signal to deliver.
 * @param child - the direct child, for the POSIX fallback.
 */
function signalTree(
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals,
  child: ChildProcess,
): void {
  if (platform === 'win32') {
    taskkillTree(pid)
    return
  }
  if (pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The tree is gone; teardown stays idempotent.
    }
  }
}

/** One live managed process. */
export interface ProcHandle {
  readonly pid: number
  readonly collected: { stdout?: OutputCollector; stderr?: OutputCollector }
  readonly stdin: NodeJS.WritableStream | undefined
  /** Settles with the root's exit facts; rejects only for spawn-level failures. */
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  /**
   * Deliver one signal to the whole process TREE.
   *
   * Not `child.kill`: signalling only the direct child is exactly the bug this
   * module exists to avoid, and a caller asking to signal a managed process
   * means the tree it leads.
   * @param signal - the signal to deliver.
   */
  signal(signal: NodeJS.Signals): void
  /** SIGTERM → grace → SIGKILL escalation on the tree. Idempotent. */
  terminate(): void
}

/** Non-positive pids are never valid, so they are the "no tree" sentinel. */
function treeAlive(platform: NodeJS.Platform, pid: number, child: ChildProcess): boolean {
  if (pid <= 0) return false
  if (platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') return false
    // EPERM means the group exists but is not ours to signal, which is still
    // "alive" for every question this module asks.
    if (code === 'EPERM') return true
    return child.exitCode === null && child.signalCode === null
  }
}

/**
 * Spawn one managed process tree.
 * @param spec - a fully specified request; no defaults are applied here.
 * @param spillDir - directory for spill files.
 * @param onPipe - receives raw chunks for streams whose mode is `'pipe'`, which
 *   are forwarded live rather than collected. Collect-mode streams never reach
 *   it: their bytes stay in the node's window for offset-addressed reads.
 * @returns the live handle.
 */
export function spawnProcess(
  spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore' | 'pipe' | { readonly data: string }
      stdout: 'pipe' | { maxBytes: number; spillMaxBytes?: number }
      stderr: 'pipe' | { maxBytes: number; spillMaxBytes?: number }
    }
    graceMs: number
    env?: NodeJS.ProcessEnv
  },
  spillDir: string,
  onPipe?: (kind: 'stdout' | 'stderr', bytes: Buffer) => void,
): ProcHandle {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new NodeOpError(
      'policy',
      `graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const [program, ...args] = spec.argv
  if (!program) {
    throw new NodeOpError('policy', 'invalid argv: expected a non-empty program name at argv[0]')
  }

  const platform = process.platform
  const collect = (mode: { maxBytes: number; spillMaxBytes?: number } | 'pipe', label: string) =>
    mode === 'pipe' ? undefined : new OutputCollector(mode.maxBytes, mode.spillMaxBytes, label, spillDir)

  const child = spawn(program, args, {
    cwd: spec.cwd,
    env: spec.env as NodeJS.ProcessEnv | undefined,
    stdio: [
      spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
      spec.stdio.stdout === 'pipe' ? 'pipe' : 'pipe',
      spec.stdio.stderr === 'pipe' ? 'pipe' : 'pipe',
    ],
    // The whole point of this module: a detached child leads its own process
    // group, so `kill(-pid)` reaches every helper it started.
    detached: platform !== 'win32',
  })

  const stdoutCollector = collect(spec.stdio.stdout, 'stdout')
  const stderrCollector = collect(spec.stdio.stderr, 'stderr')
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdoutCollector) stdoutCollector.push(chunk)
    else onPipe?.('stdout', chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrCollector) stderrCollector.push(chunk)
    else onPipe?.('stderr', chunk)
  })

  const pid = child.pid ?? -1
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let treeExitObserved = false
  let observation: Promise<void> | undefined

  // One whole-tree exit observer per handle. The first confirmed absence is a
  // permanent no-more-signals boundary: it cancels a pending escalation before
  // the process-group id can be reused by an unrelated process.
  const observeTreeExit = (): Promise<void> => {
    observation ??= (async () => {
      while (treeAlive(platform, pid, child)) await new Promise((r) => setTimeout(r, 20))
      treeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    })()
    return observation
  }

  const signal = (sig: NodeJS.Signals): void => {
    if (!treeAlive(platform, pid, child)) return
    signalTree(platform, pid, sig, child)
  }

  const terminate = (): void => {
    if (treeExitObserved || graceTimer !== undefined) return
    void observeTreeExit()
    if (!treeAlive(platform, pid, child)) return
    signalTree(platform, pid, 'SIGTERM', child)
    graceTimer = setTimeout(() => {
      if (treeAlive(platform, pid, child)) signalTree(platform, pid, 'SIGKILL', child)
    }, spec.graceMs)
    graceTimer.unref?.()
  }

  if (typeof spec.stdio.stdin === 'object' && child.stdin) {
    child.stdin.on('error', () => {})
    child.stdin.end(spec.stdio.stdin.data)
  }

  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      // Seal both collectors so a late chunk cannot extend the window after the
      // outcome was published, then release the pipes.
      stdoutCollector?.seal()
      stderrCollector?.seal()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ exitCode, signal })
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      stdoutCollector?.seal()
      stderrCollector?.seal()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      // A surviving descendant can hold an inherited descriptor open, so
      // `close` may never arrive. Drain for the grace period, then seal.
      drainTimer = setTimeout(() => { settle(exitCode, signal) }, Math.min(spec.graceMs, DEFAULT_PIPE_DRAIN_MS))
      drainTimer.unref?.()
    })
    child.on('close', (exitCode, signal) => { settle(exitCode, signal) })
  })
  // A handle whose `done` is never awaited must not surface as an unhandled
  // rejection when the spawn itself fails.
  void done.catch(() => {})

  return {
    pid,
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    },
    stdin: spec.stdio.stdin === 'pipe' ? (child.stdin ?? undefined) : undefined,
    done,
    signal,
    terminate,
  }
}

/**
 * Resolve one executable in this machine's own namespace.
 *
 * Relative paths containing a separator are refused rather than guessed at:
 * the resolution base is undefined, and silently resolving against the agent's
 * cwd would run a different program than the caller named.
 * @param command - an absolute path or a bare PATH name.
 * @param env - explicit environment used for the lookup.
 * @returns the usable executable path.
 */
export async function resolveExecutable(
  command: string,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new NodeOpError('policy', 'command must be a non-empty string')
  }
  if (command.includes('/') || command.includes('\\')) {
    if (!isAbsolute(command)) {
      throw new NodeOpError('policy', `cannot resolve relative executable path "${command}"`)
    }
    try {
      await access(command, constants.X_OK)
      return command
    } catch {
      throw new NodeOpError('not-found', `not executable: ${command}`)
    }
  }

  const pathValue = env?.['PATH'] ?? process.env['PATH'] ?? ''
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.length === 0) continue
    const candidate = join(dir, command)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new NodeOpError('not-found', `command not found on PATH: ${command}`)
}

/** Create a private directory for this agent run's spill files. */
export function privateSpillDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-node-spill-'))
}

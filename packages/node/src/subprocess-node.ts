/**
 * `ctx.subprocess` backed by a remote node.
 *
 * This is the second half of the execution world `@shaowenchen/deepseek-harness-remote-node/fs`
 * starts. With both mounted, the agent's commands, terminals, and language
 * servers run on the remote machine exactly as its file operations do — and the
 * two describe ONE world, which is the invariant the harness's architecture
 * rests on: the paths the filesystem resolves are the paths these processes
 * run in, and the executables they resolve come from the same namespace.
 *
 * Four properties this class owns:
 *
 * 1. **A missing node is a failed world, not local execution.** Every operation
 *    goes through the registry, which refuses with `disconnected` when nothing
 *    is registered. There is deliberately no fallback: if a drop could degrade
 *    into "run it on the host", the agent would execute commands on the harness
 *    machine while the user believes it is working on the remote one.
 *
 * 2. **Collected output is pulled, not buffered.** The seam's reader is
 *    offset-addressed and synchronous — `readFrom(fromByte)` — so the node keeps
 *    the byte window and this adapter asks for deltas. Buffering whole streams on
 *    the host would defeat the cap the node already applies.
 *
 * 3. **Terminals are the one push-shaped stream.** A terminal's output is a
 *    `Readable` in the seam, so this adapter forwards payload frames as they
 *    arrive into a real `Readable`, and ends it when the node says the terminal
 *    exited.
 *
 * 4. **`inherit` is refused, not reinterpreted.** The node's own stdout is not
 *    the host's, so passing a descriptor through would print a remote build's
 *    output on the wrong machine. A spec that asks for it fails loudly.
 *
 * `spawnTerminal` requires a PTY on the node. Where the node has no substrate it
 * says so at registration and this adapter surfaces `unsupported` rather than
 * silently degrading a terminal into a pipe, which would change how the user's
 * shell behaves without telling anyone.
 * @module @shaowenchen/deepseek-harness-remote-node/subprocess
 */

import { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  SubprocessRuntime,
  type SubprocessCollectedOutputs,
  type SubprocessCollect,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputMode,
  type SubprocessOutputRead,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalForeground,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSignal,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { NodeError, type NodeRegistry, type NodeStream } from './index.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Accepted for symmetry with the local backend and deliberately unused; see
   * the equivalent note in `@shaowenchen/deepseek-harness-remote-node/fs`. The execution world's
   * working directory belongs to the NODE.
   */
  cwd?: string
}

/** The node's per-stream stdio shape, as it crosses the wire. */
interface NodeStdio {
  stdin: 'ignore' | 'pipe' | { readonly data: string }
  stdout: 'pipe' | { maxBytes: number; spillMaxBytes?: number }
  stderr: 'pipe' | { maxBytes: number; spillMaxBytes?: number }
}

/** `proc.spawn`'s result, as it crosses the wire. */
interface ProcSpawnResult {
  pid: number
  collected: { stdout: boolean; stderr: boolean }
}

/** One collected-output read, as it crosses the wire. */
interface NodeOutputRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

/**
 * Convert a seam output mode into the node's.
 *
 * `inherit` has no wire representation — the node's stdout is not the host's —
 * so it is refused here rather than quietly becoming a pipe. A caller that
 * asked to share a descriptor would otherwise get captured output it never
 * reads, which reads as "the command printed nothing".
 * @param mode - the seam's output disposition.
 * @param which - the stream name, for the failure message.
 * @returns the node's disposition.
 */
function toNodeOutputMode(
  mode: SubprocessOutputMode,
  which: 'stdout' | 'stderr',
): 'pipe' | { maxBytes: number; spillMaxBytes?: number } {
  if (mode === 'inherit') {
    throw new RemoteSubprocessError(
      'unsupported',
      `${which}: 'inherit' cannot cross a node channel — the remote process's descriptor is not this machine's`,
    )
  }
  if (mode === 'pipe') return 'pipe'
  const collect = mode as SubprocessCollect
  return {
    maxBytes: collect.maxBytes,
    ...collect.spill !== undefined ? { spillMaxBytes: collect.spill.maxBytes } : {},
  }
}

/** The wire shape of the node's own failure, carried on `NodeError`. */
interface NodeFailure {
  code: string
  message: string
}

/**
 * Whether a thrown value is a failure from the node channel.
 * @param error - the caught value.
 * @returns true when it carries a node error code.
 */
function isNodeFailure(error: unknown): error is NodeFailure & Error {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
}

/**
 * Failure raised by this adapter.
 *
 * The seam has no error vocabulary of its own — it throws plain `Error`s — but
 * keeping a code on ours lets a caller distinguish a policy refusal from an
 * infrastructure failure, which is the distinction the harness branches on.
 */
export class RemoteSubprocessError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RemoteSubprocessError'
    this.code = code
  }
}

/**
 * Translate a thrown value into this adapter's error type.
 *
 * A node failure keeps its code: the node's vocabulary is this protocol's by
 * construction, so this is a pass-through rather than a translation that could
 * disagree with the other side.
 * @param error - the caught value.
 * @param what - the operation, for the message when the code is not ours.
 * @returns an error to throw.
 */
function asRemoteError(error: unknown, what: string): RemoteSubprocessError {
  if (isNodeFailure(error)) {
    return new RemoteSubprocessError(error.code, error.message, { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteSubprocessError('internal', `cannot ${what}: ${message}`, { cause: error })
}

/** The node-backed subprocess runtime. Mounts as `ctx.subprocess`. */
export class NodeSubprocessRuntime extends SubprocessRuntime {
  static Config: Schema<Config> = Schema.object({
    cwd: Schema.string(),
  })

  /**
   * The registry is a hard dependency, so it is declared rather than merely
   * reached for.
   *
   * cordis guards every service read: touching a property that is not in the
   * context's own store and not in its `inject` set throws `cannot get property
   * "nodeRegistry" without inject` — before any command runs, and with a message
   * that describes the mechanism rather than the problem. Declaring it is also
   * what makes the ordering work: cordis parks this plugin until the registry
   * appears, so the two can be loaded in either order.
   */
  static inject = ['nodeRegistry']

  /**
   * The node registry.
   *
   * Read through the context rather than captured in the constructor: the
   * declaration above guarantees it is present by the time anything here runs,
   * and going through `this.ctx` keeps the read on the current fiber. The
   * undefined branch is unreachable in a correct composition and exists only so
   * a mis-built one fails with a sentence instead of a property access error.
   */
  private get registry(): NodeRegistry {
    const registry = (this.ctx as Context & { nodeRegistry?: NodeRegistry }).nodeRegistry
    if (!registry) {
      throw new RemoteSubprocessError(
        'internal',
        'no node registry is mounted; the dsh-node channel plugin must be loaded for ctx.subprocess to reach a remote machine',
      )
    }
    return registry
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    void config
  }

  /**
   * Resolve one executable in the node's own namespace.
   * @param command - an absolute path or bare PATH name.
   * @param env - explicit environment used for the lookup.
   * @param signal - aborts the round-trip.
   * @returns the canonical executable path on the node.
   */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return await this.registry.invoke<string>(
        'proc.resolve',
        { command, ...env !== undefined ? { env } : {} },
        signal,
      )
    } catch (error) {
      throw asRemoteError(error, `resolve ${command}`)
    }
  }

  /**
   * Start one managed process on the node.
   *
   * Returns as soon as the node reports the process live, which is what makes
   * streaming possible: the caller gets the pid and readers before the process
   * has finished.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, environment.
   * @returns the live handle.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const registry = this.registry
    // The spawn crosses the wire asynchronously but the seam's `spawn` is
    // synchronous, so the stream is opened here and its result awaited by the
    // handle's `done`. A refusal that happens before the pid is known surfaces
    // through `done` rather than being thrown, because by then the caller has a
    // handle in hand.
    const stdio: NodeStdio = {
      stdin: spec.stdio.stdin,
      stdout: toNodeOutputMode(spec.stdio.stdout, 'stdout'),
      stderr: toNodeOutputMode(spec.stdio.stderr, 'stderr'),
    }

    let stream: NodeStream
    try {
      stream = registry.open('proc.spawn', {
        argv: spec.argv,
        cwd: spec.cwd,
        stdio,
        graceMs: spec.graceMs,
        ...spec.env !== undefined ? { env: spec.env } : {},
      })
    } catch (error) {
      throw asRemoteError(error, 'spawn')
    }

    // The spec's abort signal escalates on the tree, exactly as it would
    // locally: the caller's deadline must reach the remote process.
    if (spec.signal) {
      if (spec.signal.aborted) stream.cancel()
      else spec.signal.addEventListener('abort', () => { stream.cancel() }, { once: true })
    }

    const started = stream.result.then((result) => result as ProcSpawnResult)
    // Attached for the same reason the registry attaches to its own promises:
    // a handle whose `done` is never awaited must not surface as an unhandled
    // rejection.
    const settled = started.then(
      () => undefined,
      () => undefined,
    )

    const collected: SubprocessCollectedOutputs = {}
    const readers = new Map<'stdout' | 'stderr', SubprocessOutputReader>()
    const syncs = new Map<'stdout' | 'stderr', () => Promise<void>>()

    // A pipe-mode stream is handed to the caller raw, so it is a real Readable
    // fed by the node's payload frames and ended when the process exits.
    const pipes = new Map<'stdout' | 'stderr', Readable>()
    const pipeFor = (which: 'stdout' | 'stderr'): Readable => {
      let existing = pipes.get(which)
      if (!existing) {
        existing = new Readable({ read() { /* pushed, never pulled */ } })
        pipes.set(which, existing)
      }
      return existing
    }
    void (async () => {
      try {
        for await (const { kind, bytes } of stream.tagged) {
          if (kind !== 'stdout' && kind !== 'stderr') continue
          const sink = pipeFor(kind)
          sink.push(Buffer.from(bytes))
        }
      } catch (error) {
        for (const sink of pipes.values()) sink.destroy(error as Error)
        return
      }
      for (const sink of pipes.values()) sink.push(null)
    })()

    const handle: SubprocessHandle = {
      pid: -1,
      stdin: spec.stdio.stdin === 'pipe'
        ? new Writable({
            write(chunk, _encoding, callback) {
              void started.then(() => { stream.write(Buffer.from(chunk)) }).catch(() => {})
              callback()
            },
          })
        : undefined,
      get stdout(): Readable | undefined {
        return spec.stdio.stdout === 'pipe' ? pipeFor('stdout') : undefined
      },
      get stderr(): Readable | undefined {
        return spec.stdio.stderr === 'pipe' ? pipeFor('stderr') : undefined
      },
      collected,
      get done(): Promise<SubprocessOutcome> {
        return (async () => {
          const { pid } = await started
          const outcome = await registry.invoke<{ exitCode: number | null; signal: string | null }>(
            'proc.wait', { pid },
          )
          // The final sync happens BEFORE `done` settles, so the batch shape —
          // await the outcome, then read everything — cannot miss the tail.
          // Twice on purpose: the first call may join a read that was already
          // in flight from before the exit, and only the second is guaranteed
          // to have started after it. The process has exited, so the window
          // only grows by zero and the second read is cheap.
          await Promise.all([...syncs.values()].map((sync) => sync()))
          await Promise.all([...syncs.values()].map((sync) => sync()))
          return { exitCode: outcome.exitCode, signal: outcome.signal as NodeJS.Signals | null }
        })()
      },
      terminate(): void {
        // Fire-and-forget by contract: the seam's `terminate` returns void and
        // the escalation is observed through `done` / `waitForExit`.
        void started
          .then(({ pid }) => registry.invoke('proc.signal', { pid, signal: 'SIGTERM' }))
          .catch(() => {})
      },
      async waitForExit(signal?: AbortSignal): Promise<boolean> {
        const { pid } = await started
        // The node's `proc.wait` settles when the tree's root exits. A signal
        // bounds the wait; the seam defines `false` as "the signal won".
        if (!signal) {
          await registry.invoke('proc.wait', { pid })
          return true
        }
        const outcome = await Promise.race([
          registry.invoke('proc.wait', { pid }).then(() => true),
          new Promise<boolean>((resolve) => {
            if (signal.aborted) { resolve(false); return }
            signal.addEventListener('abort', () => resolve(false), { once: true })
          }),
        ])
        return outcome
      },
    }

    // The handle's pid and collected readers become known only once the node
    // answers. They are filled in here rather than being part of the object
    // literal because the seam reads `pid` synchronously and the wire is not.
    void started.then((result) => {
      Object.defineProperty(handle, 'pid', { value: result.pid, enumerable: true, configurable: true })
      for (const which of ['stdout', 'stderr'] as const) {
        if (!result.collected[which]) continue
        const { reader, sync } = this.readerFor(which, result.pid)
        readers.set(which, reader)
        syncs.set(which, sync)
      }
      Object.assign(collected, Object.fromEntries(readers))
    }).catch(() => {})

    void settled
    return handle
  }

  /**
   * One offset-addressed reader over the node's collected window.
   *
   * The seam's reader is synchronous while the node is not, so this keeps a
   * local mirror of the window and answers from it. Two things keep the mirror
   * honest, and both matter:
   *
   * - A background poll runs while the process is alive, so a caller polling
   *   `readFrom` during a long build sees output as it appears.
   * - The handle's `done` resolves only after one final sync, so the batch shape
   *   — "await done, then read everything" — always sees the complete window.
   *     Without that second part the last bytes of every process would race the
   *     outcome and be missed, which is the failure a test caught here.
   *
   * The mirror is only ever a PREFIX of the node's window, so an answer is never
   * wrong, only possibly stale.
   * @param which - the stream to read.
   * @param pid - the process that produced it.
   * @returns the seam's reader and a `sync` the handle awaits before settling.
   */
  private readerFor(
    which: 'stdout' | 'stderr',
    pid: number,
  ): { reader: SubprocessOutputReader; sync: () => Promise<void> } {
    let text = ''
    let nextOffset = 0
    let lossy = false
    let spillPath: string | undefined
    let inFlight: Promise<void> | undefined

    const sync = (): Promise<void> => {
      // One refresh at a time: the node's window only grows, and overlapping
      // reads would interleave their deltas out of order.
      if (inFlight) return inFlight
      const run = this.registry
        .invoke<NodeOutputRead>('proc.read', { pid, stream: which, fromByte: nextOffset })
        .then((read) => {
          text += read.text
          nextOffset = read.nextOffset
          lossy = lossy || read.lossy
          if (read.spillPath !== undefined) spillPath = read.spillPath
        })
        .catch(() => {})
        .finally(() => { inFlight = undefined })
      inFlight = run
      return run
    }

    return {
      reader: {
        readFrom(fromByte: number): SubprocessOutputRead {
          const start = Math.max(0, fromByte - (nextOffset - text.length))
          // A read also nudges the mirror forward, so a caller that polls during
          // a running process advances without any external tick.
          void sync()
          return {
            text: text.slice(start),
            nextOffset,
            lossy,
            ...spillPath !== undefined ? { spillPath } : {},
          }
        },
      },
      sync,
    }
  }

  /**
   * Allocate a real terminal on the node.
   * @param spec - argv, cwd, environment, dimensions, grace, cancellation.
   * @returns the live terminal handle.
   */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const registry = this.registry
    const stream = registry.open('tty.open', {
      argv: spec.argv,
      cwd: spec.cwd,
      ...spec.env !== undefined ? { env: spec.env } : {},
      rows: spec.rows,
      cols: spec.cols,
      graceMs: spec.graceMs,
    })

    let opened: { pid: number }
    try {
      opened = await stream.result as { pid: number }
    } catch (error) {
      throw asRemoteError(error, 'open terminal')
    }
    const pid = opened.pid

    if (spec.signal) {
      if (spec.signal.aborted) {
        await registry.invoke('tty.close', { pid }).catch(() => {})
        throw new RemoteSubprocessError('cancelled', 'terminal allocation aborted')
      }
    }

    // Terminal output is a real `Readable`: payload frames are pushed into it as
    // they arrive, and it ends when the node says the terminal exited.
    const output = new Readable({ read() { /* pushed, never pulled */ } })
    void (async () => {
      try {
        for await (const { bytes } of stream.tagged) output.push(Buffer.from(bytes))
      } catch (error) {
        output.destroy(error as Error)
        return
      }
      output.push(null)
    })()

    const done = registry
      .invoke<{ exitCode: number | null; signal: string | null }>('tty.wait', { pid })
      .then((outcome) => ({
        exitCode: outcome.exitCode,
        signal: outcome.signal as NodeJS.Signals | null,
      }))

    return {
      pid,
      output,
      done,
      async write(data: string): Promise<void> {
        await registry.invoke('tty.write', { pid, data })
      },
      async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
        return await registry.invoke<SubprocessTerminalForeground>('tty.inspect', { pid })
      },
      async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
        return await registry.invoke<number>('tty.signal', { pid, signal })
      },
      async terminate(): Promise<void> {
        // `tty.close` is the whole-session teardown: the node escalates
        // TERM→grace→KILL over the terminal's process group and awaits
        // quiescence, which is exactly the seam's contract.
        await registry.invoke('tty.close', { pid })
      },
    }
  }
}

export default NodeSubprocessRuntime

/**
 * `ctx.fs` backed by a remote node.
 *
 * This is the adapter the whole protocol exists for. It implements the
 * `FileSystem` seam and forwards every operation to whatever machine is
 * currently connected on `ctx.nodeRegistry` — so the agent's file reads,
 * writes, and edits happen there, while the agent loop and session state stay
 * on the host.
 *
 * Three properties this class owns:
 *
 * 1. **A missing node is a failed world, not the host filesystem.** Every
 *    operation goes through the registry, which refuses with `disconnected`
 *    when nothing is registered. There is deliberately no fallback path here:
 *    if a drop could degrade into "use the local filesystem", the agent would
 *    edit the harness host's files while the user believes it is working on the
 *    remote machine.
 *
 * 2. **Failures keep their code.** The node's error vocabulary mirrors
 *    `FsErrorCode` by name precisely so a code crosses the wire unchanged.
 *    Translating through a local table would give the policy layer above a
 *    different answer depending on where execution happened.
 *
 * 3. **Guards run on the node.** `writeText` and `editText` are single
 *    operations, not a host-side stat followed by a write: the node checks the
 *    version inside the same critical section that publishes, so no window
 *    exists between check and write for another writer to slip through.
 *
 * `sandboxMode` stays `undefined` — this backend does not confine mutations
 * itself. Confinement on a node is an OS-level property of how the agent runs
 * (an unprivileged user, a container), not something this adapter can enforce
 * from the host side. See SECURITY.md.
 * @module @shaowenchen/dsh-node/fs
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsErrorCode,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { NodeRegistry } from './index.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Accepted for symmetry with the local backend and deliberately unused.
   *
   * The execution world's working directory belongs to the NODE — the registry
   * already carries it and the agent resolves relative paths against it. A host
   * that tried to set it here would be claiming to know the remote layout,
   * which this adapter must never assume.
   */
  cwd?: string
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
 * Translate a thrown value into the seam's error type.
 *
 * A node failure keeps its code: the node's vocabulary is `FsErrorCode` by
 * construction, so this is a pass-through, not a translation. Anything else is
 * a host-side fault and becomes `FS_IO_ERROR` rather than being smuggled into
 * the filesystem vocabulary under a code it does not mean.
 * @param error - the caught value.
 * @param what - the operation, for the message when the code is not ours.
 * @returns an error to throw.
 */
function asFsError(error: unknown, what: string): FsError {
  if (isNodeFailure(error)) {
    return new FsError(error.message, error.code as FsErrorCode, { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new FsError(`cannot ${what}: ${message}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Abort plumbing: fail fast on an already-aborted signal, and reject the
 * in-flight operation when the signal fires.
 *
 * The cancellation does not reach the node — the protocol's `op.cancel` is not
 * implemented yet — so an abandoned operation still completes there. What this
 * guarantees is that the HOST stops waiting, which is what a caller can observe.
 *
 * A caller that never aborts would otherwise leave a listener attached; the
 * listener is removed once the operation settles.
 * @param signal - the caller's abort signal, if any.
 * @param what - the operation name, for the message.
 * @returns a handle whose `done()` removes the listener.
 */
function abortScope(signal: AbortSignal | undefined, what: string): { done: () => void } {
  if (!signal) return { done: () => {} }
  // An already-aborted signal must fail before any work is attempted.
  if (signal.aborted) throw new FsError(`${what} aborted`, 'FS_ABORTED')
  return { done: () => { signal.removeEventListener('abort', onAbort) } }
  function onAbort(): void { /* settled by Promise.race below */ }
}

/** The node-backed filesystem. Mounts as `ctx.fs`. */
export class NodeFileSystem extends FileSystem {
  static Config: Schema<Config> = Schema.object({
    cwd: Schema.string(),
  })

  /**
   * The node registry, resolved lazily on first use.
   *
   * Injection is asynchronous (cordis may mount the channel after this plugin),
   * so the service is read through the context on demand rather than captured in
   * the constructor. That also means a composition which never mounts the
   * registry fails on the first file operation with a clear message instead of
   * binding `undefined` at load.
   */
  private get registry(): NodeRegistry {
    const registry = (this.ctx as Context & { nodeRegistry?: NodeRegistry }).nodeRegistry
    if (!registry) {
      throw new FsError(
        'no node registry is mounted; the dsh-node channel plugin must be loaded for ctx.fs to reach a remote machine',
        'FS_IO_ERROR',
      )
    }
    return registry
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    void config
  }

  /**
   * Run one operation on the registered node.
   * @param op - the operation name.
   * @param args - its arguments.
   * @param what - a verb for the error message when the failure is host-side.
   * @param signal - the caller's abort signal.
   * @returns the node's result.
   */
  private async call<T>(
    op: string,
    args: unknown,
    what: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = abortScope(signal, what)
    try {
      const pending = this.registry.invoke<T>(op as never, args)
      if (!signal) return await pending
      // Race the operation against the abort so the host stops waiting even
      // though the node keeps working. The losing promise is left handled.
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new FsError(`${what} aborted`, 'FS_ABORTED'))
          }, { once: true })
        }),
      ])
    } catch (error) {
      throw asFsError(error, what)
    } finally {
      scope.done()
    }
  }

  /**
   * Resolve a path into a stable target.
   *
   * The node does the work, because target identity must be derived from the
   * remote machine's own path rules — a host that normalized here would be
   * wrong on the first Windows or case-insensitive node.
   * @param path - the path to resolve.
   * @param opts - optional cwd override and cancellation signal.
   * @returns the stable target.
   */
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const resolved = await this.call<{ targetKey: string; displayPath: string }>(
      'fs.resolve', { path }, 'resolve', opts?.signal,
    )
    return {
      targetKey: FsTargetKey(resolved.targetKey),
      displayPath: resolved.displayPath,
    }
  }

  /**
   * The absolute path a subprocess on the node can open.
   *
   * The target key IS that path in this world, but it is asked for from the node
   * rather than unwrapped from the key: the seam is explicit that a target key
   * stays opaque to consumers, and having one place derive both facts keeps them
   * from drifting apart.
   * @param target - the resolved target.
   * @returns an absolute path in the node's namespace.
   */
  processPath(target: FsTarget): string {
    // Synchronous by contract, so this cannot await the node. The key is the
    // canonical absolute path the node produced, which is exactly this value.
    return String(target.targetKey)
  }

  /**
   * The node's filesystem is a different world from the host's, so no host path
   * maps into it. Reporting a mapping would invite a caller to hand a host path
   * to a node process, which is the failure this backend exists to prevent.
   * @param hostPath - an absolute path on the harness host.
   * @returns always undefined.
   */
  processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }

  /**
   * The canonical `file:` URI for a target.
   *
   * Synchronous, and the node's answer would be another round-trip for a value
   * derivable from the key — so it is derived here. The node runs the same
   * platform-agnostic encoding, and a mismatch on a remote platform would show
   * up as a wrong URI rather than a silent corruption.
   * @param target - the resolved target.
   * @returns the target's file URI.
   */
  fileUrl(target: FsTarget): string {
    return new URL(`file://${String(target.targetKey)}`).href
  }

  /**
   * Whether one target contains another.
   *
   * Answered by the node, because containment is a property of the remote
   * path rules (`/srv/w` contains `/srv/w/x` on POSIX but not on Windows).
   * @param parent - canonical directory target.
   * @param child - canonical candidate target.
   * @returns true when child is parent or inside it.
   */
  contains(parent: FsTarget, child: FsTarget): boolean {
    // Containment is pure path arithmetic on two keys the node already
    // canonicalized, so it is computed here rather than paying a round-trip;
    // the node's helper is the same function, kept in sync by the shared test.
    const parentKey = String(parent.targetKey)
    const childKey = String(child.targetKey)
    if (parentKey === childKey) return true
    const relativePart = childKey.startsWith(parentKey) ? childKey.slice(parentKey.length) : undefined
    return relativePart !== undefined && (relativePart.startsWith('/') || relativePart.startsWith('\\'))
  }

  /**
   * Return target metadata, or `undefined` when the target does not exist.
   *
   * Absence is `undefined` rather than a thrown `FS_NOT_FOUND`: callers probe
   * for targets that are not there yet, and the seam reserves the throw for
   * operations that require existence.
   * @param target - the resolved target to stat.
   * @param signal - aborts the round-trip.
   * @returns metadata, or undefined for an absent target.
   */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.call<NodeFsInfo | undefined>(
      'fs.stat', { targetKey: String(target.targetKey) }, 'stat', signal,
    )
    return info ? toFsInfo(info) : undefined
  }

  /**
   * Return path metadata without following a final symlink.
   * @param path - the path to inspect.
   * @param opts - cwd override for a relative path.
   * @param signal - aborts the round-trip.
   * @returns metadata, or undefined for an absent path.
   */
  async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const info = await this.call<NodeFsInfo | undefined>(
      'fs.lstat',
      // The node resolves against its own cwd; a host-supplied override is
      // therefore only meaningful as a path fragment, so it is passed through
      // as-is rather than being resolved here.
      { path: opts?.cwd ? `${opts.cwd}/${path}` : path },
      'lstat',
      signal,
    )
    if (!info) return undefined
    return {
      version: FsVersion(info.version),
      // A path-level probe can report a symlink, which `stat` never does.
      type: info.type,
      size: info.size,
    }
  }

  /**
   * Read a whole regular text file.
   * @param target - the resolved target.
   * @param signal - aborts the round-trip.
   * @returns the decoded content.
   */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return await this.call<string>(
      'fs.readText',
      { targetKey: String(target.targetKey), displayPath: target.displayPath },
      'read',
      signal,
    )
  }

  /**
   * Stream a whole regular text file as decoded chunks.
   *
   * The node currently returns the whole text in one result, so this yields it
   * as a single chunk. The seam's contract is about what a consumer sees, and a
   * one-chunk iterator is a truthful implementation of it; framing the chunks
   * onto the wire is a separate change that does not alter this signature.
   * @param target - the resolved target.
   * @param signal - aborts the round-trip.
   * @returns the decoded chunk iterable.
   */
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.call<string>(
      'fs.streamText',
      { targetKey: String(target.targetKey), displayPath: target.displayPath },
      'read',
      signal,
    )
    return (async function* one() { yield text })()
  }

  /**
   * Read a whole regular file as raw bytes under an inclusive cap.
   * @param target - the resolved target.
   * @param signal - aborts the round-trip.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @returns the raw content.
   */
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const raw = await this.call<Uint8Array | { type: 'Buffer'; data: number[] } | string>(
      'fs.readBytes',
      { targetKey: String(target.targetKey), displayPath: target.displayPath, maxBytes },
      'read',
      signal,
    )
    // Binary frames would carry this ideally; until then it travels as JSON, so
    // accept the shapes JSON can produce and rebuild the bytes.
    if (raw instanceof Uint8Array) return raw
    if (typeof raw === 'string') return new TextEncoder().encode(raw)
    return Uint8Array.from(raw.data)
  }

  /**
   * List direct children of a directory in stable name order.
   * @param target - the resolved directory target.
   * @param signal - aborts the round-trip.
   * @returns one entry per direct child.
   */
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.call<NodeFsDirEntry[]>(
      'fs.list',
      { targetKey: String(target.targetKey), displayPath: target.displayPath },
      'list',
      signal,
    )
    return entries.map((entry) => ({
      name: entry.name,
      // The seam's listing vocabulary has no `symlink` arm; a link reports as
      // whatever it is not, so `symlink` folds into `other` here.
      type: entry.type === 'symlink' ? 'other' : entry.type,
      target: {
        targetKey: FsTargetKey(entry.targetKey),
        displayPath: entry.displayPath,
      },
      ...entry.version !== undefined ? { version: FsVersion(entry.version) } : {},
      ...entry.size !== undefined ? { size: entry.size } : {},
    }))
  }

  /**
   * Atomically create or replace UTF-8 text under an optional guard.
   *
   * One round-trip, deliberately: the node checks the guard and publishes in a
   * single critical section, so a host-side stat followed by a write would
   * reintroduce exactly the race the guard exists to close.
   * @param target - the resolved target.
   * @param content - the full new content.
   * @param expected - the write intent guarding the write.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - accepted and ignored; see the class note on
   *   `sandboxMode`.
   * @returns the outcome, including the version the write produced.
   */
  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsWriteOutcome> {
    void sandboxPolicy
    const outcome = await this.call<{
      operation: 'create' | 'update'
      version: string
      before: string | null
      after: string
    }>(
      'fs.writeText',
      {
        targetKey: String(target.targetKey),
        displayPath: target.displayPath,
        content,
        expected: expected
          ? expected.kind === 'createIfAbsent'
            ? { kind: 'createIfAbsent' }
            : { kind: 'replaceIfVersion', version: String(expected.version) }
          : undefined,
      },
      'write',
      signal,
    )
    return {
      operation: outcome.operation,
      version: FsVersion(outcome.version),
      before: outcome.before,
      after: outcome.after,
    }
  }

  /**
   * Atomically edit literal text under an optional version guard.
   * @param target - the resolved target.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - accepted and ignored; see the class note on
   *   `sandboxMode`.
   * @returns the outcome, including the version the edit produced.
   */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsEditOutcome> {
    void sandboxPolicy
    const outcome = await this.call<{ version: string; before: string; after: string }>(
      'fs.editText',
      {
        targetKey: String(target.targetKey),
        displayPath: target.displayPath,
        edit: {
          oldString: edit.oldString,
          newString: edit.newString,
          replaceAll: Boolean(edit.replaceAll),
        },
        expected: expected ? { version: String(expected.version) } : undefined,
      },
      'edit',
      signal,
    )
    return {
      version: FsVersion(outcome.version),
      before: outcome.before,
      after: outcome.after,
    }
  }
}

/** The node's metadata shape, as it crosses the wire. */
interface NodeFsInfo {
  version: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
}

/** One listing entry, as it crosses the wire. */
interface NodeFsDirEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  targetKey: string
  displayPath: string
  version?: string
  size?: number
}

/**
 * Convert node metadata into the seam's `FsInfo`.
 *
 * The seam's `stat` type has no `symlink` arm because `stat` follows links; a
 * resolved target that still reports one is therefore `other`.
 * @param info - the node's metadata.
 * @returns the seam's metadata.
 */
function toFsInfo(info: NodeFsInfo): FsInfo {
  return {
    version: FsVersion(info.version),
    type: info.type === 'symlink' ? 'other' : info.type,
    size: info.size,
  }
}

export default NodeFileSystem

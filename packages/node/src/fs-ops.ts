/**
 * The node's filesystem core: real work on the remote machine, with the same
 * observable semantics as dsh's own local backend.
 *
 * Two properties drive the shape of this module:
 *
 * 1. **Guarded mutations happen HERE, on the node.** A version check followed by
 *    a separate write is a race: another writer can interleave between the stat
 *    and the rename, and the guard silently passes on stale bytes. So the whole
 *    read → check → rewrite sequence runs inside one critical section on the
 *    machine that owns the file, exactly as the local backend does it.
 *
 * 2. **This file is self-contained.** It runs on a remote machine that has Node
 *    and nothing else — no `@deepseek-ai/*` packages, no dsh. So the failure
 *    vocabulary below is a local string union rather than an import, and it
 *    mirrors `FsErrorCode` by name so the host-side adapter can pass a code
 *    through without a lossy mapping.
 *
 * Paths are resolved against the node's own namespace. The host never
 * normalizes, joins, or realpaths a remote path: it has no business knowing the
 * remote platform's rules, and would be wrong on the first Windows or
 * case-insensitive node.
 * @module @shaowenchen/deepseek-harness-remote-node-agent/fs-ops
 */

import { constants } from 'node:fs'
import {
  chmod, lstat, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'

/**
 * The failure vocabulary, mirroring `FsErrorCode` in `@deepseek-ai/dsh-fs`.
 *
 * Kept as a local union so this module has no dsh dependency, and kept
 * name-identical so the adapter forwards a code rather than translating it. A
 * translation table would be a second place for the two sides to disagree, and
 * upstream branches on these codes — a lossy mapping changes behaviour.
 */
export type NodeFsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/** Failure raised by an operation, carrying the wire error code. */
export class NodeOpError extends Error {
  readonly nodeErrorCode: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NodeOpError'
    this.nodeErrorCode = code
  }
}

/** Bytes sampled for the NUL-byte binary heuristic, matching the local backend. */
const BINARY_SAMPLE_BYTES = 8192

/** Default cap on the content held as a contextual-diff basis. */
export const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

function errnoOf(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

/**
 * Map a Node errno onto this module's failure vocabulary.
 *
 * `ENOTDIR` and `ENOENT` are both "the target cannot exist": resolving
 * `afile/child.txt` when `afile` is a regular file is an absence, not a
 * distinct failure, so both become `FS_NOT_FOUND` rather than letting a raw
 * Node error escape the taxonomy.
 * @param error - the caught Node error.
 * @returns the structured failure.
 */
function classify(error: unknown): NodeOpError {
  if (error instanceof NodeOpError) return error
  const code = errnoOf(error)
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new NodeOpError('FS_NOT_FOUND', message, { cause: error })
    case 'EACCES':
    case 'EPERM':
      return new NodeOpError('FS_PERMISSION_DENIED', message, { cause: error })
    default:
      return new NodeOpError('FS_IO_ERROR', message, { cause: error })
  }
}

/** Metadata the protocol carries; mirrors `FsInfo` / `FsPathInfo`. */
export interface NodeFsInfo {
  version: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
}

/** One directory entry; mirrors `FsDirEntry`. */
export interface NodeFsDirEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  targetKey: string
  displayPath: string
  version?: string
  size?: number
}

/** Outcome of a guarded write; mirrors `FsWriteOutcome`. */
export interface NodeFsWriteOutcome {
  operation: 'create' | 'update'
  version: string
  before: string | null
  after: string
}

/** Outcome of a literal edit; mirrors `FsEditOutcome`. */
export interface NodeFsEditOutcome {
  version: string
  before: string
  after: string
}

/** A literal-replacement request; mirrors `FsEditRequest`. */
export interface NodeFsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

/** A guarded write intent; mirrors `FsWriteIntent`. */
export type NodeFsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }

// ── identity ────────────────────────────────────────────────────────────────

/**
 * Derive the opaque freshness token from high-resolution stat identity.
 *
 * Device+inode make the token identity-bearing (two paths to one file share a
 * version), and the freshness fields make it change on any content or metadata
 * update. `mtimeNs`/`ctimeNs` require a `bigint` stat; the millisecond fields
 * would let two writes inside the same millisecond collide.
 * @param info - a bigint stat result.
 * @returns the version token.
 */
function versionOf(info: {
  dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

function typeOf(info: { isFile(): boolean; isDirectory(): boolean }): 'file' | 'directory' | 'other' {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/**
 * Resolve a path into a stable target identity plus a display path.
 *
 * For an existing path this is a realpath, so two aliases (a symlink and its
 * target, `..` spellings, a case variant) collapse to ONE identity and therefore
 * share stale guards. For an absent path it realpaths the nearest existing
 * ancestor and appends the missing suffix, so identity stays stable across
 * creation — otherwise a guarded create could never match the observation taken
 * before the file existed.
 * @param cwd - base directory a relative `path` resolves against.
 * @param path - absolute or relative path; empty or whitespace-only is refused.
 * @returns the canonical display path and the realpath-derived target key.
 */
export async function resolveTarget(cwd: string, path: string): Promise<{ targetKey: string; displayPath: string }> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new NodeOpError('FS_NOT_FOUND', 'path must be a non-empty string')
  }
  const displayPath = resolve(cwd, path)
  try {
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error) {
    if (errnoOf(error) === 'ENOTDIR') {
      throw new NodeOpError('FS_NOT_FOUND', `cannot resolve "${displayPath}": a parent path segment is not a directory`)
    }
    if (errnoOf(error) !== 'ENOENT') throw classify(error)
  }

  // Walk up to the nearest ancestor that exists, then reattach the missing
  // suffix so the key is stable before and after creation.
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  for (;;) {
    try {
      return { displayPath, targetKey: join(await realpath(ancestor), ...missing) }
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw classify(error)
      const parent = dirname(ancestor)
      // The filesystem root always realpaths, so this guards the walk's end.
      if (parent === ancestor) return { displayPath, targetKey: displayPath }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Stat a target, or return undefined when it — or a parent — is absent. */
export async function statTarget(targetKey: string): Promise<NodeFsInfo | undefined> {
  return await probe(targetKey)
}

/**
 * Stat a path without following a final symlink.
 *
 * Deliberately path-shaped rather than target-shaped: {@link resolveTarget}
 * follows symlinks to produce the identity normal reads and writes use, while
 * this lets a consumer reject the path itself before that follow happens. A
 * relative path resolves against `cwd` per the same rules.
 * @param path - the path to inspect.
 * @param cwd - base directory for a relative path.
 * @returns the entry's metadata, or undefined when absent.
 */
export async function lstatPath(path: string, cwd: string): Promise<NodeFsInfo | undefined> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new NodeOpError('FS_NOT_FOUND', 'path must be a non-empty string')
  }
  return await probeNoFollow(resolve(cwd, path))
}

/** Stat a target, or return undefined when it — or a parent — is absent. */
async function probe(targetKey: string): Promise<NodeFsInfo | undefined> {
  try {
    const info = await stat(targetKey, { bigint: true })
    return { version: versionOf(info), type: typeOf(info), size: Number(info.size) }
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return undefined
    throw classify(error)
  }
}

/** Stat a path without following a final symlink, or undefined when absent. */
async function probeNoFollow(absolutePath: string): Promise<NodeFsInfo | undefined> {
  try {
    const info = await lstat(absolutePath, { bigint: true })
    const type = info.isSymbolicLink() ? 'symlink' : typeOf(info)
    return { version: versionOf(info), type, size: Number(info.size) }
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return undefined
    throw classify(error)
  }
}

/** Mode bits (0o777) of a target, or undefined when absent. */
async function modeOf(targetKey: string): Promise<number | undefined> {
  try {
    return Number((await stat(targetKey, { bigint: true })).mode & 511n)
  } catch {
    return undefined
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

function notText(verb: string, displayPath: string): NodeOpError {
  return new NodeOpError('FS_NOT_TEXT', `cannot ${verb} "${displayPath}": invalid UTF-8 text`)
}

function binary(verb: string, displayPath: string): NodeOpError {
  return new NodeOpError('FS_NOT_TEXT', `cannot ${verb} "${displayPath}": binary file`)
}

/** Decode UTF-8, rejecting invalid bytes rather than returning replacement chars. */
function decodeUtf8(buffer: Uint8Array, verb: string, displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw notText(verb, displayPath)
  }
}

/**
 * Require a target to be a regular file.
 *
 * A directory or a character device must fail as such rather than being read
 * and producing a confusing downstream error — the local backend draws the same
 * line, and a remote world that blurred it would make the model see different
 * results depending on where execution happened.
 */
async function requireRegularFile(targetKey: string, displayPath: string, verb: string): Promise<void> {
  let info
  try {
    info = await stat(targetKey)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') {
      throw new NodeOpError('FS_NOT_FOUND', `cannot ${verb} "${displayPath}": not found`)
    }
    throw classify(error)
  }
  if (!info.isFile()) {
    throw new NodeOpError('FS_NOT_REGULAR_FILE', `cannot ${verb} "${displayPath}": not a regular file`)
  }
}

/**
 * Read a whole regular text file, byte-for-byte.
 * @param targetKey - the resolved target.
 * @param displayPath - caller-facing path for error messages.
 * @returns the decoded content, with no line-ending normalization.
 */
export async function readText(targetKey: string, displayPath: string): Promise<string> {
  await requireRegularFile(targetKey, displayPath, 'read')
  let raw: Buffer
  try {
    raw = await readFile(targetKey)
  } catch (error) {
    throw classify(error)
  }
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw binary('read', displayPath)
  return decodeUtf8(raw, 'read', displayPath)
}

/**
 * Read a whole regular file as raw bytes under an inclusive cap.
 *
 * The cap is checked against the stat size before any content I/O, so an
 * oversized file is refused rather than buffered, and again after reading in
 * case the file grew in between.
 * @param targetKey - the resolved target.
 * @param displayPath - caller-facing path for error messages.
 * @param maxBytes - inclusive byte cap on the complete content.
 * @returns the raw content.
 */
export async function readBytes(targetKey: string, displayPath: string, maxBytes: number): Promise<Uint8Array> {
  await requireRegularFile(targetKey, displayPath, 'read')
  let info
  try {
    info = await stat(targetKey)
  } catch (error) {
    throw classify(error)
  }
  if (info.size > maxBytes) {
    throw new NodeOpError('FS_TOO_LARGE', `cannot read "${displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`)
  }
  let raw: Buffer
  try {
    raw = await readFile(targetKey)
  } catch (error) {
    throw classify(error)
  }
  if (raw.length > maxBytes) {
    throw new NodeOpError('FS_TOO_LARGE', `cannot read "${displayPath}": content exceeds the ${maxBytes}-byte limit`)
  }
  return raw
}

// ── listing ─────────────────────────────────────────────────────────────────

/**
 * List direct children of a directory in stable name order.
 *
 * Each child carries a resolved target (so follow-up operations need no second
 * resolve) and cheap metadata. Contents are never read. A child that vanishes
 * mid-listing is an error rather than a silently dropped entry, matching the
 * local backend.
 * @param targetKey - the resolved directory target.
 * @param displayPath - caller-facing path for error messages.
 * @returns one entry per direct child, sorted by name.
 */
export async function listDir(targetKey: string, displayPath: string): Promise<NodeFsDirEntry[]> {
  const info = await probe(targetKey)
  if (!info) throw new NodeOpError('FS_NOT_FOUND', `cannot list "${displayPath}": not found`)
  if (info.type !== 'directory') {
    throw new NodeOpError('FS_NOT_DIRECTORY', `cannot list "${displayPath}": not a directory`)
  }

  let entries
  try {
    entries = await readdir(targetKey, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    throw classify(error)
  }

  const result: NodeFsDirEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childDisplay = join(displayPath, entry.name)
    const identity = await resolveTarget(targetKey, entry.name)
    const childInfo = await probe(identity.targetKey)
    result.push({
      name: entry.name,
      type: childInfo?.type ?? 'other',
      targetKey: identity.targetKey,
      displayPath: childDisplay,
      ...childInfo ? { version: childInfo.version } : {},
      ...childInfo?.type === 'file' ? { size: childInfo.size } : {},
    })
  }
  return result
}

// ── guarded writes ──────────────────────────────────────────────────────────

/**
 * Stage and atomically publish a file.
 *
 * The content is written to a mode-0600 file in a private sibling directory,
 * fsynced, then renamed onto the target. The staging directory exists so the
 * temporary never appears as a sibling the model might list, and the rename is
 * what makes the change atomic: a reader sees either the old file or the new
 * one, never a truncated one.
 *
 * `createIfAbsent` publishes with `link`, which fails rather than replacing — so
 * a concurrent creator's file survives and this write is the one refused. That
 * is the whole point of the guard: `rename` would silently clobber the winner.
 * @param targetKey - absolute path to publish.
 * @param content - the full new content.
 * @param mode - mode bits to apply, or undefined to leave the default.
 * @param createIfAbsent - when set, publish without replacing an existing file.
 */
async function writeFileAtomic(
  targetKey: string,
  content: string,
  mode: number | undefined,
  createIfAbsent: boolean,
): Promise<void> {
  const directory = dirname(targetKey)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw classify(error)
  }

  // A private staging dir beside the target keeps the rename on one filesystem
  // (a cross-device rename is not atomic) without exposing a temp file.
  const stagingDir = join(directory, `.${basename(targetKey)}.${process.pid}.${randomUUID()}.tmpdir`)
  const tempPath = join(stagingDir, `${basename(targetKey)}.tmp`)
  let handle
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    await chmod(stagingDir, 0o700)
    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content, { encoding: 'utf8' })
    // Durability before publication: without the fsync a crash can leave the
    // renamed file present but empty.
    await handle.sync()
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    if (createIfAbsent) {
      try {
        await link(tempPath, targetKey)
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') {
          throw new NodeOpError('FS_NOT_OBSERVED', 'file appeared after it was observed as absent', { cause: error })
        }
        throw classify(error)
      }
    } else {
      await rename(tempPath, targetKey)
    }
  } catch (error) {
    if (handle) { try { await handle.close() } catch { /* the primary failure is the one worth reporting */ } }
    try { await rm(stagingDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw classify(error)
  }
  try { await rm(stagingDir, { recursive: true, force: true }) } catch { /* published; cleanup is best effort */ }
}

/**
 * Read a file as the diff basis, or return null when it is unusable as one.
 *
 * A binary, non-UTF-8, oversized, or unreadable prior file yields `null` so the
 * write still succeeds and presentation falls back to a whole-file diff.
 * Losing a diff basis must never fail a write.
 * @param targetKey - the file to read.
 * @param maxBytes - exclusive upper bound on the held basis.
 * @returns the LF-normalized text, or null.
 */
async function readDiffBasis(targetKey: string, maxBytes: number): Promise<string | null> {
  let raw: Buffer
  try {
    raw = await readFile(targetKey)
  } catch {
    return null
  }
  if (raw.length >= maxBytes) return null
  if (raw.includes(0)) return null
  try {
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return null
  }
}

/**
 * Create or replace a file under an optional guard, checking the guard on the
 * node immediately before publication.
 * @param targetKey - the resolved target.
 * @param displayPath - caller-facing path for error messages.
 * @param content - the full new content.
 * @param expected - the guard, or undefined for an unconditional write.
 * @param diffBasisMaxBytes - cap on the content held as the `before` basis.
 * @returns the outcome, including the version the write produced.
 */
export async function writeText(
  targetKey: string,
  displayPath: string,
  content: string,
  expected: NodeFsWriteIntent | undefined,
  diffBasisMaxBytes = DEFAULT_DIFF_BASIS_MAX_BYTES,
): Promise<NodeFsWriteOutcome> {
  if (typeof content !== 'string') {
    throw new NodeOpError('FS_IO_ERROR', `cannot write "${displayPath}": content must be a string`)
  }
  const existing = await probe(targetKey)
  if (existing && existing.type !== 'file') {
    throw new NodeOpError('FS_NOT_REGULAR_FILE', `cannot write "${displayPath}": not a regular file`)
  }

  if (expected?.kind === 'replaceIfVersion') {
    if (!existing) throw new NodeOpError('FS_STALE_VERSION', `cannot write "${displayPath}": file no longer exists`)
    if (existing.version !== expected.version) {
      throw new NodeOpError('FS_STALE_VERSION', `cannot write "${displayPath}": file changed since it was read`)
    }
  } else if (expected?.kind === 'createIfAbsent' && existing) {
    throw new NodeOpError('FS_NOT_OBSERVED', `cannot overwrite existing "${displayPath}" without reading it first`)
  }

  // Only worth reading a basis when this is an overwrite and the new content is
  // itself small enough that a contextual diff is plausible.
  const worthABasis = existing !== undefined && Buffer.byteLength(content, 'utf8') < diffBasisMaxBytes
  const before = worthABasis ? await readDiffBasis(targetKey, diffBasisMaxBytes) : null

  await writeFileAtomic(targetKey, content, existing ? await modeOf(targetKey) : undefined, expected?.kind === 'createIfAbsent')

  const after = await probe(targetKey)
  return {
    operation: existing ? 'update' : 'create',
    // A concurrent unlink between publication and this probe leaves no version
    // to report; a sentinel keeps the outcome total rather than throwing here,
    // where the write has already durably succeeded.
    version: after?.version ?? `missing:${targetKey}`,
    before,
    after: normalizeLineEndings(content),
  }
}

// ── edits ───────────────────────────────────────────────────────────────────

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit and diff basis
 * uses. A lone `\r` not followed by `\n` is left alone, since it is content
 * rather than a line ending.
 * @param content - text in whatever line-ending style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect the dominant line-ending style of a file.
 *
 * Samples the head rather than the whole file: a mixed file still has to be
 * written back one way, and the majority of the readable prefix is the best
 * available signal.
 * @param raw - the decoded file content.
 * @returns the dominant style.
 */
function detectLineEndings(raw: string): 'LF' | 'CRLF' {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the file's original style.
 *
 * Re-normalizes first so content that already contains CRLF is not doubled into
 * `\r\r\n`.
 * @param content - LF-normalized text.
 * @param style - the style detected at read time.
 * @returns the text in that style.
 */
function restoreLineEndings(content: string, style: 'LF' | 'CRLF'): string {
  return style === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement to LF-normalized content.
 *
 * Both sides of the replacement are normalized before matching, so an
 * `oldString` written with CRLF still matches a file stored with LF — the model
 * should not have to know the file's line endings to edit it.
 * @param content - the current content, already LF-normalized.
 * @param oldString - literal text to find.
 * @param newString - literal replacement text; empty deletes the match.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - caller-facing path for error messages.
 * @returns the edited content and how many occurrences were replaced.
 */
function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new NodeOpError('FS_EDIT_NOT_FOUND', 'oldString must be a non-empty string')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new NodeOpError('FS_EDIT_NOT_FOUND', `oldString was not found in "${displayPath}"`)
  }
  // Ambiguity is refused rather than guessed at: silently editing the first of
  // several matches is how a model corrupts a file it misread.
  if (!replaceAll && replacements > 1) {
    throw new NodeOpError(
      'FS_AMBIGUOUS_EDIT',
      `oldString matched ${replacements} times in "${displayPath}"; provide a more specific oldString or set replaceAll`,
    )
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

/**
 * Apply a literal edit under an optional version guard.
 *
 * The guard is checked before matching so a stale read reports
 * `FS_STALE_VERSION` rather than `FS_EDIT_NOT_FOUND` — the caller needs to know
 * the file moved underneath them, not that their search text is now wrong.
 * @param targetKey - the resolved target.
 * @param displayPath - caller-facing path for error messages.
 * @param edit - the literal search/replace request.
 * @param expected - the version guard, or undefined for an unconditional edit.
 * @returns the outcome, including the version the edit produced.
 */
export async function editText(
  targetKey: string,
  displayPath: string,
  edit: NodeFsEditRequest,
  expected: { version: string } | undefined,
): Promise<NodeFsEditOutcome> {
  const existing = await probe(targetKey)
  if (!existing) {
    throw new NodeOpError('FS_STALE_VERSION', `cannot edit "${displayPath}": file changed since it was read`)
  }
  if (existing.type !== 'file') {
    throw new NodeOpError('FS_NOT_REGULAR_FILE', `cannot edit "${displayPath}": not a regular file`)
  }
  if (expected && existing.version !== expected.version) {
    throw new NodeOpError('FS_STALE_VERSION', `cannot edit "${displayPath}": file changed since it was read`)
  }

  let raw: Buffer
  try {
    raw = await readFile(targetKey)
  } catch (error) {
    throw classify(error)
  }
  // The whole file is inspected here, unlike a read: editing the first 8 KiB of
  // a file whose tail is binary would corrupt it.
  if (raw.includes(0)) throw binary('edit', displayPath)
  const original = decodeUtf8(raw, 'edit', displayPath)

  const normalized = normalizeLineEndings(original)
  const style = detectLineEndings(original)
  const edited = applyLiteralEdit(normalized, edit.oldString, edit.newString, Boolean(edit.replaceAll), displayPath)

  await writeFileAtomic(targetKey, restoreLineEndings(edited.content, style), await modeOf(targetKey), false)

  const after = await probe(targetKey)
  return {
    version: after?.version ?? `missing:${targetKey}`,
    before: normalized,
    after: edited.content,
  }
}

// ── containment ─────────────────────────────────────────────────────────────

/**
 * Whether `child` is `parent` or a descendant of it, by path arithmetic.
 *
 * Accepts canonical target keys, so both must come from {@link resolveTarget}.
 * `relative` returning a bare name, a non-`..` prefix, or an absolute path (a
 * different root on Windows) each decides a different case; the empty string is
 * the target itself.
 * @param parentKey - canonical directory path.
 * @param childKey - canonical candidate path.
 * @returns true when child is inside parent.
 */
export function containsPath(parentKey: string, childKey: string): boolean {
  const path = relative(parentKey, childKey)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Re-exported so the agent can build file URLs from a target key. */
export { constants }

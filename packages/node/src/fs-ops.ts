/**
 * The agent's filesystem operations: real work on the remote machine.
 *
 * These are the operations `dsh-fs-node` will drive. Paths arrive as opaque
 * strings and are resolved HERE, on the node, against the node's own path
 * namespace. The host never normalizes, joins, or realpaths a remote path —
 * it has no business knowing the remote platform's path rules, and a host that
 * tried would be wrong on the first Windows or case-insensitive node.
 * @module @shaowenchen/dsh-node-agent/fs-ops
 */

import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A stat result the host can turn into its own `FsInfo`. */
export interface NodeStat {
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  /** Milliseconds since epoch. */
  mtimeMs: number
  /** Milliseconds since epoch. */
  ctimeMs: number
  /** True when the target is a regular file holding UTF-8 text. */
  text: boolean
}

/** Failure raised by an operation, carrying the wire error code. */
export class NodeOpError extends Error {
  readonly nodeErrorCode: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NodeOpError'
    this.nodeErrorCode = code
  }
}

/** Map a Node filesystem errno onto this protocol's error vocabulary. */
function classify(error: unknown): NodeOpError {
  const code = (error as { code?: string }).code
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOENT':
      return new NodeOpError('not-found', message)
    case 'EACCES':
    case 'EPERM':
      return new NodeOpError('policy', message)
    default:
      return new NodeOpError('internal', message)
  }
}

/**
 * Classify a directory entry's kind.
 * @param entry - the dirent or stats to classify.
 * @returns the protocol's kind vocabulary.
 */
function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): NodeStat['kind'] {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * Whether a path holds decodable UTF-8 text.
 *
 * The local backend rejects binary reads rather than returning mojibake, and a
 * remote world must behave the same way or the model sees different results
 * depending on where execution happens.
 * @param path - absolute path to probe.
 * @returns true when the file is readable as UTF-8 text.
 */
async function isText(path: string): Promise<boolean> {
  try {
    const handle = await readFile(path)
    // A NUL byte in the first block is the conventional binary signal.
    return !handle.subarray(0, 8192).includes(0)
  } catch {
    return false
  }
}

/**
 * Stat a path.
 * @param path - absolute path in the node's namespace.
 * @param follow - whether to follow a final symlink.
 * @returns the entry's metadata.
 */
export async function statPath(path: string, follow = true): Promise<NodeStat> {
  try {
    const info = follow ? await stat(path) : await lstat(path)
    return {
      path,
      kind: kindOf(info),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      text: info.isFile() ? await isText(path) : false,
    }
  } catch (error) {
    throw classify(error)
  }
}

/**
 * Read a whole text file.
 * @param path - absolute path in the node's namespace.
 * @returns the decoded contents.
 */
export async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw classify(error)
  }
}

/** One directory entry. */
export interface NodeDirEntry {
  name: string
  kind: NodeStat['kind']
}

/**
 * List a directory, content-free and stably ordered.
 * @param path - absolute directory path in the node's namespace.
 * @returns the entries, sorted by name.
 */
export async function listDirectory(path: string): Promise<NodeDirEntry[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw classify(error)
  }
}

/**
 * Write a whole text file, creating parent directories.
 * @param path - absolute path in the node's namespace.
 * @param content - the text to write.
 * @returns the metadata of the written file.
 */
export async function writeTextFile(path: string, content: string): Promise<NodeStat> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return await statPath(path)
  } catch (error) {
    throw classify(error)
  }
}

/**
 * Copy one file, creating the destination's parent directories.
 * @param from - absolute source path.
 * @param to - absolute destination path.
 * @returns the metadata of the copy.
 */
export async function copyPath(from: string, to: string): Promise<NodeStat> {
  try {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
    return await statPath(to)
  } catch (error) {
    throw classify(error)
  }
}

/**
 * Remove a file or directory tree.
 * @param path - absolute path in the node's namespace.
 * @param recursive - whether to remove a directory and its contents.
 * @returns nothing; absence afterwards is the postcondition.
 */
export async function removePath(path: string, recursive = false): Promise<void> {
  try {
    await rm(path, { recursive, force: false })
  } catch (error) {
    throw classify(error)
  }
}

/**
 * Resolve a path to a canonical absolute path in this namespace.
 *
 * Deliberately does NOT realpath: the host treats the result as an opaque
 * target key, and following symlinks here would make two distinct targets
 * collide.
 * @param path - the path to resolve, made absolute against `cwd` when relative.
 * @param cwd - the execution world's working directory.
 * @returns the canonical absolute path.
 */
export async function resolvePath(path: string, cwd: string): Promise<string> {
  const { isAbsolute, resolve } = await import('node:path')
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    await access(absolute, constants.F_OK)
  } catch {
    // Absence is not an error at resolve time: a target may be created later.
    return absolute
  }
  return absolute
}

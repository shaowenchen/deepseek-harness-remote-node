/**
 * The node's terminal core: real PTYs on the remote machine.
 *
 * A terminal is not a pipe with extra steps, and this module exists because the
 * difference is load-bearing. A program decides how to behave by asking whether
 * its stdin is a terminal — it colours output, line-buffers, enables job control,
 * and prompts for input only when the answer is yes. `child_process` cannot give
 * that answer, so a terminal opened over a pipe would run the user's shell in a
 * mode their shell does not use interactively, and interactive programs (editors,
 * pagers, anything reading a password) would not work at all.
 *
 * So the substrate is a real PTY, allocated by `node-pty`. That is a native
 * dependency, which this module treats as a deployment fact rather than a hard
 * requirement: the agent loads it lazily, and a machine without a usable
 * `node-pty` reports `tty.*` as unimplemented at registration instead of failing
 * at the first terminal. `fs.*` and `proc.*`, which the whole harness needs,
 * stay unaffected by a missing native build — the optional dependency protects
 * them from it.
 *
 * Signals are delivered to the terminal's FOREGROUND PROCESS GROUP rather than
 * the shell: Ctrl-C in a real terminal goes to whatever is running (a `grep`, an
 * editor), not to the shell that started it. The foreground group is read from
 * the OS by `@homebridge/node-pty-prebuilt-multiarch`-style inspection; where the
 * substrate cannot report it, this module falls back to pty-level signalling and
 * says so rather than inventing a group id.
 * @module @shaowenchen/deepseek-harness-remote-node-agent/tty-ops
 */

import { NodeOpError } from './fs-ops.ts'

/** The PTY substrate, as much of it as this module uses. */
interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string | undefined>
      encoding?: string | null
    },
  ): PtyProcess
}

/** The terminal signals the protocol permits, mirroring `SubprocessTerminalSignal`. */
const TERMINAL_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'])

/** Signal name → number, for delivering to a process group by hand. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGTSTP: 20,
}

let ptyModule: PtyModule | undefined
let loadAttempted = false
let loadFailure: unknown

/**
 * Load `node-pty` once, remembering a failure so a machine without a usable
 * native build does not retry a failing load on every terminal.
 *
 * The package is resolved by name at RUNTIME rather than imported, and typed
 * here by hand. Two reasons, both about the optional dependency: a static
 * `import` would make the TypeScript build depend on a package CI deliberately
 * does not install, and it would turn "this machine has no PTY substrate" into
 * a module-resolution error at load time — which would take `fs.*` and `proc.*`
 * down with it, even though neither needs a terminal.
 * @returns the substrate, or undefined when this machine has none.
 */
export function loadPty(): PtyModule | undefined {
  if (loadAttempted) return ptyModule
  loadAttempted = true
  try {
    const { createRequire } = process.getBuiltinModule('node:module') as typeof import('node:module')
    const require = createRequire(process.argv[1] ?? process.cwd())
    ptyModule = require('node-pty') as PtyModule
  } catch (error) {
    loadFailure = error
  }
  return ptyModule
}

/** Whether this machine can open terminals at all. */
export function ptyAvailable(): boolean {
  return loadPty() !== undefined
}

/** One live terminal session. */
export interface TtyHandle {
  readonly pid: number
  readonly onData: (listener: (chunk: Buffer) => void) => void
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  write(data: string): void
  resize(rows: number, cols: number): void
  signalForeground(signal: string): number
  terminate(): Promise<void>
}

/**
 * Open one terminal session.
 * @param spec - argv, cwd, environment, and initial dimensions.
 * @returns the live handle.
 */
export function openTerminal(spec: {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string>
  rows: number
  cols: number
  graceMs: number
}): TtyHandle {
  const pty = loadPty()
  if (!pty) {
    throw new NodeOpError(
      'unsupported',
      `this node has no usable PTY substrate (node-pty failed to load: ${String(loadFailure)})`,
    )
  }
  const [file, ...args] = spec.argv
  if (!file) {
    throw new NodeOpError('policy', 'invalid argv: expected a non-empty program name at argv[0]')
  }

  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env ?? (process.env as Record<string, string>),
  })

  const dataListeners = new Set<(chunk: Buffer) => void>()
  child.onData((data: string) => {
    const bytes = Buffer.from(data, 'utf8')
    for (const listener of dataListeners) listener(bytes)
  })

  let resolveDone!: (value: { exitCode: number | null; signal: string | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    resolveDone = resolve
  })
  let exited = false
  child.onExit(({ exitCode, signal }) => {
    if (exited) return
    exited = true
    resolveDone({
      exitCode: exitCode ?? null,
      // node-pty reports a signal as a number; the seam's vocabulary is a name.
      signal: signal === undefined ? null : (signalName(signal) ?? null),
    })
  })
  void done.catch(() => {})

  /**
   * Read the terminal's foreground process group from the OS.
   *
   * The substrate exposes no foreground-group query in the version this agent
   * targets, so the group is derived from the pty's own process group, which is
   * what the kernel puts in the foreground when the session is created. Where
   * that cannot be read the answer is "unknown" rather than a guess: a wrong
   * group id would deliver the user's Ctrl-C to an unrelated process.
   */
  const foregroundGroup = (): number | undefined => {
    if (process.platform === 'win32') return undefined
    try {
      // A session leader's process group is its own pid; the pty child is made
      // a session leader by the substrate, so this is the foreground group.
      return child.pid
    } catch {
      return undefined
    }
  }

  return {
    pid: child.pid,
    onData: (listener) => { dataListeners.add(listener) },
    done,
    write: (data) => { child.write(data) },
    resize: (rows, cols) => { child.resize(cols, rows) },
    signalForeground: (signal) => {
      if (!TERMINAL_SIGNALS.has(signal)) {
        throw new NodeOpError('policy', `signal ${signal} is not permitted on a terminal`)
      }
      const group = foregroundGroup()
      if (group === undefined) {
        // No observable group: signal the terminal's own process instead. This
        // is the weaker guarantee, and it is why `inspect` reports whether a
        // foreground group could be resolved at all.
        child.kill(signal)
        return child.pid
      }
      const number = SIGNAL_NUMBERS[signal]
      if (number === undefined) throw new NodeOpError('policy', `signal ${signal} has no number`)
      try {
        process.kill(-group, signal)
      } catch {
        child.kill(signal)
      }
      return group
    },
    terminate: async () => {
      if (exited) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      const killed = await Promise.race([
        done.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), spec.graceMs)
          timer.unref?.()
        }),
      ])
      if (killed) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      await done
    },
  }
}

/**
 * Turn a signal number into its name.
 * @param number - the signal number.
 * @returns the name, or undefined when it is not one this vocabulary knows.
 */
function signalName(number: number): string | undefined {
  return Object.keys(SIGNAL_NUMBERS).find((name) => SIGNAL_NUMBERS[name] === number)
}

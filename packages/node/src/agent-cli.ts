#!/usr/bin/env node
/**
 * `dsh-node` — run the node agent on a remote machine.
 *
 * Kept as a thin argument parser over {@link NodeAgent}: the connection logic
 * lives in `agent.ts` so it can be embedded and tested without a process.
 * @module @shaowenchen/deepseek-harness-remote-node-agent/cli
 */

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { NodeAgent, describeAgent } from './agent.ts'

const USAGE = `dsh-node — connect this machine to a DeepSeek Harness host as its execution world

Usage:
  dsh-node --url <ws-url> [options]

Options:
  --url <url>            ws:// or wss:// URL of the host's node channel (required)
  --credential <token>   Long-lived node credential (required unless --credential-file)
  --credential-file <p>  Read the credential from a file
  --node-id <id>         Node identity (default: this machine's hostname)
  --cwd <dir>            Execution world working directory (default: current directory)
  --on-disconnect <mode> orphan | terminate  (default: orphan)
  --busy-retry <ms>      Wait before retrying a connection the host refused as
                         busy, because another connection holds the node's
                         single slot (default: 5000).
  --describe             Print this machine's identity and exit
  -h, --help             Show this help

Exit status:
  0  stopped cleanly (including a signal)
  1  bad usage
  1  the host refused registration for a reason retrying cannot fix — a protocol
     mismatch or a bad credential. A refusal of "busy" is NOT this: it retries.
`

/** Where a credential installed by an enrollment flow would live. */
const DEFAULT_CREDENTIAL_FILE = join(homedir(), '.dsh', 'node-credential')

/**
 * Parse arguments and run one agent until interrupted.
 * @returns the process exit code.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      credential: { type: 'string' },
      'credential-file': { type: 'string' },
      'node-id': { type: 'string' },
      cwd: { type: 'string' },
      'on-disconnect': { type: 'string', default: 'orphan' },
      'busy-retry': { type: 'string' },
      describe: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }

  if (values.describe) {
    const identity = describeAgent()
    process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`)
    return 0
  }

  if (!values.url) {
    process.stderr.write('dsh-node: --url is required\n\n')
    process.stderr.write(USAGE)
    return 1
  }

  let credential = values.credential
  if (!credential) {
    const path = values['credential-file'] ?? DEFAULT_CREDENTIAL_FILE
    try {
      credential = (await readFile(path, 'utf8')).trim()
    } catch {
      process.stderr.write(`dsh-node: no credential: pass --credential or install one at ${path}\n`)
      return 1
    }
  }

  const mode = values['on-disconnect']
  if (mode !== 'orphan' && mode !== 'terminate') {
    process.stderr.write(`dsh-node: --on-disconnect must be "orphan" or "terminate", got "${mode}"\n`)
    return 1
  }

  let busyRetryMs: number | undefined
  if (values['busy-retry'] !== undefined) {
    busyRetryMs = Number(values['busy-retry'])
    if (!Number.isFinite(busyRetryMs) || busyRetryMs <= 0) {
      process.stderr.write(`dsh-node: --busy-retry must be a positive number of milliseconds, got "${values['busy-retry']}"\n`)
      return 1
    }
  }

  // Resolved by the refusal handler below and read after the agent settles.
  // Set rather than thrown so the process can end on its own terms: see the
  // comment on {@link NodeAgent.onTerminalRefusal}.
  let refusalExitCode = 0

  const agent = new NodeAgent({
    url: values.url,
    credential,
    nodeId: values['node-id'],
    cwd: values.cwd ?? process.cwd(),
    onDisconnect: mode,
    busyRetryMs,
    log: (message) => { process.stderr.write(`dsh-node: ${message}\n`) },
    // `protocol` and `auth` are the two refusals a human has to fix, and the
    // exit status is how a service manager is told that restarting will not
    // help. `busy` never arrives here: this agent retries it.
    onTerminalRefusal: () => { refusalExitCode = 1 },
  })

  // The agent owns the retry loop, so wait for it to finish rather than
  // polling. It settles on `stop()`: a signal, or a refusal that cannot be
  // retried.
  const finished = agent.run()

  const shutdown = (signal: string) => {
    process.stderr.write(`dsh-node: ${signal}, shutting down\n`)
    agent.stop()
  }
  process.on('SIGINT', () => { shutdown('SIGINT') })
  process.on('SIGTERM', () => { shutdown('SIGTERM') })

  await finished
  return refusalExitCode
}

main().then(
  (code) => { process.exit(code) },
  (error: unknown) => {
    process.stderr.write(`dsh-node: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)

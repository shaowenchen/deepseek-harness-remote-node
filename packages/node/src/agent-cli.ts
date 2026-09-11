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
  --describe             Print this machine's identity and exit
  -h, --help             Show this help

Exit status:
  0  stopped cleanly
  1  bad usage, or the host refused registration
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

  const agent = new NodeAgent({
    url: values.url,
    credential,
    nodeId: values['node-id'],
    cwd: values.cwd ?? process.cwd(),
    onDisconnect: mode,
    log: (message) => { process.stderr.write(`dsh-node: ${message}\n`) },
  })

  // A refusal is terminal — the credential will not become valid by retrying.
  // `NodeAgent.stop()` on refusal leaves nothing pending, so wait for it and
  // let the process end naturally.
  agent.start()

  const shutdown = (signal: string) => {
    process.stderr.write(`dsh-node: ${signal}, shutting down\n`)
    agent.stop()
    return 0
  }
  process.on('SIGINT', () => { process.exit(shutdown('SIGINT')) })
  process.on('SIGTERM', () => { process.exit(shutdown('SIGTERM')) })

  // Stay alive: the agent owns reconnection, so there is nothing to poll.
  return await new Promise<number>(() => {})
}

main().then(
  (code) => { process.exit(code) },
  (error: unknown) => {
    process.stderr.write(`dsh-node: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)

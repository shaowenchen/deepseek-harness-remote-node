# deepseek-harness-remote-node

Turn a **remote machine** into a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) execution world.

The remote machine dials **out** to dsh over the web entry point dsh already
exposes. From then on the agent's file reads, edits, shell commands, terminals,
and language servers all happen on that machine — while the agent loop, model
calls, session state, and plugins stay on the host.

No inbound port. No public address. No NAT traversal on the remote side.

---

## What it does

dsh runs an agent that reads files, runs commands, and opens terminals. By
default it does all of that **on the machine running dsh**. This project moves
that work to another machine.

| | Without this | With this |
|---|---|---|
| `ctx.fs` — reads, writes, edits | the dsh host's disk | the node's disk |
| `ctx.subprocess` — commands, terminals, LSP | the dsh host's processes | the node's processes |
| Agent loop, model calls, session state | the dsh host | the dsh host (unchanged) |

The point is that you keep the harness where your credentials, sessions, and
model access live, while the actual work happens somewhere else — a beefier
box, a machine with the right toolchain, or one you are allowed to touch.

Ask the agent "how much disk space is left on that machine?" and the `df` it
runs executes on the **node**, not on the host. That is the whole feature.

## How it works

dsh's architecture already has two capability seams, and together they define
**one execution world**:

| Seam | What it covers |
|---|---|
| `ctx.fs` | reads, writes, edits, listings, metadata |
| `ctx.subprocess` | commands, terminals, language servers |

Higher capabilities compose on top of these two without naming a provider — so
swapping both providers moves the execution world without touching bash, PTY, or
LSP.

```
        ┌───────────────────────────────────────────────────────┐
        │  dsh host                                             │
        │                                                       │
        │  webServer  :3080                                     │
        │    ├ /api/remote.mux   ← browser mux                  │
        │    └ /node/v1          ← node channel                 │
        │                                                       │
        │  ctx.nodeRegistry ── @shaowenchen/dsh-node            │
        │  ctx.fs ........... @shaowenchen/dsh-node/fs          │
        │  ctx.subprocess ... @shaowenchen/dsh-node/subprocess  │
        └───────────────────────▲───────────────────────────────┘
                                │ wss, dialled OUT by the node
        ┌───────────────────────┴───────────────────────────────┐
        │  remote machine — dsh-node agent                      │
        │  filesystem · processes · terminals                   │
        └───────────────────────────────────────────────────────┘
```

The chain, end to end: you ask the agent something → the agent calls its `bash`
tool → `dsh-bash-local` calls `ctx.subprocess` (it never imports
`child_process`; everything goes through the seam) → **this package's
`./subprocess` entry point** forwards it over the channel → the agent on the
node runs it. Every hop is a seam swap, which is why no consumer above needs to
know where execution happens.

**One WebSocket** carries every logical stream, multiplexed by `streamId`.
Control frames are JSON text; payload frames are binary and tagged with the
channel they belong to (`stdout` / `stderr` / `stdin` / `opaque`), so one
process's streams are tellable apart. Paths are resolved **on the node** against
the node's own path namespace — the host never normalizes, joins, or realpaths a
remote path, because it would be wrong on the first Windows or case-insensitive
node.

**Output is delivered two ways on purpose**, because the two seams disagree
about its shape:

- **Collected process output is pulled.** The seam's reader is offset-addressed
  and synchronous (`readFrom(fromByte)`), so the node keeps a bounded window and
  the adapter asks for deltas.
- **Terminal output is pushed.** The seam exposes it as a `Readable`, so frames
  stream as they arrive and the reader ends when the terminal exits — via an
  explicit `op.payloadEnd`, not a timeout.

Both adapters are tested against dsh's **real** local backends
(`dsh-fs-local`, `dsh-subprocess-local`) over the same operations, so "behaves
the same as running locally" is checked rather than asserted. That comparison is
why a few things match upstream byte for byte — the output cap trims to exactly
the caller's limit, slicing inside a chunk, because the local backend does.

**Registration is single-slot.** Two agents driving one machine would corrupt
each other, so a second connection is refused with `busy` rather than merged.

## Usage

Node **22+** required. Not on npm yet, so both sides install from GitHub.

### On the dsh host

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh \
  | sh -s -- --cwd /srv/workspace
```

That downloads the package, builds it, links it into the dsh profile, and writes
the plugin config below into `$DSH_HOME/profiles/web/cordis.patch.yml`. It works
inside the `deepseek-harness-web` container too, where no package manager exists.
Skip to [On the node](#on-the-node) if you do not want to read the config.

<details>
<summary>The config it writes</summary>

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        cwd: /srv/workspace        # working directory ON THE NODE
        heartbeatIntervalMs: 2000  # ping cadence and pong deadline
        onDisconnect: orphan       # orphan | terminate node processes on a drop
    - id: fs-node
      name: '@shaowenchen/dsh-node/fs'          # serves ctx.fs
    - id: subprocess-node
      name: '@shaowenchen/dsh-node/subprocess'  # serves ctx.subprocess

# Exactly one execution world may exist. Leaving the host's own providers
# mounted beside the node's is a composition error, not a fallback — and
# whichever wins silently decides where the agent's work happens.
- id: fs-sandbox
  disabled: true
- id: fs-local
  disabled: true
- id: subprocess-local
  disabled: true
```

The two adapters take no required options. They accept a `cwd` and deliberately
ignore it: the working directory belongs to the node, and the registry already
carries it. Mount only the adapters you want — the entry points are independent.

</details>

### On the node

Run this **on the machine that becomes the execution world**, then connect it:

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-node.sh \
  | sh -s -- --bin-dir ~/.local/bin

dsh-node --url ws://<host>:3080/node/v1 --credential <token> --cwd /srv/workspace
```

It logs `registered as <nodeId> (generation 1, cwd ...)` when connected, and
reconnects with backoff after a drop. `dsh-node --describe` prints this
machine's identity without connecting.

### Then just talk to it

Once the node is registered, **you do not invoke anything.** You talk to the
agent normally, and its file and shell tools happen to run on the remote
machine. Nothing about the prompt changes; what changes is where the work lands.

**Checking the node's resources** — the canonical example. Every one of these
runs `df`/`free`/`top` on the **node**:

> 看一下那台机器的磁盘还剩多少

> Check the disk usage on the workspace machine.

> Is anything eating CPU on that box right now?

> How much memory is free there?

The agent calls its `bash` tool with `df -h`, `free -m`, `uptime`, or whatever
answers the question — and because `ctx.subprocess` is served by
`@shaowenchen/dsh-node/subprocess`, those commands execute on the node. The
output comes back through the same channel. Run the identical prompt with the
node disconnected and it fails rather than reporting the host's numbers: a
missing node is a failed execution world, never a fallback to the host. See
[SECURITY.md](SECURITY.md).

**Working on the node's files** — because `ctx.fs` points there too:

> What's in the workspace directory? Summarise what this project does.

> Find every TODO in the source tree.

> Rename `config.yaml` to `config.yml` and update the references.

These read and write the node's disk. An edit is a single guarded operation
executed *on the node*, not a host-side stat followed by a write, so the version
check and the write happen in one critical section.

**Interactive and long-running work** — terminals and processes:

> Start a dev server and tell me when it's listening.

> Open a REPL and check whether that library imports cleanly.

> Run the test suite and show me only the failures.

These go through `proc.*` and `tty.*`. Long builds keep running on the node if
the channel blips (`onDisconnect: orphan`), and terminals are real PTYs — so
anything that prompts, pages, or colours its output behaves the way it does in
your own shell.

**A note on what you will not see.** Remote paths never travel over a text
channel, and the host never rewrites them. What you see in the transcript is the
path as the node resolved it. If a path looks wrong, the node's namespace is the
thing to check — not the host's.

## Development

```sh
cd packages/node
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test over tests/*.spec.ts
npm run build       # emits lib/ and lib/types/
node lib/agent-cli.js --describe
```

57 cases over a real HTTP server, real upgrades, real sockets, real process
trees, and real PTYs — the fail-closed suite, a filesystem round-trip driven by
a real agent, process and terminal integration, and two parity suites against
the dsh local backends. No test framework: Node's built-in runner strips the
TypeScript types itself.

CI runs that sequence plus a CLI smoke test and an entry-point check on every
push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Layout

```
packages/node/                      # the published package: @shaowenchen/dsh-node
├── src/
│   ├── protocol.ts                 # frame types, operation vocabulary, failure codes
│   ├── index.ts                    # NodeRegistry (ctx.nodeRegistry): channel, identity, heartbeat
│   ├── agent.ts                    # NodeAgent: the dialling process, on the remote machine
│   ├── fs-ops.ts                   # filesystem semantics, executed on the node
│   ├── proc-ops.ts                 # process trees, escalation, bounded output collection
│   ├── tty-ops.ts                  # PTY terminals, loaded lazily (node-pty is optional)
│   ├── fs-node.ts                  # entry point ./fs: implements ctx.fs over the channel
│   ├── subprocess-node.ts          # entry point ./subprocess: implements ctx.subprocess
│   └── agent-cli.ts                # the `dsh-node` entry point
├── tests/
│   ├── fail-closed.spec.ts         # the safety property, over real sockets
│   ├── proc-tty.spec.ts            # process trees and real PTYs, end to end
│   ├── fs-parity.spec.ts           # ctx.fs vs the real dsh-fs-local
│   └── subprocess-parity.spec.ts   # ctx.subprocess vs the real dsh-subprocess-local
└── cordis.patch.yml                # the bundle patch a dsh deployment mounts

scripts/install-host.sh             # dsh-host installer, fetched from GitHub (no clone)
scripts/install-node.sh             # remote-machine agent installer, same idea
2026-09-11-remote-node-execution-world.md   # design document
```

### Terminals are conditional

`fs.*` and `proc.*` are built on Node alone; `tty.*` needs a **PTY**, because a
program decides how to behave from whether its stdin is a terminal — a pipe
would run your shell non-interactively and break anything that prompts or pages.

That substrate is `node-pty`, a native module declared as an **optional**
dependency. The consequence is deliberate: a machine where its native build
fails still installs and still serves `fs.*` and `proc.*`, and the agent
advertises `tty.*` only when a substrate loads. Where it cannot, a host refuses
those operations with `unsupported` rather than hanging on them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: the fail-closed tests
come first, and a new operation means three edits — the protocol vocabulary, the
node-side implementation, and the adapter that forwards it.

## License

MIT © Shaowen Chen — see [LICENSE](LICENSE).

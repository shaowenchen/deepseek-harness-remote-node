# deepseek-harness-remote-node

[![CI](https://github.com/shaowenchen/deepseek-harness-remote-node/actions/workflows/ci.yml/badge.svg)](https://github.com/shaowenchen/deepseek-harness-remote-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn a **remote machine** into a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) execution world.

The remote machine dials **out** to dsh over the web entry point dsh already
exposes. From then on the agent's file reads, edits, shell commands, terminals,
and language servers all happen on that machine — while the agent loop, model
calls, session state, and plugins stay on the host.

No inbound port. No public address. No NAT traversal on the remote side.

## Status

| | |
|---|---|
| ✅ **Works** | Channel, registration, heartbeat, fail-closed semantics, and the full `fs.*` operation family — tested end-to-end against a real HTTP server, real upgrades, and real sockets. |
| ✅ **Works** | The full `proc.*` family (commands) — real process trees with tree-scoped `SIGTERM`→grace→`SIGKILL` escalation, bounded collected output with spill recovery, and live stdin. |
| ✅ **Works** | The full `tty.*` family (terminals) — real PTYs, resize, and foreground-group signalling. Requires a PTY substrate on the node; see below. |
| ✅ **Works** | **`@shaowenchen/dsh-fs-node`** — the adapter that serves `ctx.fs` from the node, so the agent's file operations actually happen there. Its behaviour is verified against the real local backend. |
| ✅ **Works** | **`@shaowenchen/dsh-subprocess-node`** — the adapter that serves `ctx.subprocess` from the node, so commands, terminals, and language servers run there too. Verified against `dsh-subprocess-local`. |
| ⚠️ **Conditional** | `tty.*` needs a usable **`node-pty`** on the node. `node-pty` is an *optional* dependency, so an install without a native build still works — the agent then advertises `fs.*` and `proc.*` only. |
| ⚠️ **Not published** | No package is **on the npm registry yet**. Install from GitHub (see [Install](#install)). |

The agent advertises only what it implements, so the host refuses unimplemented
operations early with `unsupported` rather than hanging on them — see
`implementedOperations()` in [`src/agent.ts`](packages/node/src/agent.ts).

### Why terminals are conditional

`fs.*` and `proc.*` are built on Node alone; `tty.*` needs a **PTY**, because a
program decides how to behave from whether its stdin is a terminal. A pipe
cannot answer that question, so a terminal over a pipe would run the user's
shell in a non-interactive mode and break anything that prompts or pages.

That substrate is `node-pty`, a native module. It is declared as an **optional**
dependency, which is the load-bearing decision: a machine where its native build
fails still installs the agent and still serves the filesystem and process
families the harness needs, and the agent reports `tty.*` as unimplemented rather
than failing at the first terminal. `node-pty` ships prebuilds for common
platforms, so in practice most nodes have terminals.

> ### ⚠️ Read this before deploying
>
> **The node channel does not verify credentials.** Registration is gated only by
> protocol version and the single-slot rule, so **any client that can reach
> `/node/v1` can register as the node** and become the agent's execution world.
> Keep it off the public internet. Full details in [Security](#security).

## Why this shape

This is not a new distributed-runtime layer. It implements two capability seams
that already exist in dsh:

| Seam | Meaning |
|---|---|
| `ctx.fs` | File reads, writes, edits, listings, metadata |
| `ctx.subprocess` | Commands, terminals, language servers |

dsh's architecture already establishes that these two together define **one
execution world**, and that higher capabilities compose on top of them without
naming a provider. Swapping the two providers moves the execution world without
touching bash, PTY, or LSP.

The design follows the existing E2B family (`dsh-e2b` + `dsh-fs-e2b` +
`dsh-subprocess-e2b`) — one lifecycle owner plus two adapters — replacing "a
third-party cloud SDK" with "a protocol we define".

## How it works

```
        ┌──────────────────────────────────────────────┐
        │  dsh host                                    │
        │                                              │
        │  webServer  :3080                            │
        │    ├ /api/remote.mux   ← browser mux         │
        │    └ /node/v1          ← node channel        │
        │                                              │
        │  ctx.nodeRegistry ──── dsh-node              │
        │  ctx.fs ........... dsh-fs-node              │
        │  ctx.subprocess ... dsh-subprocess-node      │
        └───────────────────▲──────────────────────────┘
                            │ wss, dialled OUT by the node
        ┌───────────────────┴──────────────────────────┐
        │  remote machine — dsh-node agent             │
        │  filesystem · processes · terminals          │
        └──────────────────────────────────────────────┘
```

Both capability seams point at the node, which is what makes this machine an
execution world: the paths `ctx.fs` resolves are the paths `ctx.subprocess` runs
in, because they are the same machine's.

One WebSocket carries every logical stream, multiplexed by `streamId`. Control
frames are JSON text; payload frames are binary, each tagged with the channel it
belongs to (`stdout` / `stderr` / `stdin` / `opaque`) so a reader can tell one
process's streams apart without consulting the operation that opened them. The
split is deliberate — paths and file bytes travel on the binary side so a remote
path never passes through a text channel that could reinterpret it.

Output is delivered two ways on purpose, because the two capability seams
disagree about its shape. Collected process output is **pulled**: the host asks
for an offset and the node keeps the bounded window, matching the seam's
synchronous `readFrom(fromByte)` reader. Terminal output is **pushed**: the seam
exposes it as a `Readable`, so frames are forwarded as they arrive and the stream
is ended by an explicit `op.payloadEnd` when the terminal exits — which is also
why a `proc.spawn` with piped streams replies with `payloadContinues` rather than
letting its reply end the stream.

The frame vocabulary mirrors the browser Remote mux dsh already has
(`open` / `data` / `end` / `error` / `cancel`, one `ready` opening item, a
generation number), so a reader who knows that transport recognises this one
instead of learning a second set of rules. Paths are resolved **on the node**
against the node's own path namespace; the host never normalizes, joins, or
realpaths a remote path.

Registration is single-slot: two agents driving one machine would corrupt each
other, so a second connection is refused with `busy` rather than merged.

## Fail-closed: the one property that matters

**A disconnected node is a failed execution world, never a fallback to the host.**

If a drop were allowed to degrade into "use the local filesystem", the agent
would start editing the harness host's files while the user believes it is
working on the remote machine. That is the most dangerous failure this feature
can have, so it has its own test suite:
[`tests/fail-closed.spec.ts`](packages/node/tests/fail-closed.spec.ts).

A dropped connection therefore:

- fails every in-flight operation with `disconnected` rather than leaving
  callers suspended,
- clears the registered node so the next call refuses,
- does **not** terminate processes still running on the node (default
  `onDisconnect: orphan`) — a network blip must not kill a running build,
- does **not** reattach to a previous generation's handles. A reconnection
  increments the generation; stale handles are invalid.

## Security

**The node channel does not authenticate its peers yet.** The `hello` frame
carries a `credential` and the agent sends it, but the registry **never reads
that field**, and the protocol's `auth` refusal code has no reachable path.
Registration is gated only by the protocol version and the single-slot rule.

**Any client that can reach `/node/v1` can register as the node** and become the
execution world for everything the agent does. Enrollment, credential
verification, and rotation are specified in the [design
document](2026-09-11-remote-node-execution-world.md) (§8) but are **not
implemented**.

Until they are:

- keep `/node/v1` off the public internet — restrict it by source address at the
  reverse proxy,
- run the agent as an unprivileged user, in a container or VM whose blast radius
  you accept,
- treat `--cwd` as a *working directory, not a jail* — paths are resolved on the
  node against its own namespace and are not confined to it.

See [SECURITY.md](SECURITY.md) for the full boundary description, the other
known limitations, and a deployment checklist. To report a vulnerability, use
GitHub's [private vulnerability
reporting](https://github.com/shaowenchen/deepseek-harness-remote-node/security/advisories/new) —
not a public issue.

## Install

Node **22+** is required. The npm package is not published yet, so both sides
install straight from GitHub — no clone needed. Three steps: configure the dsh
host, install the agent on the node, then use it.

### 1. Configure the dsh host

Run this on the machine running dsh. It downloads the plugin, builds it, symlinks
it into the profile, and registers the `node-registry` row:

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh \
  | sh -s -- --cwd /srv/workspace
```

Add `--dry-run` to preview, `--ref <branch|tag|sha>` to pin a revision, or
`--dsh-home <dir>` for a non-default dsh home. Every step is idempotent, so
re-running it is the upgrade path.

Then make the node authoritative. Exactly one execution world may exist;
leaving the host's own filesystem provider mounted beside the node is a
composition error, not a fallback.

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml — append
- id: fs-sandbox
  disabled: true
```

This is left manual on purpose: with it disabled, **every filesystem tool fails
until a node connects**. That is fail-closed working as designed, but it means a
host that boots without a node is a host whose agent cannot touch a filesystem —
so it is your call, not an installer's.

Verify the composition resolves without booting:

```sh
dsh --profile web --dump-config | grep -A4 node-registry
```

<details>
<summary>Doing it by hand instead</summary>

dsh loads out-of-tree plugins through its **user patch layer**, so no package
manager is needed inside the deployment container. Fetch the source first:

```sh
curl -fsSL https://github.com/shaowenchen/deepseek-harness-remote-node/archive/master.tar.gz \
  | tar -xz -C /opt && mv /opt/deepseek-harness-remote-node-master /opt/deepseek-harness-remote-node

cd /opt/deepseek-harness-remote-node/packages/node && npm ci && npm run build

DSH_HOME=~/.dsh
SCOPE="$DSH_HOME/profiles/web/node_modules/@shaowenchen"
mkdir -p "$SCOPE"
ln -sfn /opt/deepseek-harness-remote-node/packages/node "$SCOPE/dsh-node"
```

The scope directory is `@shaowenchen`, matching the package name — a symlink into
a scope directory that does not exist will fail.

Then append to `$DSH_HOME/profiles/web/cordis.patch.yml` (append; do not replace
the file, it may carry unrelated patches):

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        cwd: /srv/workspace
        heartbeatIntervalMs: 2000
        onDisconnect: orphan
```

</details>

### 2. Configure the node

Run this **on the machine that will become the execution world**. It is a
different machine — the whole point is that the agent's filesystem work happens
there, not on the host.

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-node.sh \
  | sh -s --
```

It checks for Node 22+, downloads and builds the agent, and puts a `dsh-node`
command on your PATH (`/usr/local/bin` when writable, else `~/.local/bin`; the
script tells you if it is not on your PATH). Add `--bin-dir <dir>` to choose,
or `--ref <branch|tag|sha>` to pin a revision.

Confirm the build works and see what the host will be told about this machine:

```sh
dsh-node --describe
```

Run the agent as an unprivileged user, in a container or VM whose blast radius
you accept — see [Security](#security).

### 3. Run it

Start the host first, then connect the node:

```sh
# 1. on the host
dsh web

# 2. on the node
dsh-node --url ws://<host>:3080/node/v1 --credential <token> --cwd /srv/workspace
```

The agent logs `registered as <nodeId> (generation 1, cwd ...)` once the
handshake completes, and reconnects with jittered backoff after a drop. From
then on the agent's file operations happen on the node.

```sh
dsh-node --help        # all options
dsh-node --describe    # identity, no connection
```

If the host is not directly reachable, point `--url` at a TLS-terminating
reverse proxy and dial `wss://` instead. That path needs WebSocket upgrade
headers passed through, response buffering disabled, and read/write timeouts
**well above** `heartbeatIntervalMs` (default 2s) — the interval is both the
cadence and the deadline, so a shorter proxy timeout severs healthy
connections.

## Development

```sh
cd packages/node
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test over tests/*.spec.ts
npm run build       # emits lib/ and lib/types/
node lib/agent-cli.js --describe
```

12 cases over a real HTTP server, real upgrades, and real sockets — including the
fail-closed suite and a filesystem round-trip driven by a real agent. The suite
needs no test framework: Node's built-in runner strips the TypeScript types
itself, so the only runtime dependency is `ws`.

CI runs that same sequence plus a CLI smoke test on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

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
│   └── agent-cli.ts                # the `dsh-node` entry point
├── tests/
│   ├── fail-closed.spec.ts         # the safety property, over real sockets
│   └── proc-tty.spec.ts            # process trees and real PTYs, end to end
└── cordis.patch.yml                # the bundle patch a dsh deployment mounts

packages/fs-node/                   # @shaowenchen/dsh-fs-node
├── src/index.ts                    # NodeFileSystem: implements ctx.fs over the channel
└── tests/parity.spec.ts            # checked against the real dsh-fs-local

packages/subprocess-node/           # @shaowenchen/dsh-subprocess-node
├── src/index.ts                    # NodeSubprocessRuntime: implements ctx.subprocess
└── tests/parity.spec.ts            # checked against the real dsh-subprocess-local

scripts/install-host.sh             # dsh-host installer, fetched from GitHub (no clone)
scripts/install-node.sh             # remote-machine agent installer, same idea
2026-09-11-remote-node-execution-world.md   # design document
SECURITY.md · CONTRIBUTING.md · CHANGELOG.md
```

With all three packages mounted, the two capability seams that define an
execution world both point at the remote machine, which is the goal the design
document sets out.

## Design document

[`2026-09-11-remote-node-execution-world.md`](2026-09-11-remote-node-execution-world.md)
covers the protocol, lifecycle and failure semantics, sandbox and authorization,
the security boundary, phased implementation, and the open questions. It also
records *why not* E2B and *why not* an all-in-one container.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the two rules that matter: **never weaken fail-closed**, and **advertise only
what you implement**. Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

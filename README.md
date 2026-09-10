# dsh-remote-node

[![CI](https://github.com/shaowenchen/dsh-remote-node/actions/workflows/ci.yml/badge.svg)](https://github.com/shaowenchen/dsh-remote-node/actions/workflows/ci.yml)
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
| ✅ **Works** | Channel, registration, heartbeat, fail-closed semantics, and nine of the ten `fs.*` operations — tested end-to-end against a real HTTP server, real upgrades, and real sockets. |
| ❌ **Not implemented** | `fs.editText`, the whole `proc.*` family (commands), and the whole `tty.*` family (terminals). |
| 🚧 **Next** | `dsh-fs-node` and `dsh-subprocess-node` — the two adapters that map `ctx.fs` / `ctx.subprocess` onto this protocol. |
| ⚠️ **Not published** | The npm package is **not on the registry yet**. Install from a checkout (see [Install](#install)). |

The agent advertises only what it implements, so the host refuses unimplemented
operations early with `unsupported` rather than hanging on them — see
`IMPLEMENTED_OPERATIONS` in [`src/agent.ts`](packages/node/src/agent.ts).

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
        │  ctx.fs ........... (fs-sandbox disabled)    │
        │  ctx.subprocess ... (subprocess-local stays) │
        └───────────────────▲──────────────────────────┘
                            │ wss, dialled OUT by the node
        ┌───────────────────┴──────────────────────────┐
        │  remote machine — dsh-node agent             │
        │  filesystem · processes · terminals          │
        └──────────────────────────────────────────────┘
```

One WebSocket carries every logical stream, multiplexed by `streamId`. Control
frames are JSON text; payload frames are binary. The split is deliberate —
paths and file bytes travel on the binary side so a remote path never passes
through a text channel that could reinterpret it.

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
reporting](https://github.com/shaowenchen/dsh-remote-node/security/advisories/new) —
not a public issue.

## Install

Node **22+** is required. The npm package is not published yet, so both sides
install from a checkout.

### On the host

`scripts/install-host.sh` is the recommended path. Every step is idempotent, so
it doubles as the upgrade path — re-run it after pulling a new revision.

```sh
git clone https://github.com/shaowenchen/dsh-remote-node
cd dsh-remote-node
./scripts/install-host.sh --cwd /srv/workspace            # add --dry-run to preview
```

It builds the plugin, symlinks it into `$DSH_HOME/profiles/web/node_modules/`,
and appends the `node-registry` row to that profile's patch layer. It also tells
you the one step it deliberately leaves manual, because it is a decision rather
than a default — see [Make the node
authoritative](#make-the-node-authoritative).

<details>
<summary>Doing it by hand instead</summary>

dsh loads out-of-tree plugins through its **user patch layer**, so no package
manager is needed inside the deployment container.

```sh
cd packages/node && npm ci && npm run build && cd ../..

DSH_HOME=~/.dsh
SCOPE="$DSH_HOME/profiles/web/node_modules/@shaowenchen"
mkdir -p "$SCOPE"
ln -sfn "$PWD/packages/node" "$SCOPE/dsh-node"
```

Note the scope directory is `@shaowenchen`, matching the package name — a symlink
into a scope directory that does not exist will fail.

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

### On the remote machine

Same checkout, on the machine that will become the execution world:

```sh
git clone https://github.com/shaowenchen/dsh-remote-node
cd dsh-remote-node/packages/node
npm ci && npm run build
npm link          # puts the `dsh-node` command on PATH (may need sudo)
```

If you would rather not touch the global prefix, skip `npm link` and run the
built entry point directly — it is the same thing, from the `packages/node`
directory the block above leaves you in:

```sh
node lib/agent-cli.js --describe
```

`dsh-node --describe` prints this machine's identity without connecting — useful
to confirm the build works and to see what the host will be told.

### Make the node authoritative

Exactly one execution world may exist. Leaving the host's own filesystem
provider mounted beside the node is a composition error, not a fallback.

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: fs-sandbox
  disabled: true
```

This is left manual on purpose: with it disabled, **every filesystem tool fails
until a node connects**. That is the fail-closed behaviour working as designed,
but it means a host that boots without a node is a host whose agent cannot touch
a filesystem — so it is your call to make, not an installer's.

Verify the composition resolves without booting:

```sh
dsh --profile web --dump-config | grep -A4 node-registry
```

### Run it

```sh
# 1. on the host
dsh web

# 2. on the remote machine — loopback or trusted network
dsh-node --url ws://your-host:3080/node/v1 --credential <token> --cwd /srv/workspace

# 2'. behind a TLS-terminating proxy (see Reverse proxy below)
dsh-node --url wss://your-host/node/v1 --credential <token> --cwd /srv/workspace
```

The agent logs `registered as <nodeId> (generation 1, cwd ...)` once the
handshake completes, and reconnects with jittered backoff after a drop.

```sh
dsh-node --help        # all options
dsh-node --describe    # identity, no connection
```

## Reverse proxy

dsh's HTTP carrier has no TLS, so terminate TLS at the proxy and **dial `wss://`
from the node**:

- pass WebSocket upgrade headers for `/node/v1`,
- disable response buffering on that path,
- set read/write timeouts **well above** `heartbeatIntervalMs` (default 2s), or
  the proxy will sever a healthy connection. The interval is both the cadence
  and the deadline: a peer that has not answered the previous ping by the next
  interval is terminated.
- rate-limit `/node/v1` separately.

Node authentication is deliberately **not** the browser session cookie. That
cookie is built for browsers (`HttpOnly`, `SameSite=Strict`, host-bound, and
without `Secure` because the shipped transport is loopback HTTP) — it is the
wrong tool for authenticating a machine. Nodes use their own long-lived bearer
credential. **That credential is not verified yet** — see [Security](#security).

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
│   ├── fs-ops.ts                   # filesystem operations, executed on the node
│   └── agent-cli.ts                # the `dsh-node` entry point
├── tests/
│   └── fail-closed.spec.ts
└── cordis.patch.yml                # the bundle patch a dsh deployment mounts

scripts/install-host.sh             # idempotent installer for a dsh profile
2026-09-11-remote-node-execution-world.md   # design document
SECURITY.md · CONTRIBUTING.md · CHANGELOG.md
```

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

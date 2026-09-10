# DeepSeek Harness Sandbox

Turn a **remote machine** into a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) execution world.

The remote machine dials **into** dsh over the web entry point dsh already exposes. From then on the agent's file reads, edits, shell commands, terminals, and language servers all happen on that machine — while the agent loop, model calls, session state, and plugins stay on the host. No inbound port, no public address, no NAT traversal on the remote side.

> **Status: P0 + filesystem.** The channel, registration, heartbeat, fail-closed semantics, and nine of the ten `fs.*` operations are implemented and tested end-to-end against a running `dsh web`. Not implemented yet: `fs.editText`, and the whole `proc.*` / `tty.*` families. The agent advertises only what it implements, so the host refuses those early with `unsupported` rather than pretending — see `IMPLEMENTED_OPERATIONS` in [`src/agent.ts`](packages/node/src/agent.ts).

## Why this shape

This is not a new distributed-runtime layer. It implements two capability seams that already exist in dsh:

| Seam | Meaning |
|---|---|
| `ctx.fs` | File reads, writes, edits, listings, metadata |
| `ctx.subprocess` | Commands, terminals, language servers |

dsh's architecture already establishes that these two together define **one execution world**, and that higher capabilities compose on top of them without naming a provider. Swapping the two providers moves the execution world without touching bash, PTY, or LSP.

The design follows the existing E2B family (`dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b`) — one lifecycle owner plus two adapters — replacing "a third-party cloud SDK" with "a protocol we define".

## Fail-closed: the one property that matters

**A disconnected node is a failed execution world, never a fallback to the host.**

If a drop were allowed to degrade into "use the local filesystem", the agent would start editing the harness host's files while the user believes it is working on the remote machine. That is the most dangerous failure this feature can have, so it has its own test suite: [`tests/fail-closed.spec.ts`](packages/node/tests/fail-closed.spec.ts).

A dropped connection therefore:

- fails every in-flight operation with `disconnected` rather than leaving callers suspended,
- clears the registered node so the next call refuses,
- does **not** terminate processes still running on the node (default `onDisconnect: orphan`) — a network blip must not kill a running build,
- does **not** reattach to a previous generation's handles. A reconnection increments the generation; stale handles are invalid.

## Architecture

```
        ┌──────────────────────────────────────────────┐
        │  dsh host (deepseek-harness-web container)   │
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
        │  remote machine — dsh-node-agent             │
        │  filesystem · processes · terminals          │
        └──────────────────────────────────────────────┘
```

One WebSocket multiplexed by `streamId`: control frames are JSON, payload frames are binary. Paths and file bytes travel on the binary side so a remote path never passes through a text channel that could reinterpret it.

## Layout

```
packages/node/
├── src/
│   ├── protocol.ts    # frame types, operation vocabulary, failure codes
│   ├── index.ts       # NodeRegistry (ctx.nodeRegistry): channel, identity, heartbeat
│   ├── agent.ts       # NodeAgent: the dialling process, runs on the remote machine
│   ├── fs-ops.ts      # filesystem operations, executed on the node
│   └── agent-cli.ts   # the `dsh-node` entry point
├── tests/
│   └── fail-closed.spec.ts
└── cordis.patch.yml   # the bundle patch a dsh deployment mounts

scripts/install-host.sh                     # idempotent installer for a dsh profile
2026-09-11-remote-node-execution-world.md   # full design document
SECURITY.md · CONTRIBUTING.md · CHANGELOG.md
```

`dsh-fs-node` and `dsh-subprocess-node` — the two adapters that map `ctx.fs` / `ctx.subprocess` onto this protocol — are the next step and are specified in the design document.

## Quick start

### 1. Build the plugin

```sh
cd packages/node
npm install
npm run build
```

### 2. Install it into your dsh profile

dsh loads out-of-tree plugins through its **user patch layer**, so no package manager is needed inside the deployment container. Symlink the built package into the profile and append rows to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```sh
DSH_HOME=~/.dsh
mkdir -p "$DSH_HOME/profiles/web/node_modules/@deepseek-ai"
ln -sfn "$PWD/packages/node" "$DSH_HOME/profiles/web/node_modules/@shaowenchen/dsh-node"
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        cwd: /srv/workspace
        heartbeatIntervalMs: 2000
        onDisconnect: orphan

# Exactly one execution world may exist. Leaving the host's own filesystem
# provider mounted beside the node is a composition error, not a fallback.
- id: fs-sandbox
  disabled: true
```

Verify the composition without booting:

```sh
dsh --profile web --dump-config | grep -A3 node-registry
```

### 3. Start dsh and connect the node

```sh
dsh web
```

```sh
# on the remote machine
node packages/node/lib/agent.js --url wss://your-host/node/v1 --credential <token> --cwd /srv/workspace
```

The agent logs `registered as <nodeId> (generation 1, cwd ...)` once the handshake completes.

## Reverse proxy

dsh's HTTP carrier has no TLS, so terminate TLS at the proxy and **dial `wss://` from the node**:

- pass WebSocket upgrade headers for `/node/v1`,
- disable response buffering on that path,
- set read/write timeouts **well above** the heartbeat interval (default 2s), or the proxy will sever a healthy connection,
- rate-limit `/node/v1` separately — the enrollment token is the only pre-authentication surface.

Node authentication is deliberately **not** the browser session cookie: that cookie is built for browsers (`HttpOnly`, `SameSite=Strict`, host-bound, and without `Secure` because the shipped transport is loopback HTTP). Nodes use their own long-lived bearer credential.

> ⚠️ **That credential is not verified yet.** The agent sends it, and the
> registry ignores it: registration is gated only by protocol version and the
> single-slot rule, so **any** client that can reach `/node/v1` can register as
> the node. Enrollment and verification are specified in the design document but
> not implemented. Do not expose `/node/v1` beyond a trusted network. See
> [SECURITY.md](SECURITY.md).

## Tests

```sh
cd packages/node
npm test
```

12 cases over a real HTTP server, real upgrades, and real sockets — including the fail-closed suite and a filesystem round-trip driven by a real agent. CI runs the same `typecheck` / `test` / `build` sequence plus a CLI smoke test on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Design document

[`2026-09-11-remote-node-execution-world.md`](2026-09-11-remote-node-execution-world.md) covers the protocol, lifecycle and failure semantics, sandbox and authorization, the security boundary, phased implementation, and the open questions. It also records *why not* E2B and *why not* an all-in-one container.

## Security

⚠️ **The node channel does not verify credentials yet** — any client that can reach `/node/v1` can register as the node. Keep it off the public internet, and read [SECURITY.md](SECURITY.md) for the full boundary description, the other known limitations, and the deployment checklist. To report a vulnerability, use GitHub's [private vulnerability reporting](https://github.com/shaowenchen/dsh-remote-node/security/advisories/new) rather than a public issue.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the layout, and the two rules that matter (never weaken fail-closed; advertise only what you implement). Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

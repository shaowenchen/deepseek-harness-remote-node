# @shaowenchen/deepseek-harness-remote-node

Turn a **remote machine** into a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) execution world. The node dials **out** to the harness host over the Web
entry point dsh already exposes — no inbound port, no public address, no NAT
traversal on the remote side.

## What is in this package

One package, three entry points. Install it once; mount what you need.

| Entry point | Mounts | What it is |
|---|---|---|
| `@shaowenchen/deepseek-harness-remote-node` | `ctx.nodeRegistry` | The host-side channel: identity, WebSocket, heartbeat, generation |
| `@shaowenchen/deepseek-harness-remote-node/fs` | `ctx.fs` | Filesystem adapter — file operations run on the node |
| `@shaowenchen/deepseek-harness-remote-node/subprocess` | `ctx.subprocess` | Process adapter — commands, terminals, and language servers run on the node |
| — | — | plus the `dsh-node` bin, the agent that runs on the **remote** machine |

The registry is the lifecycle owner; the two adapters are consumers of it, and
neither creates its own world. That is the same shape the E2B family uses
(`dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b`), with the provider named by
this protocol instead of a third-party SDK.

They are separate entry points rather than one auto-mounting plugin because
either adapter alone already changes where the agent's work happens. That is a
deployment decision, not a default this package should impose — and it keeps the
`dsh-*` seam packages optional, so a composition mounting only `ctx.fs` never
needs `dsh-subprocess` installed.

## Install

```sh
npm install @shaowenchen/deepseek-harness-remote-node
```

The package ships a [cordis](https://github.com/deepseek-ai/cordis) bundle patch,
so a dsh deployment can mount it directly. See the
[main README](https://github.com/shaowenchen/deepseek-harness-remote-node#readme) for the
full install path, including `scripts/install-host.sh` for container
deployments where no package manager is available.

## Mounting

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/deepseek-harness-remote-node'
      config:
        cwd: /home/you/.deepseek-harness-remote-node
        heartbeatIntervalMs: 2000
        onDisconnect: orphan
    - id: fs-node
      name: '@shaowenchen/deepseek-harness-remote-node/fs'
    - id: subprocess-node
      name: '@shaowenchen/deepseek-harness-remote-node/subprocess'

# Exactly one execution world may exist. Leaving the host's own providers
# mounted beside the node's is a composition error, not a fallback.
#
# The ids to disable are the ones YOUR profile actually mounts. `fs-sandbox`
# (which wraps fs-local) and `subprocess` are the ids in the shipped web and
# headless profiles; `fs-local` / `subprocess-local` exist as packages but are
# not the ids there, so naming them disables nothing. Check with:
#   dsh --profile <name> --dump-config | grep -E 'id: (fs|subprocess)'
- id: fs-sandbox
  disabled: true
- id: subprocess
  disabled: true

# The host's sandbox cannot confine the node either. `dsh-sandbox-local` picks
# its runner (Seatbelt / bwrap / Landlock) from the platform dsh ITSELF runs on,
# then wraps commands that execute on the node — so a macOS host driving a Linux
# node emits `sandbox-exec`, which is not there, and every command fails. Until
# a sandbox provider for the node's platform is mounted, run the host with:
#   DSH_PERMISSION_MODE=danger-full-access dsh web
```

## Quick start

On the remote machine:

```sh
dsh-node --url wss://your-host/node/v1 --credential <token> --cwd ~/.deepseek-harness-remote-node
```

The agent logs `registered as <nodeId> (generation 1, cwd ...)` once the
handshake completes, and reconnects with jittered backoff after a drop.

```sh
dsh-node --describe   # print this machine's identity without connecting
dsh-node --help
```

## Fail-closed

**A disconnected node is a failed execution world, never a fallback to the
host.** `NodeRegistry.open()` refuses with the `disconnected` code when no node
is registered, so a drop can never degrade into the agent editing the harness
host's own files — or, for the process adapter, running commands there. Every
in-flight operation is rejected rather than left suspended, and a reconnection
increments the generation so stale handles are invalid.

Both adapters are held to that property by their own tests.

## The adapters match the local backends

`ctx.fs` and `ctx.subprocess` must behave the same whether they are served by the
host's own machine or by a remote node, and both claims are checked against the
real `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-subprocess-local` over the
same operations rather than against a description of them.

That comparison is why a few things match upstream byte for byte. The
collected-output cap, for instance, trims to *exactly* the caller's limit —
slicing inside a chunk — because the local backend does; keeping whole chunks
would return a different tail for the same stream, and no caller would know why.

Failures keep their **code**, not just their shape, so a code crosses the wire
unchanged and the policy layer above gives the same answer wherever execution
happened.

## Security

⚠️ **The node channel does not authenticate its peers yet.** The `credential`
field is sent on the wire but is **not verified** by the registry, and the
`auth` refusal code is not yet reachable — registration is gated only by protocol
version and the single-slot rule. Do not expose `/node/v1` beyond a trusted
network.

The process adapter runs **arbitrary commands** on the node with the agent user's
privileges, and `tty.*` opens interactive sessions with the same reach. There is
no allow-list and no command policy: the sandbox is the agent's OS identity and
whatever container or VM it runs in.

See [SECURITY.md](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/SECURITY.md)
for the full boundary description and reporting process.

## Status

**Complete.** The channel, registration, heartbeat, fail-closed semantics, and
all three operation families (`fs.*`, `proc.*`, `tty.*`) are implemented and
tested end-to-end over real sockets, real process trees, and real PTYs, plus two
parity suites against the local backends.

`tty.*` is advertised **conditionally**: it needs a PTY substrate
([`node-pty`](https://www.npmjs.com/package/node-pty)) on the node, which is
declared as an *optional* dependency so a machine without a usable native build
still serves `fs.*` and `proc.*`. Where no substrate loads, the agent omits the
`tty.*` operations and a host refuses them early with `unsupported` rather than
hanging on them.

## License

MIT © Shaowen Chen — see [LICENSE](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/LICENSE).

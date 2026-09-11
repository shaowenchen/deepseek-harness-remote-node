# @shaowenchen/dsh-node

Turn a **remote machine** into a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) execution world. The node dials **out** to the harness host over the Web
entry point dsh already exposes — no inbound port, no public address, no NAT
traversal on the remote side.

This package contains both halves of the channel:

- **`NodeRegistry`** (default export) — the host-side service, mounted as
  `ctx.nodeRegistry`. Owns identity, the WebSocket channel, heartbeat, and the
  connection generation.
- **`dsh-node`** (bin) — the agent that runs on the remote machine and turns it
  into an execution world.

The `dsh-fs-node` and `dsh-subprocess-node` adapters that map `ctx.fs` and
`ctx.subprocess` onto this channel live in the main repository.
## Install

```sh
npm install @shaowenchen/dsh-node
```

The package ships a [cordis](https://github.com/deepseek-ai/cordis) bundle patch,
so a dsh deployment can mount it directly. See the
[main README](https://github.com/shaowenchen/deepseek-harness-remote-node#readme) for the
full install path, including `scripts/install-host.sh` for container
deployments where no package manager is available.

## Quick start

On the remote machine:

```sh
dsh-node --url wss://your-host/node/v1 --credential <token> --cwd /srv/workspace
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
host's own files. Every in-flight operation is rejected rather than left
suspended, and a reconnection increments the generation so stale handles are
invalid.

## Security

⚠️ **The node channel does not authenticate its peers yet.** The `credential`
field is sent on the wire but is **not verified** by the registry, and the
`auth` refusal code is not yet reachable — registration is gated only by protocol
version and the single-slot rule. Do not expose `/node/v1` beyond a trusted
network.

See [SECURITY.md](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/SECURITY.md)
for the full boundary description and reporting process.

## Status

**Complete.** The channel, registration, heartbeat, fail-closed semantics, and
all three operation families (`fs.*`, `proc.*`, `tty.*`) are implemented and
tested end-to-end over real sockets, real process trees, and real PTYs.

`tty.*` is advertised **conditionally**: it needs a PTY substrate
([`node-pty`](https://www.npmjs.com/package/node-pty)) on the node, which is
declared as an *optional* dependency so a machine without a usable native build
still serves `fs.*` and `proc.*`. Where no substrate loads, the agent omits the
`tty.*` operations and a host refuses them early with `unsupported` rather than
hanging on them.

## License

MIT © Shaowen Chen — see [LICENSE](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/LICENSE).

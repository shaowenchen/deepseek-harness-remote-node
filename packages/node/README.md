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
[main README](https://github.com/shaowenchen/dsh-remote-node#readme) for the
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

See [SECURITY.md](https://github.com/shaowenchen/dsh-remote-node/blob/master/SECURITY.md)
for the full boundary description and reporting process.

## Status

**P0 + filesystem.** The channel, registration, heartbeat, fail-closed
semantics, and the `fs.*` operation family are implemented and tested
end-to-end. `proc.*` and `tty.*` are **not** implemented: the agent advertises
only what it implements, so a host refuses those early with `unsupported`
rather than hanging on them.

## License

MIT © Shaowen Chen — see [LICENSE](https://github.com/shaowenchen/dsh-remote-node/blob/master/LICENSE).

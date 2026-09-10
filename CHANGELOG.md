# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffolding: `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and
  GitHub issue/PR templates.
- A package-level README so the npm tarball documents itself.

### Fixed

- Corrected the repository URL to `dsh-remote-node` (the package previously
  pointed at a name that does not exist).
- Documented that the node channel **does not verify credentials**, in the
  README and `scripts/install-host.sh`. The install script previously implied
  that any non-empty credential was accepted, when in fact the `credential`
  field is never read by the registry at all.

## [0.1.0] — 2026-09-11

First cut. **P0 + filesystem**: the channel, registration, heartbeat,
fail-closed semantics, and the `fs.*` operation family, tested end-to-end
against a real HTTP server, real upgrades, and real sockets.

### Added

- **`NodeRegistry`** (`ctx.nodeRegistry`) — the host-side service. Owns the
  `/node/v1` WebSocket channel, node identity, heartbeat liveness, and the
  connection generation. Single-slot registration: a second node is refused with
  `busy` rather than merged.
- **`NodeAgent`** — the process on the remote machine. Dials **out** to the host
  (no inbound port, no NAT traversal), reconnects with jittered exponential
  backoff, and enforces its own sandbox.
- **`dsh-node` CLI** — `--url`, `--credential` / `--credential-file`,
  `--node-id`, `--cwd`, `--on-disconnect`, `--describe`.
- **`/node/v1` protocol** — one WebSocket multiplexed by `streamId`; JSON control
  frames, binary payload frames. Frame vocabulary mirrors the existing browser
  Remote mux (`open` / `data` / `end` / `error` / `cancel`, a `ready` opening
  item, a generation number). Version mismatch is refused, not negotiated.
- **`fs.*` operations** — `fs.resolve`, `fs.stat`, `fs.lstat`, `fs.readText`,
  `fs.streamText`, `fs.writeText`, `fs.list`, `fs.copy`, `fs.remove` are
  implemented. `fs.editText` is declared in the protocol vocabulary but **not**
  implemented. Paths are resolved on the node against its own namespace; the
  host never normalizes a remote path.
- **Fail-closed semantics** — a disconnected node rejects every in-flight
  operation with `disconnected` rather than leaving callers suspended, clears the
  registered node so the next call refuses, does **not** terminate node
  processes by default (`onDisconnect: orphan`), and does not reattach to a
  previous generation's handles. Covered by `tests/fail-closed.spec.ts`, which
  runs over real servers and real sockets.
- **Cordis bundle patch** (`cordis.patch.yml`) so the plugin can be mounted by a
  dsh deployment.
- `scripts/install-host.sh` — idempotent installer for a local dsh profile,
  usable in the `deepseek-harness-web` container where no package manager exists.

### Added

- **`@shaowenchen/dsh-fs-node`** — the adapter that serves `ctx.fs` from the
  node, so the agent's file operations actually happen on the remote machine.
  Its behaviour is verified against the real `@deepseek-ai/dsh-fs-local` over
  the same operations (`tests/parity.spec.ts`), including error codes, listing
  order, CRLF preservation through an edit, and `readBytes` caps.
- **The full `fs.*` surface on the node** — targets carry a realpath-derived
  identity (`fs.resolve`), metadata carries a freshness token (`fs.stat`,
  `fs.lstat`), and `readBytes` carries its own cap so an unbounded file can
  never be buffered across the wire.
- **Guarded mutations on the node** — `fs.writeText` takes a
  `createIfAbsent`/`replaceIfVersion` intent and `fs.editText` performs literal
  search/replace, both checking the guard inside the critical section that
  publishes. A version token derived from device, inode, size, and
  nanosecond-resolution mtime/ctime is what a guard compares against.
- `scripts/install-node.sh` — installs the agent on a remote machine straight
  from GitHub, and both installers now download by default, so neither side
  needs a clone.
- `fs.contains` and `fs.paths` — containment, and the process path / `file:` URL
  facts only the node can answer.

### Changed

- `fs.copy` and `fs.remove` are no longer in the operation vocabulary. They were
  never part of the `FileSystem` seam, and shimming them over the generic
  protocol would have been a second, drifting implementation of semantics the
  seam does not define.
- The node's failure codes now mirror `FsErrorCode` **by name** so a code
  crosses the wire unchanged. Upstream branches on these codes, so a lossy
  mapping would make the remote world behave differently from the local one.

### Security

- Known and documented: **the node channel does not authenticate its peers.**
  Registration is gated only by protocol version and the single-slot rule. Do
  not expose `/node/v1` beyond a trusted network — see
  [SECURITY.md](SECURITY.md).

### Not implemented

`proc.*` and `tty.*` are declared in the protocol vocabulary but not
implemented, and there is no `dsh-subprocess-node` yet — so commands, terminals,
and language servers still run wherever the subprocess provider points. The agent
advertises only what it implements, so a host refuses those operations early with
`unsupported` rather than hanging on them.

[Unreleased]: https://github.com/shaowenchen/dsh-remote-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shaowenchen/dsh-remote-node/releases/tag/v0.1.0

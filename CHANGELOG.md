# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`--proxy` on both installers, for a network that cannot reach GitHub.**
  `github.com` and `raw.githubusercontent.com` are unreliable from mainland
  China, and the installers fetch from both. `--proxy URL` (or `DSH_PROXY`)
  names a mirror, and the whole GitHub URL is PREPENDED to it with the scheme
  and host intact:

      --proxy https://ghproxy.chenshaowen.com
        → https://ghproxy.chenshaowen.com/https://github.com/…/archive/master.tar.gz

  The naive concatenation is `$PROXY/$URL`, and the authority is split off
  before joining rather than left in place: the result is parsed as a single
  URL, so the `://` of the inner one has to survive as a path component. The
  first version of this joined `${1%%://*}` — which is `https`, without the
  colon — and produced a URL the mirror 404'd. Splitting the scheme first and
  re-attaching it with the authority is what makes it parse.

  A trailing slash on the proxy is tolerated, so both spellings work. The proxy
  in effect is printed in the installer header on **every** path, including the
  two that download nothing (a local checkout): a mirror that is set and
  silently unused is the failure worth designing out, since the operator who
  passed it is on a network where the direct URL does not work.

  The bootstrap is the one step a flag inside the script cannot carry — the
  script is not on the machine yet — so the README shows the initial `curl`
  prepending the mirror by hand, with `--proxy` passed afterwards so the source
  tarball comes through the same mirror.

- **Credential verification on the node channel.** The `hello` frame's
  `credential` was designed for, carried on the wire, and never read: before
  this, registration was gated only by protocol version and the single-slot
  rule, so anything that could reach `/node/v1` got a shell and a filesystem on
  the node machine. The protocol has carried the `auth` refusal code from the
  start, and it now has a reachable path.

  Two configuration routes supply the expected value, in priority order:
  `credential` in the plugin config (what the installer writes), or a
  `nodeCredential` reference resolved through `ctx.credentials` so a deployment
  that already manages secrets never writes this one down. When neither is set
  the channel does not authenticate — the deliberate default that keeps an
  existing deployment working — and the host says so on **every** registration,
  because a silently-open channel is worse than a knowingly-open one.

  The comparison is constant-time and both operands are hashed first. Hashing is
  the part worth recording: comparing raw buffers needs a length check first,
  and that check is a separate, very fast step that leaks the secret's LENGTH
  before an attacker starts on its bytes.

  `scripts/install-host.sh` generates a credential, stores it at
  `$DSH_HOME/node-credential` (0600), and reuses it on later runs so
  re-installing never invalidates a node that is already connected.
  `--credential` supplies one instead. A generated value is 32 characters of
  `[A-Za-z0-9]` with at least one upper-case letter, one lower-case letter, and
  one digit, drawn from `/dev/urandom` — 62 symbols over 32 positions, about 190
  bits, and short enough that an operator pastes it into `dsh-node --credential`
  by hand rather than copying it between files.

  Still missing, and documented as such: no enrollment flow, no rotation, and no
  per-node identity — verification answers "is this the shared secret", not
  "which node is this".

### Changed

- **The three packages are now one.** `@shaowenchen/deepseek-harness-remote-node` carries all three
  entry points — the registry at `.`, the filesystem adapter at `./fs`, and the
  subprocess adapter at `./subprocess` — so `@shaowenchen/dsh-fs-node` and
  `@shaowenchen/dsh-subprocess-node` no longer exist. Neither was ever
  published, so nothing depended on them.

  What this buys: one install, one version to keep in step, and one lockfile.
  What it deliberately does not change: the entry points stay separate rather
  than collapsing into one auto-mounting plugin, because either adapter alone
  already moves where the agent's work happens — a deployment decision, not a
  default. The `dsh-*` seam packages are now **optional** peers, so a
  composition mounting only `ctx.fs` does not need `dsh-subprocess` installed.

  The layout follows upstream: `@deepseek-ai/dsh-agent` likewise exposes `.` and
  `./invariant`, and a dsh bundle patch mounts it as
  `name: '@deepseek-ai/dsh-agent/invariant'`.

- **The `proc.*` family** — ordinary processes, executed on the node over
  `node:child_process`. `proc.resolve`, `proc.spawn`, `proc.read`,
  `proc.signal`, and `proc.wait` are implemented. Processes are spawned
  `detached` and signalled as a **process group**, so termination reaches the
  whole tree rather than leaving helpers behind; `SIGTERM`→`graceMs`→`SIGKILL`
  escalation is the only termination verb.
- **The `tty.*` family** — real PTYs on the node, via `node-pty`. `tty.open`,
  `tty.write`, `tty.resize`, `tty.signal`, `tty.inspect`, `tty.wait`, and
  `tty.close` are implemented. `tty.*` is advertised **only when a PTY substrate
  loads**, so a machine without a usable native build reports those operations as
  unimplemented instead of failing at the first terminal.
- **The `ctx.subprocess` adapter** (entry point `@shaowenchen/deepseek-harness-remote-node/subprocess`)
  — serves commands, terminals, and language servers from the node. Its behaviour
  is verified against the real `@deepseek-ai/dsh-subprocess-local` over the same
  operations, including process trees, output caps, piped streams, and real
  terminals.
- **Bounded collected output with spill recovery.** A collected stream keeps an
  in-memory window trimmed to EXACTLY the cap, reports when it dropped the head,
  and optionally keeps the complete stream in a spill file. Trimming matches the
  local backend byte for byte so a caller cannot tell which machine ran the
  process.
- **Payload channel tagging.** Binary frames now carry the channel they belong
  to (`stdout` / `stderr` / `stdin` / `opaque`) after the stream id, so a
  process's two output streams are distinguishable without consulting the
  operation that opened the stream.
- **`op.payloadEnd`** and the `payloadContinues` flag on `op.end`, so a stream
  whose output outlives its opening reply — a terminal, or a process with piped
  stdio — ends its reader on the real event rather than on a timeout.
- Repository scaffolding: `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and
  GitHub issue/PR templates.
- A package-level README so the npm tarball documents itself.

### Changed

- `NodeRegistry.invoke` accepts an `AbortSignal`, so a caller can stop waiting on
  a remote operation. The cancellation deliberately does not reach the node:
  abandoning a read must not kill the process being watched.
- `invoke` no longer drains the payload iterator. It awaits the result alone,
  which is what a unary caller wants and what keeps a `proc.spawn` with a piped
  stream from blocking until that stream closes.

### Fixed

- **The adapters never declared the registry they depend on.** `fs-node` and
  `subprocess-node` read `ctx.nodeRegistry` through a type cast, but cordis
  guards every service read: an undeclared access throws
  `cannot get property "nodeRegistry" without inject`, before any operation
  runs. Every command and file operation failed with an error about the
  framework rather than about the work. Both now declare
  `static inject = ['nodeRegistry']`, which also makes load order irrelevant —
  cordis parks the adapter until the registry appears.

  Found by driving the harness against a real machine. No in-process test could
  have caught it: the tests mount the registry before the adapters, which is the
  one order that happened to work.

- **The reconnect timer was `unref()`'d, so the agent exited when it dropped.**
  Between attempts the socket that was keeping the event loop open is already
  gone, so Node found an empty loop and exited mid-reconnect. The log said
  `reconnecting in 287ms` and then the process was simply not there —
  indistinguishable from a crash, and with no error to search for. `stop()`
  clears the timer, so the `unref` was doing nothing except killing the agent
  exactly when it was needed. The regression test spawns a real `agent-cli`
  process, because in-process the runner's own handles mask the effect.

- **Commands were spawned in the host's working directory, not the node's.**
  The host sends its own notion of the workspace — `/Users/you/project` as the
  HARNESS HOST sees it — which does not exist on the node. A nonexistent `cwd`
  is reported by Node as `spawn <program> ENOENT`, naming the EXECUTABLE, so a
  Linux node answered "bash is not installed" while bash sat at `/usr/bin/bash`
  and the real cause stayed invisible.

  `usableCwd` now resolves it on the node, which is the only side that can stat
  it: a path that exists there is used as given, and one that does not falls
  back to the directory the agent was started with. Both spawn paths go through
  it, so terminals and commands agree about where they run.

- A refusal is now recorded on the HOST as well as the agent. The reason a
  connection was rejected was previously only visible on the node, which then
  reconnects and retries — and the node is the machine the operator may not be
  looking at.

### Changed

- **Registration, refusal, and disconnect are reported on the host's stderr.**
  The host was silent about the one fact an operator most needs: which machine
  is currently its execution world. The disconnect line carries the count of
  streams it just failed, which is the difference between a node leaving quietly
  and work being rejected mid-flight.

  Deliberately stderr rather than `ctx.logger`: that service is a ring buffer
  with no console exporter in the shipped profiles, so an `info()` there is
  captured and printed nowhere. A logging call that silently goes nowhere is
  worse than none, because it reads as coverage that does not exist.

- Corrected the repository URL: the package pointed at `dsh-remote-node`, a name
  that does not exist. The repository was later renamed to
  `deepseek-harness-remote-node`, and every reference follows it.
- Documented that the node channel **does not verify credentials**, in the
  README and `scripts/install-host.sh`. The install script previously implied
  that any non-empty credential was accepted, when in fact the `credential`
  field is never read by the registry at all.
- `proc.wait` and `tty.wait` no longer discard the handle they waited on.
  Collected output stays readable after exit — the seam's batch shape is "await
  the outcome, then read everything" — so a waited process must remain
  addressable.

### Removed

- `proc.write` from the protocol vocabulary. A process's stdin is written on the
  stream that spawned it, not through a separate operation, and the operation was
  never implemented.

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

`proc.*` and `tty.*` were declared in the protocol vocabulary but not
implemented in this release, and there was no `dsh-subprocess-node` yet — so
commands, terminals, and language servers still ran wherever the subprocess
provider pointed. The agent advertised only what it implemented, so a host
refused those operations early with `unsupported` rather than hanging on them.

All three families landed in [Unreleased] above.

[Unreleased]: https://github.com/shaowenchen/deepseek-harness-remote-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shaowenchen/deepseek-harness-remote-node/releases/tag/v0.1.0

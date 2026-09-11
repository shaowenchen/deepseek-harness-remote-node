# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/shaowenchen/deepseek-harness-remote-node/security/advisories/new)
(**Security** tab → **Report a vulnerability**). Please do not open a public
issue for a suspected vulnerability.

Include the affected revision, what you observed, and the smallest
reproduction you have. You can expect an initial response within a few days.
Please allow time for a fix to be released before publishing.

## Threat model

`dsh-node` gives a remote machine control over an agent's filesystem and process
operations. The security boundary is therefore **the node channel**: anything
that can complete a handshake on `/node/v1` becomes the execution world for the
agent, and every file the agent reads or writes lands on that machine.

The `@shaowenchen/deepseek-harness-remote-node/fs` and `@shaowenchen/deepseek-harness-remote-node/subprocess` entry
points are the consumers of that boundary: they serve `ctx.fs` and
`ctx.subprocess` from whichever node is connected, so mounting them is what
makes the remote machine authoritative for file operations and for running
commands.

The two properties the design deliberately enforces:

- **Fail-closed.** An absent or disconnected node refuses every operation with
  the `disconnected` code. It never degrades into using the harness host's own
  filesystem, which would silently mutate host files the user believes are
  remote.
- **Single-slot registration.** Only one node may be registered at a time. A
  second connection is refused with `busy` rather than merged, because two
  agents driving one machine would corrupt each other.

## Known limitations — read before exposing the channel

These are **not** vulnerabilities to report; they are documented, known gaps.

### The node channel does not authenticate its peers yet

The `hello` frame carries a `credential`, and the agent sends it — but the
registry **does not read or verify that field**, and the protocol's `auth`
refusal code has no reachable path. Registration is gated only by:

1. the protocol version, and
2. the single-slot rule (first connection wins).

Consequently **any client that can reach `/node/v1` can register as the node**
and become the execution world. Enrollment, credential verification, and
rotation are specified in
[the design document](2026-09-11-remote-node-execution-world.md) (§8) but are
**not implemented**.

**Do not expose `/node/v1` beyond a trusted network** — terminate at a reverse
proxy, restrict the path by source address, and keep it off the public internet
until verification lands.

### Other gaps

- **No sandbox confinement.** The agent runs operations with its own process
  privileges against the node's real filesystem. A remote node *replaces* the
  execution world rather than registering into `ctx.sandbox`, so what the
  deployment's OS-level isolation gives you is what the agent gets. Run the
  agent as an unprivileged user, in a container or VM whose blast radius you
  accept.
- **No path confinement.** Paths are resolved on the node against its own
  namespace and are not confined to `--cwd`. A host that sends an absolute path
  outside the workspace gets it. The `cwd` is a working directory, not a jail.
- **`fs.readText` classifies rather than filters.** The agent reports whether a
  file decodes as UTF-8 text so the host can reject binary reads, but that is a
  fidelity measure, not a secret filter. Anything the agent's user can read, the
  agent can return.
- **No rate limiting.** The transport does not bound request rate; apply limits
  at the reverse proxy.
- **A network drop orphans node processes by default** (`onDisconnect: orphan`)
  rather than reaping them. This is deliberate — a blip must not kill a running
  build — but it means processes outlive the channel. Use `terminate` where that
  is not acceptable.
- **`proc.*` is arbitrary code execution on the node.** Once a client is
  registered, `proc.spawn` runs any executable that machine can run, with the
  agent user's privileges, and `tty.*` opens interactive sessions with the same
  reach. There is no allow-list and no command policy: the sandbox is the agent's
  OS identity and whatever container or VM it runs in. This is the same boundary
  the filesystem family already draws, stated plainly because "run a command" is
  the capability people underestimate.
- **Child processes get a scrubbed environment, but not a confined one.** The
  agent passes the child the environment the host specified, and does not forward
  credential-shaped or `DSH_*` names implicitly. That protects against *leaking*
  the harness's own secrets into a child; it does not stop a command the host
  asked for from reading anything the agent user can read.

## Deployment checklist

- [ ] Keep `/node/v1` off the public internet until credential verification is
      implemented.
- [ ] Terminate TLS at a reverse proxy and dial `wss://` from the node. dsh's
      HTTP carrier is loopback HTTP with no TLS of its own.
- [ ] Pass WebSocket upgrade headers for `/node/v1` and disable response
      buffering on that path.
- [ ] Set proxy read/write timeouts **well above** `heartbeatIntervalMs`
      (default 2s), or the proxy will sever healthy connections.
- [ ] Rate-limit `/node/v1` separately.
- [ ] Run the agent as an unprivileged user, confined to the blast radius you
      accept.
- [ ] Treat the node's working directory as untrusted input from the host's
      perspective, and the host's requests as privileged from the node's.

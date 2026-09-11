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
        │  ctx.nodeRegistry ── @shaowenchen/deepseek-harness-remote-node            │
        │  ctx.fs ........... @shaowenchen/deepseek-harness-remote-node/fs          │
        │  ctx.subprocess ... @shaowenchen/deepseek-harness-remote-node/subprocess  │
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
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh | sh
```

That downloads the package, builds it, links it into the dsh profile, and writes
the plugin config below into `$DSH_HOME/profiles/web/cordis.patch.yml`. It works
inside the `deepseek-harness-web` container too, where no package manager exists.
Skip to [On the node](#on-the-node) if you do not want to read the config.

**`--cwd` is a path on the NODE**, in the node's namespace — not this machine's.
It defaults to `$HOME/.deepseek-harness-remote-node`, which is right for most
setups; pass it when the work belongs somewhere else, such as a mounted volume:

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh \
  | sh -s -- --cwd /data/.deepseek-harness-remote-node
```

It is **created if missing** — including parents — by the agent on the node, so
there is nothing to prepare by hand. A path you cannot write is reported at
startup rather than discovered on the first command.

Two notes on the default. The leading dot means `ls` and most file pickers hide
it, which is intended for a directory the tool owns — `--cwd` takes any path if
you would rather browse your work. And it is deliberately not `/srv/workspace`,
which is common in examples but safe nowhere: `/srv` is a Linux convention that
macOS lacks entirely, and on Linux it exists but is empty, so that path exists
by default on no platform at all.

<details>
<summary>The config it writes</summary>

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/deepseek-harness-remote-node'
      config:
        cwd: /home/you/.deepseek-harness-remote-node  # working directory ON THE NODE
        credential: <generated by the installer>  # what agents must present
        heartbeatIntervalMs: 2000  # ping cadence and pong deadline
        onDisconnect: orphan       # orphan | terminate node processes on a drop
    - id: fs-node
      name: '@shaowenchen/deepseek-harness-remote-node/fs'          # serves ctx.fs
    - id: subprocess-node
      name: '@shaowenchen/deepseek-harness-remote-node/subprocess'  # serves ctx.subprocess

# Exactly one execution world may exist. Leaving the host's own providers
# mounted beside the node's is a composition error, not a fallback — and
# whichever wins silently decides where the agent's work happens.
#
# The ids to disable are the ones THIS profile actually mounts. `fs-sandbox`
# (which wraps fs-local) and `subprocess` are the ids in the shipped web and
# headless profiles; `fs-local` / `subprocess-local` exist as packages but are
# not the ids there, so naming them disables nothing. Check with:
#   dsh --profile <name> --dump-config | grep -E 'id: (fs|subprocess)'
- id: fs-sandbox
  disabled: true
- id: subprocess
  disabled: true

# The host's sandbox cannot confine the node.
#
# `dsh-sandbox-local` picks its confinement runner (Seatbelt on macOS, bwrap or
# Landlock on Linux) from the platform of the machine dsh runs on — the HOST.
# The commands it wraps then execute on the NODE. On a macOS host driving a
# Linux node that means every command is wrapped in `sandbox-exec`, a macOS-only
# binary, and every command fails with `spawn sandbox-exec ENOENT`.
#
# The node cannot be sandboxed by the host's provider, so pick one:
#
#   * Run the agent with a full-access mode, which takes the unconfined path
#     (`dsh-bash-sandbox` returns to the plain local executor when the mode is
#     `danger-full-access`). Appropriate when the node is a machine you own and
#     the agent is already trusted with it:
#
#         DSH_PERMISSION_MODE=danger-full-access dsh web
#
#   * Or mount a sandbox provider for the node's platform instead of disabling
#     anything — the seam is a capability, and this package is one of several
#     possible providers.
#
# Until one of those is in place the node will report a working channel and then
# fail every command with a missing-executable error that names the wrong thing.
```

The two adapters take no required options. They accept a `cwd` and ignore it: the
working directory belongs to the node, and the registry already carries it. Mount
only the adapters you want — the entry points are independent.

**Where commands run.** The host sends its own idea of the working directory —
the shell layer passes the session workspace, which is a path as the host sees
it (`/Users/you/project`). The node checks that path against its own filesystem:
if it exists there it is used as given, and if it does not it falls back to the
directory the agent was started with. So a plain session works without anyone
knowing the remote layout, and naming a real remote directory still means what
it says.

</details>

### On the node

Run this **on the machine that becomes the execution world**, then connect it:

```sh
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-node.sh \
  | sh -s -- --bin-dir ~/.local/bin
```

Then connect it. `wss://` here is the host's public address, not a local port:

```sh
dsh-node --url wss://<host>/node/v1 \
  --credential <the value install-host.sh printed> \
  --cwd ~/.deepseek-harness-remote-node
```

It logs `registered as <nodeId> (generation 1, cwd ...)` when connected, and
reconnects with backoff after a drop. `dsh-node --describe` prints this
machine's identity without connecting.

The credential must match the one in the host's plugin config. If you used
`install-host.sh`, it generated one and printed it; the same value is in
`$DSH_HOME/node-credential`. A generated credential is 32 characters of
`[A-Za-z0-9]`, which is short enough to paste here directly. Both sides
presenting nothing means the channel does not authenticate, and the host says so
on every registration.

### Removing it

```sh
# On the host — removes the plugin symlink and the config entries it added.
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/uninstall.sh | sh -s -- --host

# On the node — removes the command and the cached source.
curl -fsSL https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/uninstall.sh | sh -s -- --node
```

With no flags it undoes whichever half is present. **Restart dsh afterwards** —
the patch layer is read at startup, so a running host keeps the plugin mounted
until then.

What it deliberately leaves alone: the workspace directory (it holds the
agent's work — `--purge-workspace` removes it), the generated credential (a
secret is not a script's to delete), and any patch entry you wrote yourself. It
only removes lines carrying the installer's own marker comments, and refuses to
delete a `dsh-node` it did not generate.

### Then just talk to it

Once the node is registered, **you invoke nothing.** You talk to the agent
normally and its tools happen to run on the remote machine.

Reading — runs `df`, `free`, `top` on the node, because `ctx.subprocess` is
served from there:

> How much disk space is left on the workspace machine?

Writing — edits the node's disk, because `ctx.fs` is served from there:

> Rename `config.yaml` to `config.yml` and update the references.

That is the whole interaction. The prompt does not change; what changes is where
the work lands. With the node disconnected both fail rather than reporting the
host's numbers — a missing node is a failed execution world, never a fallback.
See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: the fail-closed tests
come first, and a new operation means three edits — the protocol vocabulary, the
node-side implementation, and the adapter that forwards it.

## License

MIT © Shaowen Chen — see [LICENSE](LICENSE).

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
That refusal is the one retryable one: the slot frees as soon as the incumbent
closes, so the refused agent waits and dials again instead of exiting. A node
running a duplicate agent therefore stays up — but see
[one agent per node](#on-the-node), because a duplicate is still not a state to
leave running.

## Usage

Both installers are `sh` scripts that fetch the source and build it on the
machine they run on. They need:

| | Required | For |
|---|---|---|
| **Node 22+ and npm** | both machines | building the package |
| `sh`, `curl`, `tar` | both machines | fetching and unpacking the source |

Nothing else — no package manager, no root, no npm account. `npm` fetches from
the public registry and needs a few hundred MB of scratch space under
`$XDG_CACHE_HOME` to build in.

<details>
<summary>Installing Node 22 with nvm</summary>

`nvm` installs Node into your home directory, so it needs no root and no
distribution packages. Node 22 is the floor this project requires; 24 (the
current LTS) is the better default.

`PROXY` works here the same way it does below — empty when GitHub is reachable,
a prepending mirror when it is not. **Set it before the nvm installer, not after:
nvm fetches `nvm.sh` itself, from the same blocked host, and its installer has no
proxy option of its own.**

```sh
PROXY=  # if github.com is unreachable, e.g. https://ghproxy.chenshaowen.com

# -- nvm --
# METHOD=script downloads the scripts instead of git-cloning, which also means
# this works with no git. PROFILE=/dev/null keeps it from editing your rc files.
# nvm downloads nvm.sh, nvm-exec and bash_completion from raw.githubusercontent
# ITSELF, and takes no proxy option — so the mirror has to be applied to the
# installer's own command line, not just to nvm's.
curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh" \
  | sed "s#https://raw.githubusercontent.com#${PROXY:+$PROXY/}https://raw.githubusercontent.com#g" \
  | METHOD=script PROFILE=/dev/null bash

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

# -- Node --
# nodejs.org is frequently unreachable from the same networks github is. Point
# nvm at a mirror — it serves the official prebuilt binaries, so nothing is
# compiled and no toolchain is needed.
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node

nvm install 22        # or 24, the current LTS
node -v               # v22.x
npm -v
```

With `PROXY` empty the `sed` is a no-op, so the same block runs unedited on a
normal network.

Make it survive a new shell — append to `~/.bashrc` (or `~/.zshrc`):

```sh
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

If `npm install` then fails on the registry rather than on GitHub, point npm at
a mirror too — this is a separate network path from the GitHub one:

```sh
npm config set registry https://registry.npmmirror.com
```

</details>

Node runs the build, so **both** the host and the node need it; the node needs
it at *run* time as well, since `dsh-node` is a Node program.

Every block below starts with an empty `PROXY`. **If `github.com` is unreachable
from that machine — mainland China, typically — set it to a mirror that
prepends**, e.g. `https://ghproxy.chenshaowen.com`; leave it empty otherwise.

### On the dsh host

```sh
PROXY=  # if github.com is unreachable, e.g. https://ghproxy.chenshaowen.com

curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh" \
  | sh -s -- --proxy "$PROXY"
```

That downloads the package, builds it, links it into the dsh profile, and writes
the plugin config below into `$DSH_HOME/profiles/web/cordis.patch.yml`. It works
inside the `deepseek-harness-web` container too, where no package manager exists.
Skip to [On the node](#on-the-node) if you do not want to read the config.

**`--cwd` is a path on the NODE**, in the node's namespace — not this machine's.
It defaults to `$HOME/.deepseek-harness-remote-node`, which is right for most
setups; pass it when the work belongs somewhere else, such as a mounted volume:

```sh
PROXY=  # if github.com is unreachable, e.g. https://ghproxy.chenshaowen.com

curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-host.sh" \
  | sh -s -- --cwd /data/.deepseek-harness-remote-node --proxy "$PROXY"
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
PROXY=  # if github.com is unreachable, e.g. https://ghproxy.chenshaowen.com

curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/install-node.sh" \
  | sh -s -- --bin-dir ~/.local/bin --proxy "$PROXY"
```

The requirements are in [Usage](#usage); the one worth repeating here is that
`node` and `npm` must be on `PATH` for a **non-interactive** shell. `$SHELL` is
consulted only as a *fallback* for the case where a login rc file is what put
`node` there (nvm), so a host that leaves `SHELL` unset — a container, a
Kubernetes pod — is fine, but a machine where `node` is only defined in an
interactive shell is not.

Then connect it. `wss://` here is the host's public address, not a local port:

```sh
dsh-node --url wss://<host>/node/v1 \
  --credential <the value install-host.sh printed> \
  --cwd ~/.deepseek-harness-remote-node
```

It logs `registered as <nodeId> (generation 1, cwd ...)` when connected, and
reconnects with backoff after a drop. `dsh-node --describe` prints this
machine's identity without connecting.

**Run exactly one agent per node id.** The channel is single-slot, and the node
id defaults to this machine's hostname, so a second agent for the same id is
refused as `busy`. That refusal is retried rather than fatal — the agent waits
for the slot instead of exiting — but two contenders swapping one slot is not a
state to leave running. The usual cause is a supervisor starting an agent while
an earlier manual `nohup`/`ssh` one is still alive; check with:

```sh
pgrep -af agent-cli.js   # expect exactly one line
```

<details>
<summary>Keeping it up with pm2</summary>

Any supervisor works, and `pm2` is the one that needs a note — for where a
credential ends up, and for what `dsh-node` actually is.

**Keep the credential out of the command line.** A `--credential` argument is
readable by anything that can run `ps`, and pm2 also writes its command line
into its own dump file — a bearer token, retained somewhere you will not think
to look for it. Use `--credential-file` instead; it is the same value, at rest
in a `0600` file:

```sh
# the subshell umask is what makes the file 0600 — without it the redirection
# creates it world-readable for the moment before you think to chmod it
(umask 077; printf '%s\n' '<the value install-host.sh printed>' > ~/.dsh-node-credential)

pm2 start /root/.local/bin/dsh-node --name dsh-node --interpreter none -- \
  --credential-file ~/.dsh-node-credential \
  --url wss://<host>/node/v1 \
  --cwd /root/.deepseek-harness-remote-node

pm2 save    # otherwise the process list does not survive a reboot
```

**The environment is not a way around that.** pm2 reads `--env` and
`ecosystem.config.js` from disk, and records both in the dump, so a token moved
into an environment variable is the same disclosure one indirection later.
Anything other than the file above should be a secret your supervisor reads at
launch from a `0600` source.

**Start it from one supervisor only.** pm2's restart-on-failure is exactly the
scenario the `busy` retry exists for, and exactly the one that must not be
doubled — a manual `dsh-node` or a second supervisor beside pm2 leaves two
agents trading the node's single slot. The `pgrep` check above is the one to
run.

**`--interpreter none` and the `--` are pm2 syntax, not dsh-node's.** `dsh-node`
is a `sh` wrapper around `agent-cli.js`, with the interpreter path baked in by
the installer, so it is meant to be executed, not run as JavaScript — and `--`
is what tells pm2 everything after it belongs to the agent rather than to pm2.

</details>

Two machines that share a hostname collide the same way, permanently, since
neither is ever the only claimant. Give one of them an explicit
`--node-id` in that case; two different ids on one host would also "work", but
they are two execution worlds competing for the same machine, which is the thing
the single-slot rule exists to prevent.

A refusal does not always mean a duplicate, though. The slot is released when
the **host** notices the previous connection is gone, and a peer that died
without a clean close (a killed process, a severed link) is not noticed until the
heartbeat gives up on it — up to `2 × heartbeatIntervalMs`. A `busy` refusal
within a few seconds of a restart is that window, not a second agent, and the
retry clears it on its own. If a machine is being supervised, keep it to one
supervisor set to restart on failure; the agent exits non-zero only for refusals
that retrying cannot fix (a protocol mismatch or a bad credential).

The credential must match the one in the host's plugin config. If you used
`install-host.sh`, it generated one and printed it; the same value is in
`$DSH_HOME/node-credential`. A generated credential is 32 characters of
`[A-Za-z0-9]`, which is short enough to paste here directly. Both sides
presenting nothing means the channel does not authenticate, and the host says so
on every registration.

### Removing it

```sh
PROXY=  # if github.com is unreachable, e.g. https://ghproxy.chenshaowen.com

# On the host — removes the plugin symlink and the config entries it added.
curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/uninstall.sh" \
  | sh -s -- --host

# On the node — removes the command and the cached source.
curl -fsSL "${PROXY:+$PROXY/}https://raw.githubusercontent.com/shaowenchen/deepseek-harness-remote-node/master/scripts/uninstall.sh" \
  | sh -s -- --node
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

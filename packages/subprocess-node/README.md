# @shaowenchen/dsh-subprocess-node

`ctx.subprocess` backed by a **remote machine**. With
[`dsh-fs-node`](https://www.npmjs.com/package/@shaowenchen/dsh-fs-node) mounted
beside it, both capability seams that define an execution world point at the
node — so the agent's file operations, commands, terminals, and language servers
all happen on that machine, while the agent loop, model calls, and session state
stay on the host.

Requires [`@shaowenchen/dsh-node`](https://www.npmjs.com/package/@shaowenchen/dsh-node),
which owns the channel this adapter talks over.

## Mounting

Both halves are needed: the node registry owns the connection, and this plugin
serves `ctx.subprocess` from it.

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        cwd: /srv/workspace
    - id: subprocess-node
      name: '@shaowenchen/dsh-subprocess-node'

# Exactly one execution world may exist. Leaving the host's own subprocess
# provider mounted beside the node is a composition error, not a fallback —
# it would run commands on the harness host.
- id: subprocess-local
  disabled: true
```

Until a node connects, **every operation fails**. That is the fail-closed
property working as designed, not a misconfiguration — see below.

## Fail-closed

A disconnected node is a **failed execution world, never local execution**.
Every operation goes through the registry, which refuses with `disconnected` when
nothing is registered, and this adapter has no fallback path of its own.

The stakes are higher here than for the filesystem. If a drop could degrade into
"run it on the host", the agent would execute commands on the harness machine
while the user believes it is working on the remote one. Returning an error is
the only safe answer, and it is asserted in
[`tests/parity.spec.ts`](tests/parity.spec.ts).

## Behaviour matches the local backend

This package claims that `ctx.subprocess` behaves the same whether it is served
by the host's own machine or by a remote node. That claim is checked against the
real `@deepseek-ai/dsh-subprocess-local` over the same operations rather than
against a description of it: executable resolution, exit codes, stdout/stderr
separation, collected-output caps and their `lossy` flag, stdin delivery, piped
streams, and tree-scoped termination. Terminal allocation is checked too, where
the node has a PTY.

Failures keep their **code**. The node's error vocabulary crosses the wire
unchanged, so a caller can tell a policy refusal from an infrastructure failure
the same way in either world.

### Where the semantics are enforced

**On the node, not here.** Three things cannot be reconstructed from the host
side, and all three live on the machine that owns the processes:

- **Termination is tree-scoped.** Every child is spawned `detached` and
  signalled as a process *group* (`-pid`), with the direct child as the fallback
  when the group is already gone. Signalling only the root pid leaves helpers
  behind — killing `npm run build` while `esbuild` keeps running is the ordinary
  failure. Windows has no POSIX groups and uses `taskkill /T` instead.
- **Collected output is bounded at the source.** The node keeps a byte-indexed
  window trimmed to exactly the caller's cap, reports when the head was dropped,
  and can keep the complete stream in a spill file. Streaming the whole thing to
  the host first would defeat the cap the caller set.
- **Guards run in one critical section.** `SIGTERM`→`graceMs`→`SIGKILL`
  escalation watches the whole tree's liveness, so a tier is held until the tree
  is genuinely gone rather than until the direct child exits.

### Why the reader is offset-addressed

The seam's collected-output reader is **synchronous** — `readFrom(fromByte)` —
while the node is not. This adapter keeps a local mirror of the node's window so
reads answer immediately, refreshed in the background while the process runs.

The important part is that the handle's `done` resolves only **after** a final
sync. Without that, the batch shape — "await the outcome, then read everything"
— would race the last bytes of every process and miss them. The mirror is only
ever a prefix of the node's window, so an answer is never wrong, only stale.

## Terminals need a PTY on the node

`tty.*` requires `node-pty` on the node. A pipe cannot stand in for a terminal:
a program decides how to behave from whether its stdin is one, so a shell behind
a pipe runs non-interactively and anything that prompts or pages breaks.

`node-pty` is therefore an **optional** dependency of `@shaowenchen/dsh-node`.
Where its native build is unavailable, the agent simply does not advertise
`tty.*`, and `spawnTerminal` surfaces `unsupported` — it does not silently
degrade a terminal into a pipe, because that would change how the user's shell
behaves without telling anyone.

## Configuration

| Option | Meaning |
|---|---|
| `cwd` | Accepted for symmetry with the local backend and **deliberately ignored**. The execution world's working directory belongs to the node; the registry already carries it and the agent resolves against it. |

## Security

This adapter does **not** confine execution. `proc.spawn` runs any executable the
node can run, with the agent user's privileges; `spawnTerminal` opens interactive
sessions with the same reach. There is no allow-list and no command policy — the
sandbox is the agent's OS identity and whatever container or VM it runs in.

`inherit`-mode stdio is **refused** rather than reinterpreted: the node's own
descriptors are not the host's, so passing them through would put a remote
build's output on the wrong machine.

See [SECURITY.md](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/SECURITY.md).

## Status

**Complete**, with one conditional: `tty.*` works where the node has a PTY
substrate and reports `unsupported` where it does not. See above.

## License

MIT © Shaowen Chen

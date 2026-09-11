# @shaowenchen/dsh-fs-node

`ctx.fs` backed by a **remote machine**. This is the adapter that makes the
node channel useful: it implements dsh's `FileSystem` seam and forwards every
operation to whatever node is currently connected on `ctx.nodeRegistry`, so the
agent's file reads, writes, and edits happen on that machine while the agent
loop and session state stay on the host.

Requires [`@shaowenchen/dsh-node`](https://www.npmjs.com/package/@shaowenchen/dsh-node),
which owns the channel this adapter talks over.

## Mounting

Both halves are needed: the node registry owns the connection, and this plugin
serves `ctx.fs` from it.

```yaml
- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        cwd: /srv/workspace
    - id: fs-node
      name: '@shaowenchen/dsh-fs-node'

# Exactly one execution world may exist. Leaving the host's own filesystem
# provider mounted beside the node is a composition error, not a fallback.
- id: fs-sandbox
  disabled: true
- id: fs-local
  disabled: true
```

Until a node connects, **every filesystem operation fails**. That is the
fail-closed property working as designed, not a misconfiguration — see below.

## Fail-closed

A disconnected node is a **failed execution world, never a fallback to the
host**. Every operation goes through the registry, which refuses with
`disconnected` when nothing is registered, and this adapter has no fallback path
of its own.

That matters more than it sounds. If a drop could degrade into "use the local
filesystem", the agent would start editing the harness host's files while the
user believes it is working on the remote machine. Returning an error is the
only safe answer, and it is asserted in
[`tests/parity.spec.ts`](tests/parity.spec.ts).

## Behaviour matches the local backend

This package claims that `ctx.fs` behaves the same whether it is served by the
host's own filesystem or by a remote node. That claim is checked against the
real `@deepseek-ai/dsh-fs-local` over the same operations rather than against a
description of it: text reads, stat metadata, listings and their order, binary
and non-regular-file rejection, `readBytes` caps, write outcomes, CRLF
preservation through an edit, and containment.

Failures keep their **code**, not just their shape. The node's error vocabulary
mirrors `FsErrorCode` by name so a code crosses the wire unchanged — the policy
layer above branches on codes, and a lossy mapping would give it a different
answer depending on where execution happened.

### Where the semantics are enforced

**On the node, not here.** `writeText` and `editText` are single operations
rather than a host-side stat followed by a write, so the version check and the
publication happen in one critical section on the machine that owns the file. A
stat-then-write from the host would leave a window between the check and the
write for another writer to slip through, silently defeating the guard it just
passed.

### Line endings

Edits normalize CRLF to LF before matching and restore the file's original style
on write-back, so an `oldString` written with LF matches a file stored with
CRLF, and the file keeps its line endings. A file with mixed endings is written
back as its dominant style — the same compromise the local backend makes.

## Configuration

| Option | Meaning |
|---|---|
| `cwd` | Accepted for symmetry with the local backend and **deliberately ignored**. The execution world's working directory belongs to the node; the registry already carries it and the agent resolves relative paths against it. A host that set it here would be claiming to know the remote layout. |

## Security

This adapter does **not** confine mutations. `sandboxMode` is `undefined`
because confinement on a node is an OS-level property of how the agent runs — an
unprivileged user, a container, a VM — not something the host can enforce across
the channel. What the deployment's isolation gives you is what the agent gets.

Paths are resolved on the node against its own namespace and are **not confined
to `cwd`**: the working directory is a resolution default, not a jail.

See [SECURITY.md](https://github.com/shaowenchen/deepseek-harness-remote-node/blob/master/SECURITY.md).

## Status

**Complete.** The other half of the execution world —
[`dsh-subprocess-node`](https://www.npmjs.com/package/@shaowenchen/dsh-subprocess-node)
— backs `ctx.subprocess` from the same node, so commands, terminals, and
language servers run there too. Mount both and the two seams describe one
machine.

`streamText` currently returns the whole file as a single chunk: the node
returns the text in one result and the adapter yields it once. The seam's
contract is about what a consumer observes, and a one-chunk iterable satisfies
it; framing chunks onto the wire is a later change that does not alter the
signature.

## License

MIT © Shaowen Chen

# Contributing

Thanks for taking a look. This is a small, focused codebase — the notes below
are the things that are not obvious from reading it.

## Setup

```sh
cd packages/node
npm ci
npm run build
```

Then, to verify a change:

```sh
npm run typecheck   # tsc --noEmit
npm test            # node --test over tests/*.spec.ts
npm run build       # emits lib/ and lib/types/
node lib/agent-cli.js --describe
```

Node **22+** is required (`engines`). The suite needs no test framework: Node's
built-in runner strips the TypeScript types itself, so the only runtime
dependency is `ws`.

## Layout

| Path | What lives there |
|---|---|
| `src/protocol.ts` | Frame types, operation vocabulary, failure codes. The wire contract. |
| `src/index.ts` | `NodeRegistry` — the host-side service, `ctx.nodeRegistry`. Channel, identity, heartbeat, generations. |
| `src/agent.ts` | `NodeAgent` — the dialling process that runs on the remote machine. |
| `src/fs-ops.ts` | The `fs.*` implementations, executed on the node. |
| `src/agent-cli.ts` | The `dsh-node` argument parser. Thin on purpose. |
| `tests/fail-closed.spec.ts` | The safety property. See below. |

## Two rules that matter

### 1. Never weaken the fail-closed property

A disconnected node must be a **failed execution world**, never a fallback to
the harness host. If a drop ever degraded into "use the local filesystem", the
agent would edit the host's files while the user believes it is working on the
remote machine. That is the most dangerous failure this feature can have.

`tests/fail-closed.spec.ts` is the executable statement of that property, and it
runs over real HTTP servers, real upgrades, and real sockets. If a change makes
one of those tests inconvenient, the property is what is right — not the test.

### 2. Advertise only what you implement

`IMPLEMENTED_OPERATIONS` in `src/agent.ts` is kept directly beside the `execute`
switch that fulfils it, because a capability list maintained separately from its
implementation drifts — and a drifted list is worse than no list, since the host
would promise the model work the node cannot do. When you add an operation,
update both, and have it answer `unsupported` until it genuinely works.

`proc.*`, `tty.*`, and `fs.editText` are currently declared in the protocol but
deliberately **not** implemented. They exist so the vocabulary is stable, not as
a promise. Do not advertise them until they work.

## Code style

Enforced by [`.editorconfig`](.editorconfig): 2-space indent, LF, final newline,
trim trailing whitespace (except Markdown). Match the surrounding style —
the codebase favours a heavy explanatory comment on *why* a thing is shaped the
way it is, and no comment restating *what* the line does.

### TypeScript import extensions

Source imports carry explicit `.ts` extensions (`./agent.ts`) and include the
**extension** — `allowImportingTsExtensions` is on, and
`tsconfig.build.json` rewrites them to `.js` at build time via
`rewriteRelativeImportExtensions`. Write `./foo.ts` in `src/`, and do not add a
`.js` specifier by hand; the build handles it.

## Tests

- Tests are `*.spec.ts` under `packages/node/tests/` and run with
  `node --test --test-timeout=15000 "tests/*.spec.ts"`.
- Prefer a real socket, a real HTTP server, and a real `NodeAgent` over a mock.
  The properties this project cares about are about what crosses the wire.
- Use `waitFor` from the existing suite rather than a fixed sleep, and always
  tear down servers and agents so the suite does not hang.
- A test that asserts a refusal should assert the **error code**, not just that
  it threw — the code is the contract.

## Commits and pull requests

- Keep commits focused; explain *why* in the message body when the change is not
  self-evident.
- CI (`.github/workflows/ci.yml`) runs typecheck, test, build, and a CLI smoke
  test. All four must pass.
- If you change the wire protocol, say so explicitly in the PR: `protocol.ts` is
  versioned by `NODE_PROTOCOL_VERSION`, and a mismatch is refused rather than
  negotiated.

## Adding a new operation

1. Add its name to `NodeOperation` in `src/protocol.ts` (and to the right family
   if it takes a new prefix).
2. Implement it on the node in `src/fs-ops.ts` (or a sibling module), mapping
   Node's errno onto the protocol's error vocabulary with `classify`.
3. Add it to `IMPLEMENTED_OPERATIONS` and the `execute` switch in `src/agent.ts`.
4. Test it through a real registered agent, asserting both the success path and
   its failure codes.

Operations are added to the agent first; the `dsh-fs-node` /
`dsh-subprocess-node` adapters that consume them live in the main repository.

## Security

Read [SECURITY.md](SECURITY.md) before touching the channel, path handling, or
anything that widens what a node or a host may ask of the other. Do not report
vulnerabilities in a public issue.

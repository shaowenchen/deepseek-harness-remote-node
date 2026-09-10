## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!--
The reasoning, not the diff. If this touches the channel, path handling, or
lifecycle, explain the failure mode you are preventing.
-->

## Type

- [ ] Bug fix
- [ ] New operation or capability
- [ ] Documentation
- [ ] Refactor (no behaviour change)
- [ ] Breaking change to the wire protocol

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes, and `node lib/agent-cli.js --describe` still runs
- [ ] Fail-closed is preserved: a disconnected node still refuses, and nothing
      falls back to the host filesystem
- [ ] Anything newly advertised in `IMPLEMENTED_OPERATIONS` is genuinely
      implemented in the `execute` switch beside it
- [ ] New or changed operations are covered by a test asserting their **error
      codes**, not just that they threw
- [ ] No secrets, credentials, or private hostnames are included in the diff

## Protocol impact

<!--
Delete this section if the wire format is untouched. If it changed, say what
changed, whether NODE_PROTOCOL_VERSION needs a bump, and how an older peer
behaves. A version mismatch is refused rather than negotiated, so a bump is a
breaking change for existing nodes.
-->

## Verification

<!--
How you convinced yourself. Real output beats a description — include the test
names, or the commands you ran and what they printed.
-->

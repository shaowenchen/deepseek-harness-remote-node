/**
 * Credential verification for node registration.
 *
 * Until this module existed the `credential` field crossed the wire and was
 * never read: registration was gated only by protocol version and the
 * single-slot rule. Anyone who could reach `/node/v1` got a shell and a
 * filesystem on the node machine. This is the check that was designed for and
 * never written — the protocol has carried the `auth` refusal code from the
 * start.
 *
 * The comparison is constant-time. A node credential is a bearer secret
 * presented on a network socket, so a byte-by-byte comparison that returns
 * early leaks its prefix through timing: an attacker who can measure the
 * handshake can recover the secret one byte at a time. `timingSafeEqual` is the
 * only primitive used here, and lengths are compared separately because
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 *
 * A credential that is not a valid reference name is hashed before comparison.
 * `credentialRef` requires a POSIX-identifier-shaped name (`NODE_CREDENTIAL`),
 * because that is what a settings file can hold, but operators paste real
 * tokens — the project's own documentation has been showing a base64url one.
 * Rejecting those outright would make the feature useless for the obvious case;
 * hashing collapses any string to a fixed-width digest that IS comparable in
 * constant time, without storing or logging the token itself.
 * @module @shaowenchen/deepseek-harness-remote-node/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** A resolved expected credential, or the reason there is none. */
export type ExpectedCredential =
  /** Nothing is configured; this deployment asked not to verify. */
  | { kind: 'unset' }
  /** A credential was configured, by one of the two routes below. */
  | { kind: 'value'; value: string; source: string }

/**
 * Constant-time string comparison that also hides the length of the expected
 * value.
 *
 * Two properties, and the second is the one that is easy to miss:
 *
 * 1. The comparison itself does not branch on content — `timingSafeEqual` is
 *    used for every byte, always.
 * 2. Both operands are hashed FIRST, so a wrong-length guess costs the same as
 *    a wrong-value one. Comparing raw buffers would compare lengths in a
 *    separate, very fast step, and an attacker could learn the secret's length
 *    before starting on its bytes. Hashing makes every comparison 32 bytes.
 * @param presented - the credential the agent sent.
 * @param expected - the credential this host expects.
 * @returns true when they match.
 */
export function credentialMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * The credential this host expects, if any.
 *
 * Two routes, in priority order, because the two deployments differ:
 *
 * - `credential` in the plugin config. This is what a composition file sets,
 *   and what the installers write. Preferred when present — it is a property of
 *   THIS mount, visible in `--dump-config`.
 * - The `nodeCredential` reference resolved through `ctx.credentials`. That
 *   service exists so a secret is referenced by NAME in configuration and
 *   resolved from the environment or an encrypted store, never written down.
 *   It is how a deployment that already manages secrets supplies this one.
 *
 * An empty string is treated as unset: an unset variable resolves to `''`, and
 * comparing against `''` would reject every agent with an "invalid credential"
 * message that says nothing about the real problem. Failing open on empty is
 * deliberate and is the one behaviour here that must not be quietly changed —
 * it is what keeps an existing deployment working across this upgrade.
 * @param configValue - `credential` from the plugin config, if any.
 * @param resolve - resolver for the `nodeCredential` reference, if the
 *   credentials service is mounted.
 * @returns what to compare against, or that nothing was configured.
 */
export async function expectedCredential(
  configValue: string | undefined,
  resolve: (() => Promise<string | undefined>) | undefined,
): Promise<ExpectedCredential> {
  if (typeof configValue === 'string' && configValue.length > 0) {
    return { kind: 'value', value: configValue, source: 'plugin config' }
  }
  if (resolve) {
    let resolved: string | undefined
    try {
      resolved = await resolve()
    } catch {
      // A credentials service that cannot answer is not a license to admit
      // anyone. Treat it as configured-but-unavailable so the caller refuses.
      return { kind: 'value', value: '', source: 'unresolvable reference' }
    }
    if (typeof resolved === 'string' && resolved.length > 0) {
      return { kind: 'value', value: resolved, source: 'credentials service' }
    }
  }
  return { kind: 'unset' }
}

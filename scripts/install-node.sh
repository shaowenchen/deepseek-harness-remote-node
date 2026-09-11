#!/bin/sh
# Install the dsh-node agent on a remote machine, straight from GitHub.
#
# Run this ON the machine that will become the execution world. It fetches the
# source, builds it, and puts a `dsh-node` command on PATH. No clone, no npm
# registry (the package is not published yet).
#
# Every step is idempotent, so this doubles as the upgrade path: re-run it to
# pick up a newer revision.
#
# Usage:
#   ./install-node.sh [options]
#
#   --ref REF          Branch, tag, or commit to install (default: master)
#   --source DIR       Use a local checkout instead of downloading
#   --proxy URL        Mirror to fetch GitHub through, PREPENDED to the URL:
#                      --proxy https://ghproxy.chenshaowen.com fetches
#                      https://ghproxy.chenshaowen.com/https://github.com/...
#                      (also read from $DSH_PROXY)
#   --bin-dir DIR      Where to put the `dsh-node` command
#                      (default: /usr/local/bin when writable, else ~/.local/bin)
#   --dry-run          Print what would happen, change nothing
#   -h, --help         Show this help
#
# Node 22+ and npm are required.
set -eu

REPO_URL="https://github.com/shaowenchen/deepseek-harness-remote-node"
CACHE_DIR="${DSH_NODE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/deepseek-harness-remote-node}"
REF="master"
SOURCE_DIR=""
BIN_DIR=""
PROXY="${DSH_PROXY:-}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "install-node: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Locate the script for local-checkout detection. When the script is piped in
# (`curl … | sh`), `$0` is just the interpreter name, so there is no checkout to
# find — skip the check rather than resolving a bogus path.
case "$0" in
  */*) SELF="$0" ;;
  *)   SELF="" ;;
esac
if [ -n "$SELF" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
  CLONE_ROOT=$(dirname -- "$SCRIPT_DIR")
else
  CLONE_ROOT=""
fi

say() { printf '%s\n' "$*"; }
die() { echo "install-node: $*" >&2; exit 1; }

if [ -z "$BIN_DIR" ]; then
  # Prefer a system-wide location, fall back to the user's own bin dir when
  # /usr/local/bin is not writable (the common case for an unprivileged agent
  # account — which is how this should be run).
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi
WRAPPER="$BIN_DIR/dsh-node"

# ── the GitHub mirror ────────────────────────────────────────────────────────
# `--proxy URL` (or $DSH_PROXY) names a mirror that fetches GitHub for a network
# that cannot reach it: github.com and raw.githubusercontent.com are both
# unreliable from mainland China, and this installer runs ON the node, whose
# network is not the one the operator tested from.
#
# The mirror's contract is PREPEND, not "an alternative host": the whole
# original URL stays intact behind the prefix, and the authority is split off
# first because the result is parsed as one URL, so a colon or a doubled slash
# there is a malformed one rather than a path the mirror can strip again.
#
#   source: https://github.com/o/r                        (scheme + authority)
#   rest:   /shaowenchen/deepseek-harness-remote-node     (path)
#   out:    https://mirror/https://github.com/o/r         -- one slash joined
gh_url() {
  [ -n "$PROXY" ] || { printf '%s' "$1"; return; }
  _scheme=${1%%://*}
  _rest=${1#*://}
  _authority=${_rest%%/*}
  _path=${_rest#"$_authority"}
  printf '%s/%s://%s%s' "${PROXY%/}" "$_scheme" "$_authority" "$_path"
}

# ── 1. Resolve the source ────────────────────────────────────────────────────
if [ -n "$SOURCE_DIR" ]; then
  SRC_KIND="local checkout ($SOURCE_DIR)"
  PKG_DIR="$SOURCE_DIR/packages/node"
  USE_LOCAL=1
elif [ -f "$CLONE_ROOT/packages/node/package.json" ]; then
  SRC_KIND="local checkout ($CLONE_ROOT)"
  PKG_DIR="$CLONE_ROOT/packages/node"
  USE_LOCAL=1
else
  SRC_KIND="$REPO_URL @ $REF"
  PKG_DIR="$CACHE_DIR/$REF/packages/node"
  USE_LOCAL=0
fi
ARCHIVE_URL=$(gh_url "$REPO_URL/archive/$REF.tar.gz")

say "dsh-node installer"
say "  source:  $SRC_KIND"
say "  package: $PKG_DIR"
say "  command: $WRAPPER"
# Printed whenever a mirror is in play, on every path — including the two that
# download nothing. A proxy that is set but silently unused is the failure worth
# designing out: the operator who passed it is on a network where the direct URL
# does not work, so "it is being honoured" has to be visible rather than
# inferred from which URL the error message happened to name.
[ -z "$PROXY" ] || say "  proxy:   $PROXY"
[ "$DRY_RUN" -eq 1 ] && say "  (dry run — nothing will be written)"
say ""

# ── 2. Fetch ─────────────────────────────────────────────────────────────────
if [ "$USE_LOCAL" -eq 1 ]; then
  say "[1/5] using the local checkout — skipping download"
else
  say "[1/5] downloading"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  would: download $ARCHIVE_URL"
    say "  would: extract to $CACHE_DIR/$REF"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to download $REF"
    command -v tar  >/dev/null 2>&1 || die "tar is required to unpack $REF"
    mkdir -p "$CACHE_DIR"
    # Build the new tree BESIDE the old one and swap it in, never replacing it
    # in place. Replacing wholesale is still the rule — a stale file surviving
    # from a previous ref is the silent drift this installer exists to avoid —
    # but `rm -rf` removes the directory a RUNNING process may have open, and a
    # recursive watcher rescanning it arrives as an unhandled ENOENT that takes
    # that process down. A rename is atomic: watchers see the old tree or the
    # new one, never a hole. It also means a failed fetch leaves a working
    # install untouched.
    staging="$CACHE_DIR/.staging.$REF.$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    if ! curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$staging" --strip-components=1; then
      rm -rf "$staging"
      die "could not download $ARCHIVE_URL — is \"$REF\" a branch, tag, or commit?"
    fi
    [ -f "$staging/packages/node/package.json" ] || { rm -rf "$staging"; die "downloaded tree has no packages/node/package.json"; }
    rm -rf "$CACHE_DIR/$REF.old"
    if [ -e "$CACHE_DIR/$REF" ]; then mv "$CACHE_DIR/$REF" "$CACHE_DIR/$REF.old"; fi
    mv "$staging" "$CACHE_DIR/$REF"
    rm -rf "$CACHE_DIR/$REF.old"
    [ -f "$PKG_DIR/package.json" ] || die "downloaded tree has no packages/node/package.json"
  fi
  say "      ok"
fi

# ── 3. Build ─────────────────────────────────────────────────────────────────
# `--include=dev` is load-bearing: TypeScript is a devDependency and the build
# needs it, but npm skips devDependencies when NODE_ENV is production — the
# normal setting for a deployment container. Without the flag this step failed
# with `tsc: not found` on exactly those hosts.
# Locate Node, preferring the PATH but falling back to a login shell.
#
# `command -v node` is not enough on a machine that manages Node with nvm: nvm
# installs its shims by SOURCING nvm.sh from an interactive rc file, and a
# non-interactive shell never runs that. So this script — often piped through
# `ssh host 'sh -s'` — sees no node at all on a machine where `node -v` works
# perfectly when the user types it. Asking the login shell for the answer is
# what makes the two agree.
#
# The login shell is asked ONCE and its PATH adopted for this script, because
# the build below needs `npm` too and both must come from the same place.
find_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return 0
  fi
  login_sh=""
  for candidate in "${SHELL:-}" zsh bash sh; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    resolved=$(env -i HOME="$HOME" USER="${USER:-}" "$candidate" -lic \
      'command -v node && command -v npm && printf "%s" "$PATH"' 2>/dev/null | tail -1)
    case "$resolved" in
      */*node*|*bin*) login_sh="$candidate"; break ;;
    esac
  done
  [ -n "$login_sh" ] || return 1
  resolved=$(env -i HOME="$HOME" USER="${USER:-}" "$login_sh" -lic \
    'printf "%s" "$PATH"' 2>/dev/null | tail -1)
  [ -n "$resolved" ] || return 1
  PATH="$resolved"
  export PATH
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

say "[2/5] checking Node and building"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: npm ci (or npm install) and npm run build in $PKG_DIR"
else
  if ! find_node; then
    die "node and npm not found on PATH or via \$SHELL; install Node 22+ first"
  fi
  say "      node $(node -v) at $(command -v node)"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Node $major found, but 22+ is required"
  if [ -f "$PKG_DIR/package-lock.json" ]; then
    ( cd "$PKG_DIR" && npm ci --include=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --include=dev --no-audit --no-fund >/dev/null )
  else
    ( cd "$PKG_DIR" && npm install --include=dev --no-audit --no-fund >/dev/null )
  fi
  ( cd "$PKG_DIR" && npm run build >/dev/null )
  [ -f "$PKG_DIR/lib/agent-cli.js" ] || die "build produced no lib/agent-cli.js"
fi
say "      ok"

# ── 4. Expose the command ────────────────────────────────────────────────────
# A tiny wrapper rather than a symlink: it pins the interpreter and the built
# entry point, so the command keeps working no matter how the checkout was laid
# out or whether the exec bit survived the unpack.
#
# The interpreter is pinned to the ABSOLUTE path `find_node` resolved, not to
# the bare name `node`. A bare name is only correct for an interactive shell:
# this command is meant to be run by a service manager or an ssh one-liner, and
# those inherit no interactive PATH — on a machine where Node came from nvm,
# `exec: node: not found` is the whole failure. Pinning the path the installer
# itself verified removes the dependency on how the agent is later launched.
say "[3/5] installing the dsh-node command"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: write $WRAPPER"
else
  mkdir -p "$BIN_DIR"
  node_bin=$(command -v node)
  {
    printf '#!/bin/sh\n'
    printf '# Generated by deepseek-harness-remote-node scripts/install-node.sh — re-run that to update.\n'
    printf 'exec %s %s/lib/agent-cli.js "$@"\n' "$node_bin" "$PKG_DIR"
  } > "$WRAPPER"
  chmod +x "$WRAPPER"
fi
say "      ok"

# ── 5. Create the default working directory ──────────────────────────────────
# This machine is the one the directory has to exist ON, so it is created here
# rather than left as advice. A missing working directory is not a degraded
# mode: `spawn` fails outright with ENOENT, so the execution world would be
# broken rather than merely empty — and the user would find out from the first
# command the agent tried to run.
#
# The agent also creates its working directory at startup, for whatever --cwd it
# was given, so this step is a convenience rather than the only guard. It stays
# because the default is what most deployments use and creating it here means the
# directory is owned by the account that runs the install.
say "[4/5] creating the default working directory"
if [ -d "$HOME/.deepseek-harness-remote-node" ]; then
  say "      already exists — left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  say "  would: mkdir -p \$HOME/.deepseek-harness-remote-node"
else
  mkdir -p "$HOME/.deepseek-harness-remote-node"
  say "      ok"
fi

say "[5/5] done"
say ""
if "$WRAPPER" --describe >/dev/null 2>&1 || [ "$DRY_RUN" -eq 1 ]; then
  say "Verify with:"
  say ""
  say "    dsh-node --describe"
  say ""
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "Note: $BIN_DIR is not on your PATH. Add it, or invoke $WRAPPER directly:"
    say ""
    say "    export PATH=\"$BIN_DIR:\$PATH\""
    say ""
    ;;
esac
say "Connect this machine to a host with:"
say ""
say "  Use the scheme the host is actually reachable on. A host behind TLS needs"
say "  wss://, and the URL is the public one — not a local port:"
say ""
say "    dsh-node --url wss://<host>/node/v1 \\"
say "      --credential <the value install-host.sh printed> \\"
say "      --cwd \$HOME/.deepseek-harness-remote-node"
say ""
say "  ws:// to an HTTPS host is answered with a redirect, and a redirect is not"
say "  followed — it fails with 'HTTP 301 redirect' rather than connecting."
say ""
say "  --cwd is in THIS machine's namespace, and is created if it is missing"
say "  (including parents) when the agent starts, so there is nothing to prepare"
say "  by hand. A path you cannot write is reported at startup rather than"
say "  discovered on the first command. Point it somewhere else when the work"
say "  belongs there:"
say ""
say "    dsh-node --url ... --cwd /data/.deepseek-harness-remote-node"
say ""
say "  The host verifies the credential when one is configured there, which"
say "  install-host.sh does by default. See SECURITY.md before exposing /node/v1"
say "  beyond a trusted network."

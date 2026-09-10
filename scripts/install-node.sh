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
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
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

say "dsh-node installer"
say "  source:  $SRC_KIND"
say "  package: $PKG_DIR"
say "  command: $WRAPPER"
[ "$DRY_RUN" -eq 1 ] && say "  (dry run — nothing will be written)"
say ""

# ── 2. Fetch ─────────────────────────────────────────────────────────────────
if [ "$USE_LOCAL" -eq 1 ]; then
  say "[1/4] using the local checkout — skipping download"
else
  say "[1/4] downloading"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  would: download $REPO_URL/archive/$REF.tar.gz"
    say "  would: extract to $CACHE_DIR/$REF"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to download $REF"
    command -v tar  >/dev/null 2>&1 || die "tar is required to unpack $REF"
    mkdir -p "$CACHE_DIR"
    # Replace wholesale rather than merging: a stale file surviving from a
    # previous ref is exactly the silent drift this installer exists to avoid.
    rm -rf "$CACHE_DIR/$REF"
    mkdir -p "$CACHE_DIR/$REF"
    if ! curl -fsSL "$REPO_URL/archive/$REF.tar.gz" | tar -xz -C "$CACHE_DIR/$REF" --strip-components=1; then
      die "could not download $REPO_URL/archive/$REF.tar.gz — is \"$REF\" a branch, tag, or commit?"
    fi
    [ -f "$PKG_DIR/package.json" ] || die "downloaded tree has no packages/node/package.json"
  fi
  say "      ok"
fi

# ── 3. Build ─────────────────────────────────────────────────────────────────
say "[2/4] checking Node and building"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: npm ci (or npm install) and npm run build in $PKG_DIR"
else
  command -v node >/dev/null 2>&1 || die "node not found; install Node 22+ first"
  command -v npm  >/dev/null 2>&1 || die "npm not found; install Node 22+ first"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Node $major found, but 22+ is required"
  if [ -f "$PKG_DIR/package-lock.json" ]; then
    ( cd "$PKG_DIR" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null )
  else
    ( cd "$PKG_DIR" && npm install --no-audit --no-fund >/dev/null )
  fi
  ( cd "$PKG_DIR" && npm run build >/dev/null )
  [ -f "$PKG_DIR/lib/agent-cli.js" ] || die "build produced no lib/agent-cli.js"
fi
say "      ok"

# ── 4. Expose the command ────────────────────────────────────────────────────
# A tiny wrapper rather than a symlink: it pins the interpreter and the built
# entry point, so the command keeps working no matter how the checkout was laid
# out or whether the exec bit survived the unpack.
say "[3/4] installing the dsh-node command"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: write $WRAPPER"
else
  mkdir -p "$BIN_DIR"
  {
    printf '#!/bin/sh\n'
    printf '# Generated by deepseek-harness-remote-node scripts/install-node.sh — re-run that to update.\n'
    printf 'exec node %s/lib/agent-cli.js "$@"\n' "$PKG_DIR"
  } > "$WRAPPER"
  chmod +x "$WRAPPER"
fi
say "      ok"

say "[4/4] done"
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
say "    dsh-node --url ws://<host>:3080/node/v1 --credential <token> --cwd /srv/workspace"
say ""
say "  Note: the node channel does not verify credentials yet. The credential is"
say "  sent by the agent but never checked by the registry, so do not expose"
say "  /node/v1 beyond a trusted network. See SECURITY.md."

#!/bin/sh
# Install the deepseek-harness-remote-node plugin into a local dsh profile.
#
# Sources the plugin straight from GitHub, so no clone is needed. Every step is
# idempotent, so this doubles as the upgrade path: re-run it to pick up a newer
# revision.
#
# Usage:
#   ./install-host.sh [options]
#
#   --cwd DIR          Execution world working directory on the node
#                      (default: $HOME/.deepseek-harness-remote-node)
#   --ref REF          Branch, tag, or commit to install (default: master)
#   --source DIR       Use a local checkout instead of downloading
#   --dsh-home DIR     dsh home (default: $DSH_HOME, else ~/.dsh)
#   --dry-run          Print what would happen, change nothing
#   -h, --help         Show this help
#
# Why a script instead of npm: the plugin is not published to the npm registry,
# and it lives in a subdirectory of its repository, which npm cannot install
# from a git URL. Downloading the release tarball and linking it is therefore the
# honest install path — and it is also the one that works inside the
# deepseek-harness-web container, which ships Node but no package manager.
#
# Why the workspace default is $HOME/.deepseek-harness-remote-node rather than
# /srv/workspace or $HOME/workspace:
#
# /srv is a Linux convention and is not universal — macOS has no /srv at all,
# and on Linux it exists but is empty, so /srv/workspace exists nowhere by
# default. $HOME/workspace is portable but collides with a name people commonly
# already use for their own work, and this directory is ours to own.
#
# The node installer creates the directory, because a missing working directory
# is not a degraded mode: `spawn` fails outright with ENOENT, so the execution
# world would be broken rather than merely empty. Note that the leading dot
# hides it from `ls` and from most file pickers — that is intended for a
# directory the tool manages, and `--cwd` takes any path if you would rather
# browse it.
set -eu

REPO_URL="https://github.com/shaowenchen/deepseek-harness-remote-node"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
CACHE_DIR="${DSH_NODE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/deepseek-harness-remote-node}"
WORKSPACE_CWD=""
REF="master"
SOURCE_DIR=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --cwd) WORKSPACE_CWD="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "install-host: unknown argument: $1" >&2; exit 2 ;;
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

PROFILE_DIR="$DSH_HOME/profiles/web"
SCOPE_DIR="$PROFILE_DIR/node_modules/@shaowenchen"
# The directory name is the package name, minus the scope. dsh resolves a
# plugin by name from this directory, so they must match exactly — the `curl |
# sh` path in the README creates the same layout by hand and says so.
LINK_PATH="$SCOPE_DIR/deepseek-harness-remote-node"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" -eq 1 ]; then say "  would: $*"; else "$@"; fi; }
die() { echo "install-host: $*" >&2; exit 1; }

# ── 1. Resolve the source ────────────────────────────────────────────────────
#
# Prefer a local checkout when the script is being run from one (a developer
# installing their working tree), otherwise download the tarball. Either way the
# result is a directory containing packages/node.
if [ -n "$SOURCE_DIR" ]; then
  SRC_KIND="local checkout ($SOURCE_DIR)"
  PKG_DIR="$SOURCE_DIR/packages/node"
  [ -n "$WORKSPACE_CWD" ] || WORKSPACE_CWD=${HOME:-/root}/.deepseek-harness-remote-node
elif [ -f "$CLONE_ROOT/packages/node/package.json" ]; then
  SRC_KIND="local checkout ($CLONE_ROOT)"
  PKG_DIR="$CLONE_ROOT/packages/node"
  [ -n "$WORKSPACE_CWD" ] || WORKSPACE_CWD=${HOME:-/root}/.deepseek-harness-remote-node
else
  SRC_KIND="$REPO_URL @ $REF"
  PKG_DIR="$CACHE_DIR/$REF/packages/node"
  [ -n "$WORKSPACE_CWD" ] || WORKSPACE_CWD=${HOME:-/root}/.deepseek-harness-remote-node
fi

say "deepseek-harness-remote-node installer"
say "  source:  $SRC_KIND"
say "  package: $PKG_DIR"
say "  profile: $PROFILE_DIR"
[ "$DRY_RUN" -eq 1 ] && say "  (dry run — nothing will be written)"
say ""

# ── 2. Fetch (when not using a local checkout) ───────────────────────────────
if [ -z "$SOURCE_DIR" ] && [ ! -f "$CLONE_ROOT/packages/node/package.json" ]; then
  say "[1/5] downloading"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  would: download $REPO_URL/archive/$REF.tar.gz"
    say "  would: extract to $CACHE_DIR/$REF"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to download $REF"
    command -v tar  >/dev/null 2>&1 || die "tar is required to unpack $REF"
    mkdir -p "$CACHE_DIR"
    # Replace wholesale rather than merging: a stale file from a previous ref
    # surviving into the new tree is exactly the kind of silent drift this
    # installer exists to avoid.
    rm -rf "$CACHE_DIR/$REF"
    mkdir -p "$CACHE_DIR/$REF"
    if ! curl -fsSL "$REPO_URL/archive/$REF.tar.gz" | tar -xz -C "$CACHE_DIR/$REF" --strip-components=1; then
      die "could not download $REPO_URL/archive/$REF.tar.gz — is \"$REF\" a branch, tag, or commit?"
    fi
    [ -f "$PKG_DIR/package.json" ] || die "downloaded tree has no packages/node/package.json"
  fi
  say "      ok"
else
  say "[1/5] using the local checkout — skipping download"
fi

[ -f "$PKG_DIR/package.json" ] || [ "$DRY_RUN" -eq 1 ] || die "no package.json at $PKG_DIR"

# ── 3. Build ─────────────────────────────────────────────────────────────────
# `npm ci` when a lockfile is present so the install is reproducible.
#
# One package carries all three entry points — the registry and both adapters —
# so there is nothing to build in dependency order.
say "[2/5] installing dependencies and building"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: npm ci (or npm install) and npm run build in $PKG_DIR"
else
  command -v npm >/dev/null 2>&1 || die "npm is required to build; install Node 22+ first"
  if [ -f "$PKG_DIR/package-lock.json" ]; then
    ( cd "$PKG_DIR" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null )
  else
    ( cd "$PKG_DIR" && npm install --no-audit --no-fund >/dev/null )
  fi
  ( cd "$PKG_DIR" && npm run build >/dev/null )
  [ -f "$PKG_DIR/lib/index.js" ] || die "build produced no lib/index.js"
  # The adapters are the point of the package; a build that dropped them would
  # otherwise install cleanly and simply never work.
  [ -f "$PKG_DIR/lib/fs-node.js" ] || die "build produced no lib/fs-node.js"
  [ -f "$PKG_DIR/lib/subprocess-node.js" ] || die "build produced no lib/subprocess-node.js"
fi
say "      ok"

# ── 4. Link into the profile ─────────────────────────────────────────────────
# dsh resolves the plugin by package name from the profile's own node_modules,
# and the profile supplies the module fallback that keeps one shared cordis
# instance.
say "[3/5] linking into the web profile"
run mkdir -p "$SCOPE_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
  # Replace any previous link, but never delete a real directory someone else
  # may own: refuse instead, so an unexpected layout surfaces rather than being
  # silently destroyed.
  if [ -e "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
    die "$LINK_PATH exists and is not a symlink; move it aside first"
  fi
  rm -f "$LINK_PATH"
  ln -s "$PKG_DIR" "$LINK_PATH"
fi
say "      ok"

# ── 5. Register the plugin in the patch layer ────────────────────────────────
# Appended, never overwritten: the file may already carry unrelated patches, and
# dsh's own documentation warns against replacing it.
say "[4/5] registering the node channel in the patch layer"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: append the node-registry row to $PATCH_FILE"
elif grep -q 'node-registry' "$PATCH_FILE" 2>/dev/null; then
  say "      already registered — left untouched"
else
  mkdir -p "$PROFILE_DIR"
  [ -f "$PATCH_FILE" ] || printf '[]\n' > "$PATCH_FILE"
  # Turn a bare `[]` seed into a real list, otherwise append to it.
  if [ "$(tr -d '[:space:]' < "$PATCH_FILE")" = "[]" ]; then
    printf '' > "$PATCH_FILE"
  fi
  {
    printf '\n# ── remote node execution world (added by scripts/install-host.sh) ──\n'
    printf -- '- insert:\n'
    printf -- '    - id: node-registry\n'
    printf -- "      name: '@shaowenchen/deepseek-harness-remote-node'\n"
    printf -- '      config:\n'
    printf -- '        cwd: %s\n' "$WORKSPACE_CWD"
    printf -- '        heartbeatIntervalMs: 2000\n'
    printf -- '        onDisconnect: orphan\n'
    # The two adapters are what actually move the execution world: without them
    # the registry is a channel nothing reads from, and the host's own
    # filesystem and subprocess providers keep serving the agent. They live in
    # this same package, behind subpath entry points, so no second install is
    # involved.
    printf -- '    - id: fs-node\n'
    printf -- "      name: '@shaowenchen/deepseek-harness-remote-node/fs'\n"
    printf -- '    - id: subprocess-node\n'
    printf -- "      name: '@shaowenchen/deepseek-harness-remote-node/subprocess'\n"
  } >> "$PATCH_FILE"
  say "      ok"
fi

# ── 6. Report what is still manual ───────────────────────────────────────────
say "[5/5] done"
say ""
say "Next:"
say "  Make the node authoritative by appending this to $PATCH_FILE."
say ""
say "  This is left to you on purpose rather than done above: disabling the"
say "  host's own providers is a decision about THIS deployment, and doing it"
say "  silently would stop the agent from working on the host at all the moment"
say "  no node is connected. Until you append it, the host's own filesystem and"
say "  subprocess providers still serve the agent."
say ""
say "      - id: fs-sandbox"
say "        disabled: true"
say "      - id: fs-local"
say "        disabled: true"
say "      - id: subprocess-local"
say "        disabled: true"
say ""
say "  Confirm the composition resolves without booting:"
say ""
say "      dsh --profile web --dump-config | grep -A6 node-registry"
say ""
say "  3. Start the host and connect a node:"
say ""
say "         dsh web"
say "         # on the remote machine:"
say "         dsh-node --url ws://<host>:3080/node/v1 --credential <token> --cwd $WORKSPACE_CWD"
say ""
say "  Note: the node channel does not verify credentials yet. The credential"
say "  is sent by the agent but never checked by the registry, so registration"
say "  is gated only by protocol version and the single-slot rule. Enrollment"
say "  and verification are not implemented — do not expose /node/v1 beyond a"
say "  trusted network until they are. See SECURITY.md."

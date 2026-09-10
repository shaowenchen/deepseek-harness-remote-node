#!/bin/sh
# Install the dsh-remote-node plugin into a local dsh profile.
#
# Every step is idempotent, so this doubles as the upgrade path: re-run it
# after pulling a new revision and the profile picks up the rebuilt plugin.
#
# Usage:
#   ./scripts/install-host.sh [--dsh-home DIR] [--cwd DIR] [--dry-run]
#
# Why a script instead of npm: this plugin lives in a subdirectory of its
# repository, and npm cannot install a git repository subdirectory. Cloning and
# linking is therefore the honest install path, and it is also the one that
# works inside the deepseek-harness-web container, which ships Node but no pnpm.
set -eu

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WORKSPACE_CWD=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --cwd) WORKSPACE_CWD="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "install-host: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The package directory is this script's parent's sibling.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname -- "$SCRIPT_DIR")
PKG_DIR="$ROOT_DIR/packages/node"

[ -f "$PKG_DIR/package.json" ] || { echo "install-host: no package.json at $PKG_DIR" >&2; exit 1; }

PROFILE_DIR="$DSH_HOME/profiles/web"
SCOPE_DIR="$PROFILE_DIR/node_modules/@shaowenchen"
LINK_PATH="$SCOPE_DIR/dsh-node"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" -eq 1 ]; then say "  would: $*"; else "$@"; fi; }

say "dsh-remote-node installer"
say "  plugin:  $PKG_DIR"
say "  profile: $PROFILE_DIR"
[ "$DRY_RUN" -eq 1 ] && say "  (dry run — nothing will be written)"
say ""

# 1. Build. `npm ci` when a lockfile is present so the install is reproducible.
say "[1/4] installing dependencies and building"
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -f "$PKG_DIR/package-lock.json" ]; then
    ( cd "$PKG_DIR" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null )
  else
    ( cd "$PKG_DIR" && npm install --no-audit --no-fund >/dev/null )
  fi
  ( cd "$PKG_DIR" && npm run build >/dev/null )
fi
[ -f "$PKG_DIR/lib/index.js" ] || [ "$DRY_RUN" -eq 1 ] || { echo "install-host: build produced no lib/index.js" >&2; exit 1; }
say "      ok"

# 2. Link into the profile. dsh resolves the plugin by package name from the
#    profile's own node_modules, and the profile supplies the module fallback
#    that keeps one shared cordis instance.
say "[2/4] linking into the web profile"
run mkdir -p "$SCOPE_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
  # Replace any previous link, but never delete a real directory someone else
  # may own: refuse instead, so an unexpected layout surfaces rather than being
  # silently destroyed.
  if [ -e "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
    echo "install-host: $LINK_PATH exists and is not a symlink; move it aside first" >&2
    exit 1
  fi
  rm -f "$LINK_PATH"
  ln -s "$PKG_DIR" "$LINK_PATH"
fi
say "      ok"

# 3. Add the registry row to the profile patch layer. Appended, never
#    overwritten: the file may already carry unrelated patches, and dsh's own
#    documentation warns against replacing it.
say "[3/4] registering the node channel in the patch layer"
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
    printf -- "      name: '@shaowenchen/dsh-node'\n"
    printf -- '      config:\n'
    printf -- '        cwd: %s\n' "${WORKSPACE_CWD:-/srv/workspace}"
    printf -- '        heartbeatIntervalMs: 2000\n'
    printf -- '        onDisconnect: orphan\n'
  } >> "$PATCH_FILE"
  say "      ok"
fi

# 4. Tell the truth about what is still manual. Making the node authoritative
#    means disabling the host's own filesystem provider, and that is a
#    deliberate choice rather than something an installer should decide: with
#    it disabled, every filesystem tool fails until a node connects.
say "[4/4] done"
say ""
say "Next:"
say "  1. Make the node authoritative by appending this to $PATCH_FILE"
say "     (until you do, the host's own filesystem still serves the agent):"
say ""
say "         - id: fs-sandbox"
say "           disabled: true"
say ""
say "  2. Confirm the composition resolves without booting:"
say ""
say "         dsh --profile web --dump-config | grep -A4 node-registry"
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

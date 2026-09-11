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
#   --credential VALUE The credential agents must present. Generated and stored
#                      in $DSH_HOME/node-credential (0600) when omitted, and
#                      reused on later runs so a re-install does not invalidate
#                      a node that is already connected. A generated value is
#                      32 characters of [A-Za-z0-9] containing at least one
#                      upper-case letter, one lower-case letter, and one digit.
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
CREDENTIAL=""
REF="master"
SOURCE_DIR=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --cwd) WORKSPACE_CWD="$2"; shift 2 ;;
    --credential) CREDENTIAL="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
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

# ── credential generation ────────────────────────────────────────────────────
#
# _draw is one primitive; generate_credential layers the shape requirement on
# top of it. They are separate because the requirements are separate: a uniform
# draw gives 32 characters from [A-Za-z0-9], and says nothing about which
# classes those characters land in.

# Draw n random characters from [A-Za-z0-9], uniformly.
#
# od -tu1 over /dev/urandom, NOT the familiar
# `tr -dc 'A-Za-z0-9' < /dev/urandom | head -c n`. That idiom is a trap in a
# `set -eu` script: `head` exits after n bytes, `tr` is killed by SIGPIPE
# mid-write, and the pipeline's status becomes whatever the shell decides a
# SIGPIPE death means — which can abort the install on the step that was
# supposed to succeed, on someone else's shell. `od` reads a fixed count of
# bytes and exits on its own, so nothing is ever signalled.
#
# The rejection is not decoration. od emits whole bytes, and the largest
# multiple of 62 below 256 is 248, so a byte in [248,255] would have to be
# folded back onto earlier characters. Those are skipped, which keeps every
# character uniform; 8 values in 256 are rejected, so the command substitution
# almost always yields the full count on the first pass.
_draw() {
  od -An -tu1 -N $(( $1 * 2 + 8 )) /dev/urandom | tr -s ' ' '\n' | awk -v want="$1" '
    NF == 0 { next }
    $1 >= 248 { next }
    got < want {
      table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
      printf "%s", substr(table, ($1 % 62) + 1, 1)
      got++
    }
  '
}

# 32 characters of [A-Za-z0-9]: ~190 bits, short enough to paste into a command
# line by hand — which is where this value is actually used — and far beyond
# guessing.
#
# The class requirement is met by REDRAWING the whole credential until all three
# appear, rather than by patching a character of each class into a draw that
# lacks it. Patching is the tempting version and it is worse: overwriting three
# positions — even positions chosen at random — makes the string's shape depend
# on which positions were overwritten, so the result is not uniform over the
# strings that satisfy the constraint. Redrawing is: it accepts or rejects a
# whole uniform draw, which is rejection sampling, and every satisfying string
# is equally likely.
#
# It is also nearly free, and the arithmetic is worth writing down because the
# intuition is wrong: a uniform 32-character draw almost always has every class.
# The binding case is the digit — P(no digit at all) = (52/62)^32 ≈ 0.36%, so
# about one draw in 280 is rejected. The letter cases are not comparable: the
# alphabet is 62 symbols and only 10 are digits, so a run with no upper case is
# (36/62)^32 ≈ 3e-8, about 1 in 35 million. Retries are therefore essentially
# all digit-driven, and measured over 2000 credentials the loop took one pass
# 1992 times and two passes 8 times.
generate_credential() {
  while :; do
    _candidate=$(_draw 32)
    printf '%s' "$_candidate" | grep -q '[A-Z]' || continue
    printf '%s' "$_candidate" | grep -q '[a-z]' || continue
    printf '%s' "$_candidate" | grep -q '[0-9]' || continue
    printf '%s' "$_candidate"
    return
  done
}

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
    # Build the new tree BESIDE the old one and swap it in, never replacing the
    # old tree in place.
    #
    # Replacing wholesale is still the rule — a stale file surviving from a
    # previous ref is exactly the silent drift this installer exists to avoid.
    # But `rm -rf` of a directory a RUNNING dsh has open is not a safe way to do
    # it: the symlink into the profile points here, and when a recursive watcher
    # (this profile reloads patches live) rescans it mid-download, the missing
    # path arrives as an unhandled `ENOENT: scandir .../node_modules/zod` that
    # takes the host process down. The window is real and this has happened.
    #
    # A rename is atomic, so any watcher sees the old tree or the new one and
    # never a hole between them. Downloading into a scratch dir first also means
    # a failed fetch leaves the working install untouched.
    staging="$CACHE_DIR/.staging.$REF.$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    if ! curl -fsSL "$REPO_URL/archive/$REF.tar.gz" | tar -xz -C "$staging" --strip-components=1; then
      rm -rf "$staging"
      die "could not download $REPO_URL/archive/$REF.tar.gz — is \"$REF\" a branch, tag, or commit?"
    fi
    [ -f "$staging/packages/node/package.json" ] || { rm -rf "$staging"; die "downloaded tree has no packages/node/package.json"; }
    rm -rf "$CACHE_DIR/$REF.old"
    if [ -e "$CACHE_DIR/$REF" ]; then mv "$CACHE_DIR/$REF" "$CACHE_DIR/$REF.old"; fi
    mv "$staging" "$CACHE_DIR/$REF"
    rm -rf "$CACHE_DIR/$REF.old"
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
#
# `--include=dev` is load-bearing, not tidiness. TypeScript is a devDependency
# and building needs it, but npm skips devDependencies whenever NODE_ENV is
# production — which is exactly how a deployment container is configured. This
# script ran without the flag and failed on those hosts with `tsc: not found`,
# while passing everywhere NODE_ENV was unset. Asking for dev deps explicitly
# makes the build independent of that variable.
say "[2/5] installing dependencies and building"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: npm ci (or npm install) and npm run build in $PKG_DIR"
else
  command -v npm >/dev/null 2>&1 || die "npm is required to build; install Node 22+ first"
  if [ -f "$PKG_DIR/package-lock.json" ]; then
    ( cd "$PKG_DIR" && npm ci --include=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --include=dev --no-audit --no-fund >/dev/null )
  else
    ( cd "$PKG_DIR" && npm install --include=dev --no-audit --no-fund >/dev/null )
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
#
# Re-running must converge, and the two halves of this file have OPPOSITE
# duplicate rules — verified against dsh, not assumed:
#
#   * `- insert:` naming an id that is already inserted is a hard error
#     ("duplicate loader entry id: node-registry"). So the insert block is
#     written only when absent.
#   * `- id: X` / `disabled: true` is a patch that merges. Writing it twice is
#     harmless, and the composed config still shows the id exactly once.
#
# That asymmetry is why the disable block can simply be appended every run: the
# operation is idempotent by construction, so a re-run repairs a half-finished
# install instead of stopping and asking the operator to finish it by hand.
say "[4/5] registering the node channel in the patch layer"

# The credential is resolved HERE, before the branch below, because it is needed
# on every path — including the one where the registry row already exists. It
# used to sit inside the insert branch, so a host that had been registered by an
# earlier version (before credentials existed) never got one: the run reported
# success and the channel stayed open. Generating it unconditionally is what
# lets the backfill below repair that state.
#
# Reused across runs so re-installing never silently invalidates a node that is
# already connected; `--credential` overrides.
CREDENTIAL_FILE="${DSH_NODE_CREDENTIAL_FILE:-$DSH_HOME/node-credential}"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: obtain a credential (--credential, $CREDENTIAL_FILE, or a new one)"
elif [ -n "$CREDENTIAL" ]; then
  say "      credential: supplied on the command line"
elif [ -f "$CREDENTIAL_FILE" ]; then
  CREDENTIAL=$(cat "$CREDENTIAL_FILE")
  say "      credential: reusing $CREDENTIAL_FILE"
elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
  CREDENTIAL=$(generate_credential)
  mkdir -p "$DSH_HOME"
  umask 077
  printf '%s\n' "$CREDENTIAL" > "$CREDENTIAL_FILE"
  chmod 600 "$CREDENTIAL_FILE"
  say "      credential: generated, stored in $CREDENTIAL_FILE (0600)"
else
  die "no credential available: pass --credential, or install openssl so one can be generated"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: append the node-registry row to $PATCH_FILE if absent"
  say "  would: append the disable block for the host providers"
elif grep -q 'node-registry' "$PATCH_FILE" 2>/dev/null; then
  # The registry row exists — but it may predate credential verification, in
  # which case there is no `credential:` line in it and the channel is open.
  #
  # The field is added IN PLACE, as a sibling of the entry's existing `cwd`.
  # That is not a stylistic choice. A separate `- id: node-registry` override
  # REPLACES the entry's config rather than merging into it, so appending one
  # drops `cwd` — and `cwd` is required, so dsh then refuses to boot with
  # `$.cwd missing required value`. Appending looked tidier and put the host in
  # a crash loop; the sed below is what actually works.
  if grep -A20 'id: node-registry' "$PATCH_FILE" 2>/dev/null | grep -q 'credential:'; then
    say "      node registry already registered, with a credential — left untouched"
  elif [ "$DRY_RUN" -eq 1 ]; then
    say "  would: backfill credential into the existing node-registry entry"
  else
    tmp="$PATCH_FILE.tmp.$$"
    # Match the cwd line of the node-registry entry specifically: `want` turns
    # on at that id and off at any other, so a cwd belonging to a different
    # entry is never the insertion point.
    if awk -v CRED="$CREDENTIAL" '
          /^[[:space:]]*- id: node-registry[[:space:]]*$/ { want = 1 }
          want && !done && /^[[:space:]]+cwd:/ {
            print
            match($0, /^[[:space:]]+/)
            printf "%scredential: %s\n", substr($0, 1, RLENGTH), CRED
            done = 1; next
          }
          want && /^[[:space:]]*- id: / && !/node-registry/ { want = 0 }
          { print }
        ' "$PATCH_FILE" > "$tmp" && [ -s "$tmp" ]; then
      mv "$tmp" "$PATCH_FILE"
      say "      node registry already registered — credential backfilled"
    else
      rm -f "$tmp"
      say "  !! could not backfill $PATCH_FILE — add the credential by hand:"
      say "       under the node-registry entry's cwd line, add:"
      say "         credential: $CREDENTIAL"
    fi
  fi
else
  mkdir -p "$PROFILE_DIR"
  [ -f "$PATCH_FILE" ] || printf '[]\n' > "$PATCH_FILE"
  # An untouched profile ships a COMMENTED header above a bare `[]`. That file
  # is a valid empty list, but it cannot be appended to: a document may not hold
  # both a top-level `[]` and a top-level `- insert:`, and dsh refuses to parse
  # it. So the seed is replaced — but the header is kept, because it documents
  # what this file is and dsh regenerates it anyway.
  #
  # Comments must be stripped before testing, which is the part that was wrong
  # before: the old check compared the whole file (comments included) against
  # `[]`, never matched, and appended straight onto the `[]` — producing a patch
  # dsh could not parse, so the plugin silently never loaded.
  if [ -z "$(sed 's/#.*//' "$PATCH_FILE" | tr -d '[:space:]' | sed 's/\[\]//')" ]; then
    seed_tmp="$PATCH_FILE.tmp.$$"
    grep '^#' "$PATCH_FILE" > "$seed_tmp" 2>/dev/null || true
    mv "$seed_tmp" "$PATCH_FILE"
  fi
  {
    printf '\n# ── remote node execution world (added by scripts/install-host.sh) ──\n'
    printf -- '- insert:\n'
    printf -- '    - id: node-registry\n'
    printf -- "      name: '@shaowenchen/deepseek-harness-remote-node'\n"
    printf -- '      config:\n'
    printf -- '        cwd: %s\n' "$WORKSPACE_CWD"
    printf -- '        credential: %s\n' "$CREDENTIAL"
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

# The disable block is written on EVERY run, not only when the insert block was
# added. A `- id: X` / `disabled: true` entry merges with any earlier one (unlike
# an `insert`, which errors on a duplicate id), so re-running is safe — and it is
# what makes this script converge. An install that stopped after inserting the
# adapters is left in a state dsh cannot boot; the next run repairs it in place
# rather than reporting the problem and waiting to be told what to do.
# The marker identifies OUR block, so re-running neither duplicates it nor
# mistakes a similar entry the operator wrote for their own purposes. Matching on
# the id alone would make the second run skip a block the user had deleted by
# hand, leaving a broken composition the script then reports as unfixable.
DISABLE_MARKER='# ── host execution world disabled (scripts/install-host.sh) ──'
if [ "$DRY_RUN" -eq 1 ]; then
  say "  would: ensure the host-provider disable block is present in $PATCH_FILE"
elif grep -qF "$DISABLE_MARKER" "$PATCH_FILE" 2>/dev/null; then
  say "      host providers already disabled — left untouched"
else
  mkdir -p "$PROFILE_DIR"
  {
    printf '\n%s\n' "$DISABLE_MARKER"
    printf '# A context holds exactly one ctx.fs and one ctx.subprocess, and the\n'
    printf '# host'"'"'s providers mount first — leaving them enabled makes the node\n'
    printf '# adapters fail to register and dsh exits 1 in a restart loop.\n'
    printf '# Duplicate `disabled` entries merge, so this block is safe to repeat.\n'
    printf -- '- id: fs-sandbox\n'
    printf -- '  disabled: true\n'
    printf -- '- id: subprocess\n'
    printf -- '  disabled: true\n'
  } >> "$PATCH_FILE"
  say "      host providers disabled"
fi

# ── 5b. Verify the composition can boot ──────────────────────────────────────
# A context holds exactly one ctx.fs and one ctx.subprocess. Mounting the node
# adapters while the host's own providers are still enabled does not degrade to
# "run it locally" — registration fails and the whole plugin tree refuses to
# load, so dsh exits 1 and restarts forever. That failure is expensive to
# diagnose from the outside: the only visible symptom is /node/v1 answering 404
# (and a 502 through a proxy), which looks like a networking problem rather than
# a composition one. So the composition is checked here, before the operator
# concludes anything.
#
# `--dump-config` is NOT sufficient: it prints an entry even for a package that
# cannot be imported, so it proves the YAML parses and nothing more. The check
# below is about ids that are still ENABLED, which `--dump-config` does show
# faithfully (a `disabled: true` line appears beside the entry).
say "[4b/5] checking the composition can actually boot"
# Find dsh. It is installed globally in the web container (that is how it is
# launched), but a developer running this against a local profile may have it
# only inside a node_modules tree — so PATH is tried first and a couple of
# well-known npm global locations after it, rather than assuming.
DSH_BIN=$(command -v dsh 2>/dev/null || true)
if [ -z "$DSH_BIN" ]; then
  for candidate in \
    "${npm_config_prefix:-}/bin/dsh" \
    /usr/local/bin/dsh \
    /usr/bin/dsh \
    "$HOME/.local/bin/dsh"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then DSH_BIN="$candidate"; break; fi
  done
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "      skipped (dry run)"
elif [ -z "$DSH_BIN" ]; then
  say "      !! could not find the dsh binary, so the composition was NOT checked."
  say "         This check is what prevents a crash loop, so run it by hand:"
  say ""
  say "             dsh --profile web --dump-config | grep -E 'id: (fs-sandbox|subprocess)'"
  say ""
  say "         Each id that appears WITHOUT a following 'disabled: true' will"
  say "         stop the host from booting. See the block printed below."
else
  dump_file="${TMPDIR:-/tmp}/dsh-host-dump.$$"
  DSH_HOME="$DSH_HOME" "$DSH_BIN" --profile web --dump-config > "$dump_file" 2>/dev/null || true
  # shellcheck disable=SC2064  # expand $$ now, so the trap removes THIS file
  trap "rm -f '$dump_file'" EXIT INT TERM
  if [ ! -s "$dump_file" ]; then
    say "      could not read the composed config — check the patch by hand"
    rm -f "$dump_file"
  else
    # For each host provider the node adapters replace, is it still enabled?
    #
    # The match is on the EXACT line `- id: <name>`, because `- id: subprocess`
    # is a prefix of `- id: subprocess-node` and a looser match would read the
    # node adapter's own entry as the host's.
    #
    # Exit codes: 0 disabled (fine), 1 enabled (conflict), 2 absent (not mounted
    # by this profile at all — nothing to disable, and not our business).
    still_enabled() {
      awk -v want="$2" '
        $0 == "- id: " want { found = 1; next }
        found && /^- id: /  { exit }
        found && /^[[:space:]]*disabled: true/ { off = 1 }
        END { if (!found) exit 2; exit (off ? 0 : 1) }
      ' "$1"
    }
    conflict=""
    for id in fs-sandbox subprocess; do
      # `set -e` is on, so the non-zero return must be captured, not tested.
      code=0
      still_enabled "$dump_file" "$id" || code=$?
      if [ "$code" -eq 1 ]; then conflict="$conflict $id"; fi
    done
    if [ -n "$conflict" ]; then
      # The disable block was just written, so this is not "the operator forgot".
      # Something about this profile is not what the script assumes: a different
      # id provides ctx.fs or ctx.subprocess here, or the patch file is not the
      # one being read. Both need a human, and guessing would be worse.
      say ""
      say "  !! these host providers are STILL enabled after writing the disable"
      say "     block:$conflict"
      say ""
      say "  The ids above are absent, or the patch file in use is not:"
      say "      $PATCH_FILE"
      say ""
      say "  Find what actually provides these seams in this profile and disable"
      say "  that id instead — the block this script writes is the common case,"
      say "  not a universal one:"
      say ""
      say "      dsh --profile web --dump-config | grep -B1 -A2 -E \'^(fs|subprocess)|dsh-fs|dsh-subprocess\'"
      say ""
      say "  If you leave it, dsh exits 1 in a restart loop with"
      say "  'service \"subprocess\" has been registered', and /node/v1 answers"
      say "  404 (or 502 behind a proxy) because the host never finished booting."
      say ""
      exit 1
    fi
    say "      ok — the node adapters can register"
  fi
fi

# ── 6. Report what is still manual ───────────────────────────────────────────
say "[5/5] done"
say ""
say "RESTART dsh. The patch layer is read at startup, so a running host has"
say "not picked any of this up yet."
say ""
say "  On the remote machine, use the SAME scheme this host is reachable on."
say "  A host behind TLS needs wss://; ws:// to an HTTPS host is redirected and"
say "  the redirect is not followed, so it will never connect:"
say ""
say "      dsh-node --url wss://<host>/node/v1 \\"
say "        --credential $CREDENTIAL \\"
say "        --cwd $WORKSPACE_CWD"
say ""
say "  The credential is printed above and is the same value written into the"
say "  plugin config, so this host VERIFIES it: an agent presenting anything"
say "  else is refused with the \`auth\` code and never reaches an operation."
say ""
say "  It is also stored at $CREDENTIAL_FILE (0600), which is the copy to"
say "  read from later — a re-run reuses that file rather than issuing a new"
say "  one, so a connected node is not invalidated by re-installing."
say ""
say "  Keep it secret either way. It is a bearer token: a read of the plugin"
say "  config is a shell on the node machine."
say ""
say "  If you deliberately want the old, unverified behaviour, remove the"
say "  \`credential:\` line from the config. The host then admits any peer that"
say "  reaches /node/v1 and says so loudly on every registration — that is only"
say "  appropriate when the network path itself is trusted, e.g. loopback or a"
say "  private link. See SECURITY.md."

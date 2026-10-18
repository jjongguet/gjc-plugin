#!/bin/sh
# Render or install the weekly Hermes evolution launchd user agent.
#
# This script NEVER calls launchctl. It only writes (or prints) the plist and
# prints the exact bootstrap/bootout commands for the operator to run.
#
# Default mode: --print (rendered plist on stdout, placeholder preserved when
# --digest-repo is omitted).
#
#   hermes/mac/install.sh --print
#   hermes/mac/install.sh --print --digest-repo "$HOME/digests/hermes-evolution"
#   hermes/mac/install.sh --apply --digest-repo "$HOME/digests/hermes-evolution"
#
# --apply is idempotent: an identical plist is left untouched.

set -eu

LABEL="work.jjongguet.hermes-evolution"
PLIST_NAME="$LABEL.plist"
CANONICAL_REPO="/Users/kyeongminkim/jjongguet/gjc-plugin"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPT_REPO=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
REPO="${GJC_PLUGIN_REPO:-$SCRIPT_REPO}"
DIGEST_REPO=""
MODE="print"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 2
}

usage() {
	cat <<'EOF'
Usage: install.sh [--print|--apply] [--repo PATH] [--digest-repo PATH]

  --print            print the rendered plist (default); no files are written
  --apply            write ~/Library/LaunchAgents/work.jjongguet.hermes-evolution.plist
                     and print the launchctl bootstrap/bootout commands; never runs them
  --repo PATH        gjc-plugin checkout containing hermes/scripts/weekly_evolution.py
                     (default: the checkout containing this script)
  --digest-repo PATH private digest repository (required with --apply)

The committed template intentionally contains the placeholder
__PRIVATE_DIGEST_REPO__ until a private digest repository exists.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--print)
			MODE="print"
			shift
			;;
		--apply)
			MODE="apply"
			shift
			;;
		--repo)
			[ "$#" -ge 2 ] || die "--repo requires a value"
			REPO="$2"
			shift 2
			;;
		--digest-repo)
			[ "$#" -ge 2 ] || die "--digest-repo requires a value"
			DIGEST_REPO="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			die "unknown argument: $1"
			;;
	esac
done

SOURCE="$REPO/hermes/mac/$PLIST_NAME.template"
[ -f "$SOURCE" ] || die "plist not found: $SOURCE"

case "$REPO$DIGEST_REPO" in
	*'|'*|*'&'*)
		die "paths must not contain '|' or '&'"
		;;
esac

if [ "$MODE" = "apply" ]; then
	[ -n "$DIGEST_REPO" ] || die "--digest-repo is required with --apply"
	case "$REPO" in
		*/lanes/*) printf 'install.sh: warning: installing from a session worktree (%s); prefer the canonical checkout\n' "$REPO" >&2 ;;
	esac
	[ -d "$DIGEST_REPO" ] || die "digest repository does not exist: $DIGEST_REPO"
	git -C "$DIGEST_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
		|| die "digest repository is not a git checkout: $DIGEST_REPO"
	ORIGIN=$(git -C "$DIGEST_REPO" remote get-url origin 2>/dev/null || true)
	case "$ORIGIN" in
		*gjc-plugin*) die "refusing public gjc-plugin repository: $ORIGIN" ;;
	esac
	[ -f "$REPO/hermes/scripts/weekly_evolution.py" ] \
		|| die "weekly_evolution.py not found under $REPO"
	[ -d "/Users/kyeongminkim/jjongguet/discord/logs" ] \
		|| die "log directory missing: /Users/kyeongminkim/jjongguet/discord/logs"
fi

render() {
	if [ -n "$DIGEST_REPO" ]; then
		sed -e "s|__PRIVATE_DIGEST_REPO__|$DIGEST_REPO|g" \
			-e "s|$CANONICAL_REPO|$REPO|g" "$SOURCE"
	else
		sed -e "s|$CANONICAL_REPO|$REPO|g" "$SOURCE"
	fi
}

if [ "$MODE" = "print" ]; then
	if [ -z "$DIGEST_REPO" ]; then
		printf 'install.sh: --digest-repo omitted; __PRIVATE_DIGEST_REPO__ is preserved.\n' >&2
	fi
	render
	exit 0
fi

command -v launchctl >/dev/null 2>&1 || die "launchctl not found (macOS required)"

mkdir -p "$HOME/Library/LaunchAgents"
TEMP=$(mktemp "$HOME/Library/LaunchAgents/.$PLIST_NAME.XXXXXX")
trap 'rm -f "$TEMP"' EXIT HUP INT TERM
render >"$TEMP"
chmod 0644 "$TEMP"

if [ -f "$TARGET" ] && cmp -s "$TEMP" "$TARGET"; then
	printf 'unchanged: %s\n' "$TARGET"
else
	mv "$TEMP" "$TARGET"
	trap - EXIT HUP INT TERM
	printf 'installed: %s\n' "$TARGET"
fi

cat <<EOF

Plists are not registered automatically. Run these exact commands:

  launchctl bootstrap gui/\$(id -u) "$TARGET"
  launchctl print gui/\$(id -u)/$LABEL
  launchctl kickstart -k gui/\$(id -u)/$LABEL

To stop and remove the job later:

  launchctl bootout gui/\$(id -u)/$LABEL
  rm "$TARGET"
EOF

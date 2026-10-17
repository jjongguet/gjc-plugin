#!/bin/sh
# Install/check jev-gate on a Hermes host. The plugin source is copied into
# ~/.hermes/plugins/jev-gate/ by the caller; this script prepares the
# profile-scoped data directory and validates the runtime. It never reads
# ~/.hermes/.env and never prints credentials.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_ROOT="${JEV_GATE_DATA_ROOT:-$HOME/.hermes/plugins/jev-gate-data}"
CONFIG="$DATA_ROOT/config.json"

usage() {
  echo "usage: $0 [--check|--install|--uninstall|--self-test|--print-job-map]" >&2
}

check() {
  python3 - "$HERE" <<'PY'
import sys, pathlib
here = pathlib.Path(sys.argv[1])
required = ["plugin.yaml", "plugin.py", "gate.py", "config.example.json", "README.md"]
missing = [name for name in required if not (here / name).exists()]
if missing:
    print("missing: " + ", ".join(missing), file=sys.stderr); sys.exit(1)
if sys.version_info < (3, 9):
    print("python3 >= 3.9 required", file=sys.stderr); sys.exit(1)
print(f"ok python={sys.version.split()[0]} files={len(required)}")
PY
  if [ -f "$CONFIG" ]; then
    JEV_GATE_CONFIG="$CONFIG" python3 "$HERE/gate.py" --config "$CONFIG" --config-check >/dev/null
    echo "config ok: $CONFIG"
  else
    echo "config absent: $CONFIG (install will copy config.example.json)"
  fi
  shasum -a 256 "$HERE/gate.py" "$HERE/plugin.py" 2>/dev/null || sha256sum "$HERE/gate.py" "$HERE/plugin.py"
}

install_config() {
  mkdir -p "$DATA_ROOT"
  chmod 700 "$DATA_ROOT"
  if [ ! -f "$CONFIG" ]; then
    cp "$HERE/config.example.json" "$CONFIG"
    chmod 600 "$CONFIG"
    echo "created $CONFIG (mode=off; edit allowlist/questions before enabling hold)"
  else
    chmod 600 "$CONFIG"
    echo "kept existing $CONFIG"
  fi
  check
  echo "next: hermes plugins enable jev-gate; reload/restart the gateway; hermes plugins list"
}

uninstall_hint() {
  echo "disable: hermes plugins disable jev-gate"
  echo "rollback: set mode=off in $CONFIG and reload the gateway"
  echo "state is preserved at $DATA_ROOT"
}

case "${1:---check}" in
  --check) check ;;
  --install) install_config ;;
  --uninstall) uninstall_hint ;;
  --self-test) JEV_GATE_CONFIG="${CONFIG}" python3 "$HERE/gate.py" --config "$CONFIG" --self-test ;;
  --print-job-map) python3 "$HERE/gate.py" --print-job-map ;;
  *) usage; exit 2 ;;
esac

#!/usr/bin/env bash
# Run HardlyTracking's server at startup — as a systemd *user* service, so it needs no root and no
# root-owned files, and comes back by itself after a crash.
#
#   scripts/service.sh install     # build if needed, install, enable, start
#   scripts/service.sh status      # is it enabled? is it running? what does it say?
#   scripts/service.sh logs        # follow the journal
#   scripts/service.sh restart     # after editing the env file
#   scripts/service.sh uninstall   # stop, disable, remove the unit (the env file stays)
#
# `systemctl --user enable` alone only starts the service when *you* log in. To have it run from
# boot with nobody logged in, enable lingering once — the script tells you if it is off.
set -euo pipefail

UNIT_NAME=hardlytracking.service
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO/deploy/$UNIT_NAME"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TARGET="$UNIT_DIR/$UNIT_NAME"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hardlytracking"
ENV_FILE="$ENV_DIR/env"
PORT="${PORT:-8460}"

die() { echo "  ✗ $*" >&2; exit 1; }
say() { echo "  $*"; }

need_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is not on PATH: this is not a systemd machine"
  # A container or a WSL shell without a user manager cannot run a user service at all, and the
  # failure is a confusing "Failed to connect to bus" further down.
  systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user manager (systemctl --user cannot reach a bus)"
}

build_if_needed() {
  if [ ! -f "$REPO/dist/index.html" ]; then
    say "no dist/ yet — building"
    ( cd "$REPO" && npm run build )
  fi
}

install_unit() {
  need_systemd
  build_if_needed
  mkdir -p "$UNIT_DIR" "$ENV_DIR"

  # The unit ships with `%h/apps/hardlytracking`; this checkout may be somewhere else, and a unit
  # pointing at a directory that does not exist fails with "No such file or directory" and no clue.
  sed -e "s#%h/apps/hardlytracking#$REPO#g" "$SOURCE" > "$TARGET"

  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'ENV'
# HardlyTracking server settings. Every line is optional; the defaults serve the app on
# 127.0.0.1:8460 and proxy to a Mihon runtime on :4567 and a dalvik host on :8792.
#
# HOST=0.0.0.0              # listen on the network, for a phone. Set a token with it — see below.
# PORT=8460
# RUNTIME_URL=http://127.0.0.1:4567
# DALVIK_URL=http://127.0.0.1:8792
#
# With HOST=0.0.0.0 anyone who can reach the port can read this library, so the server refuses to
# be useful without a secret: every /api/* call then needs it as `x-hardlytracking-token` or
# `?token=`. Generate one with:  openssl rand -hex 16
# HARDLYTRACKING_TOKEN=
ENV
    say "wrote $ENV_FILE (all defaults; edit it, then: $0 restart)"
  fi

  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null
  systemctl --user restart "$UNIT_NAME"
  say "installed $TARGET"
  report
}

uninstall_unit() {
  need_systemd
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$TARGET"
  systemctl --user daemon-reload
  say "removed $TARGET; $ENV_FILE was left in place"
}

report() {
  local enabled active
  enabled="$(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || true)"
  active="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
  say "enabled: ${enabled:-no}   running: ${active:-no}"
  if [ "$active" = "active" ]; then
    say "serving http://127.0.0.1:$PORT"
  fi
  if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    say
    say "Lingering is off: this service starts when you log in, not at boot."
    say "For boot with nobody logged in:  sudo loginctl enable-linger $USER"
  fi
}

case "${1:-}" in
  install)   install_unit ;;
  uninstall) uninstall_unit ;;
  restart)   need_systemd; systemctl --user restart "$UNIT_NAME"; report ;;
  status)    need_systemd; report; systemctl --user status "$UNIT_NAME" --no-pager 2>/dev/null | sed -n '1,12p' || true ;;
  logs)      need_systemd; journalctl --user -u "$UNIT_NAME" -f ;;
  *)
    echo "usage: $0 {install|uninstall|restart|status|logs}" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

# CI-only real SecretService. Always establish a new bus and private keyring,
# including when this entry is invoked manually from an existing login session.
unset DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID DBUS_SESSION_BUS_WINDOWID
unset DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE
unset GNOME_KEYRING_CONTROL GNOME_KEYRING_PID SSH_AUTH_SOCK SSH_AGENT_PID
exec dbus-run-session -- bash -euo pipefail <<'PRIVATE_SESSION'
fixture_keyring_root=$(mktemp -d)
fixture_keyring_pid=
cleanup() {
  if test -n "$fixture_keyring_pid"; then
    kill "$fixture_keyring_pid" 2>/dev/null || true
    wait "$fixture_keyring_pid" 2>/dev/null || true
  fi
  rm -rf "$fixture_keyring_root"
}
trap cleanup EXIT
mkdir -m 700 "$fixture_keyring_root/home" "$fixture_keyring_root/runtime" "$fixture_keyring_root/config" "$fixture_keyring_root/data"
export XDG_RUNTIME_DIR="$fixture_keyring_root/runtime"
export XDG_CONFIG_HOME="$fixture_keyring_root/config"
export XDG_DATA_HOME="$fixture_keyring_root/data"
export XDG_CURRENT_DESKTOP=GNOME
export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"

# Keep an owned foreground daemon, so cleanup never kills an existing service.
# This password protects only synthetic data in the private temporary keyring.
HOME="$fixture_keyring_root/home" gnome-keyring-daemon --foreground --unlock --components=secrets \
  --control-directory="$GNOME_KEYRING_CONTROL" < <(printf '%s' 'codeshell-ci-fixture-keyring') \
  > "$fixture_keyring_root/daemon.log" 2>&1 &
fixture_keyring_pid=$!
for _attempt in {1..100}; do
  kill -0 "$fixture_keyring_pid"
  fixture_service_pid=$(dbus-send --session --reply-timeout=200 --type=method_call --print-reply \
    --dest=org.freedesktop.DBus / org.freedesktop.DBus.GetConnectionUnixProcessID \
    string:org.freedesktop.secrets 2>/dev/null | awk '/uint32/ { print $2 }') || fixture_service_pid=
  test "$fixture_service_pid" != "$fixture_keyring_pid" || break
  sleep 0.1
done
test "$fixture_service_pid" = "$fixture_keyring_pid"
printf '%s' 'codeshell-ci-readiness' |
  timeout 15s secret-tool store --label='CodeShell CI readiness' codeshell-fixture readiness
timeout 15s secret-tool lookup codeshell-fixture readiness > "$fixture_keyring_root/readiness"
test "$(cat "$fixture_keyring_root/readiness")" = codeshell-ci-readiness
secret-tool clear codeshell-fixture readiness
echo 'Electron CI: private SecretService unlocked and verified'

xvfb-run -a bun run --cwd packages/desktop test:e2e
PRIVATE_SESSION

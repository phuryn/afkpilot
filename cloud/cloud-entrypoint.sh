#!/usr/bin/env bash
# Bring up one cloud environment.
#
# Two environment variables decide everything, and both are already part of the
# extension's contract rather than invented here:
#
#   GROK_RELAY_URL           which relay to dial
#   GROK_RELAY_DEVICE_TOKEN  a device token minted in advance
#
# The token path is the interesting one. `resolveInjectedDeviceToken`
# (src/remote-frames.ts) answers the SecretStorage key from memory instead of
# disk, and its own comment says why that exists: "what makes a headless Linux
# runner work: Electron safeStorage is often unavailable there, and a disk write
# would throw." Somebody built for this box before it existed.
#
# It is honoured only when GROK_RELAY_URL actually moves the relay off the
# build's default, and never in a packaged build. Both gates are deliberate and
# neither is worked around here: this runs an UNPACKAGED build against a
# non-production relay, which is exactly the case the gates permit.
#
# A managed environment would not link interactively either — the relay mints
# the token when it creates the environment, on behalf of a user who is already
# signed in, and passes it as a secret. So this is the real shape, not a
# shortcut around one.
set -euo pipefail

say() { echo "[cloud] $*"; }

if [ -z "${GROK_RELAY_URL:-}" ]; then
  say "GROK_RELAY_URL is required — a cloud environment has no .env to fall back to."
  exit 64
fi
if [ -z "${GROK_RELAY_DEVICE_TOKEN:-}" ]; then
  say "GROK_RELAY_DEVICE_TOKEN is required — nothing here can complete an interactive link."
  exit 64
fi

mkdir -p "$HOME" "$GROK_HOME" "$HOME/Grok Build"

say "relay: ${GROK_RELAY_URL}"
say "grok CLI: $(command -v grok || echo 'not installed — connect it from a client')"
say "home: ${HOME}"

# Xvfb by hand rather than `xvfb-run`, after xvfb-run cost an hour.
#
# It authenticates with an MIT-MAGIC-COOKIE in a temp Xauthority, and Electron
# could not use it: "Authorization required, but no authorization protocol
# specified" then "Missing X server or $DISPLAY", then a process that vanished
# while xvfb-run itself stayed alive — a container that looked healthy and
# hosted nothing. `-ac` disables access control outright, which is the right
# call here: the display is on a loopback-only server inside a single-tenant
# container, and there is nobody to keep out.
#
# `-nolisten tcp` keeps it off the network regardless.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99

for _ in $(seq 1 50); do
  if [ -e /tmp/.X11-unix/X99 ]; then break; fi
  sleep 0.2
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
  say "Xvfb never came up:"; cat /tmp/xvfb.log; exit 69
fi
say "display :99 up"

# Electron logs a wall of "Failed to connect to the bus" without a session bus.
# Harmless, and loud enough to bury a real error, so give it a definite answer.
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-/dev/null}

# `--no-sandbox` reaches Electron because run-desktop.cjs passes through every
# argument it does not consume itself. Chromium's setuid sandbox contains a
# renderer from the rest of a shared machine; this machine is one tenant's
# environment and the container is already that boundary.
exec node scripts/run-desktop.cjs --relay-dev --no-sandbox "$@"

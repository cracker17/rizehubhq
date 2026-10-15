#!/usr/bin/with-contenv bash
# Runs at container start (linuxserver custom-cont-init.d). Chromium leaves Singleton* lock files in its profile; after
# a crash or a VPS reboot a stale lock makes it refuse to open the profile. Nothing is running yet at this point, so the
# locks are always stale here. Logins (cookies) are untouched.
set -euo pipefail
PROFILE=/config/hq-profile
mkdir -p "$PROFILE"
rm -f "$PROFILE"/SingletonLock "$PROFILE"/SingletonSocket "$PROFILE"/SingletonCookie
chown -R "${PUID:-1000}:${PGID:-1000}" "$PROFILE"
echo "[hq] cleared stale Chromium locks in $PROFILE"

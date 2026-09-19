#!/usr/bin/env bash
# Make Chromium's setuid sandbox helper usable. Needs sudo; re-run after any
# `npm install` / `npx install-electron`, which restore the file unprivileged.
#
# WHY: Chromium's namespace sandbox needs CAP_SYS_ADMIN inside a fresh user namespace.
# On Ubuntu 24.04+ with kernel.apparmor_restrict_unprivileged_userns=1, an unconfined
# process that calls userns_create is transitioned into the `unprivileged_userns`
# AppArmor profile, which denies CAP_SYS_ADMIN. (That profile's `allow userns,` line
# permits creating the namespace, not the capability needed inside it.) Chromium then
# falls back to this setuid helper, which aborts unless it is root-owned and mode 4755.
set -euo pipefail

cd "$(dirname "$0")/.."
SANDBOX="node_modules/electron/dist/chrome-sandbox"

if [ ! -f "$SANDBOX" ]; then
  echo "Not found: $SANDBOX — run 'npm install && npx install-electron' first." >&2
  exit 1
fi

sudo chown root:root "$SANDBOX"
sudo chmod 4755 "$SANDBOX"
ls -l "$SANDBOX"
echo "chrome-sandbox fixed. 'npm start' should now work from any terminal."

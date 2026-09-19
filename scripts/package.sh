#!/usr/bin/env bash
# Build a distributable. Pass --dir for an unpacked build (fast, for testing).
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/env-repair.sh

# resources/bridge/ is gitignored and built on demand, so a clean checkout would
# otherwise produce a package with no SpaceMouse support and no warning.
if [ ! -x resources/bridge/spacemouse-bridge ]; then
  echo "Bridge binary missing — building it first."
  bash scripts/fetch-bridge.sh
fi

# Under the VS Code snap, AppArmor's fusermount3 profile refuses to hand the FUSE fd to
# a peer confined as snap.code.code, so flatpak-builder's rofiles-fuse step fails with
# "Failure spawning rofiles-fuse". A normal terminal is unaffected, so only then disable
# it. It merely guards hardlinked build files, and this build only copies prebuilt ones.
if grep -q 'snap\.code\.code' /proc/self/attr/current 2>/dev/null; then
  shim="$(mktemp -d)"
  trap 'rm -rf "$shim"' EXIT
  printf '#!/usr/bin/env bash\nexec %q --disable-rofiles-fuse "$@"\n' \
    "$(command -v flatpak-builder)" > "$shim/flatpak-builder"
  chmod +x "$shim/flatpak-builder"
  export PATH="$shim:$PATH"
fi

npx electron-builder "$@"

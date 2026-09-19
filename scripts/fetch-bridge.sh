#!/usr/bin/env bash
# Build the SpaceMouse bridge into resources/bridge/.
#
# The binary is built rather than committed: it is 7.7MB, changes with every bridge
# update, and Go is a build-time dependency we already require for packaging. The result
# is still the single static binary the architecture calls for — electron-builder copies
# resources/ into the app bundle, so the shipped app has no runtime dependency on Go.
#
# Pass a commit-ish as $1 to override the pin.
set -euo pipefail

REPO="https://github.com/kchellappan/spacemouse_linux_ws.git"
PIN="${1:-fa83af33f19aba366c7ab4f634fb753460ed6e9f}"

cd "$(dirname "$0")/.."
OUT="$PWD/resources/bridge"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v go >/dev/null || { echo "go toolchain not found; install golang-go" >&2; exit 1; }

echo "Cloning $REPO @ $PIN"
git clone --quiet "$REPO" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$PIN"

mkdir -p "$OUT"
echo "Building..."
( cd "$WORK/src" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o "$OUT/spacemouse-bridge" ./cmd/spacemouse-bridge )

printf '%s\n' "$PIN" > "$OUT/PINNED_COMMIT"

# The bridge (MIT) and its one dependency, gorilla/websocket (BSD-2-Clause), both require
# their notice to accompany redistributed binaries — and the packages redistribute this one.
cp "$WORK/src/LICENSE" "$OUT/LICENSE"
ws_dir="$(cd "$WORK/src" && go list -m -f '{{.Dir}}' github.com/gorilla/websocket)"
cp "$ws_dir/LICENSE" "$OUT/LICENSE.gorilla-websocket"
chmod u+w "$OUT"/LICENSE*
chmod +x "$OUT/spacemouse-bridge"
ls -lh "$OUT/spacemouse-bridge"
"$OUT/spacemouse-bridge" -version

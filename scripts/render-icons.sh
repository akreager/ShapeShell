#!/usr/bin/env bash
# Rasterise build/icon.svg into every size the packages need.
# Usage: bash scripts/render-icons.sh [path/to/new-icon.svg]
#   With an argument, that SVG is first copied over build/icon.svg.
#
# The source should be square. Sizes are the hicolor buckets GNOME actually searches
# (16-512); a lone 1024px icon installs where the shell never looks.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ $# -ge 1 ]; then
  cp "$1" "$ROOT/build/icon.svg"
  echo "Copied $1 -> build/icon.svg"
fi

render() { # render <size> <out.png>
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$1" -h "$1" "$ROOT/build/icon.svg" -o "$2"
  elif command -v inkscape >/dev/null 2>&1; then
    # Absolute paths: the Inkscape snap resolves relative paths against $HOME, not cwd.
    inkscape --export-type=png --export-filename="$2" -w "$1" -h "$1" "$ROOT/build/icon.svg" >/dev/null 2>&1
  else
    echo "Need rsvg-convert (librsvg2-bin) or inkscape to rasterise the icon." >&2
    exit 1
  fi
}

mkdir -p "$ROOT/build/icons"
render 1024 "$ROOT/build/icon.png"
for s in 16 24 32 48 64 128 256 512; do
  render "$s" "$ROOT/build/icons/${s}x${s}.png"
done
ls -1 "$ROOT/build/icons"
echo "Done. Rebuild with: npm run pack"

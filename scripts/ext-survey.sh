#!/usr/bin/env bash
# Extension API survey (plan phase 0): which chrome.* APIs do the target extensions use
# that Electron is missing? Fetches the targets into the gitignored dist/ext-survey/, then
# runs scripts/ext-survey/survey.js against them. Report: dist/ext-survey/report.md.
#
#   npm run ext-survey                 # the default targets below
#   npm run ext-survey -- <dir>...     # any unpacked extensions instead
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/env-repair.sh

OUT=dist/ext-survey
DL="$OUT/downloads"
mkdir -p "$DL"

# Bitwarden, from the Chrome Web Store. Unpinned on purpose: the survey should track what a
# user would install today. The report records the version it saw.
BITWARDEN_ID=nngceckbapebfimnlniiiahkandclblb
# Onshape Drawing Comfort (0BSD), GitHub only.
DRAWING_REPO=https://github.com/SamDomiono/Onshape-Drawing-Comfort-Dark-Mode.git
DRAWING_COMMIT=8bda244

fetch_crx() { # id name
  local id=$1 name=$2 chromever
  if [ ! -d "$DL/$name" ]; then
    # The store serves the build that matches the requesting Chromium version.
    chromever=$(ELECTRON_RUN_AS_NODE=1 npx electron -p process.versions.chrome)
    echo "fetching $name ($id) from the Chrome Web Store for Chromium $chromever" >&2
    curl -fsSL -o "$DL/$name.crx" \
      "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromever}&acceptformat=crx3&x=id%3D${id}%26uc"
    # CRX3: "Cr24", version 3, uint32le header length, header, then a plain zip.
    local hl
    hl=$(od -An -tu4 -j8 -N4 "$DL/$name.crx" | tr -d ' ')
    tail -c +$((12 + hl + 1)) "$DL/$name.crx" > "$DL/$name.zip"
    mkdir -p "$DL/$name"
    unzip -q "$DL/$name.zip" -d "$DL/$name"
    rm "$DL/$name.zip"
  fi
}

if [ "$#" -eq 0 ]; then
  fetch_crx "$BITWARDEN_ID" bitwarden
  if [ ! -d "$DL/drawing-comfort" ]; then
    git clone -q "$DRAWING_REPO" "$DL/drawing-comfort"
    git -C "$DL/drawing-comfort" checkout -q "$DRAWING_COMMIT"
  fi
  set -- "$DL/bitwarden" "$DL/drawing-comfort" scripts/ext-survey/fixtures/content-worlds
fi

# raw: what a user would actually get. stub: every gap, not just the first.
# preload: the gaps left once scripts/ext-survey/polyfill-preload.js fills them.
for mode in ${EXT_SURVEY_MODES:-raw stub preload}; do
  EXT_SURVEY_MODE=$mode EXT_SURVEY_STDERR="$OUT/electron-$mode.err" \
    npx electron scripts/ext-survey/survey.js "$@" 2>"$OUT/electron-$mode.err"
done

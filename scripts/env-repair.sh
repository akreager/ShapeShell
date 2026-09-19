#!/usr/bin/env bash
# Shared environment repair — source this before launching Electron from source.
#
# A terminal inside the VS Code *snap* leaks variables that each break Electron in a way
# that looks like something else entirely. Everywhere else this script changes nothing
# except unsetting ELECTRON_RUN_AS_NODE, so it is safe on any distro or desktop.
#
# 1. ELECTRON_RUN_AS_NODE=1 (from any VS Code extension host) makes the electron binary
#    run as plain Node, so require('electron') returns a path string and `app` is
#    undefined. Symptom: "TypeError: Cannot read properties of undefined (reading 'on')".
#
# 2. Under the snap, GSETTINGS_SCHEMA_DIR / XDG_DATA_HOME / XDG_DATA_DIRS point at a
#    snap-private gschema cache missing org.gnome.desktop.interface font-antialiasing.
#    Chromium's GTK code reads that key and SIGSEGVs before any window appears — even with
#    --disable-gpu, so it masquerades as a GPU failure. All three must be repaired.

unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

# Only touch XDG state when the snap leak is actually present. The snap records the
# pre-snap values in *_VSCODE_SNAP_ORIG, so restore those rather than guessing paths —
# hardcoding Ubuntu defaults here would clobber a correct XDG_DATA_DIRS elsewhere.
if [ -n "${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-}" ] || [[ "${GSETTINGS_SCHEMA_DIR:-}" == */snap/* ]]; then
  unset GSETTINGS_SCHEMA_DIR
  if [[ "${XDG_DATA_HOME:-}" == "$HOME/snap/"* ]]; then
    export XDG_DATA_HOME="$HOME/.local/share"
  fi
  [ -n "${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-}" ] && export XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG"
  [ -n "${XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG:-}" ] && export XDG_CONFIG_DIRS="$XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG"

  if command -v gsettings >/dev/null 2>&1 \
     && gsettings list-schemas 2>/dev/null | grep -qx org.gnome.desktop.interface \
     && ! gsettings get org.gnome.desktop.interface font-antialiasing >/dev/null 2>&1; then
    echo "ENV REPAIR FAILED: org.gnome.desktop.interface font-antialiasing unreadable." >&2
    echo "Electron would SIGSEGV in GTK. Check XDG_DATA_DIRS / GSETTINGS_SCHEMA_DIR." >&2
    exit 3
  fi
fi

# Warn early rather than letting Chromium abort with its much less obvious message.
# Not fatal: under a complain-mode AppArmor profile the namespace sandbox still works.
_sandbox="$(dirname "${BASH_SOURCE[0]}")/../node_modules/electron/dist/chrome-sandbox"
if [ -f "$_sandbox" ] && [ ! -u "$_sandbox" ]; then
  echo "WARNING: chrome-sandbox is not setuid-root." >&2
  echo "  From an unconfined terminal Electron may abort with 'The SUID sandbox helper" >&2
  echo "  binary was found, but is not configured correctly'. Fix: npm run fix-sandbox" >&2
fi
unset _sandbox

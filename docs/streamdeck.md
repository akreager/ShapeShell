# Stream Deck integration

**StreamController does this job. ShapeShell contributes one thing: a stable `wm_class`.**

The original plan (milestone 7) was a bespoke systemd `--user` daemon —
`python-elgato-streamdeck` reading the keys, `ydotool` emitting Onshape shortcuts, a udev
rule for non-root HID access, and a stretch goal of switching profiles on focus.
[StreamController](https://github.com/StreamController/StreamController) already does all
of it, on Wayland, and it is packaged. Writing the daemon would have duplicated a working
project to get a worse version of the stretch goal. Verified working end to end on
2026-09-22; the daemon plan is dropped.

Nothing in this document requires a code change to ShapeShell. It is all user-side setup,
recorded here because every step of it failed silently the first time.

## What ShapeShell provides

| | |
|---|---|
| `wm_class` | `io.github.akreager.ShapeShell` |
| Window title | the constant string `ShapeShell` |

`app.setDesktopName()` in `src/main.js` is the only thing that sets the Wayland `app_id`,
and Mutter copies `app_id` straight into `wm_class` for Wayland toplevels
(`xdg_toplevel_set_app_id` → `meta_window_set_wm_class`). The value is identical for the
Flatpak and for `npm start`, so one page config follows both.

The **title never changes**. Electron sets a `BaseWindow`'s title once, from the app name
(`native_window.cc`: `SetTitle(options.ValueOrDefault(kTitle, Browser::Get()->GetName()))`),
and nothing in `src/main.js` calls `setTitle`. Only `BrowserWindow` syncs its title from
page titles; a `WebContentsView` does not, and ShapeShell's content is a
`WebContentsView`. The Onshape page title you see in the toolbar is drawn by
`src/chrome/toolbar.html` and never reaches the window manager. **So the title regex must
be `.*`** — matching on anything else can never fire. See [Not done yet](#not-done-yet).

## How StreamController matches

`src/backend/WindowGrabber/WindowGrabber.py`, `get_is_window_matching`:

```python
class_match = re.search(class_regex, window.wm_class, re.IGNORECASE)
title_match = re.search(title_regex, window.title, re.IGNORECASE)
return class_match and title_match
```

- Unanchored, case-insensitive **substring** search, not a full match.
- Both must match. A field left blank defaults to `.*`, so wm-class alone is a complete
  configuration.
- On a focus change it walks every page with auto-change enabled and takes the **first**
  match whose `decks` list contains that deck's serial.

## Setup

### 1. The GNOME Shell extension

On GNOME this extension is the *only* source of window information — StreamController
calls its D-Bus interface and has no fallback. Install
[StreamController Integration](https://extensions.gnome.org/extension/6871/streamcontroller-integration/)
(`streamcontroller@core447.com`; declares Shell 45–50, verified on 50.1).

Installing through the Shell loads it live, which matters because a hand-installed
extension does not load under Wayland until you log out and back in:

```sh
gdbus call --session --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.InstallRemoteExtension \
  "streamcontroller@core447.com"
```

Accept the dialog. The call then returns
`GDBus.Error:org.freedesktop.DBus.Error.NoReply` — **this is cosmetic**, the activatable
service exits after installing. Check `gnome-extensions info streamcontroller@core447.com`
for `State: ACTIVE` rather than trusting the return.

> **Not `window-calls`.** `window-calls@domandoman.xyz` backs the separate
> `StreamController/GnomeWindowCalls` *plugin* (Move / Resize / Status actions). It
> exports `/org/gnome/Shell/Extensions/Windows` and does nothing for page switching, which
> needs `/org/gnome/Shell/Extensions/StreamController`. The repo names are nearly
> identical and it is an easy hour to lose.

### 2. The `ubuntu:gnome` blocker

StreamController tests `XDG_CURRENT_DESKTOP.lower() == "gnome"` with exact equality, and
Ubuntu sets `ubuntu:GNOME`. The session type `wayland` is not in `SUPPORTED_ENVS` either,
so `init_integration` returns early, `self.integration` stays `None`, and **no window
event is ever processed** — there is no user-visible symptom, only one line in the log.

```sh
flatpak override --user --env=XDG_CURRENT_DESKTOP=GNOME com.core447.StreamController
```

Dropping the `ubuntu:` prefix only affects GTK's portal and appearance lookups. The
override is harmless if upstream ever relaxes the comparison.

### 3. The page

`~/.var/app/com.core447.StreamController/data/pages/<Page>.json`:

```json
"auto-change": {
  "enable": true,
  "decks": ["<your deck serial>"],
  "wm-class": "io.github.akreager.ShapeShell",
  "title": ".*"
}
```

The serial is the filename under `data/settings/decks/`. Edit the file with
StreamController stopped, or set it in the UI and then **re-select the deck in the Decks
list** — a regex edit does not take effect until you do
([issue #426](https://github.com/StreamController/StreamController/issues/426)).

Restart StreamController afterwards so it re-runs `init_integration`.

## Verifying

```sh
# 1. The grabber initialised. Log: ~/.var/app/com.core447.StreamController/data/logs/logs.log
grep "window grabber" logs.log
#   want: Initializing window grabber for environment: gnome under server: wayland
#   bad:  Unsupported environment: ubuntu:gnome with server: wayland

# 2. The extension sees ShapeShell.
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/StreamController \
  --method org.gnome.Shell.Extensions.StreamController.GetAllWindows
#   want: {"wm_class":"io.github.akreager.ShapeShell","title":"ShapeShell"}

# 3. The page switches. Focus ShapeShell, then read the log.
#   want: Auto changing page: .../pages/<Page>.json on deck <serial>
#         DBus API [<serial>]: ActivePageName changed to '<Page>'
```

To drive step 3 without touching the mouse, `window-calls` (if installed) can raise the
window: take the `id` from its `List` method and call `Activate`.

## Gotchas

- **Check `flatpak override --show` only after `source scripts/env-repair.sh`.** From a VS
  Code snap terminal the leaked `XDG_DATA_HOME` sends `flatpak` to the snap's private
  directory, where it reports a confident, wrong, empty result. Same trap as in the
  packaging notes.
- **It does not switch back.** `stay-on-page` defaults to true, so leaving ShapeShell
  leaves the deck on the ShapeShell page. Turn it off to return to the last page loaded by
  hand — that is the closest equivalent to the Windows software's revert-to-default.
- **An empty page still "works".** A page with no `keys` block switches correctly and
  blanks the deck, which looks like a failure.

## Not done yet

Separate deck pages per Onshape context — Part Studio, Assembly, Drawing, the documents
list. Matching can only see `wm_class` and the title, and ShapeShell's title is a constant,
so every Onshape context looks identical today.

The change would be in the `pushState` closure in `src/main.js`, which already fires on
`page-title-updated`, `did-navigate` and `did-navigate-in-page` — give the window a title
like `ShapeShell - <context>` and the existing title regex becomes useful. The open
question first: whether Onshape's own page title distinguishes those contexts at all, or
whether it only ever carries the document name. Measure before designing.

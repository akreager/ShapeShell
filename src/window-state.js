'use strict';

const { app, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Mutter auto-maximizes a window whose requested size is close to the work area — at
// 1600x1000 on a 1920x1080 display it always opened maximized. 1440x900 stays under it.
const DEFAULTS = { width: 1440, height: 900, maximized: false };
const SAVE_DEBOUNCE_MS = 400;

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// A saved position can name a monitor that is no longer connected, which would restore
// the window off-screen. Require it to overlap some display's work area.
function isOnScreen(bounds) {
  if (!Number.isFinite(bounds?.x) || !Number.isFinite(bounds?.y)) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width &&
    bounds.x + bounds.width > a.x &&
    bounds.y < a.y + a.height &&
    bounds.y + bounds.height > a.y);
}

function load() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }

  const state = {
    width: Number.isFinite(saved.width) ? saved.width : DEFAULTS.width,
    height: Number.isFinite(saved.height) ? saved.height : DEFAULTS.height,
    maximized: !!saved.maximized,
  };
  if (isOnScreen(saved)) {
    state.x = saved.x;
    state.y = saved.y;
  }
  return state;
}

function track(win) {
  const saveNow = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // getBounds() reports the maximized size while maximized; getNormalBounds() keeps
    // the size to restore to.
    const bounds = maximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized }, null, 2));
    } catch (err) {
      console.error('[window-state] save failed:', err.message);
    }
  };

  let timer = null;
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };

  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('maximize', saveSoon);
  win.on('unmaximize', saveSoon);
  // Debounced writes would be lost to app teardown, so flush synchronously here.
  win.on('close', () => {
    clearTimeout(timer);
    saveNow();
  });
}

module.exports = { load, track };

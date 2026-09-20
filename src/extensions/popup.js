'use strict';

// The extension action popup: one host per ShapeShell window (extensions phase 1).
//
// Chrome sizes an action popup to its content, up to 800x600, and closes it as soon as it
// loses focus. Electron gives us the first for free through enablePreferredSizeMode; the
// second is wired up here.

const { WebContentsView, shell } = require('electron');
const manager = require('./manager');

const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 80;
const MARGIN = 8;

class ExtensionPopup {
  constructor({ win, partition, toolbarHeight, cornerRadius, onClosed }) {
    this.win = win;
    this.partition = partition;
    this.toolbarHeight = toolbarHeight;
    this.cornerRadius = cornerRadius;
    this.onClosed = onClosed || (() => {});
    this.view = null;
    this.extId = null;
    this.anchorRight = 0;
    this.size = { width: 360, height: 480 };
    this.lastClosed = { extId: null, at: 0 };
  }

  get isOpen() {
    return Boolean(this.view);
  }

  toggle(extId, anchorRight) {
    if (this.isOpen && this.extId === extId) {
      this.close();
      return false;
    }
    // Clicking the icon of an open popup blurs it, so it has already closed itself by the
    // time the click arrives. Without this the popup would flicker shut and reopen.
    if (this.lastClosed.extId === extId && Date.now() - this.lastClosed.at < 250) return false;
    return this.open(extId, anchorRight);
  }

  open(extId, anchorRight) {
    const url = manager.popupUrl(extId);
    if (!url) return false;
    this.close();

    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        preload: manager.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Reports the page's own content size, which is how the popup gets Chrome's
        // size-to-content behaviour instead of a fixed guess.
        enablePreferredSizeMode: true,
      },
    });
    this.view = view;
    this.extId = extId;
    this.anchorRight = anchorRight;
    view.setBackgroundColor('#ffffff');
    view.setBorderRadius(this.cornerRadius);
    this.win.contentView.addChildView(view);

    const wc = view.webContents;
    wc.on('preferred-size-changed', (_event, size) => {
      this.size = {
        width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(size.width))),
        height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(size.height))),
      };
      this.layout();
    });

    // A popup that opens a link (Bitwarden's help and web-vault links) must not become a
    // second Onshape window.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });

    // Chrome dismisses a popup on focus loss and on Escape.
    wc.on('blur', () => this.close());
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    // window.close() from inside the popup, which extensions use to dismiss themselves.
    wc.on('destroyed', () => {
      if (this.view === view) {
        this.lastClosed = { extId: this.extId, at: Date.now() };
        this.view = null;
        this.extId = null;
        this.onClosed();
      }
    });

    this.layout();
    wc.loadURL(url);
    wc.focus();
    return true;
  }

  close() {
    const view = this.view;
    if (!view) return;
    this.lastClosed = { extId: this.extId, at: Date.now() };
    this.view = null;
    this.extId = null;
    this.win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.onClosed();
  }

  layout() {
    if (!this.view) return;
    const { width: winW, height: winH } = this.win.contentView.getBounds();
    const width = Math.min(this.size.width, Math.max(MIN_WIDTH, winW - 2 * MARGIN));
    const height = Math.min(this.size.height, Math.max(MIN_HEIGHT, winH - this.toolbarHeight - 2 * MARGIN));
    // Hangs from the right edge of the tray icon, like Chrome, but never off-window.
    const x = Math.max(MARGIN, Math.min(Math.round(this.anchorRight - width), winW - width - MARGIN));
    this.view.setBounds({ x, y: this.toolbarHeight + MARGIN, width, height });
  }

  destroy() {
    this.close();
  }
}

module.exports = { ExtensionPopup };

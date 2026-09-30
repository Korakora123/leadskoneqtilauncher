'use strict';
/**
 * System tray: status line, Open Koneqti Leads (dashboard), Profiles…, Pause all, Quit.
 */
const { Tray, Menu, nativeImage } = require('electron');

function statusLabel(s) {
  if (!s.logged_in) return 'Signed out';
  if (s.paused_all) return 'Paused';
  if (s.runner && s.runner.running > 0) return `Running ${s.runner.running} job${s.runner.running === 1 ? '' : 's'}`;
  if (s.brain && s.brain.connected) return 'Connected';
  if (s.brain && s.brain.state === 'connecting') return 'Connecting…';
  return 'Offline';
}

/**
 * @param {object} o
 * @param {string} o.iconPath
 * @param {() => void} o.onOpenDashboard
 * @param {() => void} o.onOpenProfiles
 * @param {(paused:boolean) => void} o.onTogglePause
 * @param {() => void} o.onQuit
 */
function createTray(o) {
  let img = nativeImage.createFromPath(o.iconPath);
  if (!img.isEmpty()) img = img.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  const tray = new Tray(img);
  let last = { logged_in: false };

  function render(s) {
    last = s || last;
    const label = statusLabel(last);
    tray.setToolTip(`Koneqti Leads — ${label}`);
    const menu = Menu.buildFromTemplate([
      { label: `Koneqti Leads — ${label}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Koneqti Leads', click: () => o.onOpenDashboard() },
      { label: 'Profiles…', click: () => o.onOpenProfiles() },
      {
        label: 'Pause all',
        type: 'checkbox',
        checked: Boolean(last.paused_all),
        click: (item) => o.onTogglePause(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => o.onQuit() },
    ]);
    tray.setContextMenu(menu);
  }

  tray.on('click', () => o.onOpenProfiles());
  render(last);

  return {
    update: (s) => { try { render(s); } catch (_) { /* ignore */ } },
    destroy: () => { try { tray.destroy(); } catch (_) { /* ignore */ } },
  };
}

module.exports = { createTray, statusLabel };

'use strict';
/**
 * IPC bridge (contextIsolation). The renderer only gets these functions — no Node access.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('koneqti', {
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: (profile) => ipcRenderer.invoke('profiles:add', profile),
  openProfileBrowser: (id) => ipcRenderer.invoke('profiles:openBrowser', id),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  setWorkingHours: (id, hours) => ipcRenderer.invoke('profiles:setWorkingHours', { id, hours }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openDashboard: (path) => ipcRenderer.invoke('app:openDashboard', path || ''),
  onStatus: (cb) => {
    const handler = (_e, status) => { try { cb(status); } catch (_) { /* ignore */ } };
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
});

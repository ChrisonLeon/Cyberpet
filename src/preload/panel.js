'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('panel', {
  get: () => invoke('settings:get'),
  set: (patch) => invoke('settings:set', patch),
  action: (name) => invoke('action', name),
  pickHead: () => invoke('head:pick'),
  openUrl: (url) => invoke('open:url', url),
  pasteHead: () => invoke('head:paste'),
  resetHead: () => invoke('head:reset'),
  pickVoice: () => invoke('voice:pick'),
  clearVoice: () => invoke('voice:clear'),
  retryHook: () => invoke('hook:retry'),
  openPermissionSettings: () => invoke('permission:open'),
  copyPermissionFix: () => invoke('permission:copyFix'),
  updateCheck: () => invoke('update:check'),
  updateDownload: (payload) => invoke('update:download', payload),
  updateInstall: () => invoke('update:install'),
  updateOpenPage: () => invoke('update:openPage'),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onUpdateDone: (cb) => ipcRenderer.on('update:done', (_e, r) => cb(r)),
  collapse: () => invoke('panel:collapse'),
  banner: (show) => ipcRenderer.send('panel:banner', !!show),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('pet:status', (_e, s) => cb(s)),
  onPrivacy: (cb) => ipcRenderer.on('privacy', (_e, s) => cb(s)),
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onSettings: (cb) => {
    ipcRenderer.on('settings', (_e, payload) => cb(payload));
    ipcRenderer.send('pet:ready');
  },
  onInput: (cb) => ipcRenderer.on('input', (_e, ev) => cb(ev)),
  onAction: (cb) => ipcRenderer.on('action', (_e, name) => cb(name)),
  setIgnore: (ignore) => ipcRenderer.send('pet:ignore', !!ignore),
  moveBy: (dx, dy) => ipcRenderer.send('pet:moveBy', { dx, dy }),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  status: (s) => ipcRenderer.send('pet:status', s),
  headBroken: () => ipcRenderer.send('pet:headBroken'),
  saveHeadOffset: (off) => ipcRenderer.send('pet:headOffset', off),
});

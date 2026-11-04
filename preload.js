'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  ipcRenderer.on(channel, function (e, payload) { cb(payload); });
}

contextBridge.exposeInMainWorld('api', {
  init: function () { return ipcRenderer.invoke('app:init'); },

  startScan: function (opts) { return ipcRenderer.invoke('scan:start', opts); },
  stopScan: function () { return ipcRenderer.invoke('scan:stop'); },
  onBatch: function (cb) { on('scan:batch', cb); },
  onProgress: function (cb) { on('scan:progress', cb); },
  onDone: function (cb) { on('scan:done', cb); },
  onError: function (cb) { on('scan:error', cb); },

  reveal: function (p) { return ipcRenderer.invoke('shell:reveal', p); },
  openRecycleBin: function () { return ipcRenderer.invoke('shell:openBin'); },
  openRules: function () { return ipcRenderer.invoke('rules:open'); },

  pickDir: function () { return ipcRenderer.invoke('op:pickDir'); },
  opPlan: function (req) { return ipcRenderer.invoke('op:plan', req); },
  opRun: function (req) { return ipcRenderer.invoke('op:run', req); },
  opCancel: function () { return ipcRenderer.invoke('op:cancel'); },
  onOpProgress: function (cb) { on('op:progress', cb); },
  onOpBytes: function (cb) { on('op:bytes', cb); },
  onOpError: function (cb) { on('op:error', cb); },

  exportCsv: function (payload) { return ipcRenderer.invoke('export:csv', payload); },
  exportHtml: function (payload) { return ipcRenderer.invoke('export:html', payload); }
});

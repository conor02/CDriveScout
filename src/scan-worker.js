'use strict';

const { parentPort, workerData } = require('worker_threads');
const { scan } = require('./scanner');

let stopped = false;

parentPort.on('message', function (msg) {
  if (msg && msg.type === 'stop') stopped = true;
});

try {
  const result = scan(workerData, {
    onProgress: function (p) {
      parentPort.postMessage({ type: 'progress', files: p.files, bytes: p.bytes, dir: p.dir, kept: p.kept, elapsed: p.elapsed, finished: !!p.finished, cats: p.cats || {} });
    },
    onItems: function (items) {
      parentPort.postMessage({ type: 'batch', items: items });
    },
    shouldStop: function () { return stopped; }
  });
  parentPort.postMessage({ type: 'done', files: result.files, bytes: result.bytes, kept: result.kept, errors: result.errors, elapsed: result.elapsed, stopped: stopped });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
}

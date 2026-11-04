'use strict';

const fs = require('fs');
const path = require('path');
const { classify, isSystemPath } = require('./rules');

const ALWAYS_SKIP = ['$recycle.bin', 'system volume information'];

function scan(options, hooks) {
  let root = String(options.root || 'C:\\').replace(/\//g, '\\');
  while (root.length > 3 && root.charAt(root.length - 1) === '\\') root = root.slice(0, -1);
  if (root.length === 2) root += '\\';
  const minSize = Number(options.minSize) || 0;
  const skipSystemScan = !!options.skipSystemScan;
  const systemRoots = options.systemRoots || [];
  const rules = options.rules || [];
  const onProgress = (hooks && hooks.onProgress) || function () {};
  const onItems = (hooks && hooks.onItems) || function () {};
  const shouldStop = (hooks && hooks.shouldStop) || function () { return false; };

  const t0 = Date.now();
  let files = 0;
  let bytes = 0;
  let errors = 0;
  let kept = 0;
  let lastReport = 0;
  let buffer = [];
  const catStats = {};
  const stack = [root];

  function flush() {
    if (buffer.length) {
      onItems(buffer);
      buffer = [];
    }
  }

  while (stack.length) {
    if (shouldStop()) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors++;
      continue;
    }
    for (let i = 0; i < entries.length; i++) {
      const ent = entries[i];
      if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
      const lowerName = ent.name.toLowerCase();
      if (ALWAYS_SKIP.indexOf(lowerName) !== -1) continue;

      const full = dir.endsWith('\\') ? dir + ent.name : dir + '\\' + ent.name;
      let st;
      try {
        st = fs.lstatSync(full, { throwIfNoEntry: false });
      } catch (e) {
        errors++;
        continue;
      }
      if (!st) { errors++; continue; }
      if (st.isSymbolicLink()) continue;

      if (st.isDirectory()) {
        if (skipSystemScan && isSystemPath(full.toLowerCase(), systemRoots)) continue;
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;

      files++;
      bytes += st.size;

      if (st.size >= minSize) {
        const cls = classify(full, systemRoots, rules);
        buffer.push({
          p: full,
          s: st.size,
          m: st.mtimeMs,
          c: cls.category,
          a: cls.action,
          r: cls.reason,
          z: cls.systemZone ? 1 : 0
        });
        const stat = catStats[cls.category] || (catStats[cls.category] = { n: 0, b: 0 });
        stat.n++;
        stat.b += st.size;
        kept++;
        if (buffer.length >= 2000) flush();
      }

      if ((files & 1023) === 0) {
        const now = Date.now();
        if (now - lastReport > 350) {
          lastReport = now;
          onProgress({ files: files, bytes: bytes, dir: dir, kept: kept, elapsed: now - t0, cats: catStats });
        }
      }
    }
  }

  flush();
  const elapsed = Date.now() - t0;
  onProgress({ files: files, bytes: bytes, dir: '', kept: kept, elapsed: elapsed, finished: true, cats: catStats });
  return { files: files, bytes: bytes, kept: kept, errors: errors, elapsed: elapsed };
}

module.exports = { scan };

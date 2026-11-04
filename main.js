'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { loadRules } = require('./src/rules');
const { buildCsv, buildHtmlReport } = require('./src/report');
const {
  MAX_BATCH, HASH_LIMIT, buildContext, planTrash, planMigrate, checkItem
} = require('./src/ops');

const CHUNK = 20;          // 每处理 20 个文件让出一次事件循环，界面不卡
const TRASH_TIMEOUT = 20000;

let win = null;
let worker = null;
let activeOp = null;

function rulesPath() {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'rules.ini');
  return path.join(__dirname, 'rules.ini');
}

function readRules() {
  const target = rulesPath();
  if (fs.existsSync(target)) return loadRules(target);
  const bundled = path.join(app.getAppPath(), 'rules.ini');
  if (fs.existsSync(bundled)) return loadRules(bundled);
  return loadRules(target);
}

function opContext() {
  const rules = readRules();
  return buildContext(rules, {
    rulesPath: rulesPath(),
    appRoots: [
      path.dirname(process.execPath),
      app.getAppPath(),
      path.join(app.getPath('userData'))
    ]
  });
}

function listDrives() {
  const out = [];
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = letter + ':\\';
    try {
      const st = fs.statfsSync(root);
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      if (total > 0) {
        out.push({ root: root, letter: letter, total: total, free: free });
      }
    } catch (e) {
      /* 未挂载 */
    }
  }
  return out;
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function humanErr(err) {
  const msg = String((err && err.message) || err || '');
  if (/EPERM|EACCES/i.test(msg)) return '权限不足，可能正在被占用';
  if (/EBUSY/i.test(msg)) return '文件被占用';
  if (/ENOENT/i.test(msg)) return '文件不存在（可能已被移动或删除）';
  if (/ENOSPC/i.test(msg)) return '目标磁盘空间不足';
  return msg.replace(/^Error:\s*/, '').split('\n')[0];
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#F5F5F2',
    title: 'C 盘透视 · CDriveScout',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', function () {
    win = null;
    stopWorker();
    if (activeOp) activeOp.cancel = true;
  });
}

function stopWorker() {
  const w = worker;
  worker = null;                      // 立即释放句柄，允许马上重新扫描
  if (!w) return;
  try { w.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
  setTimeout(function () {
    try { w.terminate(); } catch (e) { /* ignore */ }
  }, 800);
}

function finishOp(plan, results, mode, extra) {
  const okItems = results.filter(function (r) { return r.ok; });
  const out = {
    ok: true,
    mode: mode,
    results: results,
    count: results.length,
    okCount: okItems.length,
    failCount: results.length - okItems.length,
    okBytes: okItems.reduce(function (a, b) { return a + (b.s || 0); }, 0),
    canceled: results.some(function (r) { return r.error === '已取消'; }),
    blocked: plan.blocked || [],
    targetRoot: plan.targetRoot || ''
  };
  if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

/* 移到回收站：逐个走 Electron 的 shell.trashItem（= Windows 回收站），失败即保留原文件 */
async function runTrash(plan, token) {
  const results = [];
  const list = plan.items;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (token.cancel) {
      results.push({ src: it.src, s: it.s, ok: false, error: '已取消' });
      continue;
    }
    let res;
    try {
      /* 执行前再按当前磁盘状态复核一次：防止渲染层传来的路径被替换或已变成目录 */
      const chk = checkItem({ p: it.src }, plan.ctx);
      if (!chk.ok) throw new Error(chk.msg);
      const st = fs.lstatSync(it.src);
      if (st.isSymbolicLink()) throw new Error('符号链接，已跳过');
      if (!st.isFile()) throw new Error('不是普通文件，已跳过');

      await withTimeout(shell.trashItem(it.src), TRASH_TIMEOUT, '回收站操作超时');
      res = { src: it.src, s: st.size, ok: true };
    } catch (err) {
      res = { src: it.src, s: it.s, ok: false, error: humanErr(err) };
    }
    results.push(res);
    emit('op:progress', {
      phase: 'trash', index: i + 1, total: list.length, file: it.src,
      ok: res.ok, error: res.error || ''
    });
    if (i % CHUNK === CHUNK - 1) await sleep(0);
  }
  return finishOp(plan, results, 'trash');
}

function withTimeout(promise, ms, msg) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error(msg)); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

/* 迁移：worker 复制 + 校验 → 主进程把原件送进回收站 */
async function runMigrate(plan, req, token) {
  const items = plan.items.map(function (it) {
    return { src: it.src, dst: it.dst, s: it.s };
  });

  const w = new Worker(path.join(__dirname, 'src', 'ops-worker.js'), {
    workerData: {
      items: items,
      hashLimit: req.verify === 'size' ? 0 : HASH_LIMIT
    }
  });
  token.worker = w;

  const results = [];
  const bySrc = {};

  const copyDone = new Promise(function (resolve) {
    let settled = false;
    function done() {
      if (settled) return;
      settled = true;
      resolve();
    }
    w.on('message', function (msg) {
      if (!msg) return;
      if (msg.type === 'result') {
        results.push(msg.res);
        bySrc[msg.res.src] = msg.res;
      } else if (msg.type === 'progress') {
        emit('op:progress', {
          phase: 'copy', index: msg.index, total: msg.total, file: msg.src,
          ok: true, error: ''
        });
      } else if (msg.type === 'bytes') {
        emit('op:bytes', { done: msg.done, total: msg.total, file: msg.src });
      } else if (msg.type === 'done' || msg.type === 'fatal') {
        if (msg.type === 'fatal') emit('op:error', { message: msg.message });
        done();
      }
    });
    w.on('error', function (err) {
      emit('op:error', { message: String((err && err.message) || err) });
      done();
    });
    w.on('exit', done);
  });

  /* 取消：让 worker 自己中断（每 1MB 分片检查一次），15 秒还没退出再强杀 */
  const opStart = Date.now();
  const watcher = setInterval(function () {
    if (!token.cancel) return;
    clearInterval(watcher);
    try { w.postMessage({ type: 'cancel' }); } catch (e) { /* ignore */ }
    setTimeout(function () {
      try { w.terminate(); } catch (e) { /* ignore */ }
    }, 15000);
  }, 150);

  await copyDone;
  clearInterval(watcher);
  token.worker = null;

  /* 补齐未收到结果的条目（强制终止时） */
  for (let i = 0; i < items.length; i++) {
    if (!bySrc[items[i].src]) {
      bySrc[items[i].src] = { src: items[i].src, dst: items[i].dst, s: items[i].s, ok: false, error: '已取消' };
      results.push(bySrc[items[i].src]);
    }
  }

  /* 强杀线程可能留下半成品副本。只清理「本次操作开始后新写、且大小不对」的副本，
     已存在的同名文件绝不会被误删。 */
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = bySrc[it.src];
    if (r && (r.ok || r.error !== '已取消')) continue;
    try {
      if (!fs.existsSync(it.dst)) continue;
      const st = fs.statSync(it.dst);
      if (st.mtimeMs >= opStart - 2000 && st.size !== it.s) fs.unlinkSync(it.dst);
    } catch (e) { /* ignore */ }
  }

  /* 只有校验通过的文件，原件才进回收站 */
  let trashed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) continue;
    try {
      await withTimeout(shell.trashItem(r.src), TRASH_TIMEOUT, '回收站操作超时');
      r.trash = 'ok';
      trashed++;
    } catch (err) {
      r.trash = 'failed';
      r.trashError = humanErr(err);
    }
    emit('op:progress', {
      phase: 'trash', index: i + 1, total: results.length, file: r.src,
      ok: r.ok, error: r.error || ''
    });
    if (i % CHUNK === CHUNK - 1) await sleep(0);
  }

  return finishOp(plan, results, 'migrate', { trashed: trashed });
}

app.whenReady().then(function () {
  createWindow();

  ipcMain.handle('app:init', function () {
    const r = readRules();
    const ctx = opContext();
    return {
      drives: listDrives(),
      rulesSource: r.source,
      rulesCount: r.rules.length,
      protectRoots: r.protectRoots || [],
      systemRoots: r.systemRoots || [],
      maxBatch: MAX_BATCH,
      version: app.getVersion(),
      packaged: app.isPackaged
    };
  });

  ipcMain.handle('scan:start', function (event, opts) {
    if (worker) return { ok: false, error: '已有扫描在进行中' };
    const r = readRules();
    const options = {
      root: opts.root,
      minSize: Number(opts.minSize) || 0,
      skipSystemScan: !!opts.skipSystemScan,
      systemRoots: r.systemRoots,
      rules: r.rules
    };
    worker = new Worker(path.join(__dirname, 'src', 'scan-worker.js'), { workerData: options });
    const current = worker;

    function isCurrent() { return worker === current; }

    current.on('message', function (msg) {
      /* 已停止/已被新一轮扫描取代的 worker，消息一律不再转发，避免串数据 */
      if (!isCurrent() || !win) return;
      if (msg.type === 'batch') {
        win.webContents.send('scan:batch', msg.items);
      } else if (msg.type === 'progress') {
        win.webContents.send('scan:progress', msg);
      } else if (msg.type === 'done') {
        win.webContents.send('scan:done', msg);
        worker = null;
      } else if (msg.type === 'error') {
        win.webContents.send('scan:error', msg);
        worker = null;
      }
    });
    current.on('error', function (err) {
      if (isCurrent() && win) win.webContents.send('scan:error', { message: String(err && err.stack ? err.stack : err) });
      if (isCurrent()) worker = null;
    });
    current.on('exit', function () {
      if (isCurrent()) worker = null;
    });
    return { ok: true, rulesCount: r.rules.length };
  });

  ipcMain.handle('scan:stop', function () {
    stopWorker();
    return { ok: true };
  });

  ipcMain.handle('shell:reveal', function (event, p) {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.handle('shell:openBin', function () {
    execFile('explorer.exe', ['shell:RecycleBinFolder'], function () { /* 忽略返回值 */ });
    return { ok: true };
  });

  ipcMain.handle('rules:open', function () {
    const target = rulesPath();
    if (!fs.existsSync(target)) {
      const bundled = path.join(app.getAppPath(), 'rules.ini');
      if (fs.existsSync(bundled)) {
        try { fs.copyFileSync(bundled, target); } catch (e) { /* ignore */ }
      }
    }
    shell.openPath(target);
    return { ok: true, path: target };
  });

  ipcMain.handle('op:pickDir', async function () {
    const res = await dialog.showOpenDialog(win, {
      title: '选择迁移目标目录',
      buttonLabel: '用这个目录',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: res.filePaths[0] };
  });

  ipcMain.handle('op:plan', function (event, req) {
    const ctx = opContext();
    const items = Array.isArray(req.items) ? req.items : [];
    if (!items.length) return { ok: false, error: '没有选中任何文件' };
    if (req.mode === 'migrate') {
      return planMigrate(items, { targetRoot: req.targetRoot, keepTree: !!req.keepTree }, ctx);
    }
    return planTrash(items, ctx);
  });

  ipcMain.handle('op:run', async function (event, req) {
    if (activeOp) return { ok: false, error: '已有操作正在进行中' };
    const ctx = opContext();
    const items = Array.isArray(req.items) ? req.items : [];
    if (!items.length) return { ok: false, error: '没有选中任何文件' };

    const plan = req.mode === 'migrate'
      ? planMigrate(items, { targetRoot: req.targetRoot, keepTree: !!req.keepTree }, ctx)
      : planTrash(items, ctx);
    if (!plan.ok) return plan;
    plan.ctx = ctx;

    const token = { cancel: false, worker: null };
    activeOp = token;
    try {
      if (req.mode === 'migrate') return await runMigrate(plan, req, token);
      return await runTrash(plan, token);
    } catch (err) {
      return { ok: false, error: humanErr(err) };
    } finally {
      activeOp = null;
    }
  });

  ipcMain.handle('op:cancel', function () {
    if (activeOp) activeOp.cancel = true;
    return { ok: true };
  });

  ipcMain.handle('export:csv', async function (event, payload) {
    const rows = payload.rows || [];
    const res = await dialog.showSaveDialog(win, {
      title: '导出 CSV',
      defaultPath: path.join(app.getPath('desktop'), 'C盘扫描结果.csv'),
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, buildCsv(rows), 'utf8');
    return { ok: true, path: res.filePath, count: rows.length };
  });

  ipcMain.handle('export:html', async function (event, payload) {
    const res = await dialog.showSaveDialog(win, {
      title: '导出 HTML 报告',
      defaultPath: path.join(app.getPath('desktop'), 'C盘透视报告.html'),
      filters: [{ name: 'HTML 文件', extensions: ['html'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, buildHtmlReport(payload), 'utf8');
    return { ok: true, path: res.filePath };
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  stopWorker();
  if (activeOp) activeOp.cancel = true;
  if (process.platform !== 'darwin') app.quit();
});

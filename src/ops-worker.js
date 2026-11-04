'use strict';

/* 迁移执行器（工作线程）：只做「复制 + 校验」，绝不删除源文件。
   源文件的回收站处理由主进程在拿到 ok=true 之后执行，保证失败时原件一定还在。 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const items = (workerData && workerData.items) || [];
const hashLimit = Number(workerData && workerData.hashLimit) || 0;
const PROGRESS_MS = 150;

let cancelled = false;

parentPort.on('message', function (msg) {
  if (msg && msg.type === 'cancel') cancelled = true;
});

function sha256(file) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file, { highWaterMark: 2 * 1024 * 1024 });
    rs.on('data', function (c) { h.update(c); });
    rs.on('error', reject);
    rs.on('end', function () { resolve(h.digest('hex')); });
  });
}

function copyStream(src, dst, onBytes) {
  return new Promise(function (resolve, reject) {
    const rs = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
    const ws = fs.createWriteStream(dst, { flags: 'wx' });   // wx：目标已存在直接失败，绝不覆盖
    let done = 0;
    let last = 0;
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (e) { /* ignore */ }
      try { ws.destroy(); } catch (e) { /* ignore */ }
      reject(err);
    }
    rs.on('data', function (chunk) {
      if (cancelled) { fail(new Error('已取消')); return; }
      done += chunk.length;
      const now = Date.now();
      if (now - last >= PROGRESS_MS) { last = now; onBytes(done); }
    });
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', function () {
      if (settled) return;
      settled = true;
      onBytes(done);
      resolve(done);
    });
    rs.pipe(ws);
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function runOne(it) {
  const st = fs.statSync(it.src);
  if (!st.isFile()) throw new Error('不是普通文件，已跳过');
  const dir = path.dirname(it.dst);
  fs.mkdirSync(dir, { recursive: true });
  /* 目标已存在时直接放弃：绝不覆盖，也绝不在后续清理里删掉别人的文件 */
  if (fs.existsSync(it.dst)) throw new Error('目标文件已存在，已跳过');

  let started = false;
  try {
    started = true;
    await copyStream(it.src, it.dst, function (done) {
      parentPort.postMessage({ type: 'bytes', src: it.src, dst: it.dst, done: done, total: st.size });
    });

    const dstSt = fs.statSync(it.dst);
    if (dstSt.size !== st.size) {
      throw new Error('校验失败：大小不一致（源 ' + st.size + ' / 副本 ' + dstSt.size + '）');
    }
    let verify = 'size';
    if (hashLimit > 0 && st.size <= hashLimit) {
      const pair = await Promise.all([sha256(it.src), sha256(it.dst)]);
      if (pair[0] !== pair[1]) throw new Error('校验失败：SHA-256 不一致');
      verify = 'sha256';
    }
    try {
      fs.utimesSync(it.dst, dstSt.atime, st.mtime);
    } catch (e) { /* 时间戳保留失败不影响正确性 */ }
    return { src: it.src, dst: it.dst, s: dstSt.size, ok: true, verify: verify };
  } catch (err) {
    /* 只清理「本次写入产生」的副本：EEXIST 说明目标是被别人占用的，不能动 */
    if (started && !(err && err.code === 'EEXIST')) {
      try { fs.unlinkSync(it.dst); } catch (e) { /* ignore */ }
    }
    throw err;
  }
}

(async function () {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (cancelled) {
      parentPort.postMessage({
        type: 'result',
        res: { src: it.src, dst: it.dst, s: it.s, ok: false, error: '已取消' }
      });
      continue;
    }
    let res;
    try {
      res = await runOne(it);
    } catch (err) {
      /* 半成品清理由 runOne 负责（它会区分「本次写入」与「目标已存在」） */
      res = { src: it.src, dst: it.dst, s: it.s, ok: false, error: String((err && err.message) || err) };
    }
    parentPort.postMessage({ type: 'result', res: res });
    parentPort.postMessage({ type: 'progress', index: i + 1, total: items.length, src: it.src });
    if (i % 4 === 3) await sleep(0);
  }
  parentPort.postMessage({ type: 'done' });
  /* 必须断开端口，否则监听器让事件循环常驻，线程永不退出（每次操作泄漏一个线程） */
  parentPort.close();
}()).catch(function (err) {
  parentPort.postMessage({ type: 'fatal', message: String((err && err.stack) || err) });
  parentPort.close();
});

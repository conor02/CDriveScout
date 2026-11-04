'use strict';

/* 迁移执行器单测（真跑工作线程，真读写文件）：
   1) 正常复制 + SHA-256 校验 + 时间戳保留
   2) 目标已存在时放弃，且不破坏已存在的文件
   3) 中途取消后不留半成品，源文件不动
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, '..', 'src', 'ops-worker.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-worker-'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function runWorker(items, opts) {
  return new Promise(function (resolve) {
    const w = new Worker(WORKER, {
      workerData: { items: items, hashLimit: opts && opts.hashLimit !== undefined ? opts.hashLimit : 2 * 1024 * 1024 * 1024 }
    });
    const results = [];
    let finished = false;
    let cancelledSent = false;
    function finish(list) {
      if (finished) return;
      finished = true;
      resolve(list);
    }
    w.on('message', function (m) {
      if (m.type === 'result') results.push(m.res);
      if (m.type === 'bytes' && opts && opts.cancelOnFirstBytes && !cancelledSent) {
        cancelledSent = true;
        try { w.postMessage({ type: 'cancel' }); } catch (e) { /* ignore */ }
      }
      if (m.type === 'done' || m.type === 'fatal') finish(results);
    });
    w.on('exit', function () { finish(results); });
    w.on('error', function (e) { finish([{ ok: false, error: 'worker error: ' + e.message }]); });
    if (opts && opts.cancelAfterSpawn) w.postMessage({ type: 'cancel' });
    if (opts && opts.cancelDelay) {
      setTimeout(function () {
        try { w.postMessage({ type: 'cancel' }); } catch (e) { /* ignore */ }
      }, opts.cancelDelay);
    }
    /* 超时保护：15 秒还没结束就当失败，避免测试整体挂死 */
    setTimeout(function () {
      if (finished) return;
      try { w.terminate(); } catch (e) { /* ignore */ }
      finish([{ ok: false, error: '测试超时：worker 未在 15 秒内结束' }]);
    }, 15000);
  });
}

(async function () {
  /* ---- 1. 正常复制 ---- */
  const src1 = path.join(base, 'src1', 'a.bin');
  fs.mkdirSync(path.dirname(src1), { recursive: true });
  const payload = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(src1, payload);
  const old = new Date('2024-05-06T07:08:09Z');
  fs.utimesSync(src1, old, old);

  const dst1 = path.join(base, 'dst1', 'deep', 'a.bin');
  let r = await runWorker([{ src: src1, dst: dst1, s: payload.length }]);
  check('正常复制成功', r.length === 1 && r[0].ok === true, JSON.stringify(r[0] || {}));
  check('使用 SHA-256 校验', r[0] && r[0].verify === 'sha256', r[0] && r[0].verify);
  check('副本内容一致', fs.existsSync(dst1) && sha(fs.readFileSync(dst1)) === sha(payload));
  check('副本大小一致', fs.statSync(dst1).size === payload.length);
  check('保留修改时间',
    Math.abs(fs.statSync(dst1).mtimeMs - old.getTime()) < 2000,
    String(fs.statSync(dst1).mtimeMs) + ' vs ' + old.getTime());

  /* ---- 2. 目标已存在 ---- */
  const src2 = path.join(base, 'src2', 'b.bin');
  fs.mkdirSync(path.dirname(src2), { recursive: true });
  fs.writeFileSync(src2, Buffer.from('source-content'));
  const dst2 = path.join(base, 'dst2', 'b.bin');
  fs.mkdirSync(path.dirname(dst2), { recursive: true });
  fs.writeFileSync(dst2, Buffer.from('EXISTING-USER-FILE'));

  r = await runWorker([{ src: src2, dst: dst2, s: 14 }]);
  check('目标已存在时判定失败', r[0] && r[0].ok === false, JSON.stringify(r[0] || {}));
  check('已存在的目标文件没有被删除', fs.existsSync(dst2));
  check('已存在的目标文件内容未被改动',
    fs.existsSync(dst2) && fs.readFileSync(dst2, 'utf8') === 'EXISTING-USER-FILE',
    fs.existsSync(dst2) ? fs.readFileSync(dst2, 'utf8') : '文件不存在');
  check('源文件仍然在', fs.existsSync(src2));

  /* ---- 3. 中途取消 ---- */
  const src3 = path.join(base, 'src3', 'big.bin');
  fs.mkdirSync(path.dirname(src3), { recursive: true });
  const chunk = Buffer.alloc(8 * 1024 * 1024, 0x43);
  const fd = fs.openSync(src3, 'w');
  for (let i = 0; i < 40; i++) fs.writeSync(fd, chunk);   // 320MB
  fs.closeSync(fd);
  const size3 = fs.statSync(src3).size;

  const dst3 = path.join(base, 'dst3', 'big.bin');
  r = await runWorker([{ src: src3, dst: dst3, s: size3 }], { cancelOnFirstBytes: true, hashLimit: 0 });
  const cancelled = r.filter(function (x) { return /已取消/.test(x.error || ''); });
  check('复制中途取消后返回已取消', cancelled.length === 1, JSON.stringify(r.map(function (x) { return x.error; })));
  check('取消后目标目录没有残留半成品', !fs.existsSync(dst3), fs.existsSync(dst3) ? '残留 ' + fs.statSync(dst3).size + ' 字节' : '');
  check('取消后源文件完好', fs.statSync(src3).size === size3);

  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('---');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
}()).catch(function (e) {
  console.error('异常: ' + e.stack);
  process.exit(1);
});

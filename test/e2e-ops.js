'use strict';

/* 端到端测试：驱动真实界面完成「扫描 → 勾选 → 移到回收站」与「迁移到 D 盘」，
   每一步都截图，便于人工复核。用法：node test/e2e-ops.js 9335 [trash|migrate|all] */

const fs = require('fs');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function connect(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const targets = await res.json();
  const page = targets.filter(function (t) { return t.type === 'page'; })[0];
  if (!page) throw new Error('找不到页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', function (ev) {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise(function (resolve, reject) {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  function send(method, params) {
    return new Promise(function (resolve) {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  return { send: send, ws: ws };
}

async function main() {
  const port = process.argv[2] || '9335';
  const phase = process.argv[3] || 'all';
  const c = await connect(port);

  async function ev(expr) {
    const r = await c.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function waitFor(expr, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await ev(expr);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时：' + label + ' / ' + expr.slice(0, 120));
  }

  async function shot(name) {
    let data = null;
    for (let i = 0; i < 3 && !data; i++) {
      const r = await Promise.race([
        c.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        sleep(6000).then(function () { return null; })
      ]);
      if (r && r.result && r.result.data) data = r.result.data;
    }
    if (!data) { console.log('截图失败: ' + name); return; }
    fs.writeFileSync('test/' + name, Buffer.from(data, 'base64'));
    console.log('截图 ' + name);
  }

  function log(t) { console.log('· ' + t); }

  /* 1. 扫描 */
  log('开始扫描');
  await ev('document.getElementById("btnScan").click()');
  await waitFor('document.getElementById("statusText").textContent.indexOf("完成")===0', 90000, '扫描完成');
  log('扫描完成：' + await ev('document.getElementById("statusText").textContent'));

  /* 2. 过滤到沙箱 */
  log('过滤 cds-e2e');
  await ev('(function(){var e=document.getElementById("search");e.value="cds-e2e";e.dispatchEvent(new Event("input",{bubbles:true}));return e.value})()');
  /* 搜索框有 220ms 防抖，窗口在后台时定时器还会被降频，所以等状态而不是等固定时间 */
  await waitFor('state.view.length > 0 && state.view.length < 20', 15000, '筛选生效');
  const rows = await ev('document.querySelectorAll(".row").length');
  log('过滤后可见行数 ' + rows + '，视图总数 ' + await ev('state.view.length'));
  if (!rows) throw new Error('沙箱文件没有被扫描到，检查体积门槛');
  log('首行路径 ' + await ev('document.querySelector(".row .cell.path").textContent'));

  /* 3. 全选 */
  await ev('document.getElementById("ckAll").click()');
  await sleep(500);
  log('已选 ' + await ev('document.getElementById("selCount").textContent') + ' 项，共 ' +
    await ev('document.getElementById("selSize").textContent'));

  if (phase === 'trash' || phase === 'all') {
    /* 4. 回收站：只处理 trash-me-* 两个文件 */
    log('改为只勾选 trash-me-*');
    await ev('(function(){var e=document.getElementById("search");e.value="trash-me";e.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
    await waitFor('state.view.length === 2', 15000, '筛选到两个文件');
    await ev('document.getElementById("ckAll").click()');
    await sleep(500);
    log('已选 ' + await ev('document.getElementById("selCount").textContent') + ' 项');

    await ev('document.getElementById("btnTrash").click()');
    await waitFor('document.getElementById("dlgTitle").textContent.indexOf("清单预览")===0', 15000, '预览弹窗');
    log('预览标题：' + await ev('document.getElementById("dlgTitle").textContent'));
    log('预览合计：' + await ev('document.querySelector(".dialog-foot .left").textContent'));
    await shot('e2e-1-preview.png');

    await ev('document.getElementById("dlgNext").click()');
    await waitFor('document.getElementById("dlgTitle").textContent==="最终确认"', 10000, '确认弹窗');
    log('确认按钮初始 disabled = ' + await ev('document.getElementById("dlgRun").disabled'));
    await shot('e2e-2-confirm.png');

    await ev('document.getElementById("ckConfirm").click()');
    await sleep(300);
    log('勾选后 disabled = ' + await ev('document.getElementById("dlgRun").disabled'));
    await ev('document.getElementById("dlgRun").click()');

    await waitFor('document.getElementById("dlgTitle").textContent.indexOf("完成")>0', 60000, '回收站完成');
    log('结果：' + await ev('document.querySelector(".dialog-body .note").textContent.trim()'));
    await shot('e2e-3-trash-result.png');
    await ev('document.getElementById("dlgClose").click()');
    await sleep(500);
  }

  if (phase === 'migrate' || phase === 'all') {
    log('过滤 move-me');
    await ev('(function(){var e=document.getElementById("search");e.value="move-me";e.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
    await waitFor('state.view.length === 2', 15000, '筛选到两个 iso');
    await ev('document.getElementById("ckAll").click()');
    await sleep(500);
    const n = await ev('document.getElementById("selCount").textContent');
    log('迁移候选 ' + n + ' 项');
    if (n === '0') throw new Error('没有可迁移的文件');

    await ev('document.getElementById("btnMigrate").click()');
    await waitFor('document.getElementById("dlgTitle").textContent==="迁移设置"', 10000, '迁移设置弹窗');
    await ev('(function(){var t=document.getElementById("migTarget");t.value="D:\\\\cds-e2e-target";t.dispatchEvent(new Event("input",{bubbles:true}));return t.value})()');
    await sleep(300);
    log('空间提示：' + await ev('document.getElementById("migSpace").textContent'));
    await shot('e2e-4-migrate-setup.png');

    await ev('document.getElementById("dlgNext").click()');
    await waitFor('document.getElementById("dlgTitle").textContent.indexOf("清单预览")===0', 15000, '迁移预览');
    log('预览目标：' + await ev('(document.querySelector(".dialog-body .note.ok")||{}).textContent'));
    await shot('e2e-5-migrate-preview.png');

    await ev('document.getElementById("dlgNext").click()');
    await waitFor('document.getElementById("dlgTitle").textContent==="最终确认"', 10000, '迁移确认');
    await ev('document.getElementById("ckConfirm").click()');
    await sleep(300);
    await ev('document.getElementById("dlgRun").click()');

    await waitFor('document.getElementById("dlgTitle").textContent.indexOf("完成")>0', 120000, '迁移完成');
    log('结果：' + await ev('document.querySelector(".dialog-body .note").textContent.trim()'));
    await shot('e2e-6-migrate-result.png');
    await ev('document.getElementById("dlgClose").click()');
  }

  /* 收尾截图：列表应已移除处理过的条目 */
  await sleep(500);
  await shot('e2e-7-after.png');
  console.log('剩余可见行数 ' + await ev('document.querySelectorAll(".row").length'));
  c.ws.close();
  process.exit(0);
}

main().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});

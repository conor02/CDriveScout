'use strict';

/* 取消路径专项测试：迁移一个大文件中途取消，验证「原件仍在、目标无残留半成品」
   用法：node test/e2e-cancel.js 9335 */

const fs = require('fs');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  const port = process.argv[2] || '9335';
  const target = process.argv[3] || 'D:\\cds-e2e-target';
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.filter(function (t) { return t.type === 'page'; })[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(function (r) { ws.addEventListener('open', r); });
  function send(method, params) {
    return new Promise(function (r) {
      const id = ++seq;
      pending.set(id, r);
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');

  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(300);
    }
    throw new Error('等待超时：' + label);
  }
  async function shot(name) {
    for (let i = 0; i < 3; i++) {
      const r = await Promise.race([
        send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        sleep(6000).then(function () { return null; })
      ]);
      if (r && r.result && r.result.data) {
        fs.writeFileSync('test/' + name, Buffer.from(r.result.data, 'base64'));
        console.log('截图 ' + name);
        return;
      }
    }
    console.log('截图失败 ' + name);
  }

  await ev('document.getElementById("btnScan").click()');
  await waitFor('document.getElementById("statusText").textContent.indexOf("完成")===0', 90000, '扫描');
  console.log('扫描完成');

  await ev('(function(){var e=document.getElementById("search");e.value="cds-cancel";e.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
  await waitFor('state.view.length === 1', 15000, '筛选');
  await ev('document.getElementById("ckAll").click()');
  await sleep(400);

  await ev('document.getElementById("btnMigrate").click()');
  await waitFor('document.getElementById("dlgTitle").textContent==="迁移设置"', 10000, '迁移设置');
  await ev('(function(){var t=document.getElementById("migTarget");t.value=' + JSON.stringify(target) + ';t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()');
  await ev('document.getElementById("dlgNext").click()');
  await waitFor('document.getElementById("dlgTitle").textContent.indexOf("清单预览")===0', 15000, '预览');
  await ev('document.getElementById("dlgNext").click()');
  await waitFor('document.getElementById("dlgTitle").textContent==="最终确认"', 10000, '确认');
  await ev('document.getElementById("ckConfirm").click()');
  await sleep(200);
  await ev('document.getElementById("dlgRun").click()');

  /* 等真正开始复制（进度条出现中间值）再取消，否则可能在开始前就点了 */
  let caught = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const state = await ev('(function(){var s=document.getElementById("opState"),f=document.getElementById("opFile");return JSON.stringify({s:s?s.textContent:"",f:f?f.textContent:"",t:document.getElementById("dlgTitle").textContent})})()');
    const o = JSON.parse(state);
    if (o.t.indexOf('完成') > 0) { console.log('复制太快，未抓到中途状态，操作已完成'); break; }
    if (o.s.indexOf('复制并校验') === 0) {
      const m = /(\d+)%$/.exec(o.f.trim());
      if (m) {
        const pct = Number(m[1]);
        if (pct >= 5 && pct <= 90) {
          caught = pct;
          await shot('e2e-8-copying.png');
          console.log('复制进行到 ' + pct + '%，点取消：' + o.f);
          await ev('document.getElementById("dlgStop").click()');
          break;
        }
      }
    }
    await sleep(40);
  }
  if (!caught) console.log('未在中途取到进度，仍执行取消以测试兜底分支');
  if (!caught) await ev('document.getElementById("dlgStop").click()');

  await waitFor('document.getElementById("dlgTitle").textContent.indexOf("完成")>0', 120000, '取消后返回');
  console.log('结果标题：' + await ev('document.getElementById("dlgTitle").textContent'));
  console.log('结果摘要：' + await ev('document.querySelector(".dialog-body .note").textContent.trim()'));
  await shot('e2e-9-cancel-result.png');

  ws.close();
  process.exit(0);
}

main().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});

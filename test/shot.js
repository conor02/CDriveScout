'use strict';

/* 通过 CDP 给运行中的窗口截图，用于自测界面是否正常渲染 */

const fs = require('fs');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  const port = process.argv[2] || '9333';
  const out = process.argv[3] || 'test/shot.png';
  const waitMs = Number(process.argv[4] || 2000);
  const clickSel = process.argv[5] || '';

  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const targets = await res.json();
  const page = targets.filter(function (t) { return t.type === 'page'; })[0];
  if (!page) throw new Error('找不到页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;

  ws.addEventListener('message', function (ev) {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
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

  if (clickSel) {
    const r = await send('Runtime.evaluate', {
      expression: 'document.querySelector(' + JSON.stringify(clickSel) + ').click()'
    });
    if (r.result && r.result.exceptionDetails) console.log('click error:', JSON.stringify(r.result.exceptionDetails));
  }

  await sleep(waitMs);

  const state = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({rows: document.querySelectorAll(".row").length, kpis: document.querySelectorAll(".kpi").length, status: (document.getElementById("statusText")||{}).textContent, meta: (document.getElementById("resultMeta")||{}).textContent})',
    returnByValue: true
  });
  console.log('DOM 状态: ' + (state.result && state.result.result && state.result.result.value));

  await send('Page.bringToFront');
  let shot = null;
  for (let attempt = 1; attempt <= 3 && !shot; attempt++) {
    const r = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      sleep(6000).then(function () { return null; })
    ]);
    if (r && r.result && r.result.data) shot = r;
    else console.log('第 ' + attempt + ' 次截图超时/失败，重试');
  }
  if (!shot) {
    console.log('截图失败');
    process.exit(2);
  }
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('已保存截图: ' + out);
  ws.close();
  process.exit(0);
}

main().catch(function (e) {
  console.error('失败: ' + e.message);
  process.exit(1);
});

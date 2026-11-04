'use strict';
/*
 * 文档截图脚本：驱动真实界面，扫描演示目录，截取主界面 / 目录占用 / 两段确认弹窗。
 * ⚠️ 只做「扫描 + 打开弹窗」，绝不点击最终执行按钮，不移动/删除任何文件。
 *
 * 用法：node test/demo-shot.js <调试端口> <演示目录>
 */

const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9338';
const DEMO = process.argv[3] || 'C:\\Users\\Public\\CDriveScout-Demo';
const OUT = path.join(__dirname, '..', 'docs', 'images');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find(function (t) { return t.type === 'page'; });
  if (!page) throw new Error('没有找到页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', function (e) {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise(function (r) { ws.addEventListener('open', r); });

  const send = function (method, params) {
    return new Promise(function (res) {
      const id = ++seq;
      pend.set(id, res);
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  };
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(name) {
    await send('Page.bringToFront');
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!r.result || !r.result.data) throw new Error('截图失败 ' + name);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('  已保存 ' + name + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
  }

  /* 1. 指向演示目录并扫描（体积门槛调到 1 MB，让 60MB 的小文件也出现） */
  console.log('扫描演示目录：' + DEMO);
  await ev('(function(){state.root=' + JSON.stringify(DEMO) + ';document.getElementById("minSize").value="1048576";return state.root})()');
  await ev('startScan()');

  let ok = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const done = await ev('state.scanning===false && state.items.length>0');
    if (done) { ok = true; break; }
  }
  if (!ok) throw new Error('扫描未完成');
  await sleep(600);

  console.log('  捕获 ' + await ev('state.items.length') + ' 条，状态栏：' + await ev('document.getElementById("statusText").textContent'));

  /* 2. 勾选前 3 项，露出「移到回收站 / 迁移」操作条 */
  async function pickThree() {
    await ev('(function(){state.selected.clear();var n=0;' +
      'for(var i=0;i<state.view.length && n<3;i++){var it=state.view[i];' +
      'if(isProtected(it))continue;state.selected.set(it.p,it);n++;}' +
      'renderWindow();updateSelBar();return state.selected.size})()');
    await sleep(300);
  }
  await pickThree();
  await shot('main.png');

  /* 3. 回收站：清单预览（第 1 步） */
  await ev('document.getElementById("btnTrash").click()');
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (await ev('getComputedStyle(document.getElementById("overlay")).display==="flex"')) break;
  }
  await sleep(300);
  console.log('  弹窗标题：' + await ev('document.getElementById("dlgTitle").textContent'));
  await shot('trash-step1.png');

  /* 4. 最终确认（第 2 步）——只看不点执行 */
  await ev('document.getElementById("dlgNext").click()');
  await sleep(400);
  console.log('  确认按钮当前禁用状态：' + await ev('document.getElementById("dlgRun").disabled'));
  await shot('trash-step2.png');
  await ev('closeDialog()');
  await sleep(200);

  /* 5. 迁移设置弹窗（同样只看不执行） */
  await ev('(function(){state.migrateTarget="D:\\\\CDriveScout-Moved";return state.migrateTarget})()');
  await ev('document.getElementById("btnMigrate").click()');
  await sleep(900);
  console.log('  迁移弹窗标题：' + await ev('document.getElementById("dlgTitle").textContent'));
  await shot('migrate-setup.png');
  await ev('closeDialog()');
  await sleep(200);

  /* 6. 清掉选择后再拍目录占用页，画面更干净 */
  await ev('clearSel()');
  await ev('document.querySelector(\'[data-tab="dirs"]\').click()');
  await sleep(500);
  await shot('dirs.png');

  console.log('  已关闭所有弹窗（未执行任何操作）');
  console.log('  目录文件数抽查：Downloads=' + fs.readdirSync(path.join(DEMO, 'Downloads')).length +
    ', Installers=' + fs.readdirSync(path.join(DEMO, 'Installers')).length);

  ws.close();
}

main().catch(function (e) {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

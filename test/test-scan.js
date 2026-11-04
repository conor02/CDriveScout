'use strict';

/* 命令行自测：不启动界面，只验证 扫描 + 规则分类 + 排序 是否正确 */

const path = require('path');
const os = require('os');
const { loadRules } = require('../src/rules');
const { scan } = require('../src/scanner');

/* 默认扫当前用户的 AppData\Local，换台机器也能直接跑 */
const root = process.argv[2] || path.join(os.homedir(), 'AppData', 'Local');
const minSize = Number(process.argv[3] || 1024 * 1024);

const r = loadRules(path.join(__dirname, '..', 'rules.ini'));
console.log('规则文件: ' + r.source);
console.log('系统保护区: ' + r.systemRoots.length + ' 条, 规则: ' + r.rules.length + ' 条');
console.log('开始扫描: ' + root + ' (只保留 >= ' + (minSize / 1048576).toFixed(0) + ' MB)');

const items = [];
const t0 = Date.now();
const res = scan(
  { root: root, minSize: minSize, skipSystemScan: false, systemRoots: r.systemRoots, rules: r.rules },
  {
    onItems: function (batch) { for (let i = 0; i < batch.length; i++) items.push(batch[i]); },
    onProgress: function () {}
  }
);

console.log('---');
console.log('结果: 扫描 ' + res.files + ' 个文件 / ' + (res.bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB, 保留 ' + res.kept + ' 条, 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, 跳过 ' + res.errors + ' 处');

const agg = {};
items.forEach(function (it) {
  const a = agg[it.c] || (agg[it.c] = { n: 0, b: 0 });
  a.n++;
  a.b += it.s;
});
console.log('--- 分类汇总 ---');
Object.keys(agg).forEach(function (k) {
  console.log('  ' + k + ': ' + agg[k].n + ' 个 / ' + (agg[k].b / 1024 / 1024 / 1024).toFixed(2) + ' GB');
});

items.sort(function (a, b) { return b.s - a.s; });
console.log('--- 最大的 12 个 ---');
items.slice(0, 12).forEach(function (it) {
  console.log('  ' + (it.s / 1048576).toFixed(1).padStart(9) + ' MB  [' + it.c + '] ' + it.p);
});

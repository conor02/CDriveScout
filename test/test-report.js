'use strict';

/* 报告生成单测：用合成数据跑一遍 HTML / CSV 导出 */

const fs = require('fs');
const path = require('path');
const { buildHtmlReport, buildCsv, fmtSize } = require('../src/report');

const rows = [
  { p: 'C:\\Users\\User\\AppData\\Local\\Temp\\setup.exe', s: 641728512, m: Date.now() - 86400000, c: '可安全清理', a: '删除', r: '临时文件', z: 0 },
  { p: 'C:\\Users\\User\\Downloads\\ubuntu-24.04.iso', s: 3.1e9, m: Date.now() - 172800000, c: '建议迁移', a: '迁移', r: '下载目录，建议整体迁到 D 盘', z: 0 },
  { p: 'C:\\Program Files\\Docker\\Docker\\frontend\\Docker Desktop.exe', s: 246415360, m: Date.now(), c: '需确认', a: '需确认', r: 'Docker 数据，按官方方式清理或迁移', z: 1 },
  { p: 'C:\\Windows\\System32\\drivers\\disk.sys', s: 1048576, m: Date.now(), c: '系统保护区', a: '不要动', r: '位于系统目录，清理风险高', z: 1 },
  { p: 'C:\\Users\\User\\AppData\\Roaming\\SomeApp\\data.bin', s: 52428800, m: Date.now(), c: '其他', a: '—', r: '未命中规则，按需自行判断', z: 0 }
];

const categories = [
  { name: '可安全清理', count: 282, bytes: 5.7 * 1024 ** 3 },
  { name: '建议迁移', count: 43, bytes: 597 * 1024 ** 2 },
  { name: '需确认', count: 148, bytes: 7.12 * 1024 ** 3 },
  { name: '系统保护区', count: 1079, bytes: 26.9 * 1024 ** 3 },
  { name: '其他', count: 344, bytes: 6.49 * 1024 ** 3 }
];

const html = buildHtmlReport({ rows: rows, summary: { files: 421394, bytes: 79 * 1024 ** 3, categories: categories } });
const csv = buildCsv(rows);

fs.writeFileSync(path.join(__dirname, 'sample-report.html'), html, 'utf8');
fs.writeFileSync(path.join(__dirname, 'sample-export.csv'), csv, 'utf8');

const checks = [
  ['HTML 有表格', html.indexOf('<table>') !== -1],
  ['HTML 含全部分类卡', categories.every(function (c) { return html.indexOf(c.name) !== -1; })],
  ['HTML 含扫描总数', html.indexOf('421,394') !== -1],
  ['CSV 有 BOM', csv.charCodeAt(0) === 0xfeff],
  ['CSV 行数正确', csv.split('\r\n').length === rows.length + 1],
  ['CSV 含引号转义', buildCsv([{ p: 'C:\\a,b\\"x".txt', s: 1, m: 0, c: '其他', a: '—', r: '' }]).indexOf('"C:\\a,b\\""x"".txt"') !== -1],
  ['大小格式化', fmtSize(641728512) === '612 MB']
];

let fail = 0;
checks.forEach(function (c) {
  console.log((c[1] ? 'OK  ' : 'FAIL') + '  ' + c[0]);
  if (!c[1]) fail++;
});

console.log('---');
console.log('HTML ' + html.length + ' 字节，CSV ' + csv.split('\r\n').length + ' 行');
process.exit(fail ? 1 : 0);

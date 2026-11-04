'use strict';

/* 规则单测：验证典型路径落在正确分类里 */

const path = require('path');
const { loadRules, classify } = require('../src/rules');

const r = loadRules(path.join(__dirname, '..', 'rules.ini'));

const cases = [
  ['C:\\Windows\\Temp\\abc.tmp', '可安全清理'],
  ['C:\\Users\\User\\AppData\\Local\\Temp\\install.log', '可安全清理'],
  ['C:\\Users\\User\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\data_1', '可安全清理'],
  ['C:\\Users\\User\\AppData\\Local\\npm-cache\\_cacache\\x', '可安全清理'],
  ['C:\\Windows\\SoftwareDistribution\\Download\\update.cab', '可安全清理'],
  ['C:\\Windows\\System32\\drivers\\disk.sys', '系统保护区'],
  ['C:\\Program Files\\Lenovo\\Vantage\\VantageService.exe', '系统保护区'],
  ['C:\\ProgramData\\Docker\\data.bin', '需确认'],
  ['C:\\Users\\User\\Downloads\\ubuntu.iso', '建议迁移'],
  ['C:\\Users\\User\\Desktop\\项目资料.zip', '建议迁移'],
  ['C:\\Users\\User\\Documents\\WeChat Files\\wxid_abc\\File\\报表.xlsx', '建议迁移'],
  ['C:\\Users\\User\\AppData\\Local\\Packages\\CanonicalGroupLimited\\LocalState\\ext4.vhdx', '需确认'],
  ['D:\\Games\\Steam\\steamapps\\common\\a.bin', '建议迁移'],
  ['C:\\Users\\User\\Videos\\旅行.mkv', '建议迁移'],
  ['C:\\Users\\User\\Pictures\\照片.jpg', '建议迁移'],
  ['C:\\Users\\User\\AppData\\Roaming\\SomeApp\\config.json', '其他']
];

let pass = 0;
let fail = 0;
cases.forEach(function (c) {
  const got = classify(c[0], r.systemRoots, r.rules);
  const ok = got.category === c[1];
  if (ok) pass++; else fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + c[1] + (ok ? '' : ' (实际: ' + got.category + ')') + '  ' + c[0]);
});

console.log('---');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);

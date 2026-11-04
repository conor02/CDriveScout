'use strict';

/* 只读检查：解析 C:\$Recycle.Bin 下的 $I 元数据，列出回收站里文件的原路径
   用法：node test/inspect-bin.js [过滤关键词] */

const fs = require('fs');

const base = 'C:\\$Recycle.Bin';
const filter = process.argv[2] || '';

let dirs = [];
try {
  dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory(); })
    .map(function (d) { return d.name; });
} catch (e) {
  console.log('无法读取回收站: ' + e.message);
  process.exit(0);
}

let total = 0;
let hit = 0;
for (let i = 0; i < dirs.length; i++) {
  const dir = base + '\\' + dirs[i];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(function (f) { return f.indexOf('$I') === 0; });
  } catch (e) { continue; }
  for (let k = 0; k < files.length; k++) {
    total++;
    try {
      const b = fs.readFileSync(dir + '\\' + files[k]);
      if (b.length < 28) continue;
      const size = Number(b.readBigUInt64LE(8));
      /* 偏移 24 的 4 字节是「路径字符数（含结尾 \0）」，不是字节数 */
      const chars = b.readUInt32LE(24);
      const p = b.toString('utf16le', 28, 28 + Math.max(0, chars - 1) * 2).replace(/\0+$/, '');
      if (!filter || p.toLowerCase().indexOf(filter.toLowerCase()) !== -1) {
        hit++;
        console.log(size + ' 字节  |  ' + p);
      }
    } catch (e) { /* 跳过损坏项 */ }
  }
}

console.log('---');
console.log('回收站条目总数 ' + total + '，命中 ' + hit);

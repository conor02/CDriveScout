'use strict';
/* 生成用于文档截图的演示文件树（ftruncate 瞬时创建，逻辑大小真实）
   全部放在 C:\Users\Public\CDriveScout-Demo，路径不含任何个人信息 */

const fs = require('fs');
const path = require('path');

const BASE = 'C:\\Users\\Public\\CDriveScout-Demo';
const MB = 1024 * 1024;

const files = [
  ['Downloads\\ubuntu-24.04.1-desktop-amd64.iso', 820 * MB],
  ['Downloads\\Adobe_CC_2026.zip', 320 * MB],
  ['Videos\\2026-城市漫步-4K.mkv', 480 * MB],
  ['Pictures\\wedding-raw\\DSC_0412.ARW', 96 * MB],
  ['SteamLibrary\\steamapps\\common\\DemoGame\\archive\\content.arc', 600 * MB],
  ['AppData\\Local\\Temp\\premiere-cache.dat', 240 * MB],
  ['AppData\\Local\\Temp\\install-cache.tmp', 60 * MB],
  ['AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\data_3', 180 * MB],
  ['AppData\\Local\\Docker\\wsl\\data\\ext4.vhdx', 420 * MB],
  ['Documents\\design-draft.psd', 140 * MB],
  ['Installers\\setup-2026.msi', 120 * MB]
];

let total = 0;
for (const [rel, size] of files) {
  const full = path.join(BASE, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fd = fs.openSync(full, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  total += size;
  console.log((size / MB).toFixed(0).padStart(5) + ' MB  ' + rel);
}

/* 再补一批小文件：让状态栏的「用时」和「扫描文件数」像真实整盘扫描，而不是 0.0s */
const BULK_DIRS = 15;
const PER_DIR = 1000;
const t0 = Date.now();
for (let d = 0; d < BULK_DIRS; d++) {
  const dir = path.join(BASE, 'node_modules-cache', 'pkg-' + String(d).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PER_DIR; i++) {
    fs.writeFileSync(path.join(dir, 'chunk-' + i + '.js'), '// demo ' + d + '-' + i + '\n');
  }
}
console.log('---');
console.log('小文件 ' + (BULK_DIRS * PER_DIR).toLocaleString() + ' 个，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('共 ' + files.length + ' 个大文件，合计 ' + (total / 1024 / 1024 / 1024).toFixed(2) + ' GB → ' + BASE);

#!/usr/bin/env node
'use strict';

/*
 * 打包脚本：只把「运行需要的文件」放进 staging 目录，再对它打包。
 *
 * 为什么不用 --ignore 排除：electron-packager 的 --ignore 是相对路径正则，
 * 在 Windows 上写成 "^/dist" 匹配不上，历史产物会被整个塞进 app.asar
 * （曾打出 377 MB 的 asar，正常运行只要 113 KB）。用 staging 彻底避免这类事故。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, '.build-staging');
/* 可用 `node scripts/build.js 某个目录` 指定输出位置，默认 release */
const OUT = path.resolve(ROOT, process.argv[2] || 'release');
const APP_NAME = 'CDriveScout';

/* 只拷这些：多一个文件都不进包 */
const RUNTIME_ENTRIES = [
  'main.js',
  'preload.js',
  'package.json',
  'rules.ini',
  'LICENSE',
  'src',
  'renderer'
];

function log(msg) { console.log('[build] ' + msg); }
function kb(n) { return (n / 1024).toFixed(0) + ' KB'; }
function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  fs.copyFileSync(src, dst);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

/* 1. 校验前置条件 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let electronVersion = pkg.devDependencies && pkg.devDependencies.electron;
try {
  electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version;
} catch (e) {
  /* 没装 electron 时退回 package.json 里声明的范围 */
}
if (!electronVersion) {
  console.error('[build] 找不到 Electron 版本，请先 npm install');
  process.exit(1);
}
const packagerBin = path.join(ROOT, 'node_modules/@electron/packager/bin/electron-packager.mjs');
if (!fs.existsSync(packagerBin)) {
  console.error('[build] 缺少 @electron/packager，请先 npm install');
  process.exit(1);
}
log('Electron ' + electronVersion + ' / 应用版本 ' + pkg.version);

/* 2. 重建 staging */
if (fs.existsSync(STAGING)) fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });
for (const name of RUNTIME_ENTRIES) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.error('[build] 缺少必需文件：' + name);
    process.exit(1);
  }
  copyRecursive(src, path.join(STAGING, name));
}
log('staging 就绪：' + dirSize(STAGING) + ' 字节 / ' + RUNTIME_ENTRIES.length + ' 项');

/* 3. 清掉同名旧产物（只动这一个目录） */
const outDir = path.join(OUT, APP_NAME + '-win32-x64');
if (fs.existsSync(outDir)) {
  log('移除旧产物 ' + path.relative(ROOT, outDir));
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch (e) {
    console.error('[build] 删不掉旧产物：' + (e.message || e));
    console.error('[build] 多半是里面的文件正被占用（程序还开着 / 预览面板开着）。');
    console.error('[build] 关掉程序后重试，或换一个输出目录：node scripts/build.js 其它目录');
    process.exit(1);
  }
}

/* 4. 打包 */
const args = [
  packagerBin,
  STAGING, APP_NAME,
  '--platform=win32',
  '--arch=x64',
  '--out=' + OUT,
  '--app-version=' + pkg.version,
  '--executable-name=' + APP_NAME,
  '--electron-version=' + electronVersion
];
log('开始打包（首次会下载 Electron 运行时，国内可先设 ELECTRON_MIRROR）');
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) {
  console.error('[build] 打包失败，退出码 ' + r.status);
  process.exit(r.status || 1);
}

/* 5. rules.ini 会被 packager 一起打包，但产物根目录也放一份，方便直接编辑 */
const rulesSrc = path.join(STAGING, 'rules.ini');
const rulesDst = path.join(outDir, 'rules.ini');
if (fs.existsSync(rulesSrc)) {
  fs.copyFileSync(rulesSrc, rulesDst);
  log('rules.ini 已放到产物根目录（可直接编辑）');
}

/* 6. 收尾 */
const asar = path.join(outDir, 'resources', 'app.asar');
if (fs.existsSync(asar)) log('app.asar: ' + kb(fs.statSync(asar).size));
log('完成 → ' + path.relative(ROOT, outDir) + '（' + mb(dirSize(outDir)) + '）');
log('提示：运行时必须整个文件夹一起拷走，只拿 exe 打不开。');

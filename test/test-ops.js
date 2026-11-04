'use strict';

/* 操作层单测：路径映射、冲突避让、保护拦截、计划生成（不碰真实文件） */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadRules } = require('../src/rules');
const {
  MAX_BATCH, buildContext, checkItem, mapTargetPath, uniquePath, planTrash, planMigrate
} = require('../src/ops');

const rules = loadRules(path.join(__dirname, '..', 'rules.ini'));
const ctx = buildContext(rules, {
  rulesPath: path.join(__dirname, '..', 'rules.ini'),
  appRoots: [path.join(__dirname, '..')]
});

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ops-'));

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---- 路径映射 ---- */
check('保留目录结构',
  mapTargetPath('C:\\Users\\a\\b.txt', 'D:\\Moved', true) === 'D:\\Moved\\C\\Users\\a\\b.txt',
  mapTargetPath('C:\\Users\\a\\b.txt', 'D:\\Moved', true));

check('不保留结构时只保留文件名',
  mapTargetPath('C:\\Users\\a\\b.txt', 'D:\\Moved', false) === 'D:\\Moved\\b.txt',
  mapTargetPath('C:\\Users\\a\\b.txt', 'D:\\Moved', false));

check('目标目录带尾反斜杠也能拼对',
  mapTargetPath('C:\\x\\y.bin', 'E:\\T\\', true) === 'E:\\T\\C\\x\\y.bin',
  mapTargetPath('C:\\x\\y.bin', 'E:\\T\\', true));

/* ---- 冲突避让 ---- */
const existing = { 'd:\\m\\a.txt': 1, 'd:\\m\\a (2).txt': 1 };
check('同名文件自动加 (3)',
  uniquePath('d:\\m\\a.txt', function (p) { return !!existing[p.toLowerCase()]; }) === 'd:\\m\\a (3).txt',
  uniquePath('d:\\m\\a.txt', function (p) { return !!existing[p.toLowerCase()]; }));

check('无冲突时原样返回',
  uniquePath('d:\\m\\b.txt', function () { return false; }) === 'd:\\m\\b.txt');

/* ---- 保护拦截 ---- */
check('系统目录被拦',
  checkItem({ p: 'C:\\Windows\\System32\\cmd.exe' }, ctx).code === 'system',
  JSON.stringify(checkItem({ p: 'C:\\Windows\\System32\\cmd.exe' }, ctx)));

check('受保护目录被拦',
  checkItem({ p: 'C:\\Users\\User\\Documents\\Private\\notes.md' }, ctx).code === 'protected',
  JSON.stringify(checkItem({ p: 'C:\\Users\\User\\Documents\\Private\\notes.md' }, ctx)));

check('程序自身目录被拦',
  checkItem({ p: path.join(__dirname, '..', 'main.js') }, ctx).code === 'appdir',
  JSON.stringify(checkItem({ p: path.join(__dirname, '..', 'main.js') }, ctx)));

check('普通下载文件放行',
  checkItem({ p: 'C:\\Users\\User\\Downloads\\ubuntu.iso' }, ctx).ok === true);

check('相对路径被拦',
  checkItem({ p: 'Downloads\\a.iso' }, ctx).ok === false);

check('非 Windows 绝对路径被拦',
  checkItem({ p: '\\\\nas\\share\\a.iso' }, ctx).ok === false);

/* ---- 回收站计划 ---- */
const trashPlan = planTrash([
  { p: 'C:\\Users\\User\\AppData\\Local\\Temp\\a.tmp', s: 100 },
  { p: 'C:\\Users\\User\\AppData\\Local\\Temp\\b.tmp', s: 200 },
  { p: 'C:\\Windows\\System32\\cmd.exe', s: 300 },
  { p: 'C:\\Users\\User\\Documents\\Private\\notes.md', s: 400 }
], ctx);
check('回收站计划只放行普通文件', trashPlan.count === 2 && trashPlan.total === 300,
  'count=' + trashPlan.count + ' total=' + trashPlan.total);
check('回收站计划记录被拦项', trashPlan.blocked.length === 2, 'blocked=' + trashPlan.blocked.length);
check('回收站计划带提示', trashPlan.ok === true && trashPlan.warnings.length > 0);

const allBlocked = planTrash([{ p: 'C:\\Windows\\a.dll', s: 1 }], ctx);
check('全部被拦时拒绝执行', allBlocked.ok === false && !!allBlocked.error, allBlocked.error);

const tooMany = planTrash(
  Array.from({ length: MAX_BATCH + 1 }, function (_, i) {
    return { p: 'C:\\Users\\User\\AppData\\Local\\Temp\\x' + i + '.tmp', s: 1 };
  }), ctx);
check('超过单次上限时拒绝', tooMany.ok === false && /最多处理/.test(tooMany.error), tooMany.error);

/* ---- 迁移计划 ---- */
const noTarget = planMigrate([{ p: 'C:\\a.txt', s: 1 }], { targetRoot: '' }, ctx);
check('缺目标目录被拒', noTarget.ok === false);

const badTarget = planMigrate([{ p: 'C:\\a.txt', s: 1 }], { targetRoot: sandbox + '\\nope' }, ctx);
check('目标目录不存在被拒', badTarget.ok === false && /不存在/.test(badTarget.error), badTarget.error);

const protectTarget = planMigrate([{ p: 'C:\\a.txt', s: 1 }],
  { targetRoot: 'C:\\Users\\User\\Documents\\Private\\x' }, ctx);
check('目标落在保护区被拒', protectTarget.ok === false && /受保护/.test(protectTarget.error), protectTarget.error);

const migPlan = planMigrate([
  { p: 'C:\\Users\\User\\Downloads\\a.iso', s: 100 * 1024 * 1024 },
  { p: 'C:\\Users\\User\\Downloads\\a.iso2', s: 50 * 1024 * 1024 },
  { p: 'C:\\Windows\\cmd.exe', s: 1 }
], { targetRoot: sandbox, keepTree: true }, ctx);
check('迁移计划数量与体积正确', migPlan.count === 2 && migPlan.total === 150 * 1024 * 1024,
  'count=' + migPlan.count + ' total=' + migPlan.total);
check('迁移计划带目标路径',
  migPlan.items[0].dst === path.join(sandbox, 'C', 'Users', 'User', 'Downloads', 'a.iso'),
  migPlan.items[0].dst);
check('迁移计划带可用空间', migPlan.targetFree > 0, String(migPlan.targetFree));

const flatPlan = planMigrate([
  { p: 'C:\\a\\same.txt', s: 10 },
  { p: 'C:\\b\\same.txt', s: 10 }
], { targetRoot: sandbox, keepTree: false }, ctx);
check('扁平模式下同名文件自动改名',
  flatPlan.items[0].dst !== flatPlan.items[1].dst &&
  /same \(2\)\.txt$/.test(flatPlan.items[1].dst),
  flatPlan.items[1].dst);

const inside = planMigrate([{ p: path.join(sandbox, 'x.txt'), s: 10 }],
  { targetRoot: sandbox, keepTree: true }, ctx);
check('已在目标目录内的文件被跳过', inside.ok === false || inside.blocked.length === 1,
  JSON.stringify(inside.blocked));

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('---');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);

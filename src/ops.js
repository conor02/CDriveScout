'use strict';

/* 操作层的纯函数：路径归一化、保护判定、目标路径映射、冲突避让、计划生成。
   这里不做任何实际删除/复制，只产出「计划」，方便单测与预览。 */

const path = require('path');
const fs = require('fs');

const MAX_BATCH = 800;
const HASH_LIMIT = 2 * 1024 * 1024 * 1024;   // 单文件 ≤ 2GB 时做 SHA-256 校验
const RESERVE_BYTES = 256 * 1024 * 1024;     // 目标盘预留空间

function toWin(p) {
  return String(p === null || p === undefined ? '' : p).replace(/\//g, '\\');
}

function norm(p) {
  let s = toWin(p).trim().toLowerCase();
  if (s.length === 2 && s.charAt(1) === ':') return s + '\\';
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return s;
}

function uniq(arr) {
  const seen = {};
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!v || seen[v]) continue;
    seen[v] = 1;
    out.push(v);
  }
  return out;
}

function underRoot(lowerPath, lowerRoot) {
  if (!lowerRoot) return false;
  if (lowerPath === lowerRoot) return true;
  if (lowerRoot.charAt(lowerRoot.length - 1) === '\\') return lowerPath.indexOf(lowerRoot) === 0;
  return lowerPath.indexOf(lowerRoot + '\\') === 0;
}

function buildContext(rules, extra) {
  const e = extra || {};
  return {
    systemRoots: uniq((rules.systemRoots || []).map(norm)),
    protectRoots: uniq((rules.protectRoots || []).map(norm)),
    appRoots: uniq((e.appRoots || []).map(norm)),
    rulesPath: norm(e.rulesPath || '')
  };
}

/* 单个文件能否被操作。返回 {ok, msg, code} */
function checkItem(item, ctx) {
  const raw = item && item.p;
  if (!raw || typeof raw !== 'string') return { ok: false, code: 'bad-path', msg: '路径无效' };
  const win = toWin(raw);
  if (!/^[a-zA-Z]:\\/.test(win)) return { ok: false, code: 'not-abs', msg: '不是本地绝对路径' };
  if (/(^|\\)\.\.(\\|$)/.test(win)) return { ok: false, code: 'dotdot', msg: '路径含 .. 片段，已拒绝' };
  const lp = norm(win);

  if (lp.indexOf('\\$recycle.bin') !== -1) return { ok: false, code: 'bin', msg: '回收站内部文件' };
  if (lp.indexOf('\\system volume information') !== -1) return { ok: false, code: 'vss', msg: '卷影副本目录' };

  for (let i = 0; i < ctx.protectRoots.length; i++) {
    if (underRoot(lp, ctx.protectRoots[i])) {
      return { ok: false, code: 'protected', msg: '位于受保护目录（规则文件 [protect] 段）' };
    }
  }
  for (let i = 0; i < ctx.systemRoots.length; i++) {
    if (underRoot(lp, ctx.systemRoots[i])) {
      return { ok: false, code: 'system', msg: '位于系统保护区' };
    }
  }
  for (let i = 0; i < ctx.appRoots.length; i++) {
    if (underRoot(lp, ctx.appRoots[i])) {
      return { ok: false, code: 'appdir', msg: '程序自身目录，已禁止操作' };
    }
  }
  if (ctx.rulesPath && lp === ctx.rulesPath) {
    return { ok: false, code: 'rules', msg: '规则文件本身，已禁止操作' };
  }
  return { ok: true };
}

/* 源文件 → 目标路径。keepTree=true 时保留 "盘符\原相对路径"，避免不同目录同名文件互撞 */
function mapTargetPath(srcFile, targetRoot, keepTree) {
  const s = toWin(srcFile);
  const root = toWin(targetRoot).replace(/\\+$/, '');
  if (!keepTree) return path.win32.join(root, path.win32.basename(s));
  const drive = s.slice(0, 1).toUpperCase();
  const rel = s.replace(/^[a-zA-Z]:\\?/, '');
  return path.win32.join(root, drive, rel);
}

/* 目标已存在时追加 (2)、(3)… */
function uniquePath(p, exists) {
  if (!exists(p)) return p;
  const dir = path.win32.dirname(p);
  const ext = path.win32.extname(p);
  const base = path.win32.basename(p, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.win32.join(dir, base + ' (' + i + ')' + ext);
    if (!exists(cand)) return cand;
  }
  return path.win32.join(dir, base + ' (' + Date.now() + ')' + ext);
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bfree * st.bsize;
  } catch (e) {
    return 0;
  }
}

function planTrash(items, ctx) {
  const out = { ok: true, mode: 'trash', items: [], blocked: [], total: 0, count: 0, warnings: [] };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const chk = checkItem(it, ctx);
    if (!chk.ok) {
      out.blocked.push({ src: it.p, s: Number(it.s) || 0, msg: chk.msg });
      continue;
    }
    const size = Number(it.s) || 0;
    out.items.push({ src: it.p, s: size });
    out.total += size;
    out.count++;
  }
  if (out.count === 0) {
    out.ok = false;
    out.error = '没有可处理的文件' + (out.blocked.length ? '（已选文件全部被保护规则拦截）' : '');
  } else if (out.count > MAX_BATCH) {
    out.ok = false;
    out.error = '一次最多处理 ' + MAX_BATCH + ' 个文件，当前选中 ' + out.count + ' 个，请分批操作';
  }
  if (out.count) {
    out.warnings.push('回收站里的文件仍然占用磁盘空间，清空回收站后才真正释放');
  }
  return out;
}

function planMigrate(items, opts, ctx, deps) {
  const exists = (deps && deps.exists) || fs.existsSync;
  const targetRoot = toWin((opts && opts.targetRoot) || '').replace(/\\+$/, '');
  const keepTree = !!(opts && opts.keepTree);
  const out = {
    ok: true, mode: 'migrate', items: [], blocked: [], total: 0, count: 0,
    targetRoot: targetRoot, targetFree: 0, enough: false, sameDrive: false,
    keepTree: keepTree, warnings: []
  };

  if (!targetRoot) return { ok: false, error: '请先选择迁移目标目录' };
  if (!/^[a-zA-Z]:\\/.test(targetRoot)) return { ok: false, error: '目标目录必须是本地绝对路径，例如 D:\\Moved' };

  const tn = norm(targetRoot);
  for (let i = 0; i < ctx.protectRoots.length; i++) {
    if (underRoot(tn, ctx.protectRoots[i])) return { ok: false, error: '目标目录位于受保护目录内，已拒绝' };
  }
  for (let i = 0; i < ctx.systemRoots.length; i++) {
    if (underRoot(tn, ctx.systemRoots[i])) return { ok: false, error: '目标目录位于系统保护区内，已拒绝' };
  }
  if (!exists(targetRoot)) return { ok: false, error: '目标目录不存在：' + targetRoot };

  const seen = {};
  const targetDrive = tn.slice(0, 2);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const chk = checkItem(it, ctx);
    if (!chk.ok) {
      out.blocked.push({ src: it.p, s: Number(it.s) || 0, msg: chk.msg });
      continue;
    }
    const lp = norm(it.p);
    if (lp.slice(0, 2) === targetDrive) out.sameDrive = true;
    if (underRoot(lp, tn)) {
      out.blocked.push({ src: it.p, s: Number(it.s) || 0, msg: '文件已在目标目录内' });
      continue;
    }
    let dst = mapTargetPath(it.p, targetRoot, keepTree);
    dst = uniquePath(dst, function (c) { return exists(c) || !!seen[norm(c)]; });
    seen[norm(dst)] = 1;
    const size = Number(it.s) || 0;
    out.items.push({ src: it.p, dst: dst, s: size });
    out.total += size;
    out.count++;
  }

  if (out.count === 0) {
    out.ok = false;
    out.error = '没有可迁移的文件' + (out.blocked.length ? '（已选文件全部被拦截）' : '');
    return out;
  }
  if (out.count > MAX_BATCH) {
    out.ok = false;
    out.error = '一次最多处理 ' + MAX_BATCH + ' 个文件，当前选中 ' + out.count + ' 个，请分批操作';
    return out;
  }

  out.targetFree = freeBytes(targetRoot);
  out.enough = out.targetFree > out.total + RESERVE_BYTES;
  if (!out.enough) {
    return {
      ok: false,
      error: '目标盘空间不足：需要 ' + fmt(out.total) + '，可用 ' + fmt(out.targetFree)
    };
  }
  if (out.sameDrive) {
    out.warnings.push('目标与原文件在同一个磁盘，迁移不会释放磁盘空间');
  }
  out.warnings.push('流程为「复制 → 校验 → 原文件移入回收站」，校验不通过则保留原文件并删除副本');
  return out;
}

function fmt(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
}

module.exports = {
  MAX_BATCH,
  HASH_LIMIT,
  RESERVE_BYTES,
  toWin,
  norm,
  underRoot,
  buildContext,
  checkItem,
  mapTargetPath,
  uniquePath,
  freeBytes,
  planTrash,
  planMigrate
};

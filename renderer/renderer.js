'use strict';

const $ = function (id) { return document.getElementById(id); };

const CATS = ['全部', '可安全清理', '建议迁移', '需确认', '系统保护区', '其他'];
const CAT_CLASS = {
  '可安全清理': 'safe',
  '建议迁移': 'move',
  '需确认': 'check',
  '系统保护区': 'system',
  '其他': 'other'
};
const CAT_RANK = { '可安全清理': 0, '建议迁移': 1, '需确认': 2, '系统保护区': 3, '其他': 4 };
const ACT_RANK = { '删除': 0, '迁移': 1, '需确认': 2, '不要动': 3, '—': 4 };
const ROW_H = 34;
const PREVIEW_ROWS = 200;
const BIG_COUNT = 200;
const BIG_BYTES = 5 * 1024 * 1024 * 1024;

const state = {
  items: [],
  view: [],
  counts: {},
  sortKey: 's',
  sortDir: -1,
  category: '全部',
  search: '',
  hideSystem: true,
  scanning: false,
  root: 'C:\\',
  drives: [],
  rules: { count: 0, source: '' },
  protectRoots: [],
  maxBatch: 800,
  progress: { files: 0, bytes: 0, dir: '', elapsed: 0 },
  summary: null,
  ctxItem: null,
  selected: new Map(),
  selectableCount: 0,
  lastPick: null,
  migrateTarget: '',
  keepTree: true,
  verifyMode: 'smart',
  opRunning: false,
  opTotal: 0
};

/* ---------------- 工具函数 ---------------- */

function fmtSize(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
  if (i === 0) return n.toFixed(0) + ' B';
  return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const pad = function (v) { return v < 10 ? '0' + v : '' + v; };
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(t) { $('statusText').textContent = t; }

function underRoot(p, roots) {
  if (!roots || !roots.length) return false;
  const lp = String(p).replace(/\//g, '\\').toLowerCase();
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    if (!r) continue;
    if (lp === r) return true;
    if (r.charAt(r.length - 1) === '\\') {
      if (lp.indexOf(r) === 0) return true;
    } else if (lp.indexOf(r + '\\') === 0) {
      return true;
    }
  }
  return false;
}

function isProtected(it) {
  if (!it) return true;
  if (it.z) return true;
  if (it.c === '系统保护区') return true;
  return underRoot(it.p, state.protectRoots);
}

/* ---------------- 初始化 ---------------- */

async function boot() {
  const info = await window.api.init();
  state.drives = info.drives || [];
  state.rules.count = info.rulesCount;
  state.rules.source = info.rulesSource;
  state.protectRoots = info.protectRoots || [];
  state.maxBatch = info.maxBatch || 800;

  const driveSel = $('drive');
  driveSel.innerHTML = state.drives.length
    ? state.drives.map(function (d) {
      return '<option value="' + d.root + '">' + d.letter + ':　剩余 ' + fmtSize(d.free) + ' / ' + fmtSize(d.total) + '</option>';
    }).join('')
    : '<option value="C:\\">C:\\</option>';
  const cDrive = state.drives.filter(function (d) { return d.letter === 'C'; })[0];
  state.root = cDrive ? cDrive.root : (state.drives[0] ? state.drives[0].root : 'C:\\');
  driveSel.value = state.root;

  try {
    const saved = window.localStorage.getItem('cds.migrateTarget');
    if (saved) state.migrateTarget = saved;
  } catch (e) { /* ignore */ }

  renderChips();
  renderKpis();
  updateSelBar();

  $('statusRight').textContent = '规则 ' + state.rules.count + ' 条 · 受保护目录 ' + state.protectRoots.length + ' 个';

  bindEvents();
}

function bindEvents() {
  $('drive').addEventListener('change', function (e) { state.root = e.target.value; });
  $('btnScan').addEventListener('click', startScan);
  $('btnStop').addEventListener('click', stopScan);

  $('hideSystem').addEventListener('change', function (e) {
    state.hideSystem = e.target.checked;
    clearSel();
    applyFilter();
  });

  let searchTimer = null;
  $('search').addEventListener('input', function (e) {
    const v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.search = v.trim().toLowerCase();
      clearSel();
      applyFilter();
    }, 220);
  });

  $('btnCsv').addEventListener('click', exportCsv);
  $('btnHtml').addEventListener('click', exportHtml);
  $('btnRules').addEventListener('click', function () { window.api.openRules(); });
  $('btnReload').addEventListener('click', async function () {
    const info = await window.api.init();
    state.rules.count = info.rulesCount;
    state.protectRoots = info.protectRoots || [];
    state.maxBatch = info.maxBatch || 800;
    clearSel();
    applyFilter();
    setStatus('规则已重新加载：' + info.rulesCount + ' 条，受保护目录 ' + state.protectRoots.length + ' 个');
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      const name = tab.getAttribute('data-tab');
      $('panel-files').classList.toggle('hidden', name !== 'files');
      $('panel-dirs').classList.toggle('hidden', name !== 'dirs');
      if (name === 'dirs') buildDirs();
      else renderWindow();
    });
  });

  $('thead').addEventListener('click', function (e) {
    const th = e.target.closest('.th');
    if (!th) return;
    const key = th.getAttribute('data-key');
    if (!key) return;
    if (state.sortKey === key) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortKey = key;
      state.sortDir = (key === 's' || key === 'm') ? -1 : 1;
    }
    updateHead();
    if (state.view.length) { sortView(); render(); }
  });

  $('ckAll').addEventListener('change', function (e) {
    if (!e.target.checked) { clearSel(); return; }
    selectAllVisible();
  });

  $('btnClearSel').addEventListener('click', clearSel);
  $('btnTrash').addEventListener('click', function () { openTrash(); });
  $('btnMigrate').addEventListener('click', function () { openMigrate(); });

  let ticking = false;
  $('tbody').addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; renderWindow(); });
  });

  $('tbody').addEventListener('click', function (e) {
    const ck = e.target.closest('input.rowck');
    if (!ck) return;
    const i = Number(ck.getAttribute('data-i'));
    const it = state.view[i];
    if (!it || isProtected(it)) { ck.checked = false; return; }
    if (e.shiftKey && state.lastPick !== null && state.lastPick !== i) {
      const from = Math.min(state.lastPick, i);
      const to = Math.max(state.lastPick, i);
      const on = ck.checked;
      for (let k = from; k <= to; k++) {
        const t = state.view[k];
        if (!t || isProtected(t)) continue;
        if (on) {
          if (state.selected.size >= state.maxBatch) break;
          state.selected.set(t.p, t);
        } else {
          state.selected.delete(t.p);
        }
      }
      renderWindow();
      updateSelBar();
      return;
    }
    if (!toggleSel(it, ck.checked)) { ck.checked = false; return; }
    const row = ck.closest('.row');
    if (row) row.classList.toggle('sel', ck.checked);
    state.lastPick = i;
  });

  $('tbody').addEventListener('dblclick', function (e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const item = state.view[Number(row.dataset.i)];
    if (item) window.api.reveal(item.p);
  });

  $('tbody').addEventListener('contextmenu', function (e) {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    state.ctxItem = state.view[Number(row.dataset.i)];
    const menu = $('ctxMenu');
    menu.classList.add('show');
    const w = 190;
    const hgt = 156;
    menu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - hgt - 8) + 'px';
  });

  $('ctxMenu').addEventListener('click', function (e) {
    const act = e.target.getAttribute('data-act');
    if (!act || !state.ctxItem) return;
    const item = state.ctxItem;
    if (act === 'reveal') window.api.reveal(item.p);
    if (act === 'copy') copyText(item.p);
    if (act === 'trash' || act === 'migrate') {
      if (isProtected(item)) {
        setStatus('该文件位于系统保护区或受保护目录，不能操作');
      } else {
        state.selected.clear();
        state.selected.set(item.p, item);
        updateSelBar();
        renderWindow();
        if (act === 'trash') openTrash();
        else openMigrate();
      }
    }
    $('ctxMenu').classList.remove('show');
  });

  document.addEventListener('click', function () { $('ctxMenu').classList.remove('show'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if ($('overlay').classList.contains('show')) closeDialog();
      else $('ctxMenu').classList.remove('show');
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  $('dlgX').addEventListener('click', closeDialog);
  $('overlay').addEventListener('mousedown', function (e) {
    if (e.target === $('overlay')) closeDialog();
  });

  window.api.onBatch(function (items) {
    for (let i = 0; i < items.length; i++) state.items.push(items[i]);
    scheduleKpi();
  });

  window.api.onProgress(function (p) {
    state.progress.files = p.files;
    state.progress.bytes = p.bytes;
    state.progress.dir = p.dir;
    state.progress.elapsed = p.elapsed;
    if (p.cats) {
      const next = {};
      Object.keys(p.cats).forEach(function (k) {
        next[k] = { count: p.cats[k].n, bytes: p.cats[k].b };
      });
      state.counts = next;
      scheduleKpi();
    }
  });

  window.api.onDone(function (summary) {
    state.scanning = false;
    state.summary = summary;
    setScanningUI(false);
    finalize();
  });

  window.api.onError(function (payload) {
    state.scanning = false;
    setScanningUI(false);
    setStatus('扫描出错：' + String(payload.message || '').split('\n')[0]);
  });

  window.api.onOpProgress(function (p) {
    if (!state.opRunning) return;
    const total = p.total || state.opTotal || 1;
    const pct = Math.max(0, Math.min(100, Math.round((p.index / total) * 100)));
    const bar = $('opBar');
    if (bar) bar.style.width = pct + '%';
    const st = $('opState');
    if (st) {
      const label = p.phase === 'copy' ? '复制并校验' : '移入回收站';
      st.textContent = label + '　' + p.index + ' / ' + total + '　' + pct + '%';
    }
    const f = $('opFile');
    if (f) f.textContent = p.file || '';
  });

  window.api.onOpBytes(function (b) {
    if (!state.opRunning) return;
    const f = $('opFile');
    if (!f) return;
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    f.textContent = b.file + '　' + fmtSize(b.done) + ' / ' + fmtSize(b.total) + '　' + pct + '%';
  });

  window.api.onOpError(function (p) {
    setStatus('操作出错：' + String((p && p.message) || '').split('\n')[0]);
  });
}

/* ---------------- 渲染：分类与 KPI ---------------- */

function renderChips() {
  const total = state.items.length;
  const html = CATS.map(function (name) {
    const c = name === '全部' ? { count: total, bytes: 0 } : (state.counts[name] || { count: 0, bytes: 0 });
    return '<button class="chip' + (state.category === name ? ' active' : '') + '" data-cat="' + name + '">' +
      name + '<span class="n">' + c.count.toLocaleString() + '</span></button>';
  }).join('');
  $('chips').innerHTML = html;
  $('chips').querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () { setCategory(chip.getAttribute('data-cat')); });
  });
}

function renderKpis() {
  const order = ['可安全清理', '建议迁移', '需确认', '系统保护区', '其他'];
  const html = order.map(function (name) {
    const c = state.counts[name] || { count: 0, bytes: 0 };
    return '<div class="kpi' + (state.category === name ? ' active' : '') + '" data-cat="' + name + '">' +
      '<div class="kpi-t">' + name + '</div>' +
      '<div class="kpi-v">' + fmtSize(c.bytes) + '</div>' +
      '<div class="kpi-s">' + c.count.toLocaleString() + ' 个文件</div></div>';
  }).join('');
  $('kpis').innerHTML = html;
  $('kpis').querySelectorAll('.kpi').forEach(function (k) {
    k.addEventListener('click', function () {
      const cat = k.getAttribute('data-cat');
      setCategory(state.category === cat ? '全部' : cat);
    });
  });
}

let kpiTimer = null;
let lastLive = 0;
function scheduleKpi() {
  if (kpiTimer) return;
  kpiTimer = setTimeout(function () {
    kpiTimer = null;
    renderKpis();
    renderChips();
    if (state.scanning && state.items.length && Date.now() - lastLive > 2500) {
      lastLive = Date.now();
      applyFilter(false);
    }
  }, 400);
}

function setCategory(name) {
  if (name === '系统保护区' && state.hideSystem) {
    state.hideSystem = false;
    $('hideSystem').checked = false;
  }
  state.category = name;
  clearSel();
  renderChips();
  renderKpis();
  applyFilter();
}

/* ---------------- 选择 ---------------- */

function toggleSel(it, on) {
  if (on) {
    if (state.selected.size >= state.maxBatch) {
      setStatus('一次最多选择 ' + state.maxBatch + ' 个文件，请分批操作');
      return false;
    }
    state.selected.set(it.p, it);
  } else {
    state.selected.delete(it.p);
  }
  updateSelBar();
  return true;
}

function selectAllVisible() {
  state.selected.clear();
  let n = 0;
  let truncated = false;
  for (let i = 0; i < state.view.length; i++) {
    const it = state.view[i];
    if (isProtected(it)) continue;
    if (n >= state.maxBatch) { truncated = true; break; }
    state.selected.set(it.p, it);
    n++;
  }
  renderWindow();
  updateSelBar();
  if (truncated) setStatus('已选择前 ' + n + ' 项（单次上限 ' + state.maxBatch + ' 个），其余请分批处理');
}

function clearSel() {
  state.selected.clear();
  state.lastPick = null;
  updateSelBar();
  renderWindow();
}

function updateSelBar() {
  let total = 0;
  state.selected.forEach(function (it) { total += it.s || 0; });
  const n = state.selected.size;
  $('selCount').textContent = n.toLocaleString();
  $('selSize').textContent = fmtSize(total);
  $('selBar').classList.toggle('show', n > 0);
  $('btnTrash').disabled = n === 0;
  $('btnMigrate').disabled = n === 0;
  const all = $('ckAll');
  if (all) {
    all.checked = n > 0 && n >= state.selectableCount;
    all.indeterminate = n > 0 && n < state.selectableCount;
  }
}

function collectSelection() {
  const out = [];
  state.selected.forEach(function (it) { out.push({ p: it.p, s: it.s }); });
  return out;
}

/* ---------------- 扫描 ---------------- */

function resetState() {
  state.items = [];
  state.view = [];
  state.counts = {};
  state.search = '';
  state.category = '全部';
  state.progress = { files: 0, bytes: 0, dir: '', elapsed: 0 };
  state.summary = null;
  state.selectableCount = 0;
  clearSel();
  $('search').value = '';
  $('spacer').innerHTML = '';
  $('spacer').style.height = '0px';
  $('empty').style.display = 'flex';
  $('resultMeta').textContent = '扫描中…';
  renderChips();
  renderKpis();
}

async function startScan() {
  if (state.scanning || state.opRunning) return;
  resetState();
  const res = await window.api.startScan({
    root: state.root,
    minSize: Number($('minSize').value),
    skipSystemScan: $('skipSystem').checked
  });
  if (!res.ok) {
    setStatus(res.error || '启动失败');
    return;
  }
  state.scanning = true;
  setScanningUI(true);
  state.clock = setInterval(tickStatus, 250);
  tickStatus();
}

function stopScan() {
  window.api.stopScan();
  setStatus('正在停止…');
}

function setScanningUI(on) {
  $('btnScan').disabled = on;
  $('btnScan').textContent = on ? '扫描中…' : '开始扫描';
  $('btnStop').disabled = !on;
  $('drive').disabled = on;
  $('minSize').disabled = on;
  $('skipSystem').disabled = on;
  if (!on && state.clock) { clearInterval(state.clock); state.clock = null; }
}

function tickStatus() {
  const p = state.progress;
  const sec = (p.elapsed / 1000).toFixed(1);
  setStatus((state.scanning ? '扫描中 · ' : '') +
    p.files.toLocaleString() + ' 个文件 · ' + fmtSize(p.bytes) + ' · 用时 ' + sec + 's');
  if (p.dir) $('statusRight').textContent = p.dir;
}

function finalize() {
  const s = state.summary || { files: 0, bytes: 0, elapsed: 0 };
  setStatus('完成 · ' + s.files.toLocaleString() + ' 个文件 · ' +
    fmtSize(s.bytes) + ' · 用时 ' + (s.elapsed / 1000).toFixed(1) + 's' +
    (s.stopped ? ' · 已手动停止' : ''));
  $('statusRight').textContent = '保留 ' + state.items.length.toLocaleString() + ' 条 · 跳过/无权访问 ' +
    (s.errors || 0) + ' 处（含分页/休眠等被占用文件）';
  applyFilter();
  buildDirs();
}

/* ---------------- 筛选 / 排序 / 渲染 ---------------- */

function applyFilter(resetScroll) {
  const cat = state.category;
  const q = state.search;
  const src = state.items;
  const out = [];
  let selectable = 0;
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (cat !== '全部' && it.c !== cat) continue;
    if (state.hideSystem && cat !== '系统保护区' && it.c === '系统保护区') continue;
    if (q && it.p.toLowerCase().indexOf(q) === -1) continue;
    out.push(it);
    if (!isProtected(it)) selectable++;
  }
  state.view = out;
  state.selectableCount = selectable;
  sortView();
  if (resetScroll !== false) $('tbody').scrollTop = 0;
  state.lastPick = null;
  render();
  updateSelBar();
}

function sortView() {
  const key = state.sortKey;
  const dir = state.sortDir;
  if (key === 's' || key === 'm') {
    state.view.sort(function (a, b) { return (a[key] - b[key]) * dir; });
    return;
  }
  if (key === 'c') {
    state.view.sort(function (a, b) {
      const va = CAT_RANK[a.c];
      const vb = CAT_RANK[b.c];
      return ((va === undefined ? 9 : va) - (vb === undefined ? 9 : vb)) * dir;
    });
    return;
  }
  if (key === 'a') {
    state.view.sort(function (a, b) {
      const va = ACT_RANK[a.a];
      const vb = ACT_RANK[b.a];
      const d = (va === undefined ? 9 : va) - (vb === undefined ? 9 : vb);
      if (d !== 0) return d * dir;
      return a.p < b.p ? -dir : a.p > b.p ? dir : 0;
    });
    return;
  }
  state.view.sort(function (a, b) {
    return (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) * dir;
  });
}

function updateHead() {
  $('thead').querySelectorAll('.th[data-key]').forEach(function (th) {
    const key = th.getAttribute('data-key');
    const base = { s: '大小', c: '分类', a: '建议', p: '路径', m: '修改时间' }[key];
    th.textContent = base + (state.sortKey === key ? (state.sortDir === 1 ? ' ↑' : ' ↓') : '');
    th.classList.toggle('sorted', state.sortKey === key);
  });
}

function render() {
  const total = state.view.length;
  $('spacer').style.height = (total * ROW_H) + 'px';
  $('empty').style.display = total ? 'none' : 'flex';

  if (state.scanning) {
    $('resultMeta').textContent = '扫描中 · 已捕获 ' + state.items.length.toLocaleString() + ' 条';
  } else if (total) {
    $('resultMeta').textContent = '显示 ' + total.toLocaleString() + ' 条' +
      (state.category !== '全部' ? ' · ' + state.category : '');
  } else {
    $('resultMeta').textContent = '没有匹配的记录';
  }

  if (!total) {
    const title = $('empty').querySelector('.empty-title');
    const sub = $('empty').querySelector('.empty-sub');
    if (state.scanning) {
      title.textContent = '正在扫描…';
      sub.textContent = '已读取 ' + state.progress.files.toLocaleString() + ' 个文件，暂未发现超过体积门槛的文件';
    } else {
      title.textContent = '还没有数据';
      sub.textContent = '选好盘符和体积门槛，点左侧「开始扫描」';
    }
  }

  renderWindow();
}

function renderWindow() {
  const body = $('tbody');
  const total = state.view.length;
  if (!total) { $('spacer').innerHTML = ''; return; }
  const top = body.scrollTop;
  const height = body.clientHeight;
  const start = Math.max(0, Math.floor(top / ROW_H) - 6);
  const end = Math.min(total, start + Math.ceil(height / ROW_H) + 12);
  let html = '';
  for (let i = start; i < end; i++) {
    const it = state.view[i];
    const cls = CAT_CLASS[it.c] || 'other';
    const prot = isProtected(it);
    const checked = state.selected.has(it.p);
    html += '<div class="row' + (checked ? ' sel' : '') + '" data-i="' + i + '" style="top:' + (i * ROW_H) + 'px">' +
      '<div class="cell pick"><input type="checkbox" class="rowck" data-i="' + i + '"' +
      (checked ? ' checked' : '') + (prot ? ' disabled title="系统保护区或受保护目录，不可操作"' : '') + '></div>' +
      '<div class="cell size">' + fmtSize(it.s) + '</div>' +
      '<div class="cell"><span class="tag ' + cls + '">' + esc(it.c) + '</span>' +
      (it.z ? '<span class="zone-mark" title="位于系统目录">系统</span>' : '') + '</div>' +
      '<div class="cell act">' + esc(it.a) + '</div>' +
      '<div class="cell path" title="' + esc(it.p) + '">' + esc(it.p) + '</div>' +
      '<div class="cell time">' + fmtTime(it.m) + '</div>' +
      '</div>';
  }
  $('spacer').innerHTML = html;
}

/* ---------------- 目录占用 ---------------- */

function dirKey(p) {
  const parts = String(p).split('\\');
  const isUser = parts.length > 2 && parts[1].toLowerCase() === 'users';
  const take = isUser ? 5 : 4;
  const n = Math.max(1, Math.min(parts.length - 1, take));
  return parts.slice(0, n).join('\\');
}

function buildDirs() {
  if (!state.view.length) {
    $('dirsBody').innerHTML = '<div class="empty" style="position:static;padding:60px 0">暂无可聚合的数据</div>';
    return;
  }
  const map = new Map();
  for (let i = 0; i < state.view.length; i++) {
    const it = state.view[i];
    const key = dirKey(it.p);
    const cur = map.get(key);
    if (cur) { cur.size += it.s; cur.count++; }
    else map.set(key, { size: it.s, count: 1 });
  }
  const arr = [];
  map.forEach(function (v, k) { arr.push({ dir: k, size: v.size, count: v.count }); });
  arr.sort(function (a, b) { return b.size - a.size; });
  const top = arr.slice(0, 120);
  const sum = arr.reduce(function (a, b) { return a + b.size; }, 0) || 1;

  $('dirsBody').innerHTML = top.map(function (r) {
    const share = (r.size / sum) * 100;
    const width = Math.max(0.6, share);
    return '<div class="dir-row">' +
      '<div class="dir-name" title="' + esc(r.dir) + '">' + esc(r.dir) + '</div>' +
      '<div class="dir-size">' + fmtSize(r.size) + '</div>' +
      '<div class="dir-bar"><i style="width:' + width.toFixed(1) + '%"></i><span>' + share.toFixed(1) + '%</span></div>' +
      '</div>';
  }).join('');
}

/* ---------------- 弹窗基础 ---------------- */

function openDialog(title, bodyHtml, footHtml) {
  $('dlgTitle').textContent = title;
  $('dlgBody').innerHTML = bodyHtml;
  $('dlgFoot').innerHTML = footHtml;
  $('overlay').classList.add('show');
  $('dlgBody').scrollTop = 0;
  $('dlgX').style.display = '';
}

function closeDialog() {
  if (state.opRunning) return;
  $('overlay').classList.remove('show');
  $('dlgBody').innerHTML = '';
  $('dlgFoot').innerHTML = '';
  $('dlgX').style.display = '';
}

/* ---------------- 回收站流程 ---------------- */

async function openTrash() {
  if (state.scanning) { setStatus('扫描进行中，等扫描结束再操作'); return; }
  if (state.opRunning) return;
  const items = collectSelection();
  if (!items.length) { setStatus('先勾选要处理的文件'); return; }
  setStatus('正在生成清单预览…');
  const plan = await window.api.opPlan({ mode: 'trash', items: items });
  if (!plan.ok) { setStatus(plan.error || '无法执行'); return; }
  setStatus('就绪');
  previewStep(plan, 'trash', {});
}

function previewStep(plan, mode, opts) {
  const body = previewBody(plan, mode);
  const foot = '<div class="left">合计 ' + plan.count + ' 项 · ' + fmtSize(plan.total) + '</div>' +
    '<button class="btn ghost" id="dlgCancel">取消</button>' +
    '<button class="btn ' + (mode === 'trash' ? 'warn' : 'accent') + '" id="dlgNext">继续 →</button>';
  openDialog(mode === 'trash' ? '清单预览 · 移到回收站' : '清单预览 · 迁移', body, foot);
  $('dlgCancel').addEventListener('click', closeDialog);
  $('dlgNext').addEventListener('click', function () { confirmStep(plan, mode, opts); });
}

function previewBody(plan, mode) {
  const shown = plan.items.slice(0, PREVIEW_ROWS);
  let rows = '';
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    rows += '<tr><td class="num">' + fmtSize(it.s) + '</td><td class="pth">' + esc(it.src) +
      (mode === 'migrate' && it.dst ? '<div class="dst">→ ' + esc(it.dst) + '</div>' : '') + '</td></tr>';
  }

  let html = '';
  if (mode === 'trash') {
    html += '<div class="note danger"><b>下面 ' + plan.count + ' 个文件会被移到 Windows 回收站。</b><br>' +
      '不是永久删除，可以从回收站还原；但回收站里的文件仍然占用磁盘空间，清空后才真正释放。</div>';
  } else {
    html += '<div class="note ok"><b>把 ' + plan.count + ' 个文件（' + fmtSize(plan.total) + '）复制到 ' + esc(plan.targetRoot) + '</b><br>' +
      '逐个「复制 → 校验 → 原件移入回收站」。校验不通过时保留原件、删除副本，不会丢文件。</div>';
  }

  html += '<table class="ptable"><thead><tr><th class="num">大小</th><th>' +
    (mode === 'migrate' ? '原路径 → 目标路径' : '路径') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';

  if (plan.items.length > shown.length) {
    html += '<div class="note" style="margin-top:10px">只列出前 ' + shown.length + ' 项，另有 ' +
      (plan.items.length - shown.length) + ' 项未展示，会一并处理。</div>';
  }

  if (plan.blocked && plan.blocked.length) {
    html += '<details class="blockers"><summary>' + plan.blocked.length + ' 项被保护规则跳过</summary><ul>';
    plan.blocked.slice(0, 50).forEach(function (b) {
      html += '<li>' + esc(b.src) + '　<span>' + esc(b.msg) + '</span></li>';
    });
    html += '</ul></details>';
  }
  return html;
}

function confirmStep(plan, mode, opts) {
  const big = plan.count > BIG_COUNT || plan.total > BIG_BYTES;
  let body = '<div class="note danger"><b>这是最后一步确认，点下去就开始执行。</b><br>';
  if (mode === 'trash') {
    body += '将把这 ' + plan.count + ' 个文件（' + fmtSize(plan.total) + '）移到回收站。' +
      '文件不会立刻消失，需要到回收站里还原或清空。';
  } else {
    body += '将把 ' + plan.count + ' 个文件（' + fmtSize(plan.total) + '）复制到 ' + esc(plan.targetRoot) +
      '，校验通过后把原文件移到回收站。';
  }
  body += '</div>';

  if (plan.warnings && plan.warnings.length) {
    body += '<div class="note">' + plan.warnings.map(esc).join('<br>') + '</div>';
  }

  body += '<label class="check modal-check"><input type="checkbox" id="ckConfirm">' +
    '<span>我已核对上面的清单，确认对这些文件执行操作</span></label>';

  if (big) {
    body += '<div class="type-confirm"><div style="font-size:12px;color:#6B6A64;margin-bottom:5px">' +
      '本次数量较大（' + plan.count + ' 项），请输入「确认」两个字再继续</div>' +
      '<input type="text" id="typeConfirm" autocomplete="off" placeholder="确认"></div>';
  }

  const foot = '<button class="btn ghost" id="dlgBack">返回修改</button>' +
    '<button class="btn danger" id="dlgRun" disabled>' + (mode === 'trash' ? '确认移到回收站' : '确认开始迁移') + '</button>';
  openDialog('最终确认', body, foot);

  function sync() {
    const ck = $('ckConfirm');
    const ty = $('typeConfirm');
    const ok = !!(ck && ck.checked) && (!ty || ty.value.trim() === '确认');
    const btn = $('dlgRun');
    if (btn) btn.disabled = !ok;
  }
  $('ckConfirm').addEventListener('change', sync);
  if ($('typeConfirm')) $('typeConfirm').addEventListener('input', sync);

  $('dlgBack').addEventListener('click', function () { previewStep(plan, mode, opts); });
  $('dlgRun').addEventListener('click', function () { runOperation(plan, mode, opts); });
}

async function runOperation(plan, mode, opts) {
  state.opRunning = true;
  state.opTotal = plan.count;
  showProgressDialog(plan, mode);

  const payload = {
    mode: mode,
    items: plan.items.map(function (it) { return { p: it.src, s: it.s }; }),
    targetRoot: plan.targetRoot || '',
    keepTree: !!plan.keepTree,
    verify: (opts && opts.verify) || state.verifyMode
  };

  let res;
  try {
    res = await window.api.opRun(payload);
  } catch (err) {
    state.opRunning = false;
    showResult({ ok: false, error: String((err && err.message) || err), results: [] }, plan, mode);
    return;
  }
  state.opRunning = false;
  showResult(res, plan, mode);
}

function showProgressDialog(plan, mode) {
  const body = '<div class="pstate" id="opState">准备中…</div>' +
    '<div class="pbar"><i id="opBar"></i></div>' +
    '<div class="pfile" id="opFile"></div>';
  openDialog(mode === 'trash' ? '正在移到回收站' : '正在迁移', body,
    '<button class="btn ghost" id="dlgStop">取消</button>');
  $('dlgX').style.display = 'none';
  $('dlgStop').addEventListener('click', function () {
    window.api.opCancel();
    const st = $('opState');
    if (st) st.textContent = '正在取消，等当前文件处理完…';
  });
}

function showResult(res, plan, mode) {
  if (!res || res.ok === false) {
    openDialog('操作未执行', '<div class="note danger"><b>' + esc((res && res.error) || '未知错误') + '</b></div>',
      '<button class="btn ghost" id="dlgClose">关闭</button>');
    $('dlgClose').addEventListener('click', closeDialog);
    return;
  }

  const removed = res.results.filter(function (r) {
    return r.ok && (mode === 'trash' || r.trash === 'ok');
  }).map(function (r) { return r.src; });
  refreshAfterOp(removed);

  const fails = res.results.filter(function (r) { return !r.ok && r.error !== '已取消'; });
  const trashFails = res.results.filter(function (r) { return r.ok && r.trash === 'failed'; });
  const skipped = res.results.filter(function (r) { return r.error === '已取消'; }).length;

  let body = '<div class="note ' + (fails.length || trashFails.length ? 'danger' : 'ok') + '">' +
    '<b>' + (mode === 'trash' ? '已移入回收站 ' : '已迁移 ') + res.okCount + ' 项 · ' + fmtSize(res.okBytes) + '</b>' +
    (fails.length ? '　失败 ' + fails.length + ' 项' : '') +
    (skipped ? '　取消后未处理 ' + skipped + ' 项（文件未变动）' : '') + '</div>';

  if (mode === 'migrate') {
    body += '<div class="note">目标目录：' + esc(plan.targetRoot) + '<br>原件已移入回收站 ' +
      (res.trashed || 0) + ' 个' +
      (trashFails.length ? '；另有 ' + trashFails.length + ' 个原件没能移入回收站，副本已在目标目录，原件还在原处' : '') +
      '</div>';
  }

  if (fails.length || trashFails.length) {
    body += '<table class="ptable"><thead><tr><th>需要你确认的项目</th><th>原因</th></tr></thead><tbody>';
    fails.slice(0, 60).forEach(function (r) {
      body += '<tr><td class="pth">' + esc(r.src) + '</td><td class="pth">' + esc(r.error || '') + '</td></tr>';
    });
    trashFails.slice(0, 60).forEach(function (r) {
      body += '<tr><td class="pth">' + esc(r.src) + '</td><td class="pth">副本已校验通过，但原件移入回收站失败：' +
        esc(r.trashError || '') + '</td></tr>';
    });
    body += '</tbody></table>';
    if (fails.length + trashFails.length > 120) {
      body += '<div class="note" style="margin-top:10px">失败项过多，仅列出前 120 条。</div>';
    }
  }

  body += '<div class="note" style="margin-top:12px">回收站里的文件仍占用原磁盘空间，确认无误后清空回收站才能真正释放。</div>';

  const foot = '<button class="btn ghost" id="dlgBin">打开回收站</button>' +
    '<button class="btn primary" id="dlgClose" style="flex:0 0 auto;padding:0 16px">完成</button>';
  openDialog(mode === 'trash' ? '回收站操作完成' : '迁移完成', body, foot);
  $('dlgBin').addEventListener('click', function () { window.api.openRecycleBin(); });
  $('dlgClose').addEventListener('click', closeDialog);
}

function recount() {
  const c = {};
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    const o = c[it.c] || (c[it.c] = { count: 0, bytes: 0 });
    o.count++;
    o.bytes += it.s;
  }
  state.counts = c;
}

function refreshAfterOp(removedPaths) {
  if (!removedPaths.length) return;
  const rm = new Set(removedPaths);
  const before = state.items.length;
  state.items = state.items.filter(function (it) { return !rm.has(it.p); });
  state.selected.clear();
  state.lastPick = null;
  recount();
  renderChips();
  renderKpis();
  applyFilter();
  buildDirs();
  const diff = before - state.items.length;
  $('statusRight').textContent = '已从列表移除 ' + diff.toLocaleString() + ' 条记录';
}

/* ---------------- 迁移流程 ---------------- */

async function openMigrate() {
  if (state.scanning) { setStatus('扫描进行中，等扫描结束再操作'); return; }
  if (state.opRunning) return;
  const items = collectSelection();
  if (!items.length) { setStatus('先勾选要迁移的文件'); return; }

  const srcLetter = String(state.root).charAt(0).toUpperCase();
  const others = state.drives.filter(function (d) { return d.letter !== srcLetter; });
  const suggested = state.migrateTarget ||
    (others[0] ? others[0].letter + ':\\CDriveScout-Moved' : '');

  let body = '<div class="note">迁移流程固定为 <b>复制 → 校验 → 原件移入回收站</b>。' +
    '任何一步失败都不会丢文件：校验失败时保留原件并删除副本。</div>';

  body += '<div class="mline"><label>目标目录</label><div class="mrow">' +
    '<input type="text" id="migTarget" value="' + esc(suggested) + '" placeholder="例如 D:\\CDriveScout-Moved" autocomplete="off">' +
    '<select id="migDrive"><option value="">选盘符…</option>' +
    others.map(function (d) {
      return '<option value="' + d.letter + '">' + d.letter + ': (' + fmtSize(d.free) + ' 可用)</option>';
    }).join('') + '</select>' +
    '<button class="btn ghost small" id="migPick">选择…</button>' +
    '</div></div>';

  body += '<label class="check"><input type="checkbox" id="migKeep" checked>' +
    '<span>保持目录结构（推荐，避免不同目录的同名文件互相覆盖）</span></label>';

  body += '<div class="mline"><label>校验方式</label><select id="migVerify">' +
    '<option value="smart">智能校验：≤2GB 走 SHA-256，更大只校验大小</option>' +
    '<option value="size">快速校验：只比对大小</option>' +
    '</select></div>';

  body += '<div class="note" id="migSpace">选择目标盘后显示剩余空间</div>';

  openDialog('迁移设置', body,
    '<div class="left">已选 ' + items.length + ' 项 · ' + fmtSize(items.reduce(function (a, b) { return a + b.s; }, 0)) + '</div>' +
    '<button class="btn ghost" id="dlgCancel">取消</button>' +
    '<button class="btn accent" id="dlgNext">生成预览 →</button>');

  function refreshSpace() {
    const t = $('migTarget').value.trim();
    const letter = /^[a-zA-Z]:/.test(t) ? t.charAt(0).toUpperCase() : '';
    const d = state.drives.filter(function (x) { return x.letter === letter; })[0];
    const el = $('migSpace');
    if (!el) return;
    if (!d) { el.textContent = '目标目录要以盘符开头，例如 D:\\Moved'; return; }
    let need = 0;
    items.forEach(function (it) { need += it.s; });
    const enough = d.free > need;
    el.textContent = letter + ': 剩余 ' + fmtSize(d.free) + ' · 本次约需 ' + fmtSize(need) +
      (enough ? ' · 空间充足' : ' · 空间不足，请换一个盘');
    el.className = 'note' + (enough ? '' : ' danger');
  }
  refreshSpace();

  $('migTarget').addEventListener('input', refreshSpace);
  $('migDrive').addEventListener('change', function (e) {
    if (!e.target.value) return;
    const base = $('migTarget').value.trim();
    const tail = base.replace(/^[a-zA-Z]:/, '') || '\\CDriveScout-Moved';
    $('migTarget').value = e.target.value + ':' + (tail.charAt(0) === '\\' ? tail : '\\' + tail);
    refreshSpace();
  });
  $('migPick').addEventListener('click', async function () {
    const r = await window.api.pickDir();
    if (r && r.ok && r.dir) { $('migTarget').value = r.dir; refreshSpace(); }
  });

  $('dlgCancel').addEventListener('click', closeDialog);
  $('dlgNext').addEventListener('click', async function () {
    const targetRoot = $('migTarget').value.trim();
    const keepTree = $('migKeep').checked;
    const verify = $('migVerify').value;
    if (!targetRoot) { setStatus('请填写目标目录'); return; }
    state.migrateTarget = targetRoot;
    state.keepTree = keepTree;
    state.verifyMode = verify;
    try { window.localStorage.setItem('cds.migrateTarget', targetRoot); } catch (e) { /* ignore */ }

    const plan = await window.api.opPlan({ mode: 'migrate', items: items, targetRoot: targetRoot, keepTree: keepTree });
    if (!plan.ok) {
      const el = $('migSpace');
      if (el) { el.className = 'note danger'; el.textContent = plan.error || '无法生成计划'; }
      return;
    }
    if (plan.sameDrive) setStatus('注意：目标与原文件在同一磁盘，不会释放空间');
    previewStep(plan, 'migrate', { verify: verify });
  });
}

/* ---------------- 导出 ---------------- */

function categorySummary() {
  const order = ['可安全清理', '建议迁移', '需确认', '系统保护区', '其他'];
  return order.map(function (name) {
    const c = state.counts[name] || { count: 0, bytes: 0 };
    return { name: name, count: c.count, bytes: c.bytes };
  });
}

async function exportCsv() {
  if (!state.view.length) { setStatus('没有可导出的数据，先扫描一次'); return; }
  const res = await window.api.exportCsv({ rows: state.view });
  if (res && res.ok) setStatus('已导出 ' + res.count.toLocaleString() + ' 条 → ' + res.path);
}

async function exportHtml() {
  if (!state.view.length) { setStatus('没有可导出的数据，先扫描一次'); return; }
  const s = state.summary || { files: state.items.length, bytes: 0 };
  const res = await window.api.exportHtml({
    rows: state.view,
    summary: { files: s.files, bytes: s.bytes, categories: categorySummary() }
  });
  if (res && res.ok) setStatus('报告已生成 → ' + res.path);
}

/* ---------------- 杂项 ---------------- */

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
  setStatus('路径已复制');
}

window.addEventListener('DOMContentLoaded', function () {
  updateHead();
  boot().catch(function (err) {
    setStatus('初始化失败：' + (err && err.message ? err.message : err));
  });
});

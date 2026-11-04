'use strict';

/* 报告与导出相关的纯函数，抽出来便于单测 */

function fmtSize(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + units[i];
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(rows) {
  const lines = ['大小(字节),大小,分类,建议,判断依据,修改时间,路径'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    lines.push([
      r.s, fmtSize(r.s), r.c, r.a, r.r,
      new Date(r.m).toLocaleString('zh-CN', { hour12: false }), r.p
    ].map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function buildHtmlReport(payload) {
  const rows = payload.rows || [];
  const summary = payload.summary || {};
  const generated = new Date().toLocaleString('zh-CN', { hour12: false });
  const top = rows.slice(0, 500);
  const colorMap = {
    '可安全清理': '#3B6D11', '建议迁移': '#185FA5', '需确认': '#854F0B',
    '系统保护区': '#5F5E5A', '其他': '#444441'
  };
  const bgMap = {
    '可安全清理': '#EAF3DE', '建议迁移': '#E6F1FB', '需确认': '#FAEEDA',
    '系统保护区': '#F1EFE8', '其他': '#F5F4EF'
  };
  const cards = (summary.categories || []).map(function (c) {
    return '<div class="card"><div class="card-t">' + esc(c.name) + '</div>' +
      '<div class="card-v">' + esc(fmtSize(c.bytes)) + '</div>' +
      '<div class="card-s">' + c.count + ' 个文件</div></div>';
  }).join('');

  let body = '';
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const color = colorMap[r.c] || '#444441';
    const bg = bgMap[r.c] || '#F5F4EF';
    body += '<tr><td class="num">' + fmtSize(r.s) + '</td>' +
      '<td><span class="tag" style="color:' + color + ';background:' + bg + '">' + esc(r.c) + '</span></td>' +
      '<td class="act">' + esc(r.a) + '</td>' +
      '<td class="path">' + esc(r.p) + '</td>' +
      '<td class="reason">' + esc(r.r) + '</td>' +
      '<td class="time">' + new Date(r.m).toLocaleString('zh-CN', { hour12: false }) + '</td></tr>';
  }

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>C 盘透视报告 ' + generated + '</title><style>' +
    'body{font-family:"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;background:#F5F5F2;color:#2C2C2A;margin:0;padding:32px 28px}' +
    'h1{font-size:20px;margin:0 0 6px;font-weight:600}.sub{color:#6B6A64;font-size:13px;margin-bottom:20px}' +
    '.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}' +
    '.card{background:#fff;border:1px solid #E6E5E0;border-radius:10px;padding:14px 18px;min-width:170px}' +
    '.card-t{font-size:13px;color:#6B6A64}.card-v{font-size:22px;font-weight:600;margin:4px 0}' +
    '.card-s{font-size:12px;color:#8A8880}' +
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E6E5E0;border-radius:10px;overflow:hidden;font-size:12.5px}' +
    'th{text-align:left;background:#FAFAF7;color:#6B6A64;font-weight:500;padding:9px 10px;border-bottom:1px solid #E6E5E0}' +
    'td{padding:8px 10px;border-bottom:1px solid #F0EFEA;vertical-align:top}' +
    '.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:500}' +
    '.tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px;white-space:nowrap}' +
    '.act{white-space:nowrap;color:#444441}.path{word-break:break-all;color:#444441}.reason{color:#6B6A64}.time{color:#8A8880;white-space:nowrap}' +
    'tr:hover td{background:#FCFCFA}' +
    '</style></head><body>' +
    '<h1>C 盘透视报告</h1>' +
    '<div class="sub">生成时间 ' + generated + ' · 扫描 ' + (summary.files || 0).toLocaleString() + ' 个文件 · ' +
    '保留 ' + rows.length.toLocaleString() + ' 条记录 · 本报告为只读分析，未删除或移动任何文件</div>' +
    '<div class="cards">' + cards + '</div>' +
    '<table><thead><tr><th style="width:88px">大小</th><th style="width:104px">分类</th><th style="width:76px">建议</th>' +
    '<th>路径</th><th style="width:180px">判断依据</th><th style="width:150px">修改时间</th></tr></thead><tbody>' +
    body + '</tbody></table>' +
    '<p class="sub" style="margin-top:16px">表中仅展示体积最大的 ' + Math.min(500, rows.length) + ' 条；完整清单请导出 CSV。</p>' +
    '</body></html>';
}

module.exports = { fmtSize, esc, csvCell, buildCsv, buildHtmlReport };

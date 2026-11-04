'use strict';

const fs = require('fs');
const path = require('path');

const CATEGORY = {
  SAFE: '可安全清理',
  MOVE: '建议迁移',
  CHECK: '需确认',
  SYSTEM: '系统保护区',
  OTHER: '其他'
};

const CATEGORY_ORDER = [CATEGORY.SAFE, CATEGORY.MOVE, CATEGORY.CHECK, CATEGORY.SYSTEM, CATEGORY.OTHER];

function normalizeRoot(p) {
  let s = String(p || '').trim().toLowerCase().replace(/\//g, '\\');
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

function parseRules(text) {
  const systemRoots = [];
  const protectRoots = [];
  const rules = [];
  let section = '';
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.charAt(0) === '#' || line.charAt(0) === ';') continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    if (section === 'system') {
      const root = normalizeRoot(line);
      if (root) systemRoots.push(root);
    } else if (section === 'protect') {
      const root = normalizeRoot(line);
      if (root) protectRoots.push(root);
    } else if (section === 'rules') {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const category = parts[0].trim();
      const match = parts[1].trim().toLowerCase();
      const pattern = parts[2].trim();
      const action = parts[3].trim();
      const reason = (parts[4] || '').trim();
      if (!category || !match || !pattern) continue;
      if (['contains', 'prefix', 'ext', 'name'].indexOf(match) === -1) continue;
      const isNameLike = (match === 'name' || match === 'ext');
      rules.push({
        category: category,
        match: match,
        pattern: isNameLike ? pattern.toLowerCase() : pattern.toLowerCase().replace(/\//g, '\\'),
        raw: pattern,
        action: action,
        reason: reason,
        allowSystem: String(parts[5] || '').trim().toLowerCase() === 'sys'
      });
    }
  }
  return { systemRoots: systemRoots, protectRoots: protectRoots, rules: rules };
}

const FALLBACK = `[system]
C:\\Windows
C:\\Program Files
C:\\Program Files (x86)
C:\\ProgramData
[rules]
可安全清理|contains|\\temp\\|删除|临时文件
建议迁移|contains|\\downloads\\|迁移|下载目录
需确认|ext|.iso|需确认|镜像文件
`;

function loadRules(filePath) {
  let text = '';
  let source = filePath;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    text = FALLBACK;
    source = '(内置兜底规则)';
  }
  // 去掉 UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = parseRules(text);
  parsed.source = source;
  parsed.rawText = text;
  return parsed;
}

function isSystemPath(lowerPath, systemRoots) {
  for (let i = 0; i < systemRoots.length; i++) {
    const r = systemRoots[i];
    if (lowerPath === r || lowerPath.indexOf(r + '\\') === 0) return true;
  }
  return false;
}

function matchRule(rule, lowerPath, lowerName) {
  switch (rule.match) {
    case 'contains':
      return lowerPath.indexOf(rule.pattern) !== -1;
    case 'prefix':
      return lowerPath.indexOf(rule.pattern) === 0;
    case 'ext':
      return lowerPath.slice(-rule.pattern.length) === rule.pattern;
    case 'name':
      return lowerName === rule.pattern;
    default:
      return false;
  }
}

function classify(fullPath, systemRoots, rules) {
  const lowerPath = fullPath.toLowerCase();
  const lowerName = path.basename(lowerPath);
  const systemZone = isSystemPath(lowerPath, systemRoots);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (matchRule(rule, lowerPath, lowerName)) {
      // 系统目录里：只允许「可安全清理」标签穿透，其余一律降级为系统保护区
      if (systemZone && rule.category !== CATEGORY.SAFE && !rule.allowSystem) {
        return {
          category: CATEGORY.SYSTEM,
          action: '不要动',
          reason: '系统目录内，不建议手动处理（原判定：' + (rule.reason || rule.raw) + '）',
          systemZone: true
        };
      }
      return {
        category: rule.category,
        action: rule.action,
        reason: rule.reason || rule.raw,
        systemZone: systemZone
      };
    }
  }
  if (systemZone) {
    return { category: CATEGORY.SYSTEM, action: '不要动', reason: '位于系统目录，清理风险高', systemZone: true };
  }
  return { category: CATEGORY.OTHER, action: '—', reason: '未命中规则，按需自行判断', systemZone: false };
}

module.exports = {
  CATEGORY,
  CATEGORY_ORDER,
  parseRules,
  loadRules,
  classify,
  isSystemPath,
  normalizeRoot
};

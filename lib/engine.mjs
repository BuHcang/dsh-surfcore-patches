/**
 * 补丁引擎（无依赖，纯 node）
 *
 * 设计三条硬规矩：
 *   1. 宁可不贴，也不贴错：每个锚点必须**恰好命中一次**；0 次 = 上游变了，2 次 = 锚点太泛，都拒绝。
 *   2. 幂等：源码里出现 marker 就认为已贴，重复跑不会贴两遍。
 *   3. 可回滚：贴之前把整个文件备份到 backups/<stamp>/，revert 用备份还原。
 *
 * 匹配顺序：原文精确 → 空白归一（把连续空白压成一个空格再比，用于上游改缩进/换行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------------ 读写 */

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* -------------------------------------------------------------- 锚点匹配 */

function normalizeWithMap(text) {
  const chars = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      chars.push(' ');
      map.push(i);
      i = j;
    } else {
      chars.push(ch);
      map.push(i);
      i += 1;
    }
  }
  return { norm: chars.join(''), map };
}

function countExact(hay, needle) {
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    if (first < 0) first = at;
    if (count > 1) break;
    from = at + needle.length;
  }
  return { count, first };
}

/**
 * 在 text 里找 needle，返回 { count, start, end }（原文字节偏移）。
 * 原文命中优先；原文 0 次时退到空白归一匹配。
 */
export function locate(text, needle) {
  if (typeof needle !== 'string' || needle === '') return { count: 0, start: -1, end: -1 };
  const exact = countExact(text, needle);
  if (exact.count > 0) return { count: exact.count, start: exact.first, end: exact.first + needle.length };

  const normHay = normalizeWithMap(text);
  const normNeedle = normalizeWithMap(needle).norm;
  if (!normNeedle) return { count: 0, start: -1, end: -1 };
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const at = normHay.norm.indexOf(normNeedle, from);
    if (at < 0) break;
    count += 1;
    if (first < 0) first = at;
    if (count > 1) break;
    from = at + normNeedle.length;
  }
  if (count === 0) return { count: 0, start: -1, end: -1 };
  const start = normHay.map[first];
  const end = normHay.map[first + normNeedle.length - 1] + 1;
  return { count, start, end };
}

/* ------------------------------------------------------------ 单条补丁 */

/**
 * @returns {{status:'applied'|'pending'|'missing'|'ambiguous', reason?:string, text?:string}}
 */
export function planPatch(text, patch) {
  if (patch.marker && text.includes(patch.marker)) return { status: 'applied' };
  if (patch.kind === 'insertAfter') {
    const hit = locate(text, patch.anchor);
    if (hit.count === 0) return { status: 'missing', reason: 'anchor 找不到（上游结构变了）' };
    if (hit.count > 1) return { status: 'ambiguous', reason: `anchor 命中 ${hit.count} 次（锚点太泛）` };
    // 插在锚点那一行的行尾之后、换行之前：插入内容自己带换行，原来的换行收尾。
    const at = hit.end;
    const body = /^[\r\n]/.test(patch.insert) ? patch.insert : `\n${patch.insert}`;
    return { status: 'pending', text: `${text.slice(0, at)}${body}${text.slice(at)}` };
  }
  if (patch.kind === 'replaceRange') {
    const a = locate(text, patch.start);
    const b = locate(text, patch.end);
    if (a.count === 0) return { status: 'missing', reason: 'start 找不到' };
    if (b.count === 0) return { status: 'missing', reason: 'end 找不到' };
    if (a.count > 1) return { status: 'ambiguous', reason: `start 命中 ${a.count} 次` };
    if (b.count > 1) return { status: 'ambiguous', reason: `end 命中 ${b.count} 次` };
    if (b.end <= a.start) return { status: 'ambiguous', reason: 'end 在 start 之前' };
    return { status: 'pending', text: `${text.slice(0, a.start)}${patch.replacement}${text.slice(b.end)}` };
  }
  return { status: 'missing', reason: `未知 kind: ${patch.kind}` };
}

/* ---------------------------------------------------------------- 目标 */

export function resolveRoot(manifest, roots = {}) {
  const configured = roots[manifest.id];
  if (configured) return configured;
  for (const candidate of manifest.defaultRoots ?? []) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

export function detect(manifest, roots = {}) {
  const root = resolveRoot(manifest, roots);
  if (!root || !fs.existsSync(root)) return { installed: false, root, version: '' };
  const pkgFile = path.join(root, manifest.detect?.file ?? 'package.json');
  const pkg = readJSON(pkgFile, null);
  const name = String(pkg?.[manifest.detect?.nameField ?? 'name'] ?? '');
  const version = String(pkg?.[manifest.detect?.versionField ?? 'version'] ?? '');
  const ok = manifest.detect?.equals ? name === manifest.detect.equals : Boolean(name);
  return { installed: ok, root, version, name };
}

export function checkTarget(manifest, roots = {}) {
  const info = detect(manifest, roots);
  if (!info.installed) {
    return { id: manifest.id, title: manifest.title, installed: false, root: info.root, version: info.version, known: false, items: [], counts: { applied: 0, pending: 0, bad: 0 } };
  }
  const known = (manifest.knownVersions ?? []).includes(info.version);
  const byFile = new Map();
  const items = [];
  for (const patch of manifest.patches ?? []) {
    const rel = patch.file;
    if (!byFile.has(rel)) byFile.set(rel, fs.existsSync(path.join(info.root, rel)) ? fs.readFileSync(path.join(info.root, rel), 'utf8') : '');
    const text = byFile.get(rel);
    if (!text) {
      items.push({ id: patch.id, status: 'missing', reason: `文件不存在：${rel}` });
      continue;
    }
    const plan = planPatch(text, patch);
    items.push({ id: patch.id, file: rel, status: plan.status, reason: plan.reason });
    if (plan.status === 'pending') byFile.set(rel, plan.text);
  }
  const copyItems = (manifest.copy ?? []).map((c) => {
    const dest = path.join(info.root, c.to);
    const exists = fs.existsSync(dest);
    const same = exists && fileEqual(dest, path.join(manifestBase(manifest), c.from));
    return { id: c.to, status: same ? 'applied' : 'pending', reason: exists ? (same ? '' : '内容与 payload 不同') : '文件不存在' };
  });
  const all = [...items, ...copyItems];
  const counts = {
    applied: all.filter((i) => i.status === 'applied').length,
    pending: all.filter((i) => i.status === 'pending').length,
    bad: all.filter((i) => i.status === 'missing' || i.status === 'ambiguous').length,
  };
  return { id: manifest.id, title: manifest.title, installed: true, root: info.root, version: info.version, known, items: all, counts };
}

function manifestBase(manifest) {
  return manifest.__base ?? process.cwd();
}

function fileEqual(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 应用 */

export function applyTarget(manifest, roots = {}, options = {}) {
  const { dryRun = false, stateDir = path.join(process.cwd(), '.state'), allowUnknown = false } = options;
  const info = detect(manifest, roots);
  if (!info.installed) return { ok: false, code: 'not-installed', error: `${manifest.title} 没找到（root=${info.root || '未配置'}）`, hint: '在设置里填安装目录' };
  const known = (manifest.knownVersions ?? []).includes(info.version);
  if (!known && !allowUnknown) {
    return { ok: false, code: 'unknown-version', error: `版本 ${info.version} 不在已知矩阵（${(manifest.knownVersions ?? []).join(', ')}）里`, hint: '先跑 check 看锚点是否还命中；确认无误后加 --allow-unknown' };
  }

  const backupDir = path.join(stateDir, 'backups', `${manifest.id}-${info.version}-${stamp()}`);
  const changed = new Set();
  const report = { applied: [], skipped: [], failed: [] };

  // 1) 复制 payload 文件（模块本体）
  for (const c of manifest.copy ?? []) {
    const src = path.join(manifestBase(manifest), c.from);
    const dest = path.join(info.root, c.to);
    if (!fs.existsSync(src)) {
      report.failed.push({ id: c.to, reason: `payload 缺 ${c.from}` });
      continue;
    }
    if (fileEqual(dest, src)) {
      report.skipped.push({ id: c.to, reason: '已一致' });
      continue;
    }
    if (!dryRun) {
      backupFile(backupDir, info.root, c.to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    report.applied.push({ id: c.to, reason: fs.existsSync(dest) ? '覆盖' : '新建' });
    changed.add(c.to);
  }

  // 2) 文本补丁（同一文件内按顺序叠加）
  const byFile = new Map();
  for (const patch of manifest.patches ?? []) {
    const rel = patch.file;
    if (!byFile.has(rel)) {
      const file = path.join(info.root, rel);
      byFile.set(rel, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    }
    const text = byFile.get(rel);
    if (!text) {
      report.failed.push({ id: patch.id, reason: `文件不存在：${rel}` });
      continue;
    }
    const plan = planPatch(text, patch);
    if (plan.status === 'applied') {
      report.skipped.push({ id: patch.id, reason: 'marker 已在' });
      continue;
    }
    if (plan.status !== 'pending') {
      report.failed.push({ id: patch.id, reason: plan.reason });
      continue;
    }
    byFile.set(rel, plan.text);
    report.applied.push({ id: patch.id, reason: rel });
    changed.add(rel);
  }

  if (report.failed.length > 0) {
    return {
      ok: false,
      code: 'anchor-failed',
      error: `${report.failed.length} 条补丁的锚点不成立（未写入任何文件）`,
      hint: '上游结构变了：先看 check 输出，必要时升级 manifest',
      report,
    };
  }

  if (!dryRun) {
    for (const rel of changed) {
      const file = path.join(info.root, rel);
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const next = byFile.has(rel) ? byFile.get(rel) : null;
      if (next === null) continue; // 复制型文件已处理
      if (current === next) continue;
      backupFile(backupDir, info.root, rel);
      writeTextAtomic(file, next);
    }
    // 语法自检：贴完必须还能 parse
    const broken = [];
    for (const rel of changed) {
      if (!/\.(js|mjs|cjs)$/.test(rel)) continue;
      const r = spawnSync(process.execPath, ['--check', path.join(info.root, rel)], { encoding: 'utf8' });
      if (r.status !== 0) broken.push({ id: rel, reason: (r.stderr || '').split('\n').slice(0, 2).join(' ').trim() });
    }
    if (broken.length > 0) return { ok: false, code: 'syntax-error', error: '贴完语法检查失败，请回滚', hint: '点击「回滚」用备份还原', report: { ...report, failed: broken }, backupDir };
    writeJSON(path.join(stateDir, `${manifest.id}.json`), {
      target: manifest.id,
      version: info.version,
      at: new Date().toISOString(),
      applied: report.applied.map((a) => a.id),
      backupDir,
    });
  }

  return { ok: true, code: dryRun ? 'dry-run' : 'applied', report, backupDir, version: info.version };
}

function backupFile(backupDir, root, rel) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) return;
  const dest = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/* ---------------------------------------------------------------- 回滚 */

export function revertTarget(manifest, roots = {}, options = {}) {
  const { stateDir = path.join(process.cwd(), '.state') } = options;
  const info = detect(manifest, roots);
  if (!info.installed) return { ok: false, code: 'not-installed', error: `${manifest.title} 没找到` };
  const record = readJSON(path.join(stateDir, `${manifest.id}.json`), null);
  const backupDir = record?.backupDir;
  if (!backupDir || !fs.existsSync(backupDir)) return { ok: false, code: 'no-backup', error: '没有可用的备份', hint: '备份目录不存在：' + String(backupDir) };
  const restored = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(backupDir, full).split(path.sep).join('/');
        fs.copyFileSync(full, path.join(info.root, rel));
        restored.push(rel);
      }
    }
  };
  walk(backupDir);
  return { ok: true, code: 'reverted', restored, backupDir };
}

/* ---------------------------------------------------------------- 体检 */

export function doctor(manifest, roots = {}, options = {}) {
  const { stateDir = path.join(process.cwd(), '.state') } = options;
  const checks = [];
  const push = (name, fn) => {
    try {
      const r = fn();
      checks.push({ name, ok: r.ok !== false, detail: String(r.detail ?? '') });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error?.message ?? error).slice(0, 200) });
    }
  };

  const info = detect(manifest, roots);
  push('目标已安装', () => ({ ok: info.installed, detail: info.installed ? `${info.root}（v${info.version}）` : '未找到安装目录' }));
  if (!info.installed) return { ok: false, checks };

  push('版本在已知矩阵内', () => ({ ok: (manifest.knownVersions ?? []).includes(info.version), detail: `v${info.version} / 已知 ${(manifest.knownVersions ?? []).join(', ')}` }));
  const chk = checkTarget(manifest, roots);
  push('补丁全部已贴', () => ({ ok: chk.counts.bad === 0 && chk.counts.pending === 0, detail: chk.counts.bad ? `坏 ${chk.counts.bad} 条` : chk.counts.pending ? `待贴 ${chk.counts.pending} 条` : `${chk.counts.applied} 条都在` }));
  push('已贴文件语法正常', () => {
    const broken = [];
    for (const rel of new Set((manifest.patches ?? []).map((p) => p.file))) {
      if (!/\.(js|mjs|cjs)$/.test(rel)) continue;
      const r = spawnSync(process.execPath, ['--check', path.join(info.root, rel)], { encoding: 'utf8' });
      if (r.status !== 0) broken.push(rel);
    }
    return { ok: broken.length === 0, detail: broken.length ? `语法错：${broken.join(', ')}` : 'ok' };
  });
  push('上次应用记录与版本一致', () => {
    const record = readJSON(path.join(stateDir, `${manifest.id}.json`), null);
    if (!record) return { ok: chk.counts.pending === 0, detail: chk.counts.pending === 0 ? '无记录但已全贴' : '无记录且有未贴项' };
    return { ok: String(record.version) === String(info.version), detail: `记录 v${record.version} / 实际 v${info.version}` };
  });

  return { ok: checks.every((c) => c.ok), checks };
}

/* ---------------------------------------------------------------- 清单 */

export function loadManifest(baseDir, id) {
  const file = path.join(baseDir, 'manifests', `${id}.json`);
  const manifest = readJSON(file, null);
  if (!manifest) throw new Error(`找不到清单：${file}`);
  manifest.__base = baseDir;
  return manifest;
}

export function listManifests(baseDir) {
  const dir = path.join(baseDir, 'manifests');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => loadManifest(baseDir, n.replace(/\.json$/, '')));
}
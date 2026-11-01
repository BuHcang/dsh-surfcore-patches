#!/usr/bin/env node
/**
 * 命令行：不需要 DSH 也能用。
 *
 *   node bin/cli.mjs check   --target surfcore --root D:/DSH-Work/surfcore
 *   node bin/cli.mjs apply   --target surfcore --root ... [--dry-run]
 *   node bin/cli.mjs revert  --target surfcore --root ...
 *   node bin/cli.mjs doctor  --target surfcore --root ...
 *   node bin/cli.mjs list
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listManifests, loadManifest, checkTarget, applyTarget, revertTarget, doctor } from '../lib/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE_DIR = path.join(HOME, 'surfcore-patches');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const action = args._[0] || 'check';
const json = Boolean(args.json);
const roots = args.root ? { [String(args.target ?? '')]: String(args.root) } : {};

function pickManifests() {
  const all = listManifests(REPO);
  const target = args.target;
  if (!target || target === 'all') return all;
  return all.filter((m) => m.id === target || m.id.startsWith(`${target}-`));
}

function rootsFor(manifest) {
  return args.root ? { [manifest.id]: String(args.root) } : {};
}

function printTarget(result) {
  if (!result.installed) {
    console.log(`✗ ${result.title}: 没找到安装目录（用 --root 指过去）`);
    return;
  }
  console.log(`${result.counts.bad ? '✗' : result.counts.pending ? '·' : '✓'} ${result.title}  v${result.version}  ${result.root}`);
  if (!result.known) console.log('  ! 版本不在已知矩阵里，只建议 check');
  for (const item of result.items) {
    const mark = item.status === 'applied' ? '✓' : item.status === 'pending' ? '·' : '✗';
    if (item.status === 'applied' && !args.verbose) continue;
    console.log(`  ${mark} ${item.id}${item.reason ? `  ${item.reason}` : ''}`);
  }
  console.log(`  → 已贴 ${result.counts.applied} / 待贴 ${result.counts.pending} / 异常 ${result.counts.bad}`);
}

let failed = false;
for (const manifest of pickManifests()) {
  const targets = rootsFor(manifest);
  if (action === 'list') {
    console.log(`${manifest.id}\tv${manifest.knownVersions.join(',')}\t${manifest.patches.length} 条补丁\t${manifest.title}`);
    continue;
  }
  if (action === 'check') {
    const result = checkTarget(manifest, targets);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printTarget(result);
    if (result.installed && (result.counts.bad > 0 || result.counts.pending > 0)) failed = true;
  } else if (action === 'apply') {
    const result = applyTarget(manifest, targets, { dryRun: Boolean(args['dry-run']), stateDir: STATE_DIR, allowUnknown: Boolean(args['allow-unknown']) });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) {
      console.log(`${args['dry-run'] ? '（演练）' : ''}${manifest.title}: 贴了 ${result.report.applied.length} 处，跳过 ${result.report.skipped.length} 处`);
      for (const a of result.report.applied) console.log(`  + ${a.id}  ${a.reason ?? ''}`);
      if (result.backupDir && !args['dry-run']) console.log(`  备份：${result.backupDir}`);
    } else {
      console.log(`✗ ${manifest.title}: ${result.error}\n  ${result.hint ?? ''}`);
      for (const f of result.report?.failed ?? []) console.log(`  ! ${f.id}  ${f.reason}`);
      failed = true;
    }
  } else if (action === 'revert') {
    const result = revertTarget(manifest, targets, { stateDir: STATE_DIR });
    if (result.ok) console.log(`↩ ${manifest.title}: 还原 ${result.restored.length} 个文件（${result.backupDir}）`);
    else {
      console.log(`✗ ${manifest.title}: ${result.error}`);
      failed = true;
    }
  } else if (action === 'doctor') {
    const result = doctor(manifest, targets, { stateDir: STATE_DIR });
    console.log(`${result.ok ? '✓' : '✗'} ${manifest.title}`);
    for (const c of result.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!result.ok) failed = true;
  } else {
    console.log(`未知动作：${action}（可用 check / apply / revert / doctor / list）`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
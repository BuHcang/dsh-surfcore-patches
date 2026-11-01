/**
 * dsh-surfcore-patches —— 给「独立进程型」DSH 伴侣程序（SurfCore、dsh-bili-scroll）打本地补丁的管家。
 *
 * 为什么需要它：这类程序不是 DSH 插件，升级方式是整目录换 zip，手改的代码会被冲掉。
 * 本插件把改动整理成「锚点补丁」（manifest），升级后一键重新贴回去、贴完体检、出问题回滚。
 *
 * 默认只体检、不自动贴（autoApply=false）：动的是别的程序的源码，必须人点一下。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listManifests, checkTarget, applyTarget, revertTarget, doctor } from './engine.mjs';

export const name = 'surfcore-patches';
export const inject = ['webServer'];

export const defaults = {
  /** SurfCore 安装目录（留空则用环境变量 SURFCORE_ROOT） */
  surfcoreRoot: '',
  /** dsh-bili-scroll 安装目录（留空则用 ~/.dsh/profiles/desktop/node_modules/dsh-bili-scroll） */
  biliScrollRoot: '',
  /** 启动时自动体检（只读，不改文件） */
  autoCheckOnStart: true,
  /** 体检到「待贴」时自动应用。默认关：改别人的源码必须人点 */
  autoApply: false,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE_DIR = path.join(HOME, 'surfcore-patches');

export function validateConfig(input, previous = defaults) {
  const next = { ...previous };
  if (input == null) return next;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
  for (const key of ['surfcoreRoot', 'biliScrollRoot']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} 必须是字符串`);
      next[key] = input[key].trim();
    }
  }
  for (const key of ['autoCheckOnStart', 'autoApply']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      next[key] = input[key];
    }
  }
  return next;
}

function rootsFor(config) {
  return {
    surfcore: config.surfcoreRoot || process.env.SURFCORE_ROOT || '',
    'dsh-bili-scroll':
      config.biliScrollRoot || path.join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-bili-scroll'),
  };
}

function manifestsFor(target) {
  const all = listManifests(REPO);
  if (!target || target === 'all') return all;
  return all.filter((m) => m.id === target || m.id.startsWith(`${target}-`));
}

export function apply(ctx, config) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let settings;
  try {
    settings = validateConfig({ ...defaults, ...(config && typeof config === 'object' ? config : {}) });
  } catch {
    settings = { ...defaults };
  }

  const summary = () =>
    manifestsFor('all').map((manifest) => {
      const result = checkTarget(manifest, rootsFor(settings));
      return {
        id: result.id,
        title: result.title,
        installed: result.installed,
        root: result.root,
        version: result.version,
        known: result.known,
        counts: result.counts,
        items: result.items.filter((i) => i.status !== 'applied'),
      };
    });

  if (settings.autoCheckOnStart) {
    try {
      const rows = summary();
      const pending = rows.reduce((n, r) => n + (r.counts?.pending ?? 0), 0);
      if (pending > 0) {
        ctx.logger?.warn?.(`[surfcore-patches] ${pending} 处待贴：升级后请打开设置页点「应用」`);
        if (settings.autoApply) {
          for (const manifest of manifestsFor('all')) applyTarget(manifest, rootsFor(settings), { stateDir: STATE_DIR });
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[surfcore-patches] 启动体检失败：${String(error?.message ?? error)}`);
    }
  }

  if (!ctx.webServer?.register) return;

  const originOk = (req) => {
    const origin = req.headers?.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers?.host;
    } catch {
      return false;
    }
  };

  const sendJSON = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('请求体必须是合法 JSON');
    }
  };

  const route = (suffix, method, handler) =>
    ctx.webServer.register({
      kind: 'exact',
      path: `/dsh-surfcore-patches/${suffix}`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== method) return sendJSON(res, 405, { ok: false, error: '方法不允许' });
        if (req.headers?.['x-surfcore-patches'] !== '1') return sendJSON(res, 400, { ok: false, error: '缺少设置页标记' });
        if (!originOk(req)) return sendJSON(res, 403, { ok: false, error: '拒绝跨站修改' });
        try {
          const input = method === 'POST' ? await readBody(req) : {};
          const result = await handler(input);
          sendJSON(res, 200, { ok: true, ...(result ?? {}) });
        } catch (error) {
          sendJSON(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
        }
      },
    });

  const register = route;

  register('state', 'GET', () => ({
    settings: { ...settings },
    roots: rootsFor(settings),
    stateDir: STATE_DIR,
    targets: summary(),
  }));

  register('check', 'POST', (input) => {
    const target = String(input?.target ?? 'all');
    return { targets: manifestsFor(target).map((m) => checkTarget(m, rootsFor(settings))) };
  });

  register('apply', 'POST', (input) => {
    const target = String(input?.target ?? 'all');
    const results = manifestsFor(target).map((manifest) =>
      applyTarget(manifest, rootsFor(settings), { stateDir: STATE_DIR, dryRun: Boolean(input?.dryRun) }),
    );
    return { results };
  });

  register('revert', 'POST', (input) => {
    const target = String(input?.target ?? 'all');
    return { results: manifestsFor(target).map((m) => revertTarget(m, rootsFor(settings), { stateDir: STATE_DIR })) };
  });

  register('doctor', 'POST', (input) => {
    const target = String(input?.target ?? 'all');
    return { results: manifestsFor(target).map((m) => doctor(m, rootsFor(settings), { stateDir: STATE_DIR })) };
  });
}
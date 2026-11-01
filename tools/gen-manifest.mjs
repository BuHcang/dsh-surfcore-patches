/**
 * 开发用：把当前机器上的补丁表（_custom/surfcore-patches/patches.mjs）转成发布用的 manifest。
 *
 * 只在作者机器上跑，不参与发布（files 白名单里没有 tools/）。
 *   node tools/gen-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LOCAL = 'D:/DSH-Work/_custom/surfcore-patches/patches.mjs';
const SURFCORE = 'D:/DSH-Work/surfcore';
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const BILI = path.join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-bili-scroll');

const { patches } = await import(`file:///${LOCAL.replace(/\\/g, '/')}`);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPayload(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

/* ---------------- surfcore ---------------- */

const surfcorePatches = patches.map((p) => ({
  id: p.id,
  file: p.file || 'src/bridge.js',
  kind: p.kind,
  ...(p.kind === 'insertAfter' ? { anchor: p.anchor, insert: p.insert } : { start: p.start, end: p.end, replacement: p.replacement }),
  marker: p.marker,
  desc: p.desc,
}));

for (const f of ['index.js', 'people.js']) {
  copyPayload(path.join(SURFCORE, 'src', 'custom', f), path.join(REPO, 'payload', 'surfcore', 'custom', f));
}

const surfcoreManifest = {
  schema: 2,
  id: 'surfcore',
  title: 'SurfCore',
  detect: { file: 'package.json', nameField: 'name', versionField: 'version', equals: 'surfcore' },
  knownVersions: ['0.8.6'],
  defaultRoots: [],
  copy: [
    { from: 'payload/surfcore/custom/index.js', to: 'src/custom/index.js' },
    { from: 'payload/surfcore/custom/people.js', to: 'src/custom/people.js' },
  ],
  patches: surfcorePatches,
};

/* ---------------- dsh-bili-scroll ---------------- */

const biliTemplate = path.join(BILI, 'profile-template', 'bili-duty', 'cordis.patch.yml');
copyPayload(biliTemplate, path.join(REPO, 'payload', 'dsh-bili-scroll', 'bili-duty.cordis.patch.yml'));

const biliManifest = {
  schema: 2,
  id: 'dsh-bili-scroll',
  title: '刷B站（dsh-bili-scroll）',
  detect: { file: 'package.json', nameField: 'name', versionField: 'version', equals: 'dsh-bili-scroll' },
  knownVersions: ['2.3.1'],
  defaultRoots: [],
  copy: [{ from: 'payload/dsh-bili-scroll/bili-duty.cordis.patch.yml', to: 'profile-template/bili-duty/cordis.patch.yml' }],
  patches: [
    {
      id: 'bili/verify-pages',
      file: 'lib/verify.mjs',
      kind: 'replaceRange',
      start: '    const PAGES = 6',
      end: '    const PAGES = 6',
      replacement:
        '    // [LOCAL-HOOK bili/verify-pages] 复核只翻最新 20 条容易误报「没发出去」；翻 6 页 = 最近 120 条\n    const PAGES = 6',
      marker: '[LOCAL-HOOK bili/verify-pages]',
      desc: '评论复核从「最新 20 条」放宽到 6 页 120 条，减少误报',
    },
  ],
};

ensureDir(path.join(REPO, 'manifests'));
fs.writeFileSync(path.join(REPO, 'manifests', 'surfcore-0.8.6.json'), `${JSON.stringify(surfcoreManifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(REPO, 'manifests', 'dsh-bili-scroll-2.3.1.json'), `${JSON.stringify(biliManifest, null, 2)}\n`, 'utf8');

console.log(`[gen] surfcore: ${surfcoreManifest.patches.length} 条补丁, ${surfcoreManifest.copy.length} 个 payload 文件`);
console.log(`[gen] dsh-bili-scroll: ${biliManifest.patches.length} 条补丁, ${biliManifest.copy.length} 个 payload 文件`);
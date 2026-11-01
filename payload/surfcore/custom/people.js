/**
 * 人物册：按 QQ 号记「谁是谁」。
 *
 * 为什么单独一份：SurfCore 自己的熟悉度是**按会话**记的（群共用一个分），
 * 换个人问同一件事就分不清谁是谁了。这里按 QQ 全局记名字/外号/所在群/熟悉度/印象，
 * 上游不读这个文件，数据在 <state>/people.json，模块升级也不会丢。
 *
 * 只做三件事：记住、取出来拼提示词、在文本里认人（认人用于自动 @）。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SCORE = 99;
const OWNER_SCORE = 100;
const PEOPLE_MAX = 500;
const ALIAS_MAX = 12;

export function peopleFile(stateDir) {
  return path.join(stateDir, 'people.json');
}

export function loadPeople(stateDir) {
  try {
    const db = JSON.parse(fs.readFileSync(peopleFile(stateDir), 'utf8'));
    if (!db || typeof db !== 'object') throw new Error('bad db');
    if (!db.people || typeof db.people !== 'object') db.people = {};
    return db;
  } catch {
    return { version: 1, updatedAt: 0, lastDecay: '', people: {} };
  }
}

function savePeople(stateDir, db) {
  db.version = 1;
  db.updatedAt = Date.now();
  const qqs = Object.keys(db.people);
  if (qqs.length > PEOPLE_MAX) {
    // 只丢「最久没说话」的，主人永远不丢
    qqs.sort((a, b) => Number(db.people[a]?.familiarity?.lastAt || 0) - Number(db.people[b]?.familiarity?.lastAt || 0));
    for (const qq of qqs.slice(0, qqs.length - PEOPLE_MAX)) {
      if (!db.people[qq]?.owner) delete db.people[qq];
    }
  }
  const file = peopleFile(stateDir);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 写失败不影响对话 */ }
  }
}

function ensurePerson(db, { qq, name, groupId, owner }) {
  const id = String(qq ?? '').trim();
  if (!/^\d{4,12}$/.test(id)) return null;
  let p = db.people[id];
  if (!p || typeof p !== 'object') {
    p = db.people[id] = {
      qq: id, name: '', aliases: [], owner: false, relation: '', groups: [],
      familiarity: { score: 0, lastAt: 0, hits: 0 }, impressions: [], notes: '',
    };
  }
  if (!Array.isArray(p.aliases)) p.aliases = [];
  if (!Array.isArray(p.groups)) p.groups = [];
  if (!Array.isArray(p.impressions)) p.impressions = [];
  if (!p.familiarity || typeof p.familiarity !== 'object') p.familiarity = { score: 0, lastAt: 0, hits: 0 };
  if (owner) { p.owner = true; p.familiarity.score = OWNER_SCORE; }
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (clean) {
    if (!p.name) p.name = clean;
    else if (p.name !== clean) {
      // 改名（比如群名片从 🦆老师 变 🐑老师）：旧名留作别名，仍然认得出
      if (!p.aliases.includes(p.name)) p.aliases.push(p.name);
      p.name = clean;
    }
  }
  if (groupId) {
    const g = String(groupId);
    if (!p.groups.includes(g)) p.groups.push(g);
  }
  return p;
}

/** 收到一条消息就更新册子（名字/别名/所在群/熟悉度）。永不抛错。 */
export function noteIncoming(stateDir, { qq, name, groupId, isOwner = false, at = Date.now(), aliases = [] } = {}) {
  try {
    const db = loadPeople(stateDir);
    const p = ensurePerson(db, { qq, name, groupId, owner: isOwner });
    if (!p) return;
    for (const a of aliases) {
      const s = String(a || '').trim().slice(0, 24);
      if (s && s !== p.name && !p.aliases.includes(s)) p.aliases.push(s);
    }
    if (p.aliases.length > ALIAS_MAX) p.aliases = p.aliases.slice(-ALIAS_MAX);
    p.familiarity.hits = Number(p.familiarity.hits || 0) + 1;
    p.familiarity.lastAt = at;
    if (!p.owner) {
      // 越熟涨得越慢：<60 +2，<90 +1，>=90 +0.5
      const cur = Number(p.familiarity.score) || 0;
      const gain = cur < 60 ? 2 : cur < 90 ? 1 : 0.5;
      p.familiarity.score = Math.min(MAX_SCORE, Number((cur + gain).toFixed(1)));
    }
    savePeople(stateDir, db);
  } catch { /* 人物册坏了也不能影响收消息 */ }
}

/** 按熟悉度排的名单；exclude 里的 QQ 不出现。 */
export function rosterOf(db, { limit = 8, exclude = [], ownerFirst = false } = {}) {
  const skip = new Set(exclude.map((x) => String(x ?? '')).filter(Boolean));
  const rows = Object.values(db.people || {})
    .filter((p) => p && p.qq && !skip.has(String(p.qq)) && p.name)
    .sort((a, b) => Number(b.familiarity?.score || 0) - Number(a.familiarity?.score || 0));
  const owner = ownerFirst ? rows.filter((p) => p.owner) : [];
  const rest = rows.filter((p) => !owner.includes(p));
  return [...owner, ...rest].slice(0, Math.max(1, limit));
}

/** 某个群里认识的人 + 印象（给群聊提示词用）。 */
export function impressionsOf(db, { groupId, limit = 6 } = {}) {
  const g = String(groupId ?? '');
  return Object.values(db.people || {})
    .filter((p) => p && Array.isArray(p.groups) && (!g || p.groups.includes(g)))
    .filter((p) => Array.isArray(p.impressions) && p.impressions.length)
    .slice(0, limit);
}

/**
 * 在一段文本里找出「叫到的人」。
 * 规则：名字/别名都要≥2 字；取最长命中；两个人命中同样长 → 不猜，返回 null。
 */
export function findMentioned(db, groupId, text, { exclude = [], minLen = 2 } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const skip = new Set(exclude.map((x) => String(x ?? '')).filter(Boolean));
  const g = String(groupId ?? '');
  const hits = [];
  for (const p of Object.values(db.people || {})) {
    if (!p || !p.qq || skip.has(String(p.qq))) continue;
    if (g && Array.isArray(p.groups) && !p.groups.includes(g)) continue;
    const terms = [p.name, ...(p.aliases || [])].map((t) => String(t || '').trim()).filter((t) => t.length >= minLen);
    let best = null;
    for (const term of terms) {
      if (!raw.includes(term)) continue;
      if (!best || term.length > best.term.length) best = { term, len: term.length, exact: term === p.name };
    }
    if (best) hits.push({ qq: String(p.qq), name: p.name, term: best.term, len: best.len, exact: best.exact, score: Number(p.familiarity?.score || 0) });
  }
  if (!hits.length) return null;
  // 先取最长命中的称呼；同一称呼撞到多个人时，用「正名命中优先 + 更熟优先」化解；
  // 仍然分不出胜负就不猜（返回 null），免得 @ 错人。
  const maxLen = Math.max(...hits.map((h) => h.len));
  const top = hits.filter((h) => h.len === maxLen)
    .sort((a, b) => (Number(b.exact) - Number(a.exact)) || (b.score - a.score));
  if (top.length > 1 && top[0].exact === top[1].exact && top[0].score === top[1].score) return null;
  const win = top[0];
  return { qq: win.qq, name: win.name, term: win.term };
}

export function updatePerson(stateDir, qq, mutator) {
  try {
    const db = loadPeople(stateDir);
    const id = String(qq ?? '').trim();
    if (!db.people[id]) return false;
    mutator(db.people[id], db);
    savePeople(stateDir, db);
    return true;
  } catch { return false; }
}
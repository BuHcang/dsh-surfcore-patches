/**
 * 主动找人（v1）——「她想找谁说话就去找谁」，不再只能等人来叫。
 *
 * 用户 2026-11-01 定下的规矩（m09458）：
 *  1. 方案 B：约定跟进 + 机会型 + 主人指使（主人指使不计额度）。
 *  2. **每天最多 2 次，而且越少越好，一天一次都没有是常态**。
 *  3. 可以私聊别人；发不出去（不是好友）就**别再找他、也别去群里 @**，除非主人指使。
 *  4. 22:00–08:00 不主动找人。
 *
 * 这个文件只算「该不该、找谁、到点了没」，不碰网络也不碰桥。桥那边一行调用就够。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPeople } from './people.js';

const DEFAULTS = {
  enabled: true,
  dailyMax: 2,          // 一天最多 2 次（主人指使不算）
  minGapHours: 6,       // 两次之间至少隔 6 小时
  perPersonGapDays: 3,  // 同一个人至少隔 3 天
  budgetRatio: 0.9,     // 额度用到 90% 就别再自己找人
  quietStart: 22,
  quietEnd: 8,
  followupMaxAgeMs: 36 * 60 * 60 * 1000, // 约定超过 36 小时没问就不再提
  followupMax: 6
};

function fileOf(stateDir) {
  return path.join(stateDir, 'outreach.json');
}

function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function loadOutreach(stateDir) {
  const empty = { day: dayKey(), n: 0, lastAt: 0, people: {}, followups: [] };
  try {
    const raw = fs.readFileSync(fileOf(stateDir), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return empty;
    return {
      day: String(data.day || dayKey()),
      n: Number(data.n) || 0,
      lastAt: Number(data.lastAt) || 0,
      people: data.people && typeof data.people === 'object' ? data.people : {},
      followups: Array.isArray(data.followups) ? data.followups.filter((f) => f && f.qq) : []
    };
  } catch {
    return empty;
  }
}

function saveOutreach(stateDir, data) {
  try {
    const file = fileOf(stateDir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 落盘失败不该影响回复 */ }
}

/** 22:00–08:00 是「别主动找人」的时段（不是睡眠逻辑，两者互不影响）。 */
export function customInQuietHours(now = Date.now(), options = {}) {
  const o = { ...DEFAULTS, ...(options || {}) };
  const h = new Date(now).getHours();
  const start = Number(o.quietStart);
  const end = Number(o.quietEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

function normalizeDay(data) {
  const today = dayKey();
  if (data.day !== today) {
    data.day = today;
    data.n = 0;
  }
  return data;
}

/**
 * 今天还能不能自己找人：额度、间隔、时段、以及「别在快下线的时候突然找人」。
 * 返回 { ok, why }，why 直接写进日志方便排查。
 */
export function customOutreachGate({ stateDir, now = Date.now(), ratio, options } = {}) {
  const o = { ...DEFAULTS, ...(options || {}) };
  if (!stateDir) return { ok: false, why: '没有状态目录' };
  if (o.enabled === false) return { ok: false, why: '功能关着' };
  if (customInQuietHours(now, o)) return { ok: false, why: '免打扰时段' };
  if (ratio && Number.isFinite(Number(ratio.ratio)) && Number(ratio.ratio) >= Number(o.budgetRatio)) {
    return { ok: false, why: `额度已到 ${Math.round(Number(ratio.ratio) * 100)}%` };
  }
  const data = normalizeDay(loadOutreach(stateDir));
  if (data.n >= Number(o.dailyMax)) return { ok: false, why: `今天已经找了 ${data.n} 次` };
  const since = now - Number(data.lastAt || 0);
  if (data.lastAt && since < Number(o.minGapHours) * 3600 * 1000) {
    return { ok: false, why: `离上次不到 ${Math.round(since / 3600000)} 小时` };
  }
  return { ok: true, why: '', data };
}

/** 到点的约定（按 dueAt 升序，最多 3 条）。 */
export function customFollowupsDue({ stateDir, now = Date.now() } = {}) {
  try {
    const data = loadOutreach(stateDir);
    const rows = data.followups
      .filter((f) => Number(f.dueAt) <= now && now - Number(f.dueAt) < DEFAULTS.followupMaxAgeMs)
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    return rows.slice(0, 3);
  } catch {
    return [];
  }
}

/** 记一条约定（同一个人的旧约定会被新的顶掉）。 */
export function customFollowupAdd({ stateDir, qq, about, dueAt, now = Date.now(), name } = {}) {
  try {
    if (!stateDir || !qq || !about) return false;
    const data = normalizeDay(loadOutreach(stateDir));
    const id = `${qq}-${now}`;
    data.followups = data.followups
      .filter((f) => String(f.qq) !== String(qq))
      .concat([{ id, qq: String(qq), name: String(name || ''), about: String(about).slice(0, 60), dueAt: Number(dueAt) || now + 18 * 3600 * 1000, createdAt: now }])
      .slice(-DEFAULTS.followupMax);
    saveOutreach(stateDir, data);
    return true;
  } catch {
    return false;
  }
}

export function customFollowupDone({ stateDir, id } = {}) {
  try {
    const data = loadOutreach(stateDir);
    const before = data.followups.length;
    data.followups = data.followups.filter((f) => String(f.id) !== String(id));
    if (data.followups.length !== before) saveOutreach(stateDir, data);
  } catch { /* ignore */ }
}

/** 私聊发不出去（不是好友）：记下来，以后不再主动找他，也不去群里喊。 */
export function customMarkNotFriend({ stateDir, qq, now = Date.now() } = {}) {
  try {
    if (!stateDir || !qq) return;
    const data = normalizeDay(loadOutreach(stateDir));
    data.people[String(qq)] = { ...(data.people[String(qq)] || {}), notFriend: true, at: now };
    saveOutreach(stateDir, data);
  } catch { /* ignore */ }
}

export function customIsNotFriend({ stateDir, qq } = {}) {
  try {
    return Boolean(loadOutreach(stateDir).people[String(qq)]?.notFriend);
  } catch {
    return false;
  }
}

/**
 * 挑一个「现在可以找」的人。
 *
 * 优先级：① 到点的约定（有人名、有由头）② 机会型——很久没联系、但有过正经对话的人。
 * 只从**已经有私聊窗口**的人里挑：没有窗口的冷启动会把消息发飞，也容易惹人。
 */
export function customPickOutreachTarget({ stateDir, now = Date.now(), conversations, options } = {}) {
  const o = { ...DEFAULTS, ...(options || {}) };
  try {
    if (!stateDir || !conversations?.get) return null;
    const data = normalizeDay(loadOutreach(stateDir));

    const live = (qq) => conversations.get(`private:${String(qq)}`);

    const due = customFollowupsDue({ stateDir, now });
    for (const f of due) {
      if (!live(f.qq)) continue;
      if (customIsNotFriend({ stateDir, qq: f.qq })) continue;
      return { qq: String(f.qq), name: String(f.name || ''), why: 'followup', about: String(f.about || ''), followupId: String(f.id) };
    }

    const db = loadPeople(stateDir);
    const derived = customDeriveFollowup({ conversations, now });
    if (derived && live(derived.qq) && !customIsNotFriend({ stateDir, qq: derived.qq })
      && now - Number(data.people[String(derived.qq)]?.at || 0) >= 24 * 3600 * 1000) {
      const p = db?.people?.[derived.qq];
      return { qq: String(derived.qq), name: String(p?.name || ''), why: 'followup', about: String(derived.about || '') };
    }

    const peopleList = Object.values(db?.people || {});
    const gap = Number(o.perPersonGapDays) * 24 * 3600 * 1000;
    const pool = peopleList
      .filter((p) => p && p.qq && !p.owner)
      .filter((p) => String(p.qq) !== String(o.ownerQq || ''))
      .filter((p) => live(p.qq))
      .filter((p) => !customIsNotFriend({ stateDir, qq: p.qq }))
      .filter((p) => Number(p.familiarity?.score || 0) >= 20)
      .filter((p) => now - Number(data.people[String(p.qq)]?.at || 0) >= gap)
      .filter((p) => now - Number(p.familiarity?.lastAt || 0) >= gap)
      .sort((a, b) => Number(b.familiarity?.score || 0) - Number(a.familiarity?.score || 0));
    const hit = pool[0];
    if (!hit) return null;
    return { qq: String(hit.qq), name: String(hit.name || ''), why: 'opportunity', about: '' };
  } catch {
    return null;
  }
}

/** 记一次「自己找人」：今天的次数 + 这个人多久没被找过 + 约定标记已用。 */
export function customOutreachRecord({ stateDir, qq, followupId, now = Date.now() } = {}) {
  try {
    const data = normalizeDay(loadOutreach(stateDir));
    data.n = Number(data.n || 0) + 1;
    data.lastAt = now;
    if (qq) data.people[String(qq)] = { ...(data.people[String(qq)] || {}), at: now };
    if (followupId) data.followups = data.followups.filter((f) => String(f.id) !== String(followupId));
    saveOutreach(stateDir, data);
  } catch { /* ignore */ }
}

/**
 * 唤醒提示词里那一节（reason === 'outreach' 时才有）。
 * 写得像她自己的念头，不像任务清单——这条最容易露馅。
 */
export function customOutreachLine({ stateDir, key, reason } = {}) {
  try {
    if (String(reason) !== 'outreach') return '';
    const k = String(key || '');
    if (!k.startsWith('private:')) return '';
    const qq = k.slice('private:'.length);
    const db = loadPeople(stateDir);
    const p = db?.people?.[qq];
    if (!p) return '';
    const due = customFollowupsDue({ stateDir }).find((f) => String(f.qq) === qq);
    const name = String(p.name || qq);
    const head = `【你自己找的他】没人叫你 是你自己想找 ${name} 说句话。`;
    const body = due
      ? `上次他说过「${String(due.about).slice(0, 30)}」 你现在想起来问一句。`
      : '没什么正事 就是想问问他最近怎么样。';
    return `\n${head}${body}\n一句话就够 别解释你为什么来 别说「我主动来找你」 他不回就算了 不要连发 也不要追问。\n`;
  } catch {
    return '';
  }
}

/**
 * 从别人发来的话里认出「以后要做的事」——用来排一次约定跟进。
 * 宁可漏，不可错：只有出现明确的时间词才算。
 */
const TIME_WORDS = [
  { re: /明天|明儿|次日/, offsetH: 20, label: '明天' },
  { re: /后天/, offsetH: 44, label: '后天' },
  { re: /今晚|晚上|夜里/, offsetH: 5, label: '今晚' },
  { re: /下午/, offsetH: 6, label: '下午' },
  { re: /早上|明早/, offsetH: 14, label: '早上' },
  { re: /考完|考试|出成绩/, offsetH: 20, label: '考完' },
  { re: /下班|放学/, offsetH: 8, label: '下班' },
  { re: /吃完|吃完饭|夜宵/, offsetH: 4, label: '吃完' },
  { re: /睡醒|起床/, offsetH: 10, label: '睡醒' },
  { re: /回头|待会儿|一会儿|晚点/, offsetH: 6, label: '回头' }
];

/**
 * 从已有的私聊窗口里反推「该问一句的人」——不额外存状态，直接看最近收到的消息。
 *
 * 为什么这么绕：真正要跟进的事（「我明天考试」「晚上去吃夜宵」）就写在消息里，
 * 与其在收消息时插钩子，不如到点的时候回头翻一遍——少一处补丁，也不会因为升级丢数据。
 */
export function customDeriveFollowup({ conversations, now = Date.now(), minAgeMs = 20 * 60 * 60 * 1000 } = {}) {
  try {
    if (!conversations?.get) return null;
    const best = [];
    for (const [key, conv] of conversations) {
      if (!String(key).startsWith('private:')) continue;
      const qq = String(key).slice('private:'.length);
      const recent = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const m = recent[i];
        if (!m || m.isSelf) continue;
        const at = Number(m.at || m.time || 0);
        if (!at || now - at < minAgeMs) break;       // 只看足够旧的；再往前就是更旧的了
        const guess = customGuessFollowup({ text: String(m.text ?? m.content ?? ''), now: at });
        if (!guess) continue;
        if (Number(guess.dueAt) > now) continue;      // 还没到点
        if (now - Number(guess.dueAt) > DEFAULTS.followupMaxAgeMs) break;
        best.push({ qq, about: guess.about, dueAt: Number(guess.dueAt), at });
        break;
      }
    }
    if (!best.length) return null;
    best.sort((a, b) => b.at - a.at);
    return best[0];
  } catch {
    return null;
  }
}

export function customGuessFollowup({ text, now = Date.now() } = {}) {
  try {
    const t = String(text || '');
    if (t.trim().length < 4) return null;
    const hit = TIME_WORDS.find((w) => w.re.test(t));
    if (!hit) return null;
    // 话题：去掉时间词后剩下的那一截，够长才记，免得记一堆「明天」这种空话
    const about = t.replace(hit.re, '').replace(/[，。！？、,.!?\s]+/g, ' ').trim().slice(0, 40);
    if (about.replace(/\s/g, '').length < 3) return null;
    return { about, dueAt: now + hit.offsetH * 3600 * 1000, label: hit.label };
  } catch {
    return null;
  }
}
/**
 * 本地功能模块的统一入口（bridge.js 只从这里拿东西，每处一行钩子）。
 *
 * 为什么要这么切：SurfCore 自动更新会整目录换 zip，任何写进 bridge.js 的逻辑都会丢。
 * 所以逻辑全放 src/custom/*，bridge.js 里只留「一行调用」+ `[LOCAL-HOOK xxx]` 标记，
 * 升级后用 `_custom\surfcore-patches\reapply.bat` 十分钟贴回来。
 */
import { loadPeople, noteIncoming, rosterOf, impressionsOf, findMentioned } from './people.js';
import { customOutreachLine, customIsNotFriend } from './outreach.js';
export {
  customOutreachGate,
  customPickOutreachTarget,
  customOutreachRecord,
  customMarkNotFriend,
  customGuessFollowup,
  customFollowupAdd,
  customOutreachLine
} from './outreach.js';

const FAMILY_LABEL = (score) => (score >= 90 ? '很熟' : score >= 60 ? '熟' : score >= 30 ? '有印象' : '刚认识');

function keyParts(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  if (i < 0) return { kind: '', id: '' };
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

/** 入站钩子：记名字/别名/群/熟悉度。永不抛错、永不阻塞收消息。 */
export function customNoteIncoming({ stateDir, qq, name, groupId, isOwner }) {
  if (!stateDir) return;
  noteIncoming(stateDir, { qq, name, groupId, isOwner: Boolean(isOwner) });
}

/**
 * 每轮提示词追加块：
 *  - 私聊：认识谁（名字 + QQ + 熟悉度），主人排第一
 *  - 群聊：这个群里都有谁 + 对她的印象
 *  - 统一：说话规范（一条一句、不带逗号连句、情绪别压平）
 */
export function customWakeExtra({ stateDir, key, st, selfId, ownerQq, conversations, rhythm, farewellLine, memoryCardText, reason } = {}) {
  const lines = [];
  if (farewellLine) lines.push(`${farewellLine}\n`);
  try {
    if (!stateDir) return '';
    const db = loadPeople(stateDir);
    const exclude = [selfId, ownerQq].map((x) => String(x ?? '')).filter(Boolean);
    const { kind, id } = keyParts(key);

    if (kind === 'private') {
      const rows = rosterOf(db, { limit: 8, exclude });
      if (rows.length) {
        const body = rows.map((p) => `- ${p.name}（QQ ${p.qq} · ${FAMILY_LABEL(Number(p.familiarity?.score || 0))}${p.owner ? ' · 你主人' : ''}）`);
        lines.push(`【你认识的人】\n${body.join('\n')}\n`);
      }
    } else if (kind === 'group' && id) {
      const db2 = loadPeople(stateDir);
      const inGroup = Object.values(db2.people || {})
        .filter((p) => p && p.qq && !exclude.includes(String(p.qq)) && p.name && Array.isArray(p.groups) && p.groups.includes(String(id)))
        .sort((a, b) => Number(b.familiarity?.score || 0) - Number(a.familiarity?.score || 0))
        .slice(0, 6);
      if (inGroup.length) {
        const body = inGroup.map((p) => `- ${p.name}（${FAMILY_LABEL(Number(p.familiarity?.score || 0))}${p.owner ? ' · 你主人' : ''}）`);
        lines.push(`【这个群里的人】\n${body.join('\n')}\n`);
      }
      const withImp = impressionsOf(db, { groupId: id, limit: 4 }).filter((p) => Array.isArray(p.impressions) && p.impressions.length);
      if (withImp.length) {
        const body = withImp.map((p) => {
          const last = String(p.impressions[p.impressions.length - 1]?.text || p.impressions[p.impressions.length - 1] || '').slice(0, 40);
          return `- ${p.name}: ${last}`;
        });
        lines.push(`【对群友的印象】\n${body.join('\n')}\n`);
      }
    }

    // 作息：短醒/睡眠时告诉她「你现在只是一小会儿」，避免她把整段旧账当刚发生
    const sleep = customSleepState({ rhythm });
    if (sleep.phase === 'nap') {
      lines.push('【作息】你只是醒了一小会儿 一会儿还要接着睡 只看刚到的消息 别展开长聊 困了就接着睡\n');
    } else if (sleep.phase === 'sleep') {
      lines.push('【作息】这会儿本不该醒 是被直接叫起来的 只回这一件事 说完继续睡\n');
    }

    // 跨窗口：她刚在别的会话里说过/看到过什么（只给摘要，不给原话；别人的私聊不互相串）
    const cross = crossWindowRows({ key, conversations, windowMs: rhythm?.crossWindowMs, ownerQq, memoryCardText, ownerSeesOtherPrivate: rhythm?.crossContext?.ownerSeesOtherPrivate === true });
    if (cross.length) lines.push(`【你刚在别处】\n${cross.join('\n')}\n`);

    // 自己找人：这次唤醒就是她想找对方（一天最多两次，见 outreach.js）
    const outreach = customOutreachLine({ stateDir, key, reason });
    if (outreach) lines.push(outreach);

    lines.push('【怎么说】一条一句 不出现逗号顿号 每条 8 到 18 字 默认一条 情绪起来最多三条。群里叫到谁就写出他的名字 系统会自动 @ 到人 不用写 QQ 号。\n');
  } catch { return lines.length ? `${lines.join('\n')}\n` : ''; }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/**
 * 一条消息里塞了两三句话时拆成多条（原地改数组，调用方不用改）。
 *
 * 规则来自用户 2026-10-31 的要求：没有逗号连着的两句话**必须**分开；逗号偶尔可以有，
 * 但不许拿空格/逗号把两句话连在一条里。所以切点只有两种：中文之间的空格、句末标点后。
 * 含链接的不拆（链接拆断就废了）；碎片（<2 字或纯标点）并回前一条；最多 3 条。
 */
export function splitSentences(text, { max = 3 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  if (/https?:\/\//i.test(raw)) return [raw];
  let parts = [raw];
  // 1) 句末标点后切（。！？!?…；不用逗号）
  parts = parts.flatMap((s) => s.split(/(?<=[。！？!?…])\s*/u)).map((s) => s.trim()).filter(Boolean);
  // 2) 中文之间的空格切（"我说了 你别管"），但不切数字/英文内部的空格
  parts = parts.flatMap((s) => s.split(/(?<=[\u4e00-\u9fa5，。！？、…）】」』])\s+(?=[\u4e00-\u9fa5“「『（【])/u)).map((s) => s.trim()).filter(Boolean);
  // 3) 太碎的并回前一条
  const merged = [];
  for (const p of parts) {
    const bare = p.replace(/[\s，。！？!?…、~～]/gu, '');
    if (merged.length && (bare.length < 2 || !bare)) merged[merged.length - 1] += (p.startsWith('，') ? '' : ' ') + p;
    else if (bare.length >= 2) merged.push(p);
    else if (merged.length) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  return merged.slice(0, Math.max(1, max));
}

/** 原地拆条：把 messages 数组里过长的单条换成多条（顺序不变）。 */
export function customSplitMessages(messages, { max = 3 } = {}) {
  try {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const out = [];
    for (const m of messages) {
      const parts = splitSentences(m, { max });
      if (parts.length > 1) out.push(...parts);
      else out.push(m);
      if (out.length >= max) break;
    }
    if (out.length && out.length <= max) {
      messages.length = 0;
      messages.push(...out);
    }
    return messages;
  } catch { return messages; }
}

/**
 * 跨会话放行：主人私聊拿到的令牌，允许往**白名单群**发消息。
 *
 * 为什么需要：令牌是按会话绑定的，私聊的令牌对 `group:xxx` 一律不匹配，
 * 于是「你帮我去群里喊个人」这类传话永远 403，她还以为是自己不会用。
 * 只放行群、只放行白名单里的群、只认主人私聊那一份令牌（别人私聊的令牌无效）。
 */
export function customRelayAllowed({ key, token, ownerQq, conversations, allowGroups, stateDir } = {}) {
  try {
    const k = String(key || '');
    const ownerKey = `private:${String(ownerQq ?? '')}`;
    const ownerSt = conversations?.get?.(ownerKey);
    const fromOwner = Boolean(ownerSt?.agentToken) && String(token ?? '') === String(ownerSt.agentToken);

    if (k.startsWith('group:')) {
      const gid = k.slice('group:'.length);
      const list = (Array.isArray(allowGroups) ? allowGroups : []).map((x) => String(x ?? '')).filter(Boolean);
      if (!list.includes(gid)) return false;
      return fromOwner;
    }

    // 私聊：她自己去找人说话（用户 2026-11-01 m09458 批准的「主动找人」）。
    // 只认「目标窗口已经存在」+「不是发不出去的那种」，其余一律不放。
    if (k.startsWith('private:')) {
      const qq = k.slice('private:'.length);
      if (qq === String(ownerQq ?? '')) return fromOwner;
      const target = conversations?.get?.(k);
      if (!target) return false;
      const anyValid = conversations && typeof conversations.values === 'function'
        ? [...conversations.values()].some((s2) => s2?.agentToken && String(s2.agentToken) === String(token ?? ''))
        : false;
      if (!anyValid) return false;
      if (stateDir && customIsNotFriend({ stateDir, qq })) return false;
      return true;
    }
    return false;
  } catch { return false; }
}

/**
 * 发送钩子：群里点到人名就自动 @。
 * 返回 { text, qq }；qq 为空表示不用 @。文本开头若是「@名字」或「名字」，剪掉避免重复。
 */
export function customAutoAt({ stateDir, kind, id, text, selfId, ownerQq } = {}) {
  const raw = String(text ?? '');
  try {
    if (!stateDir || kind !== 'group' || !raw.trim()) return { text: raw, qq: '' };
    const db = loadPeople(stateDir);
    const hit = findMentioned(db, id, raw, { exclude: [selfId, ownerQq].map((x) => String(x ?? '')).filter(Boolean) });
    if (!hit) return { text: raw, qq: '' };
    let out = raw;
    const head = raw.trimStart();
    const strip = (t) => {
      if (head.startsWith(`@${t}`)) return head.slice(t.length + 1).trimStart();
      if (head.startsWith(t)) return head.slice(t.length).replace(/^[，,、:：\s]+/, '').trimStart();
      return null;
    };
    const stripped = strip(hit.term);
    if (stripped !== null && stripped.length >= 2) out = stripped;
    return { text: out, qq: hit.qq };
  } catch {
    return { text: raw, qq: '' };
  }
}

/* ─────────────────────────────  作息（真睡 + 短醒）  ───────────────────────────── */

const DEFAULT_RHYTHM = {
  enabled: true,
  weekdaysOnly: true,
  quietWindows: [[9, 12], [14, 18]],
  sleepMode: true,
  napEveryMin: 90,
  napDurationMin: 10
};

/**
 * 现在是什么状态：awake / nap / sleep。
 *
 * 上游没有这个概念（它只有「回复延迟 5–40 分钟」，模型照样跑一轮烧 token），
 * 所以真睡必须自己算：工作时间段内，每 napEveryMin 分钟醒 napDurationMin 分钟，其余是睡。
 */
export function customSleepState({ now = Date.now(), rhythm } = {}) {
  try {
    const r = { ...DEFAULT_RHYTHM, ...(rhythm || {}) };
    if (r.enabled === false || r.sleepMode === false) return { phase: 'awake' };
    const d = new Date(now);
    if (r.weekdaysOnly !== false) {
      const day = d.getDay();
      if (day === 0 || day === 6) return { phase: 'awake' };
    }
    const minutes = d.getHours() * 60 + d.getMinutes();
    const windows = Array.isArray(r.quietWindows) ? r.quietWindows : DEFAULT_RHYTHM.quietWindows;
    const win = windows.find((w) => Array.isArray(w) && minutes >= Number(w[0]) * 60 && minutes < Number(w[1]) * 60);
    if (!win) return { phase: 'awake' };
    const every = Math.max(10, Number(r.napEveryMin) || DEFAULT_RHYTHM.napEveryMin);
    const dur = Math.max(1, Math.min(every - 1, Number(r.napDurationMin) || DEFAULT_RHYTHM.napDurationMin));
    // 精确到秒算，别让「还有 40 秒就短醒」被四舍五入成还有一整分钟
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    const rest = (secs - Number(win[0]) * 3600) % (every * 60);
    if (rest < dur * 60) return { phase: 'nap', napEndsInMs: Math.round((dur * 60 - rest) * 1000) };
    return { phase: 'sleep', napInMs: Math.round((every * 60 - rest) * 1000) };
  } catch {
    return { phase: 'awake' };
  }
}

function unreadMentionsSelf(st, selfName, selfId) {
  const name = String(selfName ?? '').trim();
  const id = String(selfId ?? '').trim();
  const unread = Array.isArray(st?.unread) ? st.unread : [];
  return unread.some((m) => {
    const t = String(m?.text ?? m?.content ?? '');
    if (!t) return false;
    if (id && (t.includes(`@${id}`) || t.includes(id))) return true;
    if (name && (t.includes(`@${name}`) || t.includes(`[引用 ${name}`) || t.includes(`「${name}」`) || t.includes(name))) return true;
    return false;
  });
}

/**
 * 唤醒闸：睡着的时段别叫醒她（省 token 的大头在这里，不是提示词长度）。
 *
 * 规则（用户 2026-10-31 m04720 / m05061 定的）：
 *  - 深睡：只有**主人私聊**能直接叫醒；别人的私聊、所有群都等短醒。
 *  - 短醒：私聊照常；群里只在有人 @ / 叫名字时才看（且只看那一小段）。
 *  - 清醒：全放行。
 */
export function customWakeGate({ key, st, rhythm, ownerQq, selfName, selfId, reason } = {}) {
  const sleep = customSleepState({ rhythm });
  if (sleep.phase === 'awake') return { allow: true, phase: 'awake' };
  const k = String(key || '');
  const isPrivate = k.startsWith('private:');
  const isOwnerPrivate = k === `private:${String(ownerQq ?? '')}`;

  if (sleep.phase === 'sleep') {
    if (isOwnerPrivate) return { allow: true, phase: 'sleep' };
    // 拒绝的时候把「下一次短醒还有多久」带出去：桥那边据此安排一次自发醒来（短醒不能只靠外部触发）
    return { allow: false, phase: 'sleep', why: isPrivate ? '别人私聊要等短醒' : '群里等短醒', napInMs: sleep.napInMs };
  }
  // nap：短醒是她自己醒的，可以主动翻群/自己接一句；只有「被动叫醒」时才要求有人点她
  if (isPrivate) return { allow: true, phase: 'nap' };
  if (['groupListen', 'proactiveCheck', 'timeout', 'replyCheck'].includes(String(reason))) return { allow: true, phase: 'nap' };
  if (unreadMentionsSelf(st, selfName, selfId)) return { allow: true, phase: 'nap' };
  return { allow: false, phase: 'nap', why: '短醒里没人点她' };
}

/* ─────────────────────────────  额度下机  ───────────────────────────── */

/** 今日额度消耗比例（取 QQ 与合计里最高的那一项）；没有限额时返回 null。 */
export function customBudgetRatio({ usage, limits } = {}) {
  try {
    const items = [
      ['QQ', usage?.qq?.cost, limits?.qq?.cny],
      ['合计', usage?.total?.cost, limits?.total?.cny]
    ];
    let best = null;
    for (const [label, used, limit] of items) {
      const u = Number(used);
      const l = Number(limit);
      if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) continue;
      const ratio = u / l;
      if (!best || ratio > best.ratio) best = { label, used: u, limit: l, ratio };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 额度闸：≥threshold 时，这个会话先完整说完这一轮，然后宣告下机并静默到明天。
 * 主人私聊永远放行（用户 2026-10-31 m05243 的硬要求）。
 */
export function customBudgetGate({ key, st, ratio, threshold = 0.95, ownerQq } = {}) {
  try {
    if (!ratio || !(ratio.ratio >= threshold)) return { allow: true, offline: false };
    const k = String(key || '');
    if (k === `private:${String(ownerQq ?? '')}`) return { allow: true, offline: false, owner: true };
    const day = new Date().toISOString().slice(0, 10);
    if (st && st.budgetOfflineDay === day) return { allow: false, offline: true, why: '已宣告下机' };
    if (st) st.budgetOfflineDay = day;
    return { allow: true, offline: false, farewell: true };
  } catch {
    return { allow: true, offline: false };
  }
}

/* ─────────────────────────────  群旁听  ───────────────────────────── */

/**
 * 要不要「自己翻一眼」这个群：清醒、有 ≥3 条没读、今天配额还没用完。
 * 上游的主动机会只在群安静 15 分钟后触发，活跃群永远等不到，所以单独给一条路。
 */
export function customGroupListenDue({ key, st, rhythm, options } = {}) {
  try {
    const o = { enabled: true, minMessages: 3, dailyMax: 6, ...(options || {}) };
    if (o.enabled === false) return false;
    if (!String(key || '').startsWith('group:')) return false;
    if (customSleepState({ rhythm }).phase !== 'awake') return false;
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    if (unread.length < (Number(o.minMessages) || 3)) return false;
    const day = new Date().toISOString().slice(0, 10);
    const rec = st?.customListen && st.customListen.day === day ? st.customListen : { day, n: 0 };
    if (rec.n >= (Number(o.dailyMax) || 6)) return false;
    st.customListen = { day, n: rec.n + 1 };
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────────  跨窗口（她刚在别处）  ───────────────────────────── */

const L2_DEFAULT_MS = 3 * 60 * 60 * 1000;

/**
 * 别的会话最近在聊什么（只给摘要，不给原话）。
 *
 * 隐私线（用户 2026-10-31 m07876 定的矩阵）：除了「我的私聊 → 别人私聊」是 L1，
 * 其余都是 L2。所以这里做三件事：
 *  1. 别人的私聊内容**只出现在那个人自己的私聊窗口里**，不进群、不进别人的窗口；
 *  2. 主人私聊的内容**只给主人**，不进群、不进别人的私聊；
 *  3. 群消息可以进任何窗口（本来就是公共信息）。
 */
export function crossWindowRows({ key, conversations, windowMs, maxRows = 3, ownerQq, memoryCardText = '', ownerSeesOtherPrivate = false } = {}) {
  const rows = [];
  try {
    if (!conversations?.get) return rows;
    const now = Date.now();
    // 窗口跨到记忆卡那一侧就停：记忆卡已经写进去的内容不再重复说一遍（省 token，也避免复读）
    const span = Math.min(Number(windowMs) > 0 ? Number(windowMs) : L2_DEFAULT_MS, 24 * 3600 * 1000);
    const memory = String(memoryCardText || '').replace(/\s+/gu, ' ');
    const inMemory = (text) => {
      const t = String(text || '').replace(/\s+/gu, ' ').trim();
      if (!memory || t.length < 6) return false;
      return memory.includes(t.slice(0, Math.min(12, t.length)));
    };
    const self = String(key || '');
    const selfIsPrivate = self.startsWith('private:');
    const selfIsOwner = Boolean(ownerQq) && self === `private:${String(ownerQq)}`;
    let budget = 420; // 总字数上限：跨窗口只是「提醒她刚在别处说过什么」，不该抢正文的位置

    for (const [otherKey, other] of conversations) {
      if (!other || otherKey === self) continue;
      const isPrivate = String(otherKey).startsWith('private:');
      // 隐私线（默认最严）：别人的私聊内容只出现在那个人自己的窗口里 —— 不进群、
      // 不进别人的私聊，也**不进主人窗口**（主人要总览得自己去看「和 ZepaRr」那个会话）。
      // 想放宽就把 socialV2.crossContext.ownerSeesOtherPrivate 设成 true。
      if (isPrivate) {
        if (!(selfIsPrivate && selfIsOwner && ownerSeesOtherPrivate === true)) continue;
        if (Boolean(ownerQq) && otherKey === `private:${String(ownerQq)}`) continue;
      }

      const recent = Array.isArray(other.recentMessages) ? other.recentMessages : [];
      const picks = [...recent]
        .reverse()
        .filter((m) => Number(m?.at || m?.time || 0) >= now - span)
        .filter((m) => !inMemory(String(m?.text ?? m?.content ?? '')))
        .slice(0, 2);
      if (!picks.length) continue;
      for (const m of picks) {
        const at = Number(m.at || m.time || 0);
        const hhmm = `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`;
        const who = isPrivate ? `和 ${String(m.senderName ?? m.name ?? String(otherKey).replace('private:', '')).slice(0, 8)}` : `群 ${String(otherKey).slice(6)}`;
        const text = String(m.text ?? m.content ?? '').replace(/\s+/gu, ' ').slice(0, 26);
        if (!text) continue;
        const line = `- ${hhmm} ${who}：${text}`;
        if (line.length > budget) continue;
        budget -= line.length;
        rows.push({ at, line });
      }
    }
    rows.sort((a, b) => b.at - a.at);
    return rows.slice(0, maxRows).map((r) => r.line);
  } catch {
    return [];
  }
}
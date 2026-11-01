window.__ModuleLoader__.load({
  id: 'dsh-surfcore-patches',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const API = '/dsh-surfcore-patches';

    const api = async (path, body) => {
      const res = await fetch(`${API}/${path}`, body === undefined
        ? { cache: 'no-store', headers: { 'x-surfcore-patches': '1' } }
        : {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-surfcore-patches': '1' },
          body: JSON.stringify(body),
        });
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`请求 ${path} 失败（${res.status}）`);
      }
      if (!data || data.ok !== true) throw new Error(data?.error || `请求 ${path} 失败`);
      return data;
    };

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    };

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 24px', color: C.text, fontSize: 13 },
      card: { border: `1px solid ${C.border}`, borderRadius: 10, background: C.layer, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      sub: { margin: 0, color: C.muted, fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, wordBreak: 'break-all', color: C.muted },
      badge: (kind) => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: `1px solid ${kind === 'ok' ? C.ok : kind === 'warn' ? C.brand : C.error}`,
        color: kind === 'ok' ? C.ok : kind === 'warn' ? C.brand : C.error,
      }),
      button: (primary, disabled) => ({
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 7,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        border: `1px solid ${primary ? C.brand : C.border}`,
        background: primary ? C.brand : 'transparent',
        color: primary ? '#fff' : C.text,
      }),
      error: { margin: 0, color: C.error, fontSize: 12 },
    };

    function Item({ item }) {
      const kind = item.status === 'pending' ? 'warn' : 'error';
      return h('div', { style: S.row },
        h('span', { style: S.badge(kind) }, item.status === 'pending' ? '待贴' : '异常'),
        h('span', null, item.id),
        item.reason ? h('span', { style: S.sub }, item.reason) : null);
    }

    function Target({ target, onAction, busy }) {
      const { counts } = target;
      const missing = !target.installed;
      const kind = missing ? 'error' : counts.bad ? 'error' : counts.pending ? 'warn' : 'ok';
      const label = missing ? '未找到' : counts.bad ? `${counts.bad} 处异常` : counts.pending ? `待贴 ${counts.pending}` : '全部已贴';
      const applyLabel = busy ? '处理中…' : counts.pending > 0 ? `应用补丁（${counts.pending}）` : '应用补丁';
      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('h3', { style: S.title }, target.title),
          h('span', { style: S.badge(kind) }, label),
          target.version ? h('span', { style: S.mono }, `v${target.version}`) : null,
          target.installed && !target.known ? h('span', { style: S.badge('warn') }, '版本未适配') : null),
        h('div', { style: S.mono }, target.root || '（未配置安装目录）'),
        h('div', { style: S.sub }, missing
          ? '这个程序没找到。装好之后点「体检」重新读一次。'
          : `共 ${counts.applied + counts.pending + counts.bad} 条：已贴 ${counts.applied} · 待贴 ${counts.pending} · 异常 ${counts.bad}`),
        target.items.length ? h('div', { style: S.card }, target.items.slice(0, 12).map((item) => h(Item, { key: item.id, item }))) : null,
        h('div', { style: S.row },
          h('button', { style: S.button(false, busy), disabled: busy, onClick: () => onAction('check', target.id) }, '体检'),
          h('button', { style: S.button(true, busy || missing), disabled: busy || missing, onClick: () => onAction('apply', target.id) }, applyLabel),
          h('button', { style: S.button(false, busy || missing), disabled: busy || missing, onClick: () => onAction('revert', target.id) }, '回滚')));
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [notice, setNotice] = useState('');

      const load = useCallback(async () => {
        try {
          const data = await api('state');
          setState(data);
          setMessage('');
        } catch (error) {
          setMessage(String(error.message ?? error));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const onAction = useCallback(async (action, target) => {
        setBusy(true);
        setMessage('');
        setNotice('');
        try {
          const data = await api(action, { target });
          const word = action === 'apply' ? '应用' : action === 'revert' ? '回滚' : '体检';
          const failed = (data.results ?? []).filter((r) => r && r.ok !== true);
          if (failed.length) {
            setMessage(failed.map((r) => `${r.code}: ${r.error}`).join('；'));
          } else {
            const touched = (data.results ?? []).reduce((n, r) => n + (Array.isArray(r.applied) ? r.applied.length : 0), 0);
            setNotice(action === 'apply' && touched === 0
              ? `${word}完成：没有需要改的地方（已经全部贴好）。`
              : `${word}完成，结果见下方卡片。`);
          }
          await load();
        } catch (error) {
          setMessage(String(error.message ?? error));
        } finally {
          setBusy(false);
        }
      }, [load]);

      if (!state) {
        return h('div', { style: S.page },
          h('p', { style: S.sub }, '正在读取补丁状态…'),
          message ? h('p', { style: S.error }, message) : null);
      }

      return h('div', { style: S.page },
        h('div', null,
          h('h2', { style: S.title }, '补丁管家'),
          h('p', { style: S.sub }, '给 SurfCore / 刷B站 这类「独立进程型」程序打锚点补丁。默认只体检；点「应用补丁」才会改文件（改前自动备份，可回滚）。')),
        message ? h('p', { style: S.error }, message) : null,
        notice ? h('p', { style: S.sub }, notice) : null,
        (state.targets ?? []).map((target) => h(Target, { key: target.id, target, onAction, busy })),
        h('p', { style: S.sub }, `状态目录：${state.stateDir}`),
        h('p', { style: S.sub }, '命令行等价物：node bin/cli.mjs check|apply|revert|doctor --target <id> --root <目录>'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots ?? ctx.get?.('slots');
        if (!slots?.register) return;
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'surfcore-patches',
          order: 45,
          label: '补丁管家',
        }, () => h(Panel)));
      },
    };
  },
});
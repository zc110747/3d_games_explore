/* ==========================================================================
 * 三国霸业 · 本地前后端桥接
 * --------------------------------------------------------------------------
 * 这个文件不触碰 sgby.min.js。它只做两件事：
 *   1) 在页面右上角状态栏挂一个「云存档」按钮（**仅网页版**；PC 版没有云存档）
 *   2) 把游戏原有的 localStorage 存档（键 sgby.sango<N>.sav）搬到本地 Node 后端
 *   3) 往游戏内「菜单」面板里插一节「天意赏赐」（网页版 / PC 版都有）
 *      两个按钮：天意经济（主公城 +2000 金 / +2000 粮）、天意招募（+3000 兵）
 *
 * PC 版（windows 产物）会先设 window.__SGBY_PC__=1，此时跳过云存档的
 * 面板与按钮，只保留「天意赏赐」的挂载。
 *
 * 存档键规则（与 sgby.min.js 内 jn() 一致）：
 *   前缀 = 'sgby.sango'，若 URL 带 ?save=xxx 则为 'sgby.sango.xxx'
 *   槽位 0..2，每槽两片： sgby.sango{2*slot}.sav 与 sgby.sango{2*slot+1}.sav
 * ========================================================================== */
(function () {
  'use strict';

  const IS_PC = window.__SGBY_PC__ === 1;
  const SLOTS = [0, 1, 2];
  const API_BASE = location.origin && location.origin !== 'null' ? location.origin : '';

  const PREFIX = (function () {
    try {
      const p = new URLSearchParams(location.search).get('save');
      const s = String(p == null ? '' : p).replace(/[^\w-]/g, '');
      return s ? `sgby.sango.${s}` : 'sgby.sango';
    } catch (e) {
      return 'sgby.sango';
    }
  })();

  const keysOf = (slot) => [`${PREFIX}${slot * 2}.sav`, `${PREFIX}${slot * 2 + 1}.sav`];

  // ------------------------------------------------------------------ 工具
  const $ = (sel, root) => (root || document).querySelector(sel);

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 读取本地某槽：两片都在才算完整存档 */
  function readLocal(slot) {
    const parts = {};
    let bytes = 0;
    for (const k of keysOf(slot)) {
      const v = localStorage.getItem(k);
      if (typeof v === 'string') {
        parts[k] = v;
        bytes += v.length;
      }
    }
    const keys = Object.keys(parts);
    return { parts, bytes, complete: keys.length === 2, any: keys.length > 0 };
  }

  async function api(path, opts) {
    if (!API_BASE) throw new Error('当前不是通过本地服务打开的（请用 http://localhost 访问）');
    const res = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* 非 JSON 响应 */
    }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  }

  // ------------------------------------------------------------------ UI
  const state = { online: false, remote: {}, msg: '', busy: false };

  function setMsg(text, kind) {
    state.msg = text;
    const el = $('[data-lb-msg]');
    if (!el) return;
    el.textContent = text || '';
    el.className = `wm-msg${kind ? ' ' + kind : ''}`;
  }

  function buildPanel() {
    const overlay = document.createElement('div');
    overlay.className = 'wm-overlay';
    overlay.id = 'lb-overlay';
    overlay.innerHTML = `
      <div class="wm-panel">
        <div class="wm-head">
          <span class="wm-title">云存档同步</span>
          <button class="wm-close" data-lb-close aria-label="关闭">×</button>
        </div>
        <div class="wm-body">
          <div class="wm-sec">
            <div class="wm-sec-title">后端状态</div>
            <div class="wm-row">
              <span class="lb-dot" data-lb-dot></span>
              <span class="wm-value" data-lb-status>检测中…</span>
            </div>
          </div>
          <div class="wm-sec">
            <div class="wm-sec-title">存档槽（本地 ↔ 本地服务端）</div>
            <div class="wm-slots" data-lb-slots></div>
          </div>
          <div class="wm-msg" data-lb-msg></div>
          <div class="wm-hint">
            上传：把浏览器本地存档写入服务端（data/saves/），换浏览器/换机器也能取回。<br>
            下载：用服务端存档覆盖本地，需刷新页面才生效。<br>
            本地存档键：${PREFIX}0.sav … ${PREFIX}5.sav
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const style = document.createElement('style');
    style.textContent = `
      .lb-dot { width: 8px; height: 8px; border-radius: 50%; background: #6f7885; flex: none; }
      .lb-dot.on { background: #63c26a; box-shadow: 0 0 6px rgba(99,194,106,.7); }
      .lb-dot.off { background: #c26a6a; }
      #lb-overlay { z-index: 120; }
      .wm-slot-acts { flex-wrap: wrap; }
      /* 本地/服务器状态文案可能较长，独占一行、允许换行，避免被省略号截断 */
      #lb-overlay .wm-slot { flex-wrap: wrap; }
      #lb-overlay .wm-slot-info {
        flex-basis: 100%; order: 3;
        white-space: normal; overflow: visible; text-overflow: clip;
        line-height: 1.5; color: #aeb6c2; font-size: 12px;
      }
      .lb-flash { color: #e6e9ee; }
    `;
    document.head.appendChild(style);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-lb-close]')) overlay.classList.remove('open');
    });
  }

  function renderSlots() {
    const wrap = $('[data-lb-slots]');
    if (!wrap) return;
    wrap.innerHTML = SLOTS.map((slot) => {
      const loc = readLocal(slot);
      const rem = state.remote[slot] || null;
      const locText = loc.complete
        ? `本地 ${fmtBytes(loc.bytes)}`
        : loc.any
          ? `本地不完整 ${fmtBytes(loc.bytes)}`
          : '本地空档';
      const remText = rem ? `服务器 ${fmtTime(rem.savedAt)} · ${fmtBytes(rem.bytes)}` : '服务器无档';
      const dis = state.busy ? ' disabled' : '';
      return `<div class="wm-slot">
        <span class="wm-slot-name">${slot + 1} 号档</span>
        <span class="wm-slot-info" title="${locText} / ${remText}">${locText} · ${remText}</span>
        <span class="wm-slot-acts">
          <button class="wm-btn small" data-act="up" data-slot="${slot}"${loc.any ? dis : ' disabled'}>上传</button>
          <button class="wm-btn small" data-act="down" data-slot="${slot}"${rem && state.online ? dis : ' disabled'}>下载</button>
          <button class="wm-btn small" data-act="del" data-slot="${slot}"${rem && state.online ? dis : ' disabled'}>删云端</button>
        </span>
      </div>`;
    }).join('');
  }

  function renderStatus() {
    const dot = $('[data-lb-dot]');
    const txt = $('[data-lb-status]');
    if (!dot || !txt) return;
    dot.className = `lb-dot ${state.online ? 'on' : state.busy ? '' : 'off'}`;
    txt.textContent = state.online
      ? `已连接 · ${state.info ? state.info.name + ' v' + state.info.version : '本地服务端'}`
      : state.busy
        ? '连接中…'
        : '未连接（请用 start.bat 启动本地服务）';
  }

  async function refresh() {
    state.busy = true;
    renderStatus();
    try {
      const [health, saves] = await Promise.all([api('/api/health'), api('/api/saves')]);
      state.info = health;
      state.online = true;
      state.remote = {};
      for (const s of (saves && saves.saves) || []) state.remote[s.slot] = s;
    } catch (e) {
      state.online = false;
      state.remote = {};
    } finally {
      state.busy = false;
      renderStatus();
      renderSlots();
    }
  }

  async function doAction(act, slot) {
    if (state.busy) return;
    state.busy = true;
    renderSlots();
    try {
      if (act === 'up') {
        const loc = readLocal(slot);
        if (!loc.any) throw new Error('本地这个槽是空的');
        const r = await api(`/api/saves/${slot}`, {
          method: 'PUT',
          body: JSON.stringify({ parts: loc.parts, note: `本地浏览器上传 ${new Date().toLocaleString('zh-CN')}` }),
        });
        setMsg(`已上传 ${slot + 1} 号档（${fmtBytes(r.bytes)}）`, 'ok');
      } else if (act === 'down') {
        const rec = await api(`/api/saves/${slot}`);
        if (!rec || !rec.parts) throw new Error('服务端没有这个存档');
        for (const k of keysOf(slot)) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(rec.parts)) localStorage.setItem(k, v);
        setMsg(`${slot + 1} 号档已写入本地（${fmtTime(rec.savedAt)}），请刷新页面后进游戏读取`, 'ok');
      } else if (act === 'del') {
        if (!confirm(`确定删除服务器上第 ${slot + 1} 号存档？本地存档不受影响。`)) {
          setMsg('已取消');
          state.busy = false;
          renderSlots();
          return;
        }
        await api(`/api/saves/${slot}`, { method: 'DELETE' });
        setMsg(`服务器 ${slot + 1} 号档已删除`, 'ok');
      }
    } catch (e) {
      setMsg(`失败：${e.message}`, 'err');
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  // ------------------------------------------------------ 菜单里的「天意赏赐」
  // 「菜单」（#menu-btn）弹出的 .wm-panel 由 sgby.min.js 构建，这里只往里插一节，
  // 不动它的代码。真正的发放逻辑在 sgby.min.js 的 /*SGBY-GRANT*/ 段（window.SGBY_GRANT），
  // 分两档：eco = 天意经济（金/粮），army = 天意招募（兵）。
  function grant(kind, hint) {
    const fn = window.SGBY_GRANT;
    if (typeof fn !== 'function') {
      hint.textContent = '不可用：游戏脚本还没加载，或当前版本没打「天意赏赐」补丁。';
      return;
    }
    let r;
    try {
      r = fn(kind);
    } catch (e) {
      hint.textContent = `失败：${e && e.message ? e.message : e}`;
      return;
    }
    if (!r || !r.ok) {
      hint.textContent = `失败：${(r && r.reason) || '未知原因'}`;
      return;
    }
    hint.textContent = kind === 'eco'
      ? `已发放到城市 #${r.city}：金钱 +${r.addMoney}（现有 ${r.Money}）、`
        + `粮食 +${r.addFood}（现有 ${r.Food}）。回到地图再进城即可看到最新数值。`
      : `已发放到城市 #${r.city}：后备兵 +${r.addArms}（现有 ${r.MothballArms}）。征兵时即可分配。`;
  }

  function mountGrant() {
    // 页面上有两个 .wm-panel：本文件的云存档面板（#lb-overlay 内，常驻隐藏）
    // 和游戏「菜单」面板。必须排除前者，否则会插进那个 0×0 的隐藏容器里。
    const pickBody = () => {
      const panels = [...document.querySelectorAll('.wm-panel')].filter(
        (el) => !el.closest('#lb-overlay') && !el.closest('#pc-modal'),
      );
      const opened = panels.find((el) => el.parentElement && el.parentElement.classList.contains('open'));
      const panel = opened || panels[0] || null;
      return panel ? panel.querySelector('.wm-body') : null;
    };

    const build = () => {
      const body = pickBody();
      if (!body) return false;
      if (body.querySelector('[data-sgby-grant]')) return true;

      const sec = document.createElement('section');
      sec.className = 'wm-sec';
      sec.dataset.sgbyGrant = '1';

      const title = document.createElement('div');
      title.className = 'wm-sec-title';
      title.textContent = '天意赏赐';
      sec.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'wm-hint';
      hint.textContent = '只作用于玩家主公所在的城池，其它城池不受影响。金钱与粮食封顶 3 万。';

      const acts = document.createElement('div');
      acts.className = 'wm-actions';

      const mk = (kind, label) => {
        const btn = document.createElement('button');
        btn.className = 'wm-btn primary';
        btn.dataset.grant = kind;
        btn.textContent = label;
        btn.addEventListener('click', () => grant(kind, hint));
        acts.appendChild(btn);
        return btn;
      };
      mk('eco', '天意经济　+2000 金 / +2000 粮');
      mk('army', '天意招募　+3000 兵');

      sec.appendChild(acts);
      sec.appendChild(hint);

      body.insertBefore(sec, body.firstChild);
      return true;
    };

    // 面板是首次点「菜单」时才建出来的，所以观察一次 DOM；建好插完就断开
    if (build()) return;
    const mo = new MutationObserver(() => {
      if (build()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.getElementById('menu-btn')?.addEventListener('click', () => setTimeout(build, 0));
  }

  function mount() {
    mountGrant();

    // PC 版：菜单栏里没有「云存档」入口，这里也就不再建面板和按钮
    if (IS_PC) return;

    buildPanel();

    const actions = $('#status-actions');
    if (actions) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn menu-btn';
      btn.id = 'lb-open';
      btn.textContent = '云存档';
      btn.addEventListener('click', () => {
        $('#lb-overlay').classList.add('open');
        refresh();
      });
      actions.insertBefore(btn, actions.firstChild);
    }

    $('#lb-overlay').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      doAction(b.dataset.act, Number(b.dataset.slot));
    });

    // 游戏存档变化后刷新显示
    setInterval(() => {
      const ov = $('#lb-overlay');
      if (ov && ov.classList.contains('open')) renderSlots();
    }, 2000);

    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

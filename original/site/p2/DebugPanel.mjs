/**
 * P2 地图调试面板（HTML/CSS，不做成 3D 模型）。
 * 所有数值均来自 GameAdapter / 渲染器诊断，不自行生成任何游戏数据。
 */
const $row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
const fmt = (v, digits = 3) => (v === null || v === undefined || Number.isNaN(v))
  ? '—' : (typeof v === 'number' ? v.toFixed(digits) : String(v));

export class DebugPanel {
  constructor({ root, callbacks = {} }) {
    if (!root) throw new TypeError('DebugPanel 需要挂载根节点');
    this.root = root;
    this.callbacks = callbacks;
    this.inspectId = 0;
    this.root.innerHTML = `
      <h2>战略地图 · 数据核对</h2>
      <div class="p2-row">
        <label for="p2-city-select">查看城市</label>
        <select id="p2-city-select" aria-label="查看城市"></select>
      </div>
      <dl id="p2-city-info" class="p1-kv"></dl>
      <h2>选中 / 原版联动</h2>
      <dl id="p2-selection-info" class="p1-kv"></dl>
      <div class="p2-row">
        <button type="button" class="p1-btn" id="p2-intent">原版联动：仅定位光标</button>
        <button type="button" class="p1-btn" id="p2-reset-cam">相机复位</button>
      </div>
      <div class="p2-row">
        <button type="button" class="p1-btn" id="p2-run-tests">P2 自检</button>
        <button type="button" class="p1-btn" id="p2-sync">地图全量同步</button>
      </div>
      <h2>场景与资源</h2>
      <dl id="p2-scene-info" class="p1-kv"></dl>
      <pre id="p2-log" class="p1-log"></pre>
    `;
    this.logs = [];
    this._bind();
  }

  _bind() {
    const c = this.callbacks;
    this.root.querySelector('#p2-city-select').addEventListener('change', (e) => {
      this.inspectId = Number(e.target.value);
      c.onInspect?.(this.inspectId);
      this.update(this._last);
    });
    this.root.querySelector('#p2-intent').addEventListener('click', () => c.onToggleIntent?.());
    this.root.querySelector('#p2-reset-cam').addEventListener('click', () => c.onResetCamera?.());
    this.root.querySelector('#p2-run-tests').addEventListener('click', () => c.onRunTests?.());
    this.root.querySelector('#p2-sync').addEventListener('click', () => c.onSync?.());
  }

  log(line) {
    this.logs.push(line);
    if (this.logs.length > 60) this.logs.shift();
    const el = this.root.querySelector('#p2-log');
    if (el) { el.textContent = this.logs.join('\n'); el.scrollTop = el.scrollHeight; }
  }

  fillCities(cities) {
    const sel = this.root.querySelector('#p2-city-select');
    if (!sel) return;
    sel.replaceChildren();
    for (const city of cities) {
      const opt = document.createElement('option');
      opt.value = String(city.id);
      opt.textContent = `#${city.id} ${city.name}`;
      sel.appendChild(opt);
    }
    if (cities.length) sel.value = String(this.inspectId);
  }

  update(s) {
    if (!s) return;
    this._last = s;
    const info = s.inspect || null;
    const selInfo = s.selection || null;
    const d = s.diagnostics || {};
    const rows = [];
    if (info) {
      rows.push($row('城市 ID / 名称', `#${info.id} ${info.name}`, 'ok'));
      rows.push($row('原版逻辑坐标', `(${info.logical.x}, ${info.logical.y})`));
      rows.push($row('Three.js 世界坐标', info.world
        ? `(${fmt(info.world.x)}, ${fmt(info.world.y)}, ${fmt(info.world.z)})` : '—'));
      rows.push($row('所属势力 ID', `${info.ownerId}（${info.faction?.kind || '—'}）`));
      rows.push($row('势力名 / 旗帜色', info.faction
        ? `${info.faction.name || '空城'} / #${info.faction.color.toString(16).padStart(6, '0')}` : '—'));
      rows.push($row('城市状态 (原版 Id)', String(info.state)));
      rows.push($row('原版连接数量', String(info.connectionCount)));
      rows.push($row('连接明细', info.connections.filter((c) => c.cityId !== null)
        .map((c) => `${c.dir}→#${c.cityId}(${c.distance})`).join(' ') || '无'));
    } else {
      rows.push($row('城市数据', '未就绪'));
    }
    this.root.querySelector('#p2-city-info').innerHTML = rows.join('');

    const srows = [];
    srows.push($row('当前选中城市', selInfo ? `#${selInfo.id} ${selInfo.name}` : '未选中',
      selInfo ? 'ok' : ''));
    if (selInfo) {
      srows.push($row('选中城世界坐标', selInfo.world
        ? `(${fmt(selInfo.world.x)}, ${fmt(selInfo.world.z)})` : '—'));
      srows.push($row('高亮的相邻路径', String(s.highlighted ?? 0)));
    }
    const req = selInfo?.lastRequest;
    srows.push($row('原版选城请求', req
      ? (req.injected ? `已投递 ${req.messageCount ?? 0} 条原版输入` : '未注入')
      : '无', req?.injected ? 'ok' : ''));
    if (req && !req.injected) srows.push($row('未注入原因', req.reason || req.phase?.reason || '—'));
    const oc = selInfo?.originalCursor;
    srows.push($row('原版光标结果 (只读)', oc
      ? (oc.error ? oc.error : `(${oc.setx},${oc.sety}) → 城 #${oc.cityId ?? '—'}`)
      : '尚未观测'));
    this.root.querySelector('#p2-selection-info').innerHTML = srows.join('');

    const cam = d.camera || {};
    const dr = [];
    dr.push($row('城市 / 唯一 ID', `${d.cities?.cityCount ?? '—'} / ${d.cities?.uniqueIds ?? '—'}`));
    dr.push($row('道路 / 有向记录', `${d.roads?.edges ?? '—'} / ${d.roads?.directedRecords ?? '—'}`));
    dr.push($row('旗帜 / 势力', `${d.flags?.flags ?? '—'} / ${d.flags?.factionCount ?? '—'}`));
    dr.push($row('地形来源', d.terrain?.degraded ? '降级占位（非原版）' : `原版图块 ${d.terrain?.frames} 帧`,
      d.terrain?.degraded ? 'bad' : 'ok'));
    dr.push($row('相机', cam.fixed45 ? '固定斜 45°（禁旋转）' : '未知', cam.fixed45 ? 'ok' : 'bad'));
    dr.push($row('缩放 / 注视点', `${fmt(cam.zoom, 2)} / [${(cam.target || []).map((v) => fmt(v, 1)).join(', ')}]`));
    dr.push($row('输入 点击/命中/拖动', `${s.input?.clicks ?? 0} / ${s.input?.cityHits ?? 0} / ${s.input?.drags ?? 0}`));
    dr.push($row('事件订阅数', String(d.subscriptions ?? 0)));
    this.root.querySelector('#p2-scene-info').innerHTML = dr.join('');

    const btn = this.root.querySelector('#p2-intent');
    if (btn) btn.textContent = s.intent === 'select'
      ? '原版联动：确认选城（会进入原版菜单）'
      : '原版联动：仅定位光标';
  }
}

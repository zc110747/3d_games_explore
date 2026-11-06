/**
 * P4 BattleHUD —— 战斗信息面板（HTML/CSS，不做成 3D 模型）。
 *
 * 只显示 GameAdapter 给出的真实字段：回合/天候/双方粮草/地图尺寸、
 * 选中部队（名称/兵种/势力/兵力/生命/技力/坐标/状态/是否可操作）、
 * 选中格（坐标/地形名/原版地形说明/是否在移动或攻击范围内）。
 *
 * 面板整体带 data-p1-ui-block，因此点击不会穿透到 3D 场景；
 * 但它不覆盖全屏（宽度固定、可折叠），地图区域仍可正常拾取。
 */
import { el } from '../p3/Dialogs.mjs';

export class BattleHUD {
  constructor({ host }) {
    this.host = host;
    this.dom = null;
    this.collapsed = false;
    this.logs = [];
    this.stats = { updates: 0, opens: 0 };
  }

  mount() {
    if (this.dom) return this;
    const root = el('div', 'p4-hud');
    root.id = 'p4-battle-hud';
    root.hidden = true;
    root.setAttribute('data-p1-ui-block', '');

    const head = el('header', 'p4-hud-head');
    const title = el('span', 'p4-hud-title', '战斗');
    const chip = el('span', 'p4-hud-chip', '—');
    const toggle = el('button', 'p4-hud-btn', '收起');
    toggle.type = 'button';
    toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    head.append(title, chip, toggle);

    const body = el('div', 'p4-hud-body');
    const secBattle = el('section', 'p4-hud-sec');
    const secUnit = el('section', 'p4-hud-sec');
    const secCell = el('section', 'p4-hud-sec');
    const secLegend = el('section', 'p4-hud-sec');
    body.append(secBattle, secUnit, secCell, secLegend);

    const foot = el('footer', 'p4-hud-foot');
    foot.textContent = '操作：P5 战棋层（点击 = 原版输入协议）；判定一律由原版 qi/vo/xo/Ao/Fo 完成';

    root.append(head, body, foot);
    this.host.append(root);
    this.dom = { root, chip, toggle, body, secBattle, secUnit, secCell, secLegend, foot };
    return this;
  }

  get isOpen() { return !!(this.dom && !this.dom.root.hidden); }

  show() {
    if (!this.dom) this.mount();
    this.dom.root.hidden = false;
    this.stats.opens++;
    return this;
  }

  hide() {
    if (this.dom) this.dom.root.hidden = true;
    return this;
  }

  setCollapsed(v) {
    this.collapsed = !!v;
    if (!this.dom) return;
    this.dom.body.hidden = this.collapsed;
    this.dom.foot.hidden = this.collapsed;
    this.dom.toggle.textContent = this.collapsed ? '展开' : '收起';
  }

  setChip(text) { if (this.dom) this.dom.chip.textContent = text; }

  /** 数据全部来自调用方（GameAdapter 投影），本类不做任何推断。 */
  update(data) {
    if (!this.dom) this.mount();
    this.stats.updates++;
    const b = data.battle || {};
    this.dom.chip.textContent = b.mapReady
      ? `第 ${b.round} 回合 · 地图 ${b.width}×${b.height}`
      : '战斗初始化中…';

    this.dom.secBattle.replaceChildren(
      el('h3', null, '战况'),
      kv([
        ['地图', b.mapReady ? `#${b.mapId}（${b.width}×${b.height}）` : `#${b.mapId}（初始化中）`],
        ['回合', String(b.round)],
        ['天候', b.weatherName || String(b.weather)],
        ['模式', b.modeName || String(b.mode)],
        ['我方粮草', String(b.provender ? b.provender.mine : '—')],
        ['敌方粮草', String(b.provender ? b.provender.enemy : '—')],
        ['结束标志', b.over ? String(b.over) : '进行中'],
      ]),
    );

    const u = data.unit;
    if (u && u.present) {
      const blocks = [
        el('h3', null, `选中部队 #${u.index}`),
        kv([
          ['武将', u.name || '—'],
          ['兵种', u.armsTypeName || '—'],
          ['势力', u.factionName || '(空)'],
          ['兵力', u.arms === null ? '—' : String(u.arms)],
          ['生命 / 技力', `${u.hp} / ${u.mp}`],
          ['坐标', `(${u.x}, ${u.y})`],
          ['状态', u.stateName || String(u.state)],
          ['本回合', u.active === 1 ? '已行动' : '未行动'],
          ['可操作', u.selectable ? '是（原版 Xo() 判定）' : '否（原版 Xo() 判定）'],
        ]),
      ];
      if (!u.selectable) {
        blocks.push(el('p', 'p4-hud-note',
          '该部队当前不可操作：可能是敌方部队、已行动，或处于混乱/石阵等状态。'));
      }
      this.dom.secUnit.replaceChildren(...blocks);
    } else {
      this.dom.secUnit.replaceChildren(
        el('h3', null, '选中部队'),
        el('p', 'p4-hud-note', u ? `#${u.index} 槽位在原版编制中为空。` : '点击地图上的部队查看信息。'),
      );
    }

    const c = data.cell;
    if (c) {
      this.dom.secCell.replaceChildren(
        el('h3', null, `选中格 (${c.x}, ${c.y})`),
        kv([
          ['地形', c.terrainName || '—'],
          ['图块号', String(c.tile)],
          ['移动范围', c.inMove ? '在范围内' : '不在范围内'],
          ['攻击范围', c.inAttack ? '在范围内' : '不在范围内'],
        ]),
        el('p', 'p4-hud-note', c.description || ''),
      );
    } else {
      this.dom.secCell.replaceChildren(
        el('h3', null, '选中格'),
        el('p', 'p4-hud-note', '点击地图上的空格查看地形。'),
      );
    }

    this.dom.secLegend.replaceChildren(
      el('h3', null, '图例'),
      el('div', 'p4-legend',
        legendItem('p4-swatch-move', `移动范围 ${data.counts ? data.counts.move : 0} 格`),
        legendItem('p4-swatch-attack', `攻击范围 ${data.counts ? data.counts.attack : 0} 格`),
        legendItem('p4-swatch-mine', '我方部队'),
        legendItem('p4-swatch-enemy', '敌方部队'),
        legendItem('p4-swatch-state', '状态异常标记')),
    );
  }

  log(text) {
    this.logs.push(text);
    if (this.logs.length > 40) this.logs.shift();
  }

  dispose() {
    if (this.dom && this.dom.root.parentNode) this.dom.root.parentNode.removeChild(this.dom.root);
    this.dom = null;
  }
}

function kv(rows) {
  const dl = el('dl', 'p4-kv');
  for (const [k, v] of rows) {
    dl.append(el('dt', null, k), el('dd', null, v));
  }
  return dl;
}

function legendItem(cls, text) {
  const wrap = el('span', 'p4-legend-item');
  wrap.append(el('i', `p4-swatch ${cls}`), el('span', null, text));
  return wrap;
}

/**
 * P3 独立武将选择弹窗 —— 原版 Ls() 的 HTML 等价物。
 *
 * 原版签名（L3686）：Ls(persons, count, x1, y1, x2, y2, startIndex)
 *   persons  由调用方传入的候选数组（城市指令里都来自 ss(cityId)）
 *   start    预选中下标（25 分配 会传入上次选中项）
 *   返回     选中下标；取消返回 255
 *
 * 本弹窗因此**不做任何筛选**：候选就是原版给的那一批，
 * 属性列直接来自原版 Bs(officerId, col)，列标题来自 getConst(24..36)。
 * 「不可选」只能由原版决定（例如体力不足由 mi() 自己 Ms(Hr) 提示），
 * 弹窗不会自行禁用或放行。
 */
import { el } from './Dialogs.mjs';

export class OfficerSelectDialog {
  constructor({ host, cityUI }) {
    this.host = host;
    this.cityUI = cityUI;
    this.stats = { opened: 0, confirmed: 0, cancelled: 0 };
  }

  /**
   * @param {object} opts
   * @param {number[]} opts.persons  原版候选武将 id 数组
   * @param {number} [opts.startIndex] 原版预选下标
   * @param {string} [opts.actionName] 当前指令名（仅作标题说明）
   * @param {string} [opts.cityName]
   * @returns {Promise<number>} 下标 或 255
   */
  async ask({ persons, startIndex = 0, actionName = '', cityName = '' }) {
    if (!persons || !persons.length) return 255;   // 与原版 `if(!e)return 255` 同义
    this.stats.opened++;

    const columns = this.cityUI.getOfficerColumns();
    const rows = this.cityUI.officerRowsByIds(persons);

    let cursor = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < rows.length
      ? startIndex : 0;

    const wrap = el('div', 'p3-officer-wrap');
    const table = el('table', 'p3-officer-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of columns) hr.append(el('th', null, c.label));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    const trs = rows.map((row, index) => {
      const tr = el('tr', 'p3-officer-row');
      tr.tabIndex = 0;
      tr.setAttribute('data-officer-id', String(row.id));
      tr.append(el('td', 'p3-officer-name', row.name));
      for (const cell of row.cells) tr.append(el('td', null, cell));
      tr.addEventListener('click', () => setCursor(index));
      tr.addEventListener('dblclick', () => { setCursor(index); confirm(); });
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { setCursor(index); confirm(); }
        if (ev.key === 'ArrowDown') { ev.preventDefault(); setCursor(Math.min(rows.length - 1, index + 1)); }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); setCursor(Math.max(0, index - 1)); }
      });
      tbody.append(tr);
      return tr;
    });
    table.append(tbody);
    wrap.append(table);
    const detail = el('div', 'p3-officer-detail');
    wrap.append(detail);

    const subtitle = [cityName, actionName].filter(Boolean).join(' · ');
    const note = el('p', 'p3-hint');
    note.textContent = `候选 ${rows.length} 人（原版 Ls() 传入的数组，未在本弹窗做二次筛选）· 双击或回车确认`;

    let resolveFn = null;
    let closed = false;

    const result = await this.host.open({
      title: '选择武将',
      subtitle,
      wide: true,
      body: [wrap, note],
      actions: [
        { label: '确认', value: 'confirm', variant: 'primary' },
        { label: '取消', value: null },
      ],
      cancelValue: null,
      onMount: ({ card, finish }) => {
        card.classList.add('p3-officer-modal');
        resolveFn = finish;
        setCursor(cursor);
        // 打开时把当前行滚到可视区（原版也会按 start 预滚）
        requestAnimationFrame(() => {
          try { trs[cursor].scrollIntoView({ block: 'nearest' }); } catch (_) { /* 忽略 */ }
        });
      },
    });

    closed = true;
    resolveFn = null;
    if (result === 'confirm') {
      this.stats.confirmed++;
      return cursor;
    }
    this.stats.cancelled++;
    return 255;

    // ------------------------------------------------------- 内部函数
    function setCursor(index) {
      if (closed) return;
      cursor = index;
      trs.forEach((tr, i) => tr.classList.toggle('is-current', i === index));
      const row = rows[index];
      detail.replaceChildren();
      detail.append(el('span', 'p3-detail-label', '当前：'), el('strong', null, row.name));
      columns.forEach((c, i) => {
        if (c.key === 'name') return;
        detail.append(el('span', 'p3-detail-kv', `${c.label} ${row.cells[i - 1]}`));
      });
    }

    function confirm() {
      if (closed || !resolveFn) return;
      resolveFn('confirm', 'action');
    }
  }
}

/**
 * P6 UIStack —— 全局 UI 层栈（纯逻辑，不碰 DOM，可在 Node 里直接测）。
 *
 * 解决的问题（P1~P5 各自管自己的弹窗时真实出现过）：
 *   1) 嵌套弹窗（城市面板里的武将选择、数值输入）关掉内层后，外层还开着，
 *      但输入阻断被提前复位 → 点击穿透到 3D 场景；
 *   2) 同一个弹窗被重复打开两次（事件重复派发 / 双击），关闭一次后另一个残留；
 *   3) 场景切换时残留弹窗没人收，返回后仍挡着地图。
 *
 * 做法：所有会「遮挡或吃掉输入」的界面都必须在栈里登记一个 token。
 *   - 只要栈里还有 blocking 项，input.setUIOpen(true)；全部出栈才恢复输入；
 *   - 同一个 id 重复入栈返回**已有 token**（不叠加阻断、不产生第二份 DOM 责任）；
 *   - 弹出未知 token 记一次 orphanCloses（诊断用，不抛错——异常路径也可能走到这里）。
 */

export class UIStack {
  constructor({ input = null, log = () => {} } = {}) {
    this.input = input;
    this.log = log;
    this._items = [];          // [{id, layer, blocking, owner, token}]
    this._seq = 0;
    this.stats = {
      opens: 0, closes: 0, duplicates: 0, orphanCloses: 0,
      peakDepth: 0, inputBlocks: 0, inputRestores: 0, forcedCloses: 0,
    };
    this._blocked = false;
  }

  get depth() { return this._items.length; }
  get ids() { return this._items.map((i) => i.id); }

  /** 栈顶（最上面那层）。 */
  get top() { return this._items.length ? this._items[this._items.length - 1] : null; }

  /** 是否应阻断 3D 输入：任意 blocking 项存在即阻断。 */
  get blocking() { return this._items.some((i) => i.blocking); }

  _sync() {
    if (!this.input || typeof this.input.setUIOpen !== 'function') return;
    const want = this.blocking;
    if (want === this._blocked) return;
    this._blocked = want;
    this.input.setUIOpen(want);
    if (want) this.stats.inputBlocks++; else this.stats.inputRestores++;
  }

  /**
   * 入栈。
   * @param {string} id 稳定标识（同 id 视为「同一个界面」）
   * @param {object} [opts] { layer, blocking, owner }
   * @returns {object} token（传给 close）
   */
  push(id, { layer = 0, blocking = true, owner = null } = {}) {
    if (!id) throw new TypeError('UIStack.push 需要 id');
    const exist = this._items.find((i) => i.id === id);
    if (exist) {
      this.stats.duplicates++;
      // 重复打开同一个界面：**引用计数 +1**，返回同一个 token。
      // 这样每次 open 都必须对应一次 close，任何一方提前关闭都不会把仍在显示的界面
      // 的输入阻断提前解除（真实场景：外层菜单与内层确认框共用同一个 id）。
      exist.refs++;
      if (blocking && !exist.blocking) { exist.blocking = true; this._sync(); }
      if (layer > exist.layer) exist.layer = layer;
      return exist.token;
    }
    const token = Object.freeze({ id, seq: ++this._seq });
    this._items.push({ id, layer, blocking, owner, token, refs: 1 });
    this.stats.opens++;
    this.stats.peakDepth = Math.max(this.stats.peakDepth, this._items.length);
    this._sync();
    return token;
  }

  close(token) {
    if (!token) return false;
    const item = this._items.find((i) => i.token === token || i.id === token);
    if (!item) { this.stats.orphanCloses++; return false; }
    item.refs--;
    if (item.refs > 0) return true;      // 还有其它打开者，界面仍然存在
    return this._remove(item);
  }

  _remove(item) {
    const idx = this._items.indexOf(item);
    if (idx < 0) return false;
    this._items.splice(idx, 1);
    this.stats.closes++;
    this._sync();
    return true;
  }

  closeId(id) {
    const item = this._items.find((i) => i.id === id);
    return item ? this._remove(item) : false;
  }

  /** 关掉某个 owner 的全部界面（场景退出 / 读档 / 错误恢复时用；忽略引用计数）。 */
  closeOwner(owner) {
    if (!owner) return 0;
    let n = 0;
    for (const item of [...this._items]) if (item.owner === owner) { if (this._remove(item)) n++; }
    return n;
  }

  /** 清空（读档、致命错误、场景重置）。 */
  clear(reason = 'clear') {
    const n = this._items.length;
    if (!n) return 0;
    this.stats.forcedCloses += n;
    this._items.length = 0;
    this._sync();
    this.log(`UI 栈强制清空 ${n} 层（${reason}）`);
    return n;
  }

  /** 层级是否单调（诊断用：确认没有「下层盖住上层」的登记错误）。 */
  isOrdered() {
    for (let i = 1; i < this._items.length; i++) {
      if (this._items[i].layer < this._items[i - 1].layer) return false;
    }
    return true;
  }

  getStats() {
    return { ...this.stats, depth: this._items.length, blocking: this.blocking, ids: this.ids };
  }
}

/**
 * P5 BattleDelta —— 「行动前后状态差」的唯一实现（纯函数，无副作用）。
 *
 * 用途：原版 Fo() 结算完成后，把操作前后的两份快照对比出真实变化，
 * 供战报面板与受击/死亡表现使用。
 *
 * 为什么不用「战斗中计算伤害」：
 *   P5 的硬约束是不在前端重算任何战斗数值。这里只做减法：
 *   两个时刻都由 GameAdapter.getBattleUnitStates() 直接从 Dn 读出，
 *   差值就是原版真实结果（含反击、状态变化、粮草消耗）。
 */

/**
 * @param {object} before  结算前快照（{ [unitId]: {x,y,hp,mp,state,arms,...} }）
 * @param {object} after   结算后快照（同结构）
 * @returns {Array<{id:number, armsDelta:number, hpDelta:number, mpDelta:number, died:boolean, stateChanged:boolean, stateFrom:number, stateTo:number, armsBefore:number, armsAfter:number, hpBefore:number, hpAfter:number}>}
 */
export function diffUnitStates(before, after) {
  const out = [];
  if (!before || !after) return out;
  for (const key of Object.keys(after)) {
    const id = Number(key);
    const a0 = before[id];
    const a1 = after[id];
    if (!a0 || !a1) continue;
    const armsDelta = (a0.arms | 0) - (a1.arms | 0);
    const hpDelta = (a0.hp | 0) - (a1.hp | 0);
    const mpDelta = (a0.mp | 0) - (a1.mp | 0);
    const died = a0.state !== 8 && a1.state === 8;
    const stateChanged = a0.state !== a1.state;
    if (!armsDelta && !hpDelta && !mpDelta && !died && !stateChanged) continue;
    out.push({
      id, armsDelta, hpDelta, mpDelta, died, stateChanged,
      stateFrom: a0.state, stateTo: a1.state,
      armsBefore: a0.arms | 0, armsAfter: a1.arms | 0,
      hpBefore: a0.hp | 0, hpAfter: a1.hp | 0,
    });
  }
  return out;
}

/** 双方粮草变化（原版 Ki()/计谋都会改这两个字段）。 */
export function diffProvender(before, after) {
  const b = before || { mine: 0, enemy: 0 };
  const a = after || { mine: 0, enemy: 0 };
  const mine = (a.mine | 0) - (b.mine | 0);
  const enemy = (a.enemy | 0) - (b.enemy | 0);
  return { mine, enemy, totalDelta: mine + enemy };
}

/** 一行战报文本（只陈述变化，不加判断；名称由调用方按原版 $n() 给出）。 */
export function describeChange(change, name = '') {
  const who = name || `#${change.id}`;
  if (change.died) return `${who} 部队溃灭`;
  const bits = [];
  if (change.armsDelta) bits.push(`兵力${change.armsDelta > 0 ? '-' : '+'}${Math.abs(change.armsDelta)}（余 ${change.armsAfter}）`);
  if (change.hpDelta) bits.push(`生命${change.hpDelta > 0 ? '-' : '+'}${Math.abs(change.hpDelta)}（余 ${change.hpAfter}）`);
  if (change.mpDelta) bits.push(`技力${change.mpDelta > 0 ? '-' : '+'}${Math.abs(change.mpDelta)}`);
  if (change.stateChanged) bits.push(`状态 ${change.stateFrom}→${change.stateTo}`);
  return bits.length ? `${who} ${bits.join('，')}` : `${who} 无变化`;
}

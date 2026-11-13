// shared/scan-registry.ts
// ERP 添加页产品明细表是长列表窗口化渲染：滚动时 DOM 里可见行集变化，
// 逐次扫描直接重建列表会导致参数配置跳变（2026-09-02 用户报 bug：采购页
// SKU 数量随滚动条变化；调拨页列表短未触发但同款扫描同隐患）。
// 修复两件套：
// ① 累计登记表 createScanRegistry——后台扫描取并集（先见不丢，列表稳定）；
// ② 分析前滚表对账 sweepTableScroller——程序化把表格滚一遍让每行进过 DOM，
//    全量扫描结果即表格真实内容（顺带剔除用户已删除的行）。

/** 累计登记表：merge 取并集保持首见顺序；sweep 期间记录全量见集，endSweep 对账 */
export function createScanRegistry<T>(keyOf: (item: T) => string = (x) => String(x)) {
  let stable: T[] = [];
  const byKey = new Map<string, T>();
  let sweepSeen: Set<string> | null = null;

  /** 并入一次扫描结果，返回登记表快照（滚动窗口变化不丢先见项） */
  function merge(scan: T[]): T[] {
    for (const item of scan) {
      const key = keyOf(item);
      if (!byKey.has(key)) {
        byKey.set(key, item);
        stable.push(item);
      }
      if (sweepSeen !== null) sweepSeen.add(key);
    }
    return stable.slice();
  }

  /** 进入对账模式：之后的 merge 同时记录"本轮滚表见过" */
  function beginSweep(): void {
    sweepSeen = new Set();
  }

  /** 结束对账：只保留本轮滚表见过的条目（= 表格真实内容），返回新快照 */
  function endSweep(): T[] {
    if (sweepSeen !== null) {
      stable = stable.filter((item) => sweepSeen!.has(keyOf(item)));
      byKey.clear();
      for (const item of stable) byKey.set(keyOf(item), item);
      sweepSeen = null;
    }
    return stable.slice();
  }

  function snapshot(): T[] {
    return stable.slice();
  }

  return { merge, beginSweep, endSweep, snapshot };
}

/** 找到产品表的纵向滚动体：优先有实际滚动量的（真浏览器），jsdom/无滚动兜底首个 */
export function findTableScroller(root: Document | HTMLElement): HTMLElement | null {
  const bodies = root.querySelectorAll('.surely-table-body');
  for (let i = 0; i < bodies.length; i++) {
    const el = bodies[i] as HTMLElement;
    if (el.scrollHeight > el.clientHeight) return el;
  }
  return (bodies[0] as HTMLElement) || null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 程序化滚表：顶→底逐步滚动，每步回调 onStep 采集当前窗口行，结束后恢复原位置。
 *  真浏览器 scrollTop 到底部会被夹住不再增长（终止条件）；guard 防病态循环。 */
export async function sweepTableScroller(scroller: HTMLElement, onStep: () => void): Promise<void> {
  const origTop = scroller.scrollTop;
  const step = Math.max(200, scroller.clientHeight || 400);
  scroller.scrollTop = 0;
  for (let guard = 0; guard < 500; guard++) {
    onStep();
    await sleep(120);
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    const atEnd = scroller.scrollTop === before || scroller.scrollTop >= scroller.scrollHeight - 1;
    if (atEnd) {
      onStep();   // 底部窗口再采一次（含最后一屏的行）
      await sleep(120);
      break;
    }
  }
  scroller.scrollTop = origTop;
}

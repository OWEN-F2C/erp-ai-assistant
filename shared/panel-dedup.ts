// shared/panel-dedup.ts
// 面板去重看门狗 + 构建标记（2026-09-08 用户偶遇双"AI 采购建议"面板，F5 即恢复；
// 悬浮球只有一个=单实例，具体竞态路径未锁定）。三层意义：
// ① dedupeExtensionPanels 由 content.ts 每秒轮询调用——无论哪条路径造成重复，
//    1 秒内收敛回一个面板（症状自愈）；
// ② data-erp-build 构建标记：复发时一眼区分同实例重复 vs 跨实例残留（取证）；
// ③ 去重优先保留带标记的面板（新构建胜出）。

/** 手动构建号：结构性改动面板注入/生命周期时递增（用于双面板取证） */
export const PANEL_BUILD = '2026-09-08.2';

/** 四个数据面板的根类名（marker span 与面板 div 共用类名，属正常共存） */
export const PANEL_CLASSES = ['erp-ai-panel', 'erp-transfer-ai-panel', 'erp-gen-panel', 'erp-profit-panel'];

/** 同类可见面板 >1 时只留一个（优先带构建标记的），返回移除数量；marker 不动 */
export function dedupeExtensionPanels(doc: Document): number {
  let removed = 0;
  for (const cls of PANEL_CLASSES) {
    const panels = Array.from(doc.querySelectorAll<HTMLElement>('div.' + cls));
    if (panels.length <= 1) continue;
    // 稳定排序：带构建标记的排前（新构建胜出），其余保持文档顺序
    panels.sort(function (a, b) {
      return (b.dataset.erpBuild ? 1 : 0) - (a.dataset.erpBuild ? 1 : 0);
    });
    for (let i = 1; i < panels.length; i++) {
      const p = panels[i]!;
      // 取证：看门狗动作时在页面 console 留痕（构建号+挂载父链），
      // 下次复发即可判断重复面板从哪来（根因至今未锁定）
      console.warn('[erp-enhancer] 去除重复面板', cls,
        'build=' + (p.dataset.erpBuild || 'NO-TAG'),
        'parent=' + String((p.parentElement && p.parentElement.className) || '').slice(0, 60));
      p.remove();
      removed++;
    }
  }
  return removed;
}

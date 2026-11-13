// shared/extension-context.ts
// Chrome 扩展重载/更新后，旧页面里仍存活的内容脚本上下文失效：chrome.storage 等
// API 抛 "Extension context invalidated"（2026-09-03 用户报"获取数据失败"英文裸错误）。
// 失效信号：chrome.runtime.id 变 undefined（对象仍可访问，读 id 安全不抛错）。
// 面板在轮询里做"有效→失效"跃迁检测后给出刷新指引；注入时本就无效（测试环境
// chrome stub 无 runtime）不触发，避免误报。

export function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

export function isExtensionContextInvalidatedError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  return /Extension context invalidated/i.test(String((e as Error).message || ''));
}

export function extensionInvalidatedNoticeHtml(): string {
  return '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
    'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">' +
      '<span style="font-size:16px;flex-shrink:0;">🔄</span>' +
      '<div style="font-size:12px;color:#991b1b;line-height:1.5;">' +
        '<b>扩展已更新或重新加载</b><br>' +
        '本页面的 AI 面板已失效，请刷新页面（F5）后重新使用。' +
      '</div>' +
    '</div>';
}

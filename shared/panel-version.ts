// shared/panel-version.ts
// 面板版本徽章：chrome.runtime.getManifest 读取（策略/crx 安装与 unpacked 均有效），
// 读取失败回退 '0.0.0'（jsdom 测试无 chrome 对象）。发版后远程确认谁已更新用。
export function getPanelVersion(): string {
  try {
    const v = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } })
      .chrome?.runtime?.getManifest?.().version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function versionBadgeHtml(): string {
  // float:right：标题容器有 flex 也有普通 block，float 两种下都可靠右显示
  return '<span data-erp-version title="扩展版本" style="float:right;margin-left:8px;' +
    'font-size:10px;color:#94a3b8;">v' + getPanelVersion() + '</span>';
}

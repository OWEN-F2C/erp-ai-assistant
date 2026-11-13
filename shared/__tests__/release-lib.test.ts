import { describe, it, expect } from 'vitest';
// 自动更新·方案A（unpacked + 文件同步，2026-09-10 pivot）：
// Chrome 137+ 对非托管设备 [BLOCKED] 扩展安装策略（chrome://policy 实锤），
// Forcelist 路线废弃。改为：服务器放 dist.zip，同事机计划任务自动拉取解压，
// Chrome 重启时重读解压加载目录 → 新版生效。安装 bat 自包含（base64 内嵌 sync.ps1）。
import { bumpPatch, renderInstallerBat, renderUninstallerBat, renderSyncPs1, SYNC_PS1_URL } from '../../scripts/release-lib';

describe('bumpPatch', () => {
  it('1.5.0 → 1.5.1；patch 进位 1.5.9 → 1.5.10', () => {
    expect(bumpPatch('1.5.0')).toBe('1.5.1');
    expect(bumpPatch('1.5.9')).toBe('1.5.10');
  });
  it('格式不符抛错', () => {
    expect(() => bumpPatch('v1.5')).toThrow();
    expect(() => bumpPatch('')).toThrow();
  });
});

describe('renderSyncPs1（同步脚本：下载→版本比对→原子交换）', () => {
  it('从服务器拉 dist.zip，同版本跳过', () => {
    expect(renderSyncPs1()).toContain(SYNC_PS1_URL);
    expect(renderSyncPs1()).toContain('ConvertFrom-Json');
    expect(renderSyncPs1()).toContain('exit');
  });
  it('原子交换：先解压 .staging → 换到 app.new → 删旧目录 → 改名（Chrome 半路读不到半成品）', () => {
    const ps1 = renderSyncPs1();
    expect(ps1).toContain('.staging');
    expect(ps1).toContain('app.new');
    expect(ps1).toContain('Rename-Item');
    expect(ps1).toContain('Remove-Item');
  });
});

describe('renderInstallerBat（自包含安装：内嵌 sync.ps1 + 计划任务）', () => {
  const bat = renderInstallerBat();
  it('base64 内嵌 sync.ps1（certutil 解码，单文件分发）', () => {
    expect(bat).toContain('certutil -decode');
    expect(bat).toContain('sync.ps1');
  });
  it('注册两个计划任务：登录时 + 每小时', () => {
    expect(bat).toContain('schtasks /Create');
    expect(bat).toContain('/SC ONLOGON');
    expect(bat).toContain('/SC HOURLY');
  });
  it('首次安装引导：base64 内嵌中文引导文案，type 显示（echo 中文不稳）', () => {
    expect(bat).toContain('erp-guide.txt');
    expect(bat).toContain('type "%TEMP%\\erp-guide.txt"');
    // 路径明文出现在解码目标与任务命令行（引导文案里的 app 路径在 base64 内）
    expect(bat).toContain('C:\\erp-enhancer\\sync.ps1');
    // 解码引导块验证内容（bat 里第二段 base64）
    const blocks = [...bat.matchAll(/\((echo [A-Za-z0-9+/=]+(?:\r\necho [A-Za-z0-9+/=]+)*)\) > "%TEMP%\\erp-guide.b64"/g)];
    expect(blocks.length).toBe(1);
    const b64 = blocks[0]![1]!.split('\r\n').map(l => l.replace(/^echo /, '')).join('');
    const guide = Buffer.from(b64, 'base64').toString('utf8');
    expect(guide).toContain('chrome://extensions');
    expect(guide).toContain('加载已解压');
    expect(guide).toContain('C:\\erp-enhancer\\app');
    expect(guide).toContain('v1.5.4');
  });
  it('CRLF 行尾 + chcp 65001', () => {
    expect(bat).toContain('\r\n');
    expect(bat).toContain('chcp 65001');
  });
});

describe('renderUninstallerBat', () => {
  it('删除两个计划任务 + 本地目录 + 提醒移除扩展条目（ASCII 输出）', () => {
    const bat = renderUninstallerBat();
    expect(bat).toContain('schtasks /Delete');
    expect(bat).toContain('chrome://extensions');
    expect(bat).toContain('C:\\erp-enhancer');
  });
});

// shared/erp-errors.ts
// ERP 接口失败的统一分类与提示。启发式判定（仓库内无真实权限失败样本，
// 拿到样本后只需修正 PERMISSION_KEYWORDS / KNOWN_PERMISSION_CODES 两处）：
//   - HTTP 401                       → 登录失效（提示刷新页面）
//   - HTTP 403，或 200 且 body 表明失败且消息含权限关键词 → 无权限（提示找管理员）
//   - 其余                           → 普通失败（透出接口消息/状态码）

import { clearAuthToken } from './auth';

const PERMISSION_KEYWORDS = ['无权限', '没有权限', '未授权', '权限不足', '无权访问', '禁止访问', 'forbidden', 'no permission'];
/** 登录失效文案（真实样本 2026-08-21 实测：{msg:"登录已过期，请重新登录",code:401}，
 *  通常直接返回 HTTP 401，此列表兜底 HTTP 200 带 body 的情况） */
const AUTH_KEYWORDS = ['登录已过期', '请重新登录', '登录失效', '未登录', '请先登录'];
/** 已确认表示无权限的 body.code 值（拿到真实样本后补充） */
const KNOWN_PERMISSION_CODES: ReadonlySet<number> = new Set();

export type ErpFailureKind = 'permission' | 'auth' | 'api';

export class ErpApiError extends Error {
  readonly kind: ErpFailureKind;
  readonly datasets: string[];

  constructor(kind: ErpFailureKind, datasets: string[], message: string) {
    super(message);
    this.name = 'ErpApiError';
    this.kind = kind;
    this.datasets = datasets;
  }

  /** 聚合多个失败：数据集去重合并，优先级 auth > permission > api */
  static aggregate(errors: ErpApiError[]): ErpApiError {
    const datasets: string[] = [];
    for (const e of errors) {
      for (const d of e.datasets) {
        if (!datasets.includes(d)) datasets.push(d);
      }
    }
    const kinds = new Set(errors.map(e => e.kind));
    const kind: ErpFailureKind = kinds.has('auth') ? 'auth' : kinds.has('permission') ? 'permission' : 'api';
    const message = kind === 'auth'
      ? '登录状态已失效（' + datasets.join('、') + '），请刷新页面重新登录后重试。'
      : kind === 'permission'
        ? '以下数据无法访问：' + datasets.join('、') + '。若为账号权限问题，请联系积加系统管理员开通相应页面/报表权限后重试。'
        : '以下数据获取失败：' + datasets.join('、') + '。';
    return new ErpApiError(kind, datasets, message);
  }
}

function messagesText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof b.message === 'string') parts.push(b.message);
  if (Array.isArray(b.messages)) parts.push(...b.messages.filter(m => typeof m === 'string') as string[]);
  if (typeof b.msg === 'string') parts.push(b.msg);
  return parts.join('；');
}

/** body 是否表明业务失败（success 形态或 error/code 形态） */
function bodyIndicatesFailure(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.success === false) return true;
  if (b.error === true) return true;
  if (typeof b.code === 'number' && b.code !== 0) return true;
  return false;
}

/** 读取并校验 ERP 响应：正常返回解析后的 JSON；失败抛携带数据集名的 ErpApiError */
export async function readErpJson(resp: Response, dataset: string): Promise<any> {
  if (resp.status === 401) {
    // 登录失效：清掉 token 缓存，用户重新登录后无需刷新页面
    clearAuthToken();
    throw new ErpApiError('auth', [dataset], '登录状态已失效（' + dataset + '），请刷新页面重新登录');
  }
  if (resp.status === 403) {
    throw new ErpApiError('permission', [dataset], '无权访问' + dataset + '（HTTP 403），请联系管理员开通权限');
  }
  let body: unknown = null;
  let parseFailed = false;
  try {
    body = await resp.json();
  } catch {
    parseFailed = true;
  }
  if (!resp.ok || parseFailed) {
    throw new ErpApiError('api', [dataset], dataset + ' 接口返回 ' + resp.status + (parseFailed ? '（非 JSON 响应）' : ''));
  }
  if (bodyIndicatesFailure(body)) {
    const text = messagesText(body);
    const code = (body as Record<string, unknown>).code;
    if (AUTH_KEYWORDS.some(kw => text.includes(kw)) || code === 401) {
      clearAuthToken();
      throw new ErpApiError('auth', [dataset], '登录状态已失效（' + dataset + '），请刷新页面重新登录');
    }
    const isPermission =
      (typeof code === 'number' && KNOWN_PERMISSION_CODES.has(code)) ||
      PERMISSION_KEYWORDS.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
    if (isPermission) {
      throw new ErpApiError('permission', [dataset],
        '无权访问' + dataset + (text ? '：' + text : '') + '，请联系积加系统管理员开通权限');
    }
    throw new ErpApiError('api', [dataset], dataset + '获取失败' + (text ? '：' + text : '（code ' + code + '）'));
  }
  return body;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** 分析中止类错误的面板警告框（红色，列出缺失数据集 + 找管理员/刷新提示） */
export function erpErrorNoticeHtml(e: ErpApiError): string {
  const isAuth = e.kind === 'auth';
  const list = e.datasets.join('、');
  const text = isAuth
    ? '登录状态已失效（' + list + '），请刷新页面重新登录后重试。'
    : e.kind === 'permission'
      ? '以下数据无法访问：' + list + '。若为账号权限问题，请联系积加系统管理员开通相应页面/报表权限后重试。'
      : (e.message || '以下数据获取失败：' + list + '。');
  const icon = isAuth ? '🔑' : '⚠️';
  const bg = isAuth ? '#eff6ff' : '#fef2f2';
  const border = isAuth ? '#bfdbfe' : '#fecaca';
  const color = isAuth ? '#1e40af' : '#991b1b';
  return '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px;' +
    'background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;">' +
    '<span style="font-size:16px;flex-shrink:0;">' + icon + '</span>' +
    '<div style="font-size:12px;color:' + color + ';line-height:1.6;">' + esc(text) + '</div>' +
    '</div>';
}

/** 降级继续类警告条（黄色，点名缺失数据 + 对分析口径的影响） */
export function dataWarningHtml(title: string, consequence: string): string {
  return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 12px;margin:6px 0;' +
    'background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">' +
    '<span style="font-size:14px;flex-shrink:0;">⚠️</span>' +
    '<div style="font-size:11px;color:#92400e;line-height:1.6;">' +
    '<b>' + esc(title) + '</b>：' + esc(consequence) +
    '。若为账号权限问题，请联系积加系统管理员开通后重试。</div>' +
    '</div>';
}

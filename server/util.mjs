/** 通用小工具 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成短随机 id */
export function uid(len = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** 安全 JSON 解析 */
export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 取出 `{a:{b:1}}` 里的 a.b，缺省返回 fallback */
export function pick(obj, path, fallback = undefined) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}

/** TronClass 列表接口的返回形状差异很大，统一抽出数组 */
export function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'list', 'items', 'results', 'rollcalls', 'courses']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    for (const key of ['list', 'items', 'results', 'rollcalls', 'courses']) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

/** 归一化时间：兼容秒/毫秒时间戳与 ISO 字符串 */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return toDate(Number(s));
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日期 YYYY-MM-DD */
export function ymd(date = new Date()) {
  const d = toDate(date) ?? new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(date, days) {
  const d = new Date(toDate(date) ?? new Date());
  d.setDate(d.getDate() + days);
  return d;
}

/** 数字/字符串安全转整数 */
export function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 提取 HTML 里某个 input 的 value */
export function inputValue(html, name) {
  const re = new RegExp(
    `<input\\b[^>]*\\bname=["']${name}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const v = /\bvalue=["']([^"']*)["']/i.exec(tag);
  return v ? v[1] : null;
}

/** 极简 HTML 文本抽取（用于错误信息展示） */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

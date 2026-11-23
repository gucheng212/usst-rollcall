import { config } from './config.mjs';
import { log } from './logger.mjs';
import { sleep } from './util.mjs';

/**
 * 简易 Cookie 罐：按 host 保存，支持 Domain/Path/Expires。
 * 上理登录链跨越 1906.usst.edu.cn / 1906.usst.edu.cn:8600 / ehall.usst.edu.cn /
 * ids6.usst.edu.cn 四个 host，必须严格按 host 取用，否则会把 CAS 的 JSESSIONID
 * 带到畅课上导致 401。
 */
export class CookieJar {
  constructor(data = []) {
    /** @type {Map<string, Map<string, {value:string, domain:string, path:string, expires:number|null, secure:boolean, httpOnly:boolean}>>} */
    this.byHost = new Map();
    for (const item of data) this.set(item);
  }

  static keyOf(host) {
    return String(host || '').toLowerCase();
  }

  set(cookie) {
    const host = CookieJar.keyOf(cookie.domain || cookie.host);
    if (!host || !cookie.name) return;
    if (!this.byHost.has(host)) this.byHost.set(host, new Map());
    const bucket = this.byHost.get(host);
    if (cookie.expires !== null && cookie.expires !== undefined && cookie.expires <= Date.now()) {
      bucket.delete(cookie.name);
      return;
    }
    bucket.set(cookie.name, {
      name: cookie.name,
      value: cookie.value,
      domain: host,
      path: cookie.path || '/',
      expires: cookie.expires ?? null,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    });
  }

  /** 解析响应里的 Set-Cookie */
  absorb(url, headers) {
    const list =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);

    const host = new URL(url).hostname.toLowerCase();
    const added = [];

    for (const raw of list) {
      if (!raw) continue;
      const parts = raw.split(';');
      const [nameValue, ...attrs] = parts;
      const eq = nameValue.indexOf('=');
      if (eq <= 0) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();

      let domain = host;
      let path = '/';
      let expires = null;
      let secure = false;
      let httpOnly = false;

      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split('=');
        const key = rawKey.trim().toLowerCase();
        const val = rest.join('=').trim();
        if (key === 'domain' && val) {
          domain = val.replace(/^\./, '').toLowerCase();
        } else if (key === 'path' && val) {
          path = val;
        } else if (key === 'expires' && val) {
          const t = Date.parse(val);
          if (!Number.isNaN(t)) expires = t;
        } else if (key === 'max-age' && val) {
          const n = Number(val);
          if (Number.isFinite(n)) expires = Date.now() + n * 1000;
        } else if (key === 'secure') {
          secure = true;
        } else if (key === 'httponly') {
          httpOnly = true;
        }
      }

      this.set({ name, value, domain, path, expires, secure, httpOnly });
      added.push(`${name}@${domain}`);
    }
    return added;
  }

  /** 取出适合该 URL 的 Cookie 头 */
  headerFor(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const out = [];
    for (const [domain, bucket] of this.byHost) {
      const matches = host === domain || host.endsWith(`.${domain}`);
      if (!matches) continue;
      for (const [name, c] of bucket) {
        if (c.expires !== null && c.expires <= Date.now()) continue;
        if (c.secure && u.protocol !== 'https:') continue;
        if (!u.pathname.startsWith(c.path || '/')) continue;
        out.push(`${name}=${c.value}`);
      }
    }
    return out.join('; ');
  }

  /** 该 host 是否有会话级 Cookie（用于判断登录态） */
  hostNames() {
    return [...this.byHost.keys()];
  }

  toJSON() {
    const out = [];
    for (const bucket of this.byHost.values()) for (const c of bucket.values()) out.push(c);
    return out;
  }

  static fromJSON(data) {
    return new CookieJar(Array.isArray(data) ? data : []);
  }
}

/** 全局请求节流：上理侧对高频请求会返回 429，做统一最小间隔 */
class Throttle {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.chain = Promise.resolve();
  }

  run(fn) {
    const task = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = task.catch(() => {});
    return task;
  }
}

export const throttle = new Throttle(config.network.minIntervalMs);

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleepBackoff = (attempt) => sleep(400 * 2 ** attempt + Math.random() * 200);

export class HttpClient {
  constructor({ jar = new CookieJar(), userAgent = config.userAgent, scope = 'http' } = {}) {
    this.jar = jar;
    this.userAgent = userAgent;
    this.scope = scope;
  }

  baseHeaders(extra = {}) {
    const headers = {
      'user-agent': this.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extra,
    };
    const cookie = this.jar.headerFor(extra['__url'] ?? '');
    delete headers.__url;
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  /**
   * 单次请求（默认 manual 重定向，便于逐跳记录 Cookie）。
   * @returns {Promise<{status:number,url:string,headers:Headers,text:string,location:string|null}>}
   */
  async raw(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      form = null,
      json = null,
      redirect = 'manual',
      timeoutMs = config.network.timeoutMs,
      retries = config.network.retries,
    } = options;

    const finalHeaders = {
      'user-agent': this.userAgent,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: headers.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...headers,
    };
    const cookie = this.jar.headerFor(url);
    if (cookie && !finalHeaders.cookie) finalHeaders.cookie = cookie;

    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      finalHeaders['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    } else if (json !== null) {
      body = JSON.stringify(json);
      finalHeaders['content-type'] = 'application/json; charset=UTF-8';
    }

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await throttle.run(() =>
          fetch(url, {
            method,
            headers: finalHeaders,
            body,
            redirect,
            signal: controller.signal,
          }),
        );
        const text = await res.text();
        this.jar.absorb(url, res.headers);
        if (res.status === 429 && attempt < retries) {
          log.warn(this.scope, `429 限流，退避重试 ${url.slice(0, 120)}`);
          await sleepBackoff(attempt + 1);
          continue;
        }
        return {
          status: res.status,
          url: res.url || url,
          headers: res.headers,
          text,
          location: res.headers.get('location'),
        };
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          log.warn(this.scope, `请求失败，重试 ${attempt + 1}/${retries}: ${err.message}`);
          await sleepBackoff(attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HttpError(
      `请求失败: ${lastError?.message ?? '未知错误'} (${url})`,
      { url, status: 0 },
    );
  }

  /**
   * 跟随重定向链，逐跳记录日志与 Cookie。
   * @param {(hop:{index:number,url:string,status:number,html:string,location:string|null})=>boolean|void} onHop
   *        返回 true 表示"到此为止，不再跟随"
   */
  async follow(url, options = {}) {
    const {
      maxRedirects = config.network.maxRedirects,
      onHop = null,
      method = 'GET',
      form = null,
      headers = {},
      stopWhen = null,
    } = options;

    let current = url;
    let currentMethod = method;
    let currentForm = form;
    /** @type {Array<{index:number,url:string,status:number,location:string|null}>} */
    const hops = [];

    for (let i = 0; i <= maxRedirects; i++) {
      const res = await this.raw(current, {
        method: currentMethod,
        form: currentForm,
        headers,
        redirect: 'manual',
      });
      const hop = {
        index: i,
        url: current,
        status: res.status,
        location: res.location,
        html: res.text,
      };
      hops.push({ index: i, url: current, status: res.status, location: res.location });
      log.debug(this.scope, `跳转 ${i}: ${res.status} ${current.slice(0, 140)}`);

      if (onHop && onHop(hop) === true) return { ...res, html: res.text, hops, hop, stopReason: 'onHop' };

      const isRedirect = res.status >= 300 && res.status < 400 && res.location;
      if (!isRedirect) return { ...res, html: res.text, hops, stopReason: 'end' };

      current = new URL(res.location, current).toString();
      currentMethod = 'GET';
      currentForm = null;

      if (stopWhen && stopWhen({ url: current, index: i + 1 })) {
        return { ...res, hops, stopReason: 'stopWhen', nextUrl: current };
      }
    }
    throw new HttpError(`重定向次数超限（>${maxRedirects}）`, { url });
  }
}

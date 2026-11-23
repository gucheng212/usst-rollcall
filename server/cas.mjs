import { config } from './config.mjs';
import { HttpClient, CookieJar, HttpError } from './httpx.mjs';
import { log } from './logger.mjs';
import { htmlToText, inputValue, tryJson } from './util.mjs';

/**
 * 上海理工大学统一身份认证登录。
 *
 * 实测链路（2026-11）：
 *   1. https://1906.usst.edu.cn/login
 *        302 → 2. https://1906.usst.edu.cn:8600/auth/realms/usst/protocol/cas/login?service=…
 *        303 → 3. …/realms/usst/broker/cas-client/login?session_code=…&client_id=Tronclass
 *        303 → 4. http://ehall.usst.edu.cn/amp-auth-adapter/login?service=<keycloak broker endpoint>&state=…
 *        302 → 5. https://ids6.usst.edu.cn/authserver/login?service=<ehall loginSuccess>
 *               ← 这里出现「统一身份认证」表单（金智 IDS6）
 *        登录成功 302 → ehall loginSuccess → CAS ticket → keycloak broker endpoint
 *              → 1906 TronClass /login → 首⻚，拿到畅课 `session` Cookie
 *
 * 关键结论：
 *   - 上理 CCS 的表单不加密密码（对比厦大 Keycloak OAuth 完全不同），直接明文 POST，
 *     但是否需要图形验证码由 `/authserver/needCaptcha.html?username=` 动态决定。
 *   - 因此本模块不做"URL 拼接"，而是沿 Real 重定向链走，遇到 CAS 表单才停。
 */

const CAS_FORM_MARKERS = ['casLoginForm', 'name="execution"', 'authserver/login'];

function looksLikeCasForm(html) {
  return CAS_FORM_MARKERS.some((m) => html.includes(m)) && html.includes('name="execution"');
}

/** 从 CAS 错误页/欢迎页提取人类可读提示 */
function extractCasMessage(html) {
  const candidates = [
    /<span[^>]*id=["']msg["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*id=["']msg["'][^>]*>([\s\S]*?)<\/div>/i,
    /<p[^>]*class=["'][^"']*auth_error[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<span[^>]*class=["']auth_error[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class=["']auth_error["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m?.[1]) {
      const text = htmlToText(m[1]).replace(/^[\s:：]+/, '');
      if (text) return text;
    }
  }
  return '';
}

/** 判断是否停在 Keycloak 的"关联已有账号"确认页 */
function looksLikeLinkConfirm(html) {
  return (
    /id=["']kc-info-mgmt-password["']/i.test(html) ||
    /name=["']confirmLink["']/i.test(html) ||
    /已有账号|关联账号|继续登录/.test(html)
  );
}

export class CasLogin {
  /**
   * @param {{jar?:CookieJar}} [options]
   */
  constructor({ jar = new CookieJar() } = {}) {
    this.jar = jar;
    this.http = new HttpClient({ jar, scope: 'cas' });
    this.lastCasUrl = null;
  }

  /** 记录链路上出现过的主机，便于排查网络问题 */
  inspectChain(hops) {
    return hops.map((h) => `${h.status} ${new URL(h.url).host}${new URL(h.url).pathname}`);
  }

  /**
   * 第一阶段：走完前置跳转，抵达统一身份认证表单页。
   * 不涉及用户凭据，可安全重复调用（用于刷新验证码）。
   * @returns {Promise<{status:'cas'|'logged-in'|'link-confirm',casUrl?:string,needCaptcha?:boolean,message?:string,hops:string[],html?:string}>}
   */
  async begin() {
    const res = await this.http.follow(config.loginEntry, {
      maxRedirects: config.network.maxRedirects,
      onHop: (hop) => {
        if (looksLikeCasForm(hop.html)) {
          hop.matched = true;
          return true;
        }
        return false;
      },
    });

    const hops = this.inspectChain(res.hops);
    const html = res.html ?? '';

    if (looksLikeCasForm(html)) {
      this.lastCasUrl = res.url;
      const needCaptcha = await this.checkNeedCaptcha('');
      log.info('cas', `抵达统一身份认证表单，需要验证码=${needCaptcha}`);
      return {
        status: 'cas',
        casUrl: res.url,
        needCaptcha,
        execution: inputValue(html, 'execution'),
        hops,
        html,
      };
    }

    // 兜底：没有出现登录表单，先用 /api/profile 判断是否其实已登录
    const profile = await this.fetchProfile().catch(() => null);
    if (profile) {
      log.info('cas', '前置跳转未出现登录表单，但 /api/profile 可用 → 已是登录态');
      return { status: 'logged-in', hops, profile };
    }

    if (looksLikeLinkConfirm(html)) {
      return { status: 'link-confirm', hops, html };
    }

    return {
      status: 'unknown',
      casUrl: res.url,
      hops,
      html,
      error: `未识别到登录表单，最终停在 ${res.url}`,
    };
  }

  /** 询问是否需要图形验证码 */
  async checkNeedCaptcha(username) {
    const base = this.casBaseUrl();
    if (!base) return false;
    try {
      const res = await this.http.raw(
        `${base}/needCaptcha.html?username=${encodeURIComponent(username)}&_=${Date.now()}`,
        { headers: { accept: 'text/plain,*/*' } },
      );
      return /true/i.test(res.text);
    } catch (err) {
      log.warn('cas', `needCaptcha 查询失败: ${err.message}`);
      return false;
    }
  }

  casBaseUrl() {
    if (!this.lastCasUrl) return null;
    try {
      const u = new URL(this.lastCasUrl);
      return `${u.origin}/authserver`;
    } catch {
      return null;
    }
  }

  /** 图形验证码图片（PNG 字节流），交给前端 <img> 显示 */
  async captchaImage() {
    const base = this.casBaseUrl();
    if (!base) throw new HttpError('尚未进入统一身份认证页，无法获取验证码');
    const url = `${base}/captcha.html?ts=${Date.now()}`;
    const cookie = this.jar.headerFor(url);
    const res = await fetch(url, {
      headers: {
        'user-agent': config.userAgent,
        accept: 'image/avif,image/webp,image/png,*/*',
        ...(cookie ? { cookie } : {}),
      },
    });
    if (!res.ok) throw new HttpError(`验证码获取失败 HTTP ${res.status}`, { url, status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'image/png';
    return { buffer: buf, contentType: type };
  }

  /**
   * 第二阶段：用凭据登录，并沿重定向链一路回到畅课。
   * @returns {Promise<{ok:boolean, message?:string, needCaptcha?:boolean, hops:string[], profile?:object}>}
   */
  async login({ username, password, captcha = '' }) {
    if (!username || !password) {
      return { ok: false, message: '请输入学号与密码', hops: [] };
    }

    const begin = await this.begin();
    if (begin.status === 'logged-in') {
      return { ok: true, hops: begin.hops, message: '已处于登录状态' };
    }
    if (begin.status === 'link-confirm') {
      return {
        ok: false,
        message: '统一身份认证要求在浏览器中确认账号关联，请先用浏览器登录一次',
        hops: begin.hops,
      };
    }
    if (!begin.casUrl) {
      return { ok: false, message: begin.error ?? '登录入口异常', hops: begin.hops };
    }

    const needCaptcha = await this.checkNeedCaptcha(username);
    if (needCaptcha && !captcha) {
      return {
        ok: false,
        needCaptcha: true,
        message: '该校账号需要图形验证码，请输入验证码后重试',
        hops: begin.hops,
      };
    }

    const html = begin.html ?? '';
    const form = {
      username,
      password,
      lt: inputValue(html, 'lt') ?? '',
      dllt: inputValue(html, 'dllt') ?? 'userNamePasswordLogin',
      execution: inputValue(html, 'execution') ?? 'e1s1',
      _eventId: inputValue(html, '_eventId') ?? 'submit',
      rmShown: inputValue(html, 'rmShown') ?? '1',
    };
    if (needCaptcha) form.captchaResponse = captcha;

    log.info('cas', `提交登录：${username.slice(0, 3)}***`);

    const res = await this.http.follow(begin.casUrl, {
      method: 'POST',
      form,
      maxRedirects: config.network.maxRedirects,
      onHop: (hop) => {
        // 被弹回登录表单 = 凭据错误
        if (hop.index > 0 && looksLikeCasForm(hop.html)) {
          hop.rejected = true;
          return true;
        }
        return false;
      },
    });

    const hops = this.inspectChain(res.hops);

    if (res.hop?.rejected || looksLikeCasForm(res.html ?? '')) {
      const message = extractCasMessage(res.html ?? '') || '学号或密码错误';
      const needCaptchaAgain = await this.checkNeedCaptcha(username);
      log.warn('cas', `登录失败: ${message}`);
      return { ok: false, message, needCaptcha: needCaptchaAgain, hops };
    }

    if (looksLikeLinkConfirm(res.html ?? '')) {
      return {
        ok: false,
        message: '需要在浏览器中确认一次账号关联，之后即可正常使用',
        hops,
      };
    }

    // 最终校验：拿 profile
    try {
      const profile = await this.fetchProfile();
      if (profile) {
        log.info('cas', '登录成功，已获取 /api/profile');
        return { ok: true, hops, profile };
      }
    } catch (err) {
      log.warn('cas', `profile 校验异常: ${err.message}`);
    }

    const lastHost = res.url ? new URL(res.url).host : '';
    if (lastHost.includes('1906.usst.edu.cn')) {
      return { ok: true, hops, message: '已回到畅课站点（profile 校验未通过，可能接口版本差异）' };
    }

    return {
      ok: false,
      message: `登录未完成，最终停在 ${res.url}`,
      hops,
    };
  }

  async fetchProfile() {
    const url = `${config.tenantBase}/api/profile`;
    const res = await this.http.raw(url, {
      headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
    });
    if (res.status !== 200) return null;
    const json = tryJson(res.text);
    if (!json || typeof json !== 'object') return null;
    if (json.id || json.user_id || json.student_id || json.name) return json;
    return null;
  }
}

import { CasLogin } from './cas.mjs';
import { CookieJar } from './httpx.mjs';
import { TronClient, SessionExpired } from './tron.mjs';
import { log } from './logger.mjs';
import { clearSession, getDeviceId, loadSession, saveSession } from './store.mjs';

/**
 * 全局登录态。
 *
 * - 未登录时持有一个 `CasLogin`（保留 CAS 会话，用于取验证码、重试登录）
 * - 登录成功后换成 `TronClient`，Cookie 落盘，重启后自动恢复
 * - 密码永不落盘：只保存畅课与 CAS 的会话 Cookie
 */
class SessionManager {
  constructor() {
    /** @type {CasLogin|null} */
    this.cas = null;
    /** @type {TronClient|null} */
    this.tron = null;
    /** @type {object|null} */
    this.profile = null;
    this.username = '';
    this.restore = null;
  }

  /** 进程启动时尝试恢复上次会话 */
  async init() {
    this.restore = (async () => {
      const saved = await loadSession();
      if (!saved?.cookies?.length) return false;
      const jar = CookieJar.fromJSON(saved.cookies);
      const tron = new TronClient(jar);
      try {
        const profile = await tron.profile();
        this.tron = tron;
        this.profile = profile;
        this.username = profile.username ?? saved.username ?? '';
        // 顺手刷新一次落盘内容，保持 Cookie 最新（例如 session 续期）
        await saveSession(jar.toJSON(), this.profile, this.username);
        log.info('session', `已恢复登录态：${profile.name}`);
        return true;
      } catch (error) {
        const detail = `${error.name}: ${error.message || '(无消息)'}`;
        log.info('session', `上次会话恢复失败（${detail}）${error.stack ? `\n${error.stack.split('\n').slice(0, 4).join('\n')}` : ''}`);
        // 只有明确是会话问题才丢弃落盘 Cookie；网络抖动时保留，下次启动还能再试
        if (error instanceof SessionExpired || error.status === 401 || error.status === 403) {
          await clearSession();
        }
        return false;
      }
    })();
    return this.restore;
  }

  async ensureReady() {
    if (this.restore) await this.restore;
  }

  get loggedIn() {
    return Boolean(this.tron);
  }

  /** 未登录时的 CAS 客户端（惰性创建，保留会话以复用验证码） */
  casClient() {
    if (!this.cas) this.cas = new CasLogin();
    return this.cas;
  }

  async prepareLogin() {
    const cas = this.casClient();
    const begin = await cas.begin();
    return {
      status: begin.status,
      needCaptcha: Boolean(begin.needCaptcha),
      casUrl: begin.casUrl ?? '',
      hops: begin.hops,
      error: begin.error ?? null,
    };
  }

  async captcha() {
    return this.casClient().captchaImage();
  }

  async login({ username, password, captcha = '' }) {
    const cas = this.casClient();
    const result = await cas.login({ username, password, captcha });
    if (!result.ok) return result;

    const jar = cas.jar;
    const tron = new TronClient(jar);
    const profile = (await tron.profile().catch(() => null)) ?? null;

    this.tron = tron;
    this.profile = profile
      ? {
          id: profile.id,
          name: profile.name,
          username: profile.username ?? username,
          department: profile.department,
          klass: profile.klass,
          grade: profile.grade,
        }
      : null;
    this.username = this.profile?.username ?? username;
    this.cas = null;

    // 只落 Cookie，不落密码
    await saveSession(jar.toJSON(), this.profile, this.username);
    log.info('session', `登录成功：${this.profile?.name ?? username}`);
    return { ok: true, profile: this.profile, hops: result.hops };
  }

  async logout() {
    this.tron = null;
    this.profile = null;
    this.cas = null;
    this.username = '';
    await clearSession();
    log.info('session', '已退出登录');
  }

  /** 取业务客户端，未登录直接抛会话失效 */
  client() {
    if (!this.tron) throw new SessionExpired('尚未登录，请先登录');
    return this.tron;
  }

  /** 包装一层：会话失效时清理本地状态，避免前端反复 401 */
  async withSession(fn) {
    try {
      return await fn(this.client());
    } catch (error) {
      if (error instanceof SessionExpired) {
        log.warn('session', '会话失效，已清除本地登录态');
        await this.logout();
      }
      throw error;
    }
  }

  async deviceId() {
    return getDeviceId();
  }

  snapshot() {
    return {
      loggedIn: this.loggedIn,
      profile: this.profile,
      username: this.username,
    };
  }
}

export const session = new SessionManager();

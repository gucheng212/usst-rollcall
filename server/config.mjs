/**
 * 全局配置：上海理工大学「一网畅学」= TronClass 私有部署实例。
 *
 * 与参考项目 xmu-rollcall 的 `lib/core/network/tron_endpoints.dart` 对应，
 * 但上理与厦大的差异是登录链路：厦大走 Keycloak OAuth 直连，
 * 上理走  Keycloak(CAS client) → ehall 适配器 → 金智 IDS6 统一身份认证。
 * 因此这里的登录不是"固定 URL 拼接"，而是"沿重定向链走下去"（见 cas.mjs）。
 */

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

export const config = {
  /** 一网畅学主站（TronClass 租户） */
  tenantBase: env('USST_TENANT', 'https://1906.usst.edu.cn'),

  /** 登录入口：访问它会 302 到统一身份认证链路 */
  loginEntry: env('USST_LOGIN_ENTRY', 'https://1906.usst.edu.cn/login'),

  /** Keycloak realm 所在端口（由重定向链自动发现，此处仅作兜底/展示） */
  keycloakBase: env('USST_KEYCLOAK', 'https://1906.usst.edu.cn:8600/auth/realms/usst'),

  /** 金智统一身份认证（由重定向链自动发现，此处仅作兜底） */
  casBase: env('USST_CAS', 'https://ids6.usst.edu.cn/authserver'),

  /** TronClass 客户端标识 */
  clientId: env('USST_CLIENT_ID', 'Tronclass'),

  /** 与 TronClass H5 客户端对齐的 UA，避免被判定为异常浏览器 */
  userAgent: env(
    'USST_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ),

  /** 接口版本号（沿用 TronClass 通用值，可按需覆写） */
  apiVersionList: env('USST_API_VERSION_LIST', '1.1.0'),
  apiVersionAnswer: env('USST_API_VERSION_ANSWER', '1.76'),

  /** 本地服务 */
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '8619')),

  /** 数据目录（会话、设置、日志） */
  dataDir: env('USST_DATA_DIR', '.data'),

  /** 允许调用写接口的来源（本地服务，防同机网页 CSRF） */
  allowedOrigins: [`http://127.0.0.1:${env('PORT', '8619')}`, `http://localhost:${env('PORT', '8619')}`],

  /** 网络行为 */
  network: {
    /** 单请求超时 */
    timeoutMs: Number(env('USST_TIMEOUT_MS', '15000')),
    /** 登录链路最多跟随的重定向次数 */
    maxRedirects: Number(env('USST_MAX_REDIRECTS', '16')),
    /** 请求最小间隔（毫秒），避免触发风控 */
    minIntervalMs: Number(env('USST_MIN_INTERVAL_MS', '220')),
    /** 失败重试次数 */
    retries: Number(env('USST_RETRIES', '2')),
  },
};

export const APP = {
  name: '上理畅课助手',
  nameEn: 'USST Rollcall',
  version: '1.3.0',
  school: '上海理工大学',
  official: false,
  repo: 'usst-rollcall',
};

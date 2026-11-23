import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { log } from './logger.mjs';

/**
 * 本地持久化。
 *
 * 全部落在 `.data/persist/`：
 *   session.json  cookie 会话 + 用户摘要（不存密码）
 *   settings.json 用户设置（自动签到、检测窗口、雷达点…）
 *   device.json   安装级 deviceId（畅课作答要带上它，参考项目用 UUID v4）
 *   cache/*.json  课程 / 课表 / 签到记录缓存
 *
 * 读失败一律返回默认值，不让损坏的文件把整个应用带崩。
 */
const dir = path.join(config.dataDir, 'persist');
const cacheDir = path.join(dir, 'cache');

const DEFAULTS_SETTINGS = () => ({
  /** 自动签到总开关，默认关闭 —— 默认替用户签到是危险的 */
  autoAnswer: false,
  /** 只对哪些类型自动作答 */
  autoTypes: { number: true, qr: false, radar: false },
  /** 轮询间隔（毫秒） */
  pollIntervalMs: 20000,
  /** 检测窗口：允许自动作答的时段，空数组 = 不限制 */
  detectionWindows: [],
  /** 数字签到等待策略：等到应到人数的百分比 / 固定人数，取先满足者 */
  numberWait: { enabled: true, minRatio: 0.6, minPeople: 8, maxWaitMs: 90000 },
  /** 雷达签到的固定位置（在设置页地图/坐标里填） */
  radarLocation: null,
  /**
   * 二维码「占位数据」实验开关，默认关闭。
   * 平台会对空 data 返回 400 {"message":"no data"}，但「非空但随意」的数据会不会被校验签名，
   * 只能在真实进行中的二维码签到上试出来。开启后自动签到会拿占位串去提交一次。
   */
  qrTryPlaceholder: false,
  /** 命中签到后在页面上弹提示 */
  notify: true,
  /** 记录保留天数 */
  historyDays: 60,
});

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn('store', `读取 ${path.basename(file)} 失败：${error.message}`);
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const sessionFile = () => path.join(dir, 'session.json');
const settingsFile = () => path.join(dir, 'settings.json');
const deviceFile = () => path.join(dir, 'device.json');

/* ---------------------------------------------------------------- 会话 */

/**
 * @typedef {{cookies: object, savedAt: string, profile: object|null, username: string}} SessionState
 */
export async function loadSession() {
  const raw = await readJson(sessionFile(), null);
  if (!raw || typeof raw !== 'object' || !raw.cookies) return null;
  return raw;
}

export async function saveSession(cookies, profile, username) {
  const state = {
    username: username ?? profile?.user_no ?? '',
    profile: profile ?? null,
    cookies,
    savedAt: new Date().toISOString(),
  };
  await writeJson(sessionFile(), state);
  return state;
}

export async function clearSession() {
  await fs.rm(sessionFile(), { force: true });
}

/* ---------------------------------------------------------------- 设置 */

export async function loadSettings() {
  const raw = await readJson(settingsFile(), {});
  const base = DEFAULTS_SETTINGS();
  return {
    ...base,
    ...raw,
    autoTypes: { ...base.autoTypes, ...(raw.autoTypes ?? {}) },
    numberWait: { ...base.numberWait, ...(raw.numberWait ?? {}) },
  };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const merged = {
    ...current,
    ...patch,
    autoTypes: { ...current.autoTypes, ...(patch?.autoTypes ?? {}) },
    numberWait: { ...current.numberWait, ...(patch?.numberWait ?? {}) },
  };
  // 轮询间隔兜底，防止用户填 0 把服务打爆
  merged.pollIntervalMs = Math.min(120000, Math.max(5000, Number(merged.pollIntervalMs) || 20000));
  await writeJson(settingsFile(), merged);
  return merged;
}

/* ---------------------------------------------------------------- 设备号 */

/** 畅课作答要求的安装级 deviceId，只生成一次。 */
export async function getDeviceId() {
  const raw = await readJson(deviceFile(), null);
  if (raw?.deviceId) return raw.deviceId;
  const deviceId = randomUUID();
  await writeJson(deviceFile(), { deviceId, createdAt: new Date().toISOString() });
  log.info('store', '生成新的设备标识');
  return deviceId;
}

/* ---------------------------------------------------------------- 缓存 */

const cachePath = (name) => path.join(cacheDir, `${name}.json`);

export async function readCache(name) {
  return readJson(cachePath(name), null);
}

export async function writeCache(name, data) {
  await writeJson(cachePath(name), { savedAt: new Date().toISOString(), data });
  return data;
}

export async function clearCache(name) {
  if (name) {
    await fs.rm(cachePath(name), { force: true });
    return;
  }
  await fs.rm(cacheDir, { recursive: true, force: true });
}

export const settingsDefaults = DEFAULTS_SETTINGS;

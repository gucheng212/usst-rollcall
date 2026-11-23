import { EventEmitter } from 'node:events';
import { log } from './logger.mjs';
import { session } from './session.mjs';
import { SessionExpired } from './tron.mjs';
import { loadSettings } from './store.mjs';
import { isSettled } from './endpoints.mjs';

/**
 * 后台巡检 + 自动签到。
 *
 * 参考项目 xmu-rollcall 的 monitor_engine：定时拉「进行中的签到」，
 * 命中未处理的新签到就按用户设置的策略作答。这里保持同样的安全底线：
 *   - 默认关闭，必须用户在设置页主动开启
 *   - 只处理类型被勾选的签到
 *   - 受检测窗口限制（可选）
 *   - 每个签到只尝试一次，失败就停手并把原因抛给界面
 */
export class Monitor extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.running = false;
    this.startedAt = null;
    /** 已处理过的签到：id → {状态, 时间} */
    this.handled = new Map();
    /** 最近一次巡检结果 */
    this.lastActive = [];
    this.lastPollAt = null;
    this.lastError = null;
    this.nextPollAt = null;
    /** 巡检互斥锁，防止循环与手动触发并发重复提交 */
    this.busy = false;
  }

  get status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      lastError: this.lastError,
      activeCount: this.lastActive.length,
      handledCount: this.handled.size,
    };
  }

  /** 启动巡检循环（幂等） */
  async start() {
    if (this.running) return this.status;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    log.info('monitor', '自动巡检已启动');
    this.emit('status', this.status);
    this.loop();
    return this.status;
  }

  stop() {
    if (!this.running) return this.status;
    this.running = false;
    this.startedAt = null;
    this.nextPollAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log.info('monitor', '自动巡检已停止');
    this.emit('status', this.status);
    return this.status;
  }

  async loop() {
    if (!this.running) return;
    try {
      await this.tick();
    } catch (error) {
      this.lastError = error.message;
      if (error instanceof SessionExpired) {
        log.warn('monitor', '会话失效，巡检暂停');
        this.stop();
        return;
      }
      log.error('monitor', `巡检出错：${error.message}`);
    }
    if (!this.running) return;
    const settings = await loadSettings();
    const interval = settings.pollIntervalMs;
    this.nextPollAt = new Date(Date.now() + interval).toISOString();
    this.emit('status', this.status);
    this.timer = setTimeout(() => this.loop(), interval);
    if (this.timer.unref) this.timer.unref();
  }

  /** 单次巡检 */
  async tick() {
    if (!session.loggedIn) {
      this.stop();
      return;
    }
    // 循环与「立即检查」按钮可能同时触发；同一时刻只允许一个巡检在跑，
    // 否则同一个签到会被两条流程各提交一次。
    if (this.busy) {
      log.debug('monitor', '上一次巡检还没结束，跳过本次');
      return;
    }
    this.busy = true;
    try {
      await this.tickOnce();
    } finally {
      this.busy = false;
      this.pruneHandled();
    }
  }

  /** 已处理记录只留最近 24 小时，避免长期运行后无限增长 */
  pruneHandled() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, info] of this.handled) {
      const at = Date.parse(info.at ?? '');
      if (Number.isFinite(at) && at < cutoff) this.handled.delete(id);
    }
  }

  async tickOnce() {
    const settings = await loadSettings();
    const tron = session.client();

    const courses = await tron.courses();
    const courseIds = courses.map((c) => c.id);
    const active = await tron.activeRollcalls({ courseIds });

    this.lastPollAt = new Date().toISOString();
    this.lastActive = active;
    this.lastError = null;
    this.emit('active', active);

    if (!settings.autoAnswer) return;
    if (!withinWindow(settings.detectionWindows, new Date())) {
      log.debug('monitor', '当前不在检测窗口内，跳过自动签到');
      return;
    }

    for (const item of active) {
      if (!item.type || item.type === 'unknown') continue;
      if (!settings.autoTypes?.[item.type]) continue;
      // 已经有结果（已签到/请假）的不再补签
      if (item.settled || isSettled(item.attendance)) continue;
      const prev = this.handled.get(item.id);
      if (prev && prev.state !== 'retryable') continue;

      await this.autoAnswer(item, settings);
    }
  }

  async autoAnswer(item, settings) {
    const tron = session.client();
    const deviceId = await session.deviceId();

    // 数字签到：等出勤人数涨上来再交，避免答案被前几名"占位"
    if (item.type === 'number' && settings.numberWait?.enabled) {
      const ready = await this.waitForAttendance(item, settings);
      if (!ready) {
        this.mark(item.id, 'skipped', '等待人数超时，未自动签到');
        return;
      }
    }

    if (!item.numberCode && item.type === 'number') {
      // 尝试再取一次签到码
      try {
        const detail = await tron.rollcallDetail(item.id);
        item.numberCode = detail.numberCode;
      } catch {
        /* 忽略 */
      }
    }
    if (item.type === 'number' && !item.numberCode) {
      this.mark(item.id, 'retryable', '暂未拿到数字签到码');
      return;
    }

    try {
      const result = await tron.answer({
        type: item.type,
        rollcallId: item.id,
        deviceId,
        numberCode: item.numberCode ?? '',
        // 二维码正常情况下拿不到码；只有开了「占位数据」实验开关才拿占位串去试探平台是否校验签名
        qrData: item.type === 'qr' && settings.qrTryPlaceholder ? `probe-${item.id}` : '',
        location: settings.radarLocation,
      });
      // 平台判定不可作答（已结束/未开始）或接口不存在时，重试也没用，直接记成跳过
      // needsCode = 二维码签到拿不到码，需要人来扫/粘，记成独立状态好让界面弹提示
      const skip = result.routeMissing || result.notAnswerable || result.needsCode;
      const state = result.ok ? 'ok' : result.needsCode ? 'needsCode' : skip ? 'skipped' : 'failed';
      this.mark(item.id, state, result.message);
      this.emit('answered', { item, result });
    } catch (error) {
      if (error instanceof SessionExpired) throw error;
      this.mark(item.id, 'failed', error.message);
      this.emit('answered', { item, result: { ok: false, message: error.message } });
    }
  }

  /** 等到出勤人数达到阈值；返回是否应该继续提交 */
  async waitForAttendance(item, settings) {
    const { minRatio = 0.6, minPeople = 8, maxWaitMs = 90000 } = settings.numberWait ?? {};
    const expected = Number(item.totalStudents ?? 0) || Number(item.attendanceCount ?? 0);
    const target = Math.max(minPeople, Math.ceil(expected * minRatio));
    const deadline = Date.now() + maxWaitMs;
    const tron = session.client();

    while (Date.now() < deadline) {
      try {
        const detail = await tron.rollcallDetail(item.id);
        item.attendanceCount = detail.count;
        item.totalStudents = detail.total;
        if (!detail.numberCode && item.numberCode) detail.numberCode = item.numberCode;
        if (detail.numberCode) item.numberCode = detail.numberCode;
        log.debug('monitor', `数字签到 #${item.id} 已到 ${detail.count}/${target} 人`);
        if (detail.count >= target) return true;
        if (detail.status === 'finished') return false;
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        log.warn('monitor', `出勤人数刷新失败：${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    return false;
  }

  mark(id, state, message = '') {
    this.handled.set(id, { state, message, at: new Date().toISOString() });
    log.info('monitor', `签到 #${id} → ${state}${message ? `（${message}）` : ''}`);
    this.emit('handled', { id, state, message });
  }

  /** 手动作答（前端按钮触发），复用同一套去重记录 */
  async manualAnswer({ type, rollcallId, numberCode, qrData, location }) {
    const tron = session.client();
    const deviceId = await session.deviceId();
    const result = await tron.answer({ type, rollcallId, deviceId, numberCode, qrData, location });
    this.mark(rollcallId, result.ok ? 'ok' : 'failed', result.message);
    return result;
  }
}

/**
 * 检测窗口：空数组表示不限制；否则任一窗口命中即可。
 * 形如 `[{start:'07:30', end:'12:00', days:[1,2,3,4,5]}]`
 */
export function withinWindow(windows, now = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  // Date.getDay(): 0=周日；统一成 1..7（周一=1）
  const day = now.getDay() === 0 ? 7 : now.getDay();
  return windows.some((w) => {
    if (!w || typeof w !== 'object') return false;
    const days = Array.isArray(w.days) && w.days.length ? w.days.map(Number) : [1, 2, 3, 4, 5, 6, 7];
    if (!days.includes(day)) return false;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start === null || end === null) return false;
    return minutes >= start && minutes <= end;
  });
}

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const monitor = new Monitor();

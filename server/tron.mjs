import { config } from './config.mjs';
import { log } from './logger.mjs';
import { HttpClient, CookieJar, HttpError } from './httpx.mjs';
import {
  ANSWER_ROUTES,
  attendanceLabel,
  detectRollcallType,
  endpoints,
  isNotAnswerable,
  isRouteMissing,
  isSettled,
  normalizeAttendance,
  rollcallTypeLabel,
} from './endpoints.mjs';
import { readCache, writeCache } from './store.mjs';
import { toDate, ymd } from './util.mjs';

const JSON_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'x-requested-with': 'XMLHttpRequest',
};

export class SessionExpired extends Error {
  constructor(message = '登录状态已失效，请重新登录') {
    super(message);
    this.name = 'SessionExpired';
    this.code = 'session_expired';
  }
}

/** 上游把错误消息放在 message 里，但有时是空串，此时用兜底文案。 */
const upstreamMessage = (body, status) => body?.message || `接口返回 ${status}`;

/**
 * 畅课业务层。只负责「把接口变成有意义的数据」，不处理 HTTP 界面。
 * 所有方法在会话失效时抛 SessionExpired，由上层转成 401。
 */
export class TronClient {
  constructor(jar = new CookieJar()) {
    this.http = new HttpClient({ jar, scope: 'tron' });
    // 官方安卓 App 的每个请求都带 `x-session-id`，值来自 GET /api/captcha-code 的响应头。
    // 这是 App 与网页端唯一的行为差异，某些接口（作答）可能依赖它，所以照抄。
    this.appSessionId = null;
  }

  /** 取（并缓存）App 用的 x-session-id。失败不影响主流程。 */
  async ensureSessionId(force = false) {
    if (this.appSessionId && !force) return this.appSessionId;
    try {
      const res = await this.http.raw(`${endpoints.base()}/api/captcha-code?t=${Date.now()}`, {
        headers: { accept: 'image/jpeg,image/png,application/json' },
        timeoutMs: 12000,
        retries: 0,
      });
      const sid = res.headers?.get?.('x-session-id') ?? null;
      if (sid) {
        this.appSessionId = sid;
        log.debug('tron', 'x-session-id 已获取');
      }
    } catch (err) {
      log.debug('tron', `x-session-id 获取失败：${err.message}`);
    }
    return this.appSessionId;
  }

  /** 请求头：App 同款（X-Requested-With + x-session-id）。 */
  appHeaders() {
    return this.appSessionId ? { ...JSON_HEADERS, 'x-session-id': this.appSessionId } : JSON_HEADERS;
  }

  /** 统一发请求：解析 JSON、识别会话失效。 */
  async api(path, { method = 'GET', json = null } = {}) {
    const url = path.startsWith('http') ? path : `${endpoints.base()}${path}`;
    const res = await this.http.raw(url, { method, json, headers: this.appHeaders() });
    const contentType = res.headers.get('content-type') ?? '';
    const looksJson = contentType.includes('json') || /^\s*[[{]/.test(res.text);

    if (res.status === 401 || res.status === 403) {
      // 403 有两种：真没权限（带回 JSON message）和会话失效被重定向到登录页
      if (looksJson) {
        throw new HttpError(upstreamMessage(safeJson(res.text), res.status), {
          status: res.status,
          url,
          body: res.text.slice(0, 400),
        });
      }
      throw new SessionExpired();
    }
    if (res.status >= 300 && res.status < 400) throw new SessionExpired();
    if (!looksJson) {
      throw new HttpError(`接口返回了非 JSON 内容（${res.status}）`, {
        status: res.status,
        url,
        body: res.text.slice(0, 200),
      });
    }
    const body = safeJson(res.text);
    if (res.status >= 400) {
      throw new HttpError(upstreamMessage(body, res.status), {
        status: res.status,
        url,
        body: res.text.slice(0, 400),
      });
    }
    return body;
  }

  /* ------------------------------------------------------------ 账号 */

  async profile() {
    const data = await this.api('/api/profile');
    return {
      id: data.id,
      name: data.name,
      username: data.user_no,
      nickname: data.nickname ?? '',
      avatar: data.avatar_small_url || data.avatar_big_url || '',
      department: data.department?.name ?? '',
      klass: data.klass?.name ?? data.klass_name ?? '',
      grade: data.grade?.name ?? data.grade_name ?? '',
      email: data.email ?? '',
      totalCourse: data.total_course ?? 0,
      totalHomework: data.total_homework ?? 0,
    };
  }

  async semesters() {
    const data = await this.api('/api/semesters');
    return (data.semesters ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      active: Boolean(s.is_active),
      academicYearId: s.academic_year_id,
    }));
  }

  /* ------------------------------------------------------------ 课程 */

  /** 课程列表（带 5 分钟缓存）。 */
  async courses({ force = false } = {}) {
    if (!force) {
      const cached = await readCache('courses');
      if (cached && Date.now() - Date.parse(cached.savedAt) < 5 * 60 * 1000) return cached.data;
    }
    let lastError;
    for (let i = 0; i < 3; i++) {
      try {
        const data = await this.api(endpoints.courseList(i).replace(endpoints.base(), ''));
        const list = data.courses ?? data.data ?? [];
        if (Array.isArray(list)) {
          const courses = list.map((c) => this.normalizeCourse(c));
          await writeCache('courses', courses);
          return courses;
        }
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new HttpError('课程列表为空');
  }

  normalizeCourse(raw = {}) {
    return {
      id: raw.id,
      name: raw.name ?? '',
      code: raw.course_code ?? '',
      department: raw.department?.name ?? '',
      instructors: (raw.instructors ?? []).map((i) => i.name).filter(Boolean),
      startDate: raw.start_date ?? '',
      endDate: raw.end_date ?? '',
      academicYear: raw.academic_year?.name ?? '',
      semesterId: raw.semester_id ?? raw.semester?.id ?? null,
      semesterCode: raw.semester?.code ?? '',
      studentCount: raw.course_attributes?.student_count ?? raw.student_count ?? 0,
      teachingClass: raw.course_attributes?.teaching_class_name ?? '',
      /** 去掉「课程代码后缀」让界面更好看：`高等数学A(1)(2025-2026-1)-22000210-05` */
      shortName: shortCourseName(raw.name ?? ''),
    };
  }

  /* ------------------------------------------------------------ 课表 */

  /**
   * 上理的课表只能一门课一门课取：`GET /api/courses/{id}?fields=…timetables…`。
   * 返回按周展开的每条 occurrence，这里压成「周几 + 第几节」的固定格子。
   */
  async courseTimetable(courseId) {
    const data = await this.api(endpoints.courseDetail(courseId).replace(endpoints.base(), ''));
    const rows = Array.isArray(data.timetables) ? data.timetables : [];
    return rows.map((t) => ({
      courseId,
      dayOfWeek: Number(t.day_of_week) || 0,
      slot: Number(t.timetable_slot?.sequence ?? t.timetable_slot?.name ?? 0) || 0,
      slotName: String(t.timetable_slot?.name ?? ''),
      startTime: t.timetable_slot?.start_time ?? '',
      endTime: t.timetable_slot?.end_time ?? '',
      date: (t.start_time ?? '').slice(0, 10),
      classroom: t.classroom ?? t.location ?? t.room ?? '',
    }));
  }

  /**
   * 汇总课表格子（带 30 分钟缓存）。
   * 默认只取「当前活跃学期」的课程 —— 账号里还留着往届课程，
   * 全取会把课表塞满已经上完的课。
   */
  async timetable({ force = false, semesterId = null } = {}) {
    if (!force) {
      const cached = await readCache('timetable');
      if (cached && Date.now() - Date.parse(cached.savedAt) < 30 * 60 * 1000) return cached.data;
    }

    const courses = await this.courses();
    const semesters = await this.semesters().catch(() => []);
    const activeId = semesterId ?? semesters.find((s) => s.active)?.id ?? null;
    const scoped = activeId ? courses.filter((c) => c.semesterId === activeId) : courses;
    const picked = scoped.length ? scoped : courses;

    const cells = [];
    for (const course of picked) {
      try {
        const rows = await this.courseTimetable(course.id);
        for (const row of rows) {
          cells.push({
            ...row,
            semesterId: course.semesterId,
            courseName: course.shortName,
            fullName: course.name,
            instructors: course.instructors,
            dayOfWeek: row.dayOfWeek || dayOfWeekFromDate(row.date),
          });
        }
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        log.warn('tron', `课程 ${course.id} 课表获取失败：${error.message}`);
      }
    }

    const result = {
      cells: dedupeCells(cells),
      semester: semesters.find((s) => s.id === (activeId ?? picked[0]?.semesterId)) ?? null,
      courseCount: picked.length,
      fetchedAt: new Date().toISOString(),
    };
    await writeCache('timetable', result);
    return result;
  }

  /* ------------------------------------------------------------ 签到 */

  /** 单门课的签到记录。上理的列表项用 `rollcall_id` 作主键。 */
  async courseRollcalls(courseId, studentId, { pageSize = 100 } = {}) {
    const data = await this.api(
      endpoints.courseStudentRollcalls(courseId, studentId, { pageSize }).replace(endpoints.base(), ''),
    );
    const list = Array.isArray(data) ? data : (data.rollcalls ?? data.data ?? []);
    return list.map((raw) => this.normalizeRollcall(raw, courseId));
  }

  normalizeRollcall(raw = {}, courseId = null) {
    const type = detectRollcallType(raw);
    const attendance = normalizeAttendance(
      raw.status,
      raw.student_status,
      raw.student_status_detail,
      raw.rollcall_status,
    );
    return {
      id: raw.rollcall_id ?? raw.id ?? raw.activity_id ?? null,
      courseId: raw.course_id ?? courseId,
      courseName: raw.course_name ?? '',
      title: raw.title ?? '',
      type,
      typeLabel: rollcallTypeLabel(type),
      platformStatus: raw.rollcall_status ?? raw.status ?? 'unknown',
      attendance,
      attendanceLabel: attendanceLabel(attendance),
      settled: isSettled(attendance),
      detail: raw.student_status_detail ?? '',
      time: toDate(raw.rollcall_time ?? raw.created_at ?? raw.start_time),
      isExpired: raw.is_expired === true,
      numberCode: raw.number_code ?? null,
      signed: attendance === 'signed',
    };
  }

  /** 全部课程的签到记录（并发由全局节流串行化，带 2 分钟缓存）。 */
  async rollcallHistory({ studentId, force = false, maxCourses = 60 } = {}) {
    if (!force) {
      const cached = await readCache('rollcalls');
      if (cached && Date.now() - Date.parse(cached.savedAt) < 2 * 60 * 1000) return cached.data;
    }
    const courses = await this.courses();
    const out = [];
    let done = 0;
    for (const course of courses.slice(0, maxCourses)) {
      try {
        const rows = await this.courseRollcalls(course.id, studentId);
        for (const row of rows) {
          out.push({ ...row, courseName: course.shortName, courseFullName: course.name });
        }
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        log.warn('tron', `课程 ${course.id} 签到记录获取失败：${error.message}`);
      }
      done += 1;
      if (done % 10 === 0) log.debug('tron', `签到记录进度 ${done}/${courses.length}`);
    }
    out.sort((a, b) => (b.time ? Date.parse(b.time) : 0) - (a.time ? Date.parse(a.time) : 0));
    const result = { items: out, fetchedAt: new Date().toISOString() };
    await writeCache('rollcalls', result);
    return result;
  }

  /**
   * 进行中的签到。两条来源并起来：
   *   - `/api/radar/rollcalls` 平台主动推送的实时签到
   *   - `/api/timetable_rollcalls` 按今天课表查到的签到
   */
  async activeRollcalls({ courseIds = [], date = ymd() } = {}) {
    const found = new Map();

    const push = (raw, source) => {
      const item = this.normalizeRollcall(raw);
      if (!item.id) return;
      const prev = found.get(item.id);
      found.set(item.id, { ...prev, ...item, source: prev?.source ? `${prev.source}+${source}` : source });
    };

    const [radar, tt] = await Promise.allSettled([
      this.api('/api/radar/rollcalls'),
      courseIds.length
        ? this.api(endpoints.timetableRollcalls(courseIds, date).replace(endpoints.base(), ''))
        : Promise.resolve({ rollcalls: [] }),
    ]);

    if (radar.status === 'fulfilled') for (const raw of radar.value.rollcalls ?? []) push(raw, 'radar');
    else if (radar.reason instanceof SessionExpired) throw radar.reason;

    if (tt.status === 'fulfilled') for (const raw of tt.value.rollcalls ?? []) push(raw, 'timetable');
    else if (tt.reason instanceof SessionExpired) throw tt.reason;

    const items = [...found.values()].filter((i) => !i.isExpired);
    // 数字签到要额外取签到码与出勤人数
    for (const item of items) {
      try {
        const detail = await this.rollcallDetail(item.id);
        item.numberCode = detail.numberCode ?? item.numberCode;
        item.attendanceCount = detail.count;
        item.totalStudents = detail.total;
        item.endTime = detail.endTime;
        item.isNumber = detail.isNumber;
        item.isRadar = detail.isRadar;
        if (detail.isNumber) item.type = item.type === 'unknown' ? 'number' : item.type;
        if (detail.isRadar) item.type = item.type === 'unknown' ? 'radar' : item.type;
        item.typeLabel = rollcallTypeLabel(item.type);
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        item.detailError = error.message;
      }
    }
    items.sort((a, b) => (b.time ? Date.parse(b.time) : 0) - (a.time ? Date.parse(a.time) : 0));
    return items;
  }

  /** 签到详情：本实例 `GET /api/rollcall/{id}` 会 500，统一走 student_rollcalls。 */
  async rollcallDetail(id) {
    const data = await this.api(`/api/rollcall/${encodeURIComponent(id)}/student_rollcalls`);
    const students = Array.isArray(data.student_rollcalls) ? data.student_rollcalls : [];
    const onCall = students.filter((s) => normalizeAttendance(s.rollcall_status, s.status) === 'signed')
      .length;
    return {
      id,
      numberCode: data.number_code ?? null,
      isNumber: data.is_number === true,
      isRadar: data.is_radar === true,
      status: data.status ?? 'unknown',
      endTime: toDate(data.end_time),
      comment: data.comment ?? '',
      students: students.map((s) => ({
        name: s.name,
        userNo: s.user_no,
        status: s.status,
        attendance: normalizeAttendance(s.rollcall_status, s.status),
        distance: s.distance ?? null,
        klass: s.klass?.name ?? '',
        department: s.department?.name ?? '',
        updatedAt: toDate(s.updated_at),
      })),
      count: onCall,
      total: students.length,
    };
  }

  /**
   * 作答。
   *
   * 路由与 payload 完全照官方安卓 App（见 endpoints.ANSWER_ROUTES 的注释）。
   * 请求头也照抄 App：`X-Requested-With` + `x-session-id`。
   *
   * 失败分三类，语义完全不同，不能混：
   *   - 路由缺失（中文「未找到资源」/ 5xx HTML）→ 换候选；
   *   - 平台判定当前不可作答（英文 `Not Found`）→ 停，提示已结束/未到时间；
   *   - 业务拒绝（`rollcall_already_closed`、距离太远）→ 停，原样报告。
   */
  async answer({ type, rollcallId, deviceId, numberCode = '', qrData = '', location = null }) {
    let candidates;
    let body;

    if (type === 'number') {
      const code = String(numberCode).trim();
      body = { deviceId, numberCode: code, number_code: code, code };
      candidates = ANSWER_ROUTES.number(rollcallId);
    } else if (type === 'qr') {
      const data = String(qrData).trim();
      // 二维码里的数据只存在于那张二维码图片中，平台的任何接口都不下发（/student_rollcalls、/lite 都试过），
      // 空着提交会被服务器以 400 {"message":"no data"} 拒掉，所以这里直接告诉用户去拿码。
      if (!data) {
        return {
          ok: false,
          needsCode: true,
          status: 0,
          message:
            '二维码签到需要一个「二维码内容」：它只印在老师投屏的那张二维码里，畅课接口不向学生下发，' +
            '空着提交会被服务器以 no data 拒掉。把你扫到的那条链接粘进签到卡片，程序就能立刻提交；' +
            '想全自动只能指望平台不校验这个数据，设置页有「占位数据实验」开关可以试。',
          data: null,
          route: null,
        };
      }
      body = { deviceId, data, qr_code: data };
      candidates = ANSWER_ROUTES.qr(rollcallId);
    } else if (type === 'radar') {
      if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
        throw new HttpError('雷达签到需要先设置位置', { status: 400 });
      }
      body = {
        accuracy: location.accuracy ?? 35,
        altitude: 0,
        altitudeAccuracy: null,
        deviceId,
        heading: null,
        latitude: location.latitude,
        longitude: location.longitude,
        speed: null,
      };
      candidates = ANSWER_ROUTES.radar(rollcallId);
    } else {
      throw new HttpError('未知的签到类型', { status: 400 });
    }

    await this.ensureSessionId();

    let last = null;
    for (const candidate of candidates) {
      const url = candidate.path.startsWith('http')
        ? candidate.path
        : `${endpoints.base()}${candidate.path}`;
      const res = await this.http.raw(url, {
        method: candidate.method,
        json: body,
        headers: this.appHeaders(),
      });
      const payload = safeJson(res.text) ?? { raw: res.text.slice(0, 200) };
      const attempt = { ...candidate, status: res.status, payload };

      if (res.status === 401) throw new SessionExpired();

      if (res.status >= 200 && res.status < 300) {
        log.info('tron', `签到成功 #${rollcallId} (${type}) via ${candidate.method} ${candidate.path}`);
        return { ok: true, status: res.status, message: '提交成功', data: payload, route: candidate };
      }

      if (isNotAnswerable(res.status, payload)) {
        const message =
          '平台返回 Not Found：这次签到当前不在可作答状态（通常已结束或还没开始），没有提交任何内容。';
        log.warn('tron', `签到未提交 #${rollcallId} (${type})：${message}`);
        return { ok: false, notAnswerable: true, status: res.status, message, distance: null, data: payload, route: candidate };
      }

      if (isRouteMissing(res.status, payload)) {
        // 路由不存在，换下一个候选
        log.debug('tron', `路由不存在：${candidate.method} ${candidate.path}（${res.status}）`);
        last = { ...attempt, message: payload.message || `接口不可用（${res.status}）` };
        continue;
      }

      const distance = typeof payload.distance === 'number' ? payload.distance : null;
      const message =
        payload.message === 'rollcall_closed'
          ? '签到已结束，无法提交'
          : payload.error_code === 'rollcall_already_closed'
            ? '签到已结束，无法提交'
            : distance !== null
              ? `不在有效范围内（距离约 ${Math.round(distance)} 米）`
              : payload.message || `提交失败（${res.status}）`;
      log.warn('tron', `签到失败 #${rollcallId} (${type}) via ${candidate.path}: ${message}`);
      return { ok: false, status: res.status, message, distance, data: payload, route: candidate };
    }

    const label = type === 'number' ? '数字签到' : type === 'qr' ? '二维码签到' : '雷达签到';
    const message =
      `${label}的提交接口在本实例上不存在（所有候选路由都不可用，最后状态 ${last?.status ?? 404}）。` +
      '请把这次签到用手机上的畅课 App 完成，并在「日志」页确认详情。';
    log.warn('tron', `签到失败 #${rollcallId} (${type}): 所有候选路由都不可用`);
    return {
      ok: false,
      status: last?.status ?? 404,
      message,
      routeMissing: true,
      distance: null,
      data: last?.payload ?? null,
    };
  }

  /* ------------------------------------------------------------ 作业 */

  async todos() {
    const data = await this.api('/api/todos');
    return (data.todo_list ?? []).map((t) => ({
      id: t.id,
      type: t.type ?? '',
      title: t.title ?? '',
      courseId: t.course_id,
      courseName: shortCourseName(t.course_name ?? ''),
      courseCode: t.course_code ?? '',
      dueAt: toDate(t.end_time),
      locked: Boolean(t.is_locked),
    }));
  }

  async homeworkDetail(activityId) {
    const data = await this.api(`/api/activities/${encodeURIComponent(activityId)}`);
    return {
      id: activityId,
      title: data.title ?? '',
      courseId: data.course_id,
      dueAt: toDate(data.end_time ?? data.due_at),
      createdAt: toDate(data.created_at),
      description: data.data?.description ?? '',
      criterion: data.completion_criterion ?? '',
      averageScore: data.average_score ?? null,
    };
  }

  async submissions(activityId, studentId) {
    const data = await this.api(
      `/api/activities/${encodeURIComponent(activityId)}/students/${encodeURIComponent(studentId)}/submission_list`,
    );
    return data.list ?? [];
  }

  async courseHomework(courseId) {
    const data = await this.api(
      endpoints.courseHomeworkActivities(courseId).replace(endpoints.base(), ''),
    );
    return (data.homework_activities ?? []).map((h) => ({
      id: h.id,
      title: h.title ?? '',
      courseId: h.course_id ?? courseId,
      dueAt: toDate(h.end_time),
      started: Boolean(h.is_started ?? true),
    }));
  }
}

/* -------------------------------------------------------------- 工具 */

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `高等数学A(1)(2025-2026-1)-22000210-05` → `高等数学A(1)` */
export function shortCourseName(name) {
  const trimmed = String(name ?? '')
    .replace(/\s*\(\d{4}-\d{4}-[12]\)[-\d]*\s*$/, '')
    .trim();
  return trimmed || String(name ?? '');
}

function dayOfWeekFromDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  const js = d.getUTCDay();
  return js === 0 ? 7 : js;
}

function dedupeCells(cells) {
  const seen = new Map();
  for (const cell of cells) {
    if (!cell.dayOfWeek || !cell.slot) continue;
    const key = `${cell.courseId}|${cell.dayOfWeek}|${cell.slot}`;
    const prev = seen.get(key);
    // 同一门课同一格只留一条（不同周次会重复展开）
    if (!prev) seen.set(key, { ...cell, dates: cell.date ? [cell.date] : [] });
    else if (cell.date && !prev.dates.includes(cell.date)) prev.dates.push(cell.date);
  }
  return [...seen.values()].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.slot - b.slot || a.courseName.localeCompare(b.courseName),
  );
}

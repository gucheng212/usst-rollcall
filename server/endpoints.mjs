import { config } from './config.mjs';

/**
 * 畅课 (TronClass) 接口契约 —— 上海理工大学「一网畅学」实测版。
 *
 * 参考项目 lib/core/network/tron_endpoints.dart 只换了 baseUrl 就复用了这套路径，
 * 但上理实例（1906.usst.edu.cn）有几处与厦大不同，这里按实测结果收敛：
 *   - 签到主键字段是 `rollcall_id`（不是 id）
 *   - `GET /api/rollcall/{id}` 在本实例 500，签到详情走 `/student_rollcalls`
 *   - `timetable_rollcalls` 的多课程参数必须写成 `course_ids[]=`，逗号拼串会 500
 *   - 课表不在课程列表里，要 `GET /api/courses/{id}?fields=…timetables…` 单独取
 */
const base = () => config.tenantBase.replace(/\/+$/, '');

/** 课程列表候选路径：不同版本暴露的接口不一致，按序回退。 */
export const courseListPaths = [
  '/api/my-courses?per_page=1000',
  '/api/courses?role=student&per_page=1000',
  '/api/courses?per_page=1000',
];

/** 取课表时请求的字段集（少一个字段服务端就不返回 timetables）。 */
export const timetableFields = 'id,name,course_code,timetables,classroom_schedule,instructors(id,name)';

export const endpoints = {
  base,

  profile: () => `${base()}/api/profile`,
  semesters: () => `${base()}/api/semesters`,

  myCourses: () => `${base()}/api/my-courses`,
  courseList: (index = 0) => `${base()}${courseListPaths[index] ?? courseListPaths.at(-1)}`,

  courseDetail: (courseId, fields = timetableFields) =>
    `${base()}/api/courses/${encodeURIComponent(courseId)}?fields=${encodeURIComponent(fields)}`,

  courseStudentRollcalls: (courseId, studentId, { page = 1, pageSize = 100 } = {}) =>
    `${base()}/api/course/${encodeURIComponent(courseId)}/student/${encodeURIComponent(studentId)}/rollcalls` +
    `?page=${page}&page_size=${pageSize}`,

  radarRollcalls: () =>
    `${base()}/api/radar/rollcalls?api_version=${encodeURIComponent(config.apiVersionList)}`,

  /** 多课程必须逐项写成 course_ids[]=，否则服务端 500。 */
  timetableRollcalls: (courseIds = [], date = '') => {
    const ids = (Array.isArray(courseIds) ? courseIds : [courseIds])
      .filter((id) => id !== undefined && id !== null && `${id}` !== '')
      .map((id) => `course_ids[]=${encodeURIComponent(id)}`)
      .join('&');
    const d = date ? `&rollcall_date=${encodeURIComponent(date)}` : '';
    return `${base()}/api/timetable_rollcalls?${ids}${d}`;
  },

  /** 本实例可用：含 number_code / is_number / is_radar / 出勤名单。 */
  rollcallDetail: (id) => `${base()}/api/rollcall/${encodeURIComponent(id)}/student_rollcalls`,

  /** 单条作答路径（保留给需要精确控制的场景）。 */
  answerNumber: (id) => `${base()}/api/rollcall/${encodeURIComponent(id)}/answer_number_rollcall`,
  answerQr: (id) => `${base()}/api/rollcall/${encodeURIComponent(id)}/answer_qr_rollcall`,
  answerRadar: (id) =>
    `${base()}/api/rollcall/${encodeURIComponent(id)}/answer?api_version=${encodeURIComponent(config.apiVersionAnswer)}`,

  todos: () => `${base()}/api/todos`,

  courseHomeworkActivities: (courseId, { page = 1, pageSize = 100 } = {}) =>
    `${base()}/api/courses/${encodeURIComponent(courseId)}/homework-activities?page=${page}&page_size=${pageSize}`,
  activityDetail: (activityId) => `${base()}/api/activities/${encodeURIComponent(activityId)}`,
  homeworkSubmissions: (activityId, studentId) =>
    `${base()}/api/activities/${encodeURIComponent(activityId)}/students/${encodeURIComponent(studentId)}/submission_list`,
};

export const ROLLCALL_TYPES = ['number', 'radar', 'qr', 'unknown'];

/**
 * 作答路由。
 *
 * 依据来自官方安卓 App（`com.wisdomgarden.trpc` 2.16.1，从学校自己的
 * `https://1906.usst.edu.cn/mobile` 页面下载）里的接口表，逐条对齐：
 *   answerNumberRollcall            → PUT /api/rollcall/{id}/answer_number_rollcall
 *   answerQRRollcall                → PUT /api/rollcall/{id}/answer_qr_rollcall
 *   answerRollcall（雷达/旧版）      → PUT /api/rollcall/{id}/answer?api_version=1.76
 *   answerSelfRegistionRollcall     → PUT /api/rollcall/{id}/answer_self_registration_rollcall
 *
 * 官方 App 的学生端代码（chunk 386）就是 `{deviceId, numberCode}` PUT 第一条；
 * 二维码是 `{data, deviceId}`。本实例上 `OPTIONS` 探测确认这些路由都注册着
 * （`answer_number_rollcall` → Allow: PUT, PATCH）。
 *
 * 保留候选链只是为了容错：真实环境里若第一家租户改过路由，能自动落到底二条。
 */
export const ANSWER_ROUTES = {
  number: (id) => {
    const encoded = encodeURIComponent(id);
    const version = encodeURIComponent(config.apiVersionAnswer);
    return [
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer_number_rollcall` },
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer?api_version=${version}` },
    ];
  },
  qr: (id) => {
    const encoded = encodeURIComponent(id);
    const version = encodeURIComponent(config.apiVersionAnswer);
    return [
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer_qr_rollcall` },
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer?api_version=${version}` },
    ];
  },
  radar: (id) => {
    const encoded = encodeURIComponent(id);
    const version = encodeURIComponent(config.apiVersionAnswer);
    return [
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer_radar_rollcall` },
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer?api_version=${version}` },
      { method: 'PUT', path: `/api/rollcall/${encoded}/answer?api_version=${encodeURIComponent(config.apiVersionList)}` },
    ];
  },
};

/**
 * 判断一次作答失败是不是「这条路根本不存在」。
 *
 * 上理这套接口有两种 404，来源不同：
 *   - 中文 `{"message":"未找到资源"}` → 路由没注册，换候选；
 *   - 英文 `{"message":"Not Found"}`   → 路由在（`OPTIONS` 会回 Allow: PUT, PATCH），
 *     但平台认为这次签到当前不可作答（已结束 / 未到时间）。此时换候选也没有意义。
 * 另外上理对「方法不对」返回 500 HTML 而不是 405，所以 5xx 也按路由缺失处理。
 */
export function isRouteMissing(status, payload) {
  if (status >= 500) return true;
  if (status === 405) return true;
  if (status !== 404) return false;
  return !isNotAnswerable(status, payload);
}

/** 路由存在、但平台判定这次签到当前不可作答（英文 Not Found）。 */
export function isNotAnswerable(status, payload) {
  if (status !== 404) return false;
  return String(payload?.message ?? '').trim() === 'Not Found';
}

const TYPE_LABELS = { number: '数字签到', radar: '雷达签到', qr: '二维码签到', unknown: '未知类型' };

export const rollcallTypeLabel = (type) => TYPE_LABELS[type] ?? TYPE_LABELS.unknown;

/**
 * 用签到对象上的布尔标记 + type/source 字符串判断签到方式。
 * 上理的列表项形如 `{is_number:false,is_radar:false,type:'qr_rollcall',source:'qr'}`。
 */
export function detectRollcallType(raw = {}) {
  if (raw.is_radar === true) return 'radar';
  if (raw.is_number === true) return 'number';
  if (raw.is_qrcode === true || raw.is_qr === true) return 'qr';
  const v = `${raw.type ?? ''} ${raw.rollcall_type ?? ''} ${raw.source ?? ''}`.toLowerCase();
  if (v.includes('radar') || v.includes('location')) return 'radar';
  if (v.includes('number') || v.includes('digit')) return 'number';
  if (v.includes('qr')) return 'qr';
  return 'unknown';
}

export function normalizeRollcallType(raw) {
  if (typeof raw === 'object' && raw !== null) return detectRollcallType(raw);
  const v = String(raw ?? '').toLowerCase();
  if (v.includes('number') || v === '1' || v === 'num') return 'number';
  if (v.includes('radar') || v.includes('location') || v === '2') return 'radar';
  if (v.includes('qr') || v.includes('qrcode') || v === '3') return 'qr';
  return 'unknown';
}

const SIGNED = ['on_call_fine', 'signed', 'present', 'attended', 'fine', 'done', 'on_call', 'late', 'on_late'];
const ABSENT = ['on_call_absence', 'absent', 'absence', 'missed', 'not_signed', 'unsigned', 'unanswered', 'truancy'];
const LEAVE = ['on_personal_leave', 'on_sick_leave', 'on_leave', 'personal_leave', 'sick_leave', 'leave'];

/**
 * 归一化签到结果：`signed` / `leave` / `absent` / `unknown`。
 *
 * 上理这套接口有两个坑，所以这里接收「任意多个状态值」一起判断：
 *   1. 列表接口里 `rollcall_status` 是整场签到的状态（finished），本人结果在 `status`；
 *      详情接口反而把本人结果放在 `rollcall_status`（on_call_fine），`status` 只是粗分类。
 *   2. `on_call`（签到正常）和 `on_call_absence`（缺勤）互为前缀，必须先判缺勤/请假。
 */
export function normalizeAttendance(...values) {
  const flat = values
    .flat(3)
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter(Boolean);

  if (flat.some((v) => ABSENT.some((x) => v === x || v.includes(x)))) return 'absent';
  if (flat.some((v) => LEAVE.some((x) => v === x || v.includes(x)))) return 'leave';
  if (flat.some((v) => SIGNED.some((x) => v === x || v.includes(x)))) return 'signed';
  return 'unknown';
}

/** 已经「有结果」的状态，不再需要（也不应该）自动补签。 */
export const isSettled = (state) => state === 'signed' || state === 'leave';

export const attendanceLabel = (state) =>
  ({ signed: '已签到', leave: '请假', absent: '缺勤', unknown: '未知' })[state] ?? '未知';

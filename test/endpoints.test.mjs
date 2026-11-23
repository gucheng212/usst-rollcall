import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANSWER_ROUTES,
  attendanceLabel,
  detectRollcallType,
  endpoints,
  isRouteMissing,
  isNotAnswerable,
  isSettled,
  normalizeAttendance,
  normalizeRollcallType,
  rollcallTypeLabel,
} from '../server/endpoints.mjs';

/* ------------------------------------------------------------------
 * 归档真实响应：上理列表接口里 rollcall_status 是整场签到状态，
 * status 才是本人结果；详情接口两者含义互换。分类必须两种都吃得住。
 * ------------------------------------------------------------------ */

test('列表接口：status=on_call_fine 判为已签到', () => {
  assert.equal(normalizeAttendance('on_call_fine', 'on_call', '', 'finished'), 'signed');
});

test('列表接口：status=absent 判为缺勤', () => {
  assert.equal(normalizeAttendance('absent', 'absent', '', 'finished'), 'absent');
});

test('列表接口：事假单独成一类，不算缺勤', () => {
  assert.equal(normalizeAttendance('on_personal_leave', 'on_leave', '事假', 'finished'), 'leave');
});

test('详情接口：本人结果在 rollcall_status 里也能判出来', () => {
  // 详情里 status='on_call'、rollcall_status='on_call_fine'
  assert.equal(normalizeAttendance('on_call', 'on_call_fine'), 'signed');
});

test('on_call_absence 不会被 on_call 前缀误判为已签到', () => {
  assert.equal(normalizeAttendance('on_call_absence'), 'absent');
});

test('平台状态 finished 不会被当成已签到', () => {
  assert.equal(normalizeAttendance('finished'), 'unknown');
});

test('完全空值返回 unknown', () => {
  assert.equal(normalizeAttendance(undefined, null, ''), 'unknown');
});

test('isSettled 只对已签到/请假成立', () => {
  assert.equal(isSettled('signed'), true);
  assert.equal(isSettled('leave'), true);
  assert.equal(isSettled('absent'), false);
  assert.equal(isSettled('unknown'), false);
});

test('attendanceLabel 中文标签', () => {
  assert.equal(attendanceLabel('signed'), '已签到');
  assert.equal(attendanceLabel('leave'), '请假');
  assert.equal(attendanceLabel('absent'), '缺勤');
  assert.equal(attendanceLabel('unknown'), '未知');
});

/* ------------------------------------------------------------ 类型 */

test('类型识别：平台把类型写在 source 里（type 常为 another）', () => {
  assert.equal(detectRollcallType({ type: 'another', source: 'number' }), 'number');
  assert.equal(detectRollcallType({ type: 'another', source: 'qr' }), 'qr');
  assert.equal(detectRollcallType({ type: 'another', source: 'radar' }), 'radar');
});

test('类型识别：优先相信 is_number / is_radar 标志', () => {
  assert.equal(detectRollcallType({ is_number: true, type: 'qr_rollcall' }), 'number');
  assert.equal(detectRollcallType({ is_radar: true, type: 'qr_rollcall' }), 'radar');
});

test('类型识别：经典 qr_rollcall 形状', () => {
  assert.equal(detectRollcallType({ type: 'qr_rollcall', source: 'qr' }), 'qr');
});

test('类型识别：认不出来时给 unknown，不要瞎猜', () => {
  assert.equal(detectRollcallType({ type: 'another', source: '' }), 'unknown');
  assert.equal(detectRollcallType({}), 'unknown');
});

test('类型标签', () => {
  assert.equal(rollcallTypeLabel('number'), '数字签到');
  assert.equal(rollcallTypeLabel('qr'), '二维码签到');
  assert.equal(rollcallTypeLabel('radar'), '雷达签到');
  assert.equal(rollcallTypeLabel('unknown'), '未知类型');
});

test('normalizeRollcallType 兼容纯字符串输入', () => {
  assert.equal(normalizeRollcallType('1'), 'number');
  assert.equal(normalizeRollcallType('radar_rollcall'), 'radar');
  assert.equal(normalizeRollcallType('QRCode'), 'qr');
  assert.equal(normalizeRollcallType('乱码'), 'unknown');
});

/* ------------------------------------------------------------ URL */

test('URL 构造：租户地址统一 1906 域名', () => {
  assert.ok(endpoints.base().startsWith('https://1906.usst.edu.cn'));
  assert.equal(endpoints.profile(), 'https://1906.usst.edu.cn/api/profile');
});

test('URL 构造：多课程签到查询必须逐项 course_ids[]=，逗号会 500', () => {
  const url = endpoints.timetableRollcalls([11, 22], '2026-11-23');
  assert.ok(url.includes('course_ids[]=11'), url);
  assert.ok(url.includes('course_ids[]=22'), url);
  assert.ok(!url.includes('course_ids=11%2C22'), url);
  assert.ok(url.includes('rollcall_date=2026-11-23'), url);
});

test('URL 构造：取签到详情走 student_rollcalls（/api/rollcall/{id} 会 500）', () => {
  assert.equal(
    endpoints.rollcallDetail(123456),
    'https://1906.usst.edu.cn/api/rollcall/123456/student_rollcalls',
  );
});

test('作答候选路由：二维码首选已实测确认的 PUT answer_qr_rollcall', () => {
  const routes = ANSWER_ROUTES.qr(123456);
  assert.equal(routes[0].method, 'PUT');
  assert.ok(routes[0].path.endsWith('/api/rollcall/123456/answer_qr_rollcall'));
});

test('作答候选路由：数字/雷达都至少有一条候选，且不重复', () => {
  for (const type of ['number', 'radar']) {
    const routes = ANSWER_ROUTES[type](1);
    assert.ok(routes.length >= 1, type);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    assert.equal(new Set(keys).size, keys.length, `${type} 候选有重复`);
  }
});

test('作答候选路由：数字签到首选官方 App 的 answer_number_rollcall', () => {
  const routes = ANSWER_ROUTES.number(234567);
  assert.equal(routes[0].method, 'PUT');
  assert.ok(routes[0].path.endsWith('/api/rollcall/234567/answer_number_rollcall'));
});

test('路由缺失判定：中文 404 / 405 / 5xx 才算缺失，英文 Not Found 是"当前不可作答"', () => {
  assert.equal(isRouteMissing(404, { message: '未找到资源' }), true);
  assert.equal(isRouteMissing(404, { message: 'Not Found' }), false); // 路由在（OPTIONS 回 Allow: PUT, PATCH）
  assert.equal(isRouteMissing(405, {}), true);
  assert.equal(isRouteMissing(500, {}), true);
  assert.equal(isRouteMissing(400, { error_code: 'rollcall_already_closed' }), false);
  assert.equal(isRouteMissing(403, { message: '无权限' }), false);
  assert.equal(isRouteMissing(200, {}), false);
});

test('不可作答判定：只有英文 Not Found 才算', () => {
  assert.equal(isNotAnswerable(404, { message: 'Not Found' }), true);
  assert.equal(isNotAnswerable(404, { message: '未找到资源' }), false);
  assert.equal(isNotAnswerable(400, { message: 'rollcall_closed' }), false);
  assert.equal(isNotAnswerable(200, {}), false);
});

test('URL 构造：课表要带 fields=timetables', () => {
  const url = endpoints.courseDetail(146399);
  assert.ok(url.includes('/api/courses/146399'), url);
  assert.ok(url.includes('timetables'), url);
});

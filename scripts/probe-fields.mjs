/**
 * 探查课表对象里还有哪些可用字段（教室、周次等），以及当前活跃学期下有多少门课。
 * 跑法: node .\scripts\probe-fields.mjs
 */
import { loadSession } from '../server/store.mjs';
import { CookieJar } from '../server/httpx.mjs';
import { TronClient } from '../server/tron.mjs';

const saved = await loadSession();
if (!saved) {
  console.error('没有已保存的会话，请先在网页里登录一次');
  process.exit(1);
}

const tron = new TronClient(CookieJar.fromJSON(saved.cookies));
const semesters = await tron.semesters();
const active = semesters.find((s) => s.active);
console.log('活跃学期:', active);

const courses = await tron.courses();
const bySemester = new Map();
for (const c of courses) bySemester.set(c.semesterId, (bySemester.get(c.semesterId) ?? 0) + 1);
console.log('课程按学期分布:', [...bySemester.entries()]);

const target = courses.find((c) => c.semesterId === active.id);
console.log('\n取样课程:', target.id, target.name);

const raw = await tron.api(`/api/courses/${target.id}`);
console.log('课程详情顶层字段:', Object.keys(raw));

// 只有在 fields 里点名 timetables 才会返回课表
const withTt = await tron.api(
  `/api/courses/${target.id}?fields=${encodeURIComponent('id,name,timetables,classroom_schedule')}`,
);
console.log('带 fields 的顶层字段:', Object.keys(withTt));
const first = withTt.timetables?.[0];
console.log('timetable[0] 全部字段:', JSON.stringify(first, null, 2));
if (withTt.classroom_schedule) {
  console.log('classroom_schedule[0]:', JSON.stringify(withTt.classroom_schedule[0], null, 2));
}

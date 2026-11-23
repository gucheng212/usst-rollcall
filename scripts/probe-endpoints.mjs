/**
 * 接口发现：批量探测候选 endpoint，输出 status + 结构摘要。
 * 用于确定上理实例实际暴露的 课表 / 签到列表 / 作业 接口。
 */
import { CasLogin } from '../server/cas.mjs';
import { endpoints } from '../server/endpoints.mjs';

const cas = new CasLogin();
const login = await cas.login({ username: process.env.USST_USER, password: process.env.USST_PASS });
if (!login.ok) {
  console.error('登录失败', login.message);
  process.exit(1);
}
const profile = login.profile;
const base = endpoints.base();

const api = async (path) => {
  const res = await cas.http.raw(`${base}${path}`, {
    headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* not json */
  }
  const summary = json
    ? `keys=${Object.keys(json).slice(0, 10).join(',')}`
    : `text=${res.text.slice(0, 80).replace(/\s+/g, ' ')}`;
  return { status: res.status, json, summary, text: res.text };
};

const candidates = [
  '/api/timetables',
  '/api/timetables?per_page=100',
  '/api/my-timetables',
  '/api/student/timetables',
  '/api/timetable_rollcalls',
  '/api/courses?role=student&per_page=1000',
  '/api/rollcalls',
  '/api/rollcalls?page=1&page_size=20',
  '/api/my-rollcalls',
  '/api/student/rollcalls',
  '/api/radar/rollcalls',
  '/api/radar/rollcalls?api_version=1.1.0',
  '/api/todos',
  '/api/activities',
  '/api/announcements',
  '/api/user/semesters',
  '/api/semesters',
  '/api/klasses',
];

console.log('--- endpoint discovery ---');
for (const path of candidates) {
  try {
    const r = await api(path);
    console.log(`${String(r.status).padEnd(4)} ${path.padEnd(46)} ${r.summary}`);
    if (r.status === 200 && r.json && ['/api/timetables', '/api/my-timetables', '/api/student/timetables', '/api/semesters', '/api/user/semesters'].includes(path)) {
      console.log('      sample:', JSON.stringify(r.json).slice(0, 700));
    }
  } catch (err) {
    console.log(`ERR  ${path} ${err.message}`);
  }
}

console.log('\n--- 课表字段探测：/api/timetables?with_timetable ---');
const tt = await api(`/api/timetables?query[user_id]=${profile.id}&per_page=200`);
console.log(tt.status, JSON.stringify(tt.json).slice(0, 900));

console.log('\n--- 扫描各课程的签到记录 ---');
const courses = (await api('/api/my-courses?per_page=1000')).json?.courses ?? [];
let found = 0;
const active = [];
for (const c of courses) {
  const r = await api(`/api/course/${c.id}/student/${profile.id}/rollcalls?page=1&page_size=100`);
  const list = r.json?.rollcalls ?? [];
  if (list.length) {
    found += list.length;
    console.log(`  ${c.name.slice(0, 34)} → ${list.length} 条`);
    if (found === list.length) {
      console.log('  ROLLCALL SAMPLE:', JSON.stringify(list[0]).slice(0, 1400));
      for (const rc of list.slice(0, 3)) {
        const detail = await api(`/api/rollcall/${rc.id}`);
        console.log(`  DETAIL ${rc.id}:`, JSON.stringify(detail.json).slice(0, 900));
      }
    }
    active.push(...list.map((rc) => ({ course: c.name, ...rc })));
  }
}
console.log('TOTAL rollcalls:', found);

console.log('\n--- 进行中/最近签到（timetable_rollcalls 试探） ---');
const today = new Date().toISOString().slice(0, 10);
const todayCourses = courses.slice(0, 3).map((c) => c.id).join(',');
const tr = await api(`/api/timetable_rollcalls?course_ids=${todayCourses}&rollcall_date=${today}`);
console.log(tr.status, JSON.stringify(tr.json).slice(0, 600));

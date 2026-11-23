/**
 * 作答路由矩阵复查：对一条已结束的签到发各种方法/路径，
 * 用 404 与 400/500 的区别判断路由是否存在（400 = 路由在，但签到已关闭）。
 */
import { loadSession } from '../server/store.mjs';
import { CookieJar, HttpClient } from '../server/httpx.mjs';
import { TronClient } from '../server/tron.mjs';
import { endpoints } from '../server/endpoints.mjs';

const saved = await loadSession();
const tron = new TronClient(CookieJar.fromJSON(saved.cookies));
const http = new HttpClient({ jar: CookieJar.fromJSON(saved.cookies), scope: 'probe' });

const profile = await tron.profile();
const courses = await tron.courses();
// 找第一门有签到记录的课，不限学期
let list = [];
for (const course of courses) {
  list = await tron.courseRollcalls(course.id, profile.id);
  if (list.length) break;
}
const target = list.find((r) => r.id);
if (!target) throw new Error('该账号没有任何签到记录，无法探测作答路由');
console.log('探测目标签到', target.id, target.typeLabel, target.platformStatus);

const body = {
  deviceId: '00000000-0000-4000-8000-000000000000',
  numberCode: '1234',
  data: 'probe',
  accuracy: 35,
  altitude: 0,
  altitudeAccuracy: null,
  heading: null,
  latitude: 31.3,
  longitude: 121.5,
  speed: null,
};

const attempts = [
  ['PUT', `/api/rollcall/${target.id}/answer_radar_rollcall`],
  ['PUT', `/api/rollcall/${target.id}/answer_radar`],
  ['PUT', `/api/rollcall/${target.id}/radar_answer`],
  ['PUT', `/api/rollcall/${target.id}/answer_number_rollcall`],
  ['POST', `/api/rollcall/${target.id}/answer_number_rollcall`],
  ['PUT', `/api/rollcall/${target.id}/answer_qr_rollcall`],
  ['POST', `/api/rollcall/${target.id}/answer_qr_rollcall`],
  ['PUT', `/api/rollcall/${target.id}/answer?api_version=1.76`],
  ['PUT', `/api/rollcall/${target.id}/answer?api_version=1.1.0`],
  ['PUT', `/api/rollcall/${target.id}/student_rollcalls`],
];

for (const [method, path] of attempts) {
  const res = await http.raw(`${endpoints.base()}${path}`, {
    method,
    json: body,
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  });
  const snippet = res.text.replace(/\s+/g, ' ').slice(0, 110);
  console.log(`${String(res.status).padEnd(4)} ${method.padEnd(5)} ${path.replace(String(target.id), '{id}')} :: ${snippet}`);
}

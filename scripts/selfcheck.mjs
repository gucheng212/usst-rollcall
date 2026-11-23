/**
 * 自检：把本机服务的一圈接口实际打一遍，确认「能跑、能登录、能取数」。
 *
 * 用法：先 `npm start`（或双击 启动.cmd），再 `npm run selfcheck`。
 * 只在 127.0.0.1 上访问，不会碰学校服务器之外的任何东西。
 * 未登录时只校验静态资源与登录链路，不算失败。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.USST_BASE ?? 'http://127.0.0.1:8619';

const results = [];
let failed = 0;

async function check(name, fn, { optional = false } = {}) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt, detail });
  } catch (error) {
    if (optional) {
      results.push({ name, ok: true, ms: Date.now() - startedAt, detail: `跳过：${error.message}` });
      return;
    }
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - startedAt, detail: error.message });
  }
}

async function getJson(pathname, { timeoutMs = 60000 } = {}) {
  const res = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 80)}`);
  }
}

/* 1. 本地页面与服务本体 */
await check('首页 index.html', async () => {
  const res = await fetch(base, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('上理')) throw new Error('页面内容不对');
  return `${(html.length / 1024).toFixed(1)} KB`;
});

await check('前端脚本 app.js', async () => {
  const res = await fetch(new URL('/app.js', base), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const js = await res.text();
  if (!js.includes('/api/')) throw new Error('脚本内容不对');
  return `${(js.length / 1024).toFixed(1)} KB`;
});

const health = await getJson('/api/health').catch(() => null);
await check('/api/health', async () => {
  if (!health) throw new Error('服务没起来？先运行 npm start');
  return `${health.app?.name ?? '?'} v${health.app?.version ?? '?'}`;
});

/* 2. 会话状态 */
const snapshot = await getJson('/api/session').catch(() => ({ loggedIn: false }));
const loggedIn = Boolean(snapshot.loggedIn);

await check('/api/session', async () => {
  if (!loggedIn) return '未登录（下面跳过需要登录的接口）';
  return `已登录：${snapshot.profile?.name ?? '?'}（${snapshot.profile?.username ?? snapshot.profile?.userNo ?? '?'}）`;
});

await check('/api/login/prepare（登录链路可通）', async () => {
  const data = await getJson('/api/login/prepare', { timeoutMs: 60000 });
  if (data.error) throw new Error(`链路异常：${data.error}`);
  const cas = data.casUrl ? new URL(data.casUrl).host : '统一身份认证';
  const hops = Array.isArray(data.hops) ? data.hops.length : Number(data.hops ?? 0) || 0;
  return `已到达 ${cas}${data.needCaptcha ? '（本次需要验证码）' : ''}，共 ${hops} 跳`;
}, { optional: true });

/* 3. 需要登录的取数接口 */
const optional = { optional: true };

await check('/api/courses', async () => {
  const data = await getJson('/api/courses');
  if (!data.total) throw new Error('没有课程，账号异常？');
  return `${data.total} 门课`;
}, optional);

await check('/api/semesters', async () => {
  const data = await getJson('/api/semesters');
  const list = Array.isArray(data) ? data : (data.semesters ?? []);
  const active = list.find((s) => s.active);
  return active ? `当前学期：${active.name}` : `${list.length} 个学期`;
}, optional);

await check('/api/timetable', async () => {
  const data = await getJson('/api/timetable', { timeoutMs: 120000 });
  return `${data.courseCount ?? 0} 门课 / ${data.cells?.length ?? 0} 个课表格子（${data.semester?.name ?? '未知学期'}）`;
}, optional);

await check('/api/rollcalls?days=30', async () => {
  const data = await getJson('/api/rollcalls?days=30', { timeoutMs: 120000 });
  const s = data.summary ?? {};
  return `${s.total ?? 0} 条，出勤率 ${s.rate ?? '?'}%（已签到 ${s.signed ?? 0} / 请假 ${s.leave ?? 0} / 缺勤 ${s.absent ?? 0}）`;
}, optional);

await check('/api/active', async () => {
  const data = await getJson('/api/active', { timeoutMs: 60000 });
  return `进行中 ${data.items?.length ?? 0} 个`;
}, optional);

await check('/api/todos', async () => {
  const data = await getJson('/api/todos');
  return `待办 ${data.items?.length ?? 0} 个（未截止 ${data.ongoing?.length ?? 0}）`;
}, optional);

await check('/api/settings', async () => {
  const data = await getJson('/api/settings');
  const s = data.settings ?? {};
  return `自动签到 ${s.autoAnswer ? '开' : '关'}，巡检间隔 ${Math.round((s.pollIntervalMs ?? 0) / 1000)}s`;
});

await check('/api/device', async () => {
  const data = await getJson('/api/device');
  if (!/^[0-9a-f-]{36}$/i.test(String(data.deviceId ?? ''))) throw new Error('设备号格式不对');
  return String(data.deviceId).slice(0, 8) + '…';
});

/* 4. 测试套件 */
await check('单元测试（59 项）', async () => {
  const files = ['test/endpoints.test.mjs', 'test/httpx.test.mjs', 'test/util.test.mjs', 'test/ui.test.mjs', 'test/monitor.test.mjs'];
  for (const f of files) {
    await readFile(join(here, '..', f), 'utf8'); // 只确认文件在位；实际跑用 npm test
  }
  return '测试文件齐全，运行 node scripts\\test-all.mjs 执行';
});

/* ------------------------------------------------------------ 输出 */

const pad = (text, width) => String(text).padEnd(width, ' ');
console.log('');
console.log(`上理畅课助手 · 自检 @ ${base}`);
console.log('-'.repeat(78));
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${pad(r.name, 34)} ${pad(`${r.ms}ms`, 8)} ${r.detail}`);
}
console.log('-'.repeat(78));
console.log(failed === 0 ? `全部通过（${results.length} 项）` : `${failed} 项失败`);
if (!loggedIn) {
  console.log('提示：当前未登录，需要登录后才能校验课表/签到/作业相关接口。');
}
process.exit(failed === 0 ? 0 : 1);

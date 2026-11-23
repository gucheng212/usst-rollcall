// 盯梢：等下一次真正「进行中」的数字签到出现，立刻用官方 App 同一套请求提交，
// 把原始 HTTP 往返打印出来 —— 这是验证数字签到能否成功的唯一可靠办法
// （平台上已结束的签到一律返回 404 Not Found，看不出路由是否可用）。
//
// 用法：
//   node .\scripts\watch-live.mjs                 # 只看，不提交（默认）
//   node .\scripts\watch-live.mjs --try           # 出现数字签到时真的提交一次
//   node .\scripts\watch-live.mjs --minutes 45    # 盯 45 分钟（默认 30）
//
// 注意：--try 会把你的真实出勤记录提交上去，只在你自己也想签到的时候用。
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../server/config.mjs';
import { session } from '../server/session.mjs';

const args = process.argv.slice(2);
const TRY = args.includes('--try');
const minutesArg = args.indexOf('--minutes');
const MINUTES = minutesArg >= 0 ? Number(args[minutesArg + 1]) || 30 : 30;
const INTERVAL_MS = 15000;
const LOG_DIR = join(config.dataDir);
const LOG_FILE = join(LOG_DIR, 'live-watch.log');

await mkdir(LOG_DIR, { recursive: true });
const log = async (text) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${text}`;
  console.log(line);
  await appendFile(LOG_FILE, line + '\n', 'utf8').catch(() => {});
};

await session.init();
if (!session.snapshot()?.loggedIn) {
  console.error('未登录：先启动服务并在页面上登录一次');
  process.exit(1);
}
const tron = session.client();
const me = await tron.profile();
const deviceId = await session.deviceId();

// 只盯本学期在上的课：/api/timetable_rollcalls 必须逐门带 course_ids[]，
// 不带的话只会看到 /api/radar/rollcalls 那一路，容易漏掉数字签到。
const semesters = await tron.semesters().catch(() => []);
const activeId = semesters.find((s) => s.active)?.id ?? null;
const courses = await tron.courses().catch(() => []);
const courseIds = courses
  .filter((c) => (activeId ? c.semesterId === activeId : true))
  .map((c) => c.id);

await log(`开始盯梢：${me.name}（${me.username}），每 ${INTERVAL_MS / 1000}s 一轮，共 ${MINUTES} 分钟`);
await log(`本学期 ${courseIds.length} 门课纳入监听：${courseIds.join(',')}`);
await log(TRY ? '模式：发现进行中的数字签到会真的提交一次' : '模式：只观察，不提交（加 --try 才会提交）');

const handled = new Set();
const deadline = Date.now() + MINUTES * 60000;
let rounds = 0;

while (Date.now() < deadline) {
  rounds += 1;
  try {
    const items = await tron.activeRollcalls({ courseIds });
    const live = items.filter((it) => !it.settled);
    if (live.length) {
      await log(`第 ${rounds} 轮：进行中 ${live.length} 条`);
      for (const item of live) {
        const tag = `#${item.id} ${item.typeLabel} ${item.title || ''} ${item.courseName || ''}`.trim();
        if (!handled.has(item.id)) {
          await log(`  ${tag}  end=${item.endTime ?? '-'}  number_code=${item.numberCode ?? '-'}`);
        }
        if (!TRY || handled.has(item.id) || item.type !== 'number') continue;
        handled.add(item.id);
        let code = item.numberCode ?? '';
        if (!code) {
          try {
            const detail = await tron.rollcallDetail(item.id);
            code = detail.numberCode ?? '';
          } catch (err) {
            await log(`  取签到码失败：${err.message}`);
          }
        }
        if (!code) {
          await log('  没有拿到签到码，跳过');
          continue;
        }
        await log(`  → 用 ${code} 提交 ${item.id}`);
        const result = await tron.answer({ type: 'number', rollcallId: item.id, deviceId, numberCode: code });
        await log(`  ← status=${result.status} ok=${result.ok} message=${result.message}`);
        await log(`     raw=${JSON.stringify(result.data)} route=${result.route?.method} ${result.route?.path}`);
      }
    } else if (rounds % 8 === 0) {
      await log(`第 ${rounds} 轮：无进行中签到`);
    }
  } catch (err) {
    await log(`第 ${rounds} 轮出错：${err.message}`);
    if (/登录|Session/i.test(err.message)) break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await log(`结束：共 ${rounds} 轮，提交过 ${handled.size} 条`);

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, APP } from './config.mjs';
import { log, recentLogs, clearLogFile, readLogFile } from './logger.mjs';
import { session } from './session.mjs';
import { monitor } from './monitor.mjs';
import { SessionExpired } from './tron.mjs';
import { clearCache, getDeviceId, loadSettings, saveSettings, settingsDefaults } from './store.mjs';
import { jsonBody, sendJson, sendText, HttpError } from './httpserver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..', 'web');

/** 前端事件订阅（SSE） */
const subscribers = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) {
    res.write(frame);
  }
}

monitor.on('status', (status) => broadcast('monitor', status));
monitor.on('active', (active) => broadcast('active', active));
monitor.on('answered', (payload) => broadcast('answered', payload));
monitor.on('handled', (payload) => broadcast('handled', payload));

/* ------------------------------------------------------------ 路由 */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', '/api/health', async () => ({
  app: APP,
  time: new Date().toISOString(),
  session: session.snapshot(),
  monitor: monitor.status,
}));

route('GET', '/api/session', async () => session.snapshot());

route('GET', '/api/login/prepare', async () => session.prepareLogin());

route('GET', '/api/captcha', async (req, res) => {
  const { buffer, contentType } = await session.captcha();
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': buffer.length,
  });
  res.end(buffer);
  return null;
});

route('POST', '/api/login', async (req) => {
  const body = await jsonBody(req);
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const captcha = String(body.captcha ?? '').trim();
  if (!username || !password) throw new HttpError('请输入学号与密码', { status: 400 });
  const result = await session.login({ username, password, captcha });
  if (result.ok) {
    broadcast('session', session.snapshot());
    // 登录后顺手把巡检拉起来（是否自动作答由设置决定）
    monitor.start().catch(() => {});
  }
  return {
    ok: result.ok,
    message: result.message ?? (result.ok ? '登录成功' : '登录失败'),
    needCaptcha: Boolean(result.needCaptcha),
    profile: result.profile ?? null,
    session: session.snapshot(),
  };
});

route('POST', '/api/logout', async () => {
  monitor.stop();
  await session.logout();
  broadcast('session', session.snapshot());
  return { ok: true };
});

route('GET', '/api/courses', async (req) =>
  session.withSession(async (tron) => {
    const force = req.query.get('force') === '1';
    const courses = await tron.courses({ force });
    return { courses, total: courses.length };
  }),
);

route('GET', '/api/semesters', async () =>
  session.withSession((tron) => tron.semesters()),
);

route('GET', '/api/timetable', async (req) =>
  session.withSession(async (tron) => {
    const force = req.query.get('force') === '1';
    return tron.timetable({ force });
  }),
);

route('GET', '/api/rollcalls', async (req) =>
  session.withSession(async (tron) => {
    const force = req.query.get('force') === '1';
    const profile = session.profile ?? (await tron.profile());
    const data = await tron.rollcallHistory({ studentId: profile.id, force });
    const course = req.query.get('course') ?? '';
    const status = req.query.get('status') ?? '';
    const type = req.query.get('type') ?? '';
    const days = Number(req.query.get('days') ?? 0);

    let items = data.items;
    if (course) items = items.filter((i) => String(i.courseId) === course);
    if (status === 'signed') items = items.filter((i) => i.attendance === 'signed');
    if (status === 'absent') items = items.filter((i) => i.attendance === 'absent');
    if (status === 'leave') items = items.filter((i) => i.attendance === 'leave');
    if (type) items = items.filter((i) => i.type === type);
    if (days > 0) {
      const since = Date.now() - days * 86400000;
      items = items.filter((i) => (i.time ? Date.parse(i.time) >= since : false));
    }

    const count = (state) => data.items.filter((i) => i.attendance === state).length;
    const summary = {
      total: data.items.length,
      signed: count('signed'),
      leave: count('leave'),
      absent: count('absent'),
      unknown: count('unknown'),
      rate: data.items.length ? Math.round((count('signed') / data.items.length) * 1000) / 10 : 0,
      byType: countBy(data.items, (i) => i.typeLabel),
    };
    return { items, summary, fetchedAt: data.fetchedAt };
  }),
);

route('GET', '/api/active', async () =>
  session.withSession(async (tron) => {
    const courses = await tron.courses();
    const items = await tron.activeRollcalls({ courseIds: courses.map((c) => c.id) });
    return { items, at: new Date().toISOString() };
  }),
);

route('GET', '/api/rollcall', async (req) => {
  const id = req.query.get('id');
  if (!id) throw new HttpError('缺少签到 id', { status: 400 });
  return session.withSession((tron) => tron.rollcallDetail(id));
});

route('POST', '/api/answer', async (req) => {
  const body = await jsonBody(req);
  const type = String(body.type ?? '');
  const rollcallId = body.rollcallId;
  if (!rollcallId) throw new HttpError('缺少签到 id', { status: 400 });
  const settings = await loadSettings();
  const location = body.location ?? settings.radarLocation;
  return session.withSession(() =>
    monitor.manualAnswer({
      type,
      rollcallId,
      numberCode: body.numberCode ?? '',
      qrData: body.qrData ?? body.data ?? '',
      location,
    }),
  );
});

route('GET', '/api/todos', async () =>
  session.withSession(async (tron) => {
    const list = await tron.todos();
    const now = Date.now();
    const withState = list.map((t) => ({
      ...t,
      overdue: t.dueAt ? Date.parse(t.dueAt) < now : false,
      dueInHours: t.dueAt ? Math.round((Date.parse(t.dueAt) - now) / 3600000) : null,
    }));
    return {
      items: withState,
      ongoing: withState.filter((t) => !t.overdue),
      overdue: withState.filter((t) => t.overdue),
    };
  }),
);

route('GET', '/api/homework', async (req) => {
  const id = req.query.get('id');
  if (!id) throw new HttpError('缺少作业 id', { status: 400 });
  return session.withSession(async (tron) => {
    const detail = await tron.homeworkDetail(id);
    const profile = session.profile ?? (await tron.profile());
    const submissions = await tron.submissions(id, profile.id).catch(() => []);
    return { ...detail, submissions };
  });
});

route('GET', '/api/settings', async () => ({
  settings: await loadSettings(),
  defaults: settingsDefaults(),
}));

route('POST', '/api/settings', async (req) => {
  const body = await jsonBody(req);
  const settings = await saveSettings(body ?? {});
  log.info('app', '设置已更新');
  broadcast('settings', settings);
  return { ok: true, settings };
});

route('GET', '/api/device', async () => ({ deviceId: await getDeviceId() }));

route('GET', '/api/monitor', async () => monitor.status);
route('POST', '/api/monitor', async (req) => {
  const body = await jsonBody(req);
  if (body.action === 'start') {
    if (!session.loggedIn) throw new HttpError('请先登录', { status: 401 });
    return monitor.start();
  }
  if (body.action === 'stop') return monitor.stop();
  if (body.action === 'poll') {
    await monitor.tick();
    return monitor.status;
  }
  throw new HttpError('未知操作', { status: 400 });
});

route('GET', '/api/logs', async (req) => ({
  items: recentLogs(Number(req.query.get('limit') ?? 200)),
  file: await readLogFile(200).catch(() => ''),
}));

route('POST', '/api/logs/clear', async () => {
  await clearLogFile();
  return { ok: true };
});

route('POST', '/api/cache/clear', async (req) => {
  const body = await jsonBody(req).catch(() => ({}));
  await clearCache(body.name);
  return { ok: true };
});

/* ------------------------------------------------------------ 静态资源 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(webRoot, rel);
  if (!file.startsWith(webRoot)) {
    sendText(res, 403, '禁止访问');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    // 单页应用：未知路径回落到 index.html
    const index = path.join(webRoot, 'index.html');
    try {
      const html = await fs.readFile(index);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(html);
    } catch {
      sendText(res, 404, '未找到页面');
    }
  }
}

/* ------------------------------------------------------------ 服务器 */

function handleSse(req, res, url) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ session: session.snapshot(), monitor: monitor.status })}\n\n`);
  subscribers.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  const cleanup = () => {
    clearInterval(keepAlive);
    subscribers.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (pathname === '/events') {
      handleSse(req, res, url);
      return;
    }

    // 仅允许本机来源调用写接口，避免被同机其它网页 CSRF
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.some((o) => origin.startsWith(o))) {
        sendText(res, 403, '来源不被允许');
        return;
      }
    }

    const match = routes.find((r) => r.method === req.method && r.pattern === pathname);
    if (!match) {
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
        return;
      }
      await serveStatic(req, res, pathname);
      return;
    }

    const qIndex = (req.url ?? '').indexOf('?');
    const query = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex + 1) : '');
    // 统一把查询串挂到 req 上，处理器约定写成 req.query.get('x')
    req.query = query;
    try {
      const result = await match.handler(req, res, { query });
      if (result !== null && result !== undefined && !res.writableEnded) sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof SessionExpired) {
        sendJson(res, 401, { error: 'session_expired', message: error.message });
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status ?? 400, {
          error: 'request_failed',
          message: error.message,
          detail: error.body ?? null,
        });
        return;
      }
      log.error('app', `接口 ${pathname} 出错：${error.message}`);
      sendJson(res, 500, { error: 'internal_error', message: error.message });
    }
  });
}

function countBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const key = keyFn(item) || '其它';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

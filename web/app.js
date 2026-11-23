/**
 * 上理畅课助手 — 前端（零依赖 ES Module）。
 *
 * 只做三件事：调本地 /api/*、把结果渲染成卡片/表格、接 /events 的实时推送。
 * 所有业务规则都在服务端，这里不重复实现。
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  session: null,
  view: 'active',
  courses: [],
  active: [],
  history: { items: [], summary: null },
  timetable: null,
  settings: null,
  monitor: null,
};

/* ------------------------------------------------------------ 基础工具 */

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    if (res.status === 401) {
      showLogin();
      throw new Error(data?.message ?? '请先登录');
    }
    throw new Error(data?.message ?? `请求失败（${res.status}）`);
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 4200 : 2600);
}

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRelative(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ------------------------------------------------------------ 登录 */

function showLogin() {
  $('#view-login').hidden = false;
  $('#view-app').hidden = true;
  $('#user-chip').hidden = true;
}

function showApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  $('#user-chip').hidden = false;
  const name = state.session?.profile?.name ?? state.session?.username ?? '';
  $('#user-name').textContent = name;
}

async function prepareLogin() {
  try {
    const info = await api('/api/login/prepare');
    if (info.status === 'logged-in') {
      await loadSession();
      return;
    }
    // 平时不显示验证码框，只有平台真的要求（needCaptcha=true）才插进来
    if (info.needCaptcha) ensureCaptchaField();
  } catch (error) {
    console.warn('登录准备失败', error);
  }
}

/** 平台要求验证码时才插入图片验证码字段，返回 false 表示这次登录没法带验证码 */
function ensureCaptchaField() {
  if ($('#captcha-field')) {
    refreshCaptcha();
    return true;
  }
  const template = $('#captcha-template');
  const form = $('#login-form');
  if (!template || !form) return false;
  form.insertBefore(template.content.cloneNode(true), $('#login-msg'));
  $('#captcha-img')?.addEventListener('click', refreshCaptcha);
  refreshCaptcha();
  return true;
}

function refreshCaptcha() {
  const img = $('#captcha-img');
  if (img) img.src = `/api/captcha?ts=${Date.now()}`;
}

$('#login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = $('#btn-login');
  const msg = $('#login-msg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = '正在登录，需要走完统一身份认证…';
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
        captcha: $('#login-captcha')?.value.trim() ?? '',
      },
    });
    if (result.ok) {
      msg.className = 'msg ok';
      msg.textContent = '登录成功';
      state.session = result.session;
      $('#login-pass').value = '';
      showApp();
      await bootstrap();
    } else {
      msg.className = 'msg error';
      msg.textContent = result.message ?? '登录失败';
      if (result.needCaptcha) ensureCaptchaField();
    }
  } catch (error) {
    msg.className = 'msg error';
    msg.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout')?.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  state.session = null;
  showLogin();
  toast('已退出登录');
});

/* ------------------------------------------------------------ 会话 */

async function loadSession() {
  state.session = await api('/api/session');
  if (state.session.loggedIn) {
    showApp();
    await bootstrap();
  } else {
    showLogin();
    prepareLogin();
  }
}

async function bootstrap() {
  await Promise.allSettled([loadActive(), loadMonitor(), loadSettings(), loadCoursesForFilter()]);
  if (state.view === 'history') loadHistory();
  if (state.view === 'timetable') loadTimetable();
  if (state.view === 'homework') loadHomework();
}

/* ------------------------------------------------------------ 签到页 */

function renderMonitor() {
  const pill = $('#monitor-pill');
  if (!state.monitor) return;
  const on = state.monitor.running;
  pill.className = `pill ${on ? 'on' : ''}`;
  pill.textContent = on
    ? `巡检中 · 每 ${Math.round((state.settings?.pollIntervalMs ?? 20000) / 1000)} 秒`
    : '巡检未启动';
}

function rollcallTypeBadge(item) {
  const map = { number: '数字', qr: '二维码', radar: '雷达', unknown: '未知' };
  return `<span class="badge">${map[item.type] ?? '未知'}</span>`;
}

function renderActive() {
  const list = $('#active-list');
  const empty = $('#active-empty');
  const items = state.active ?? [];

  $('#active-meta').textContent = items.length
    ? `${items.length} 个进行中 · 更新于 ${fmtTime(new Date().toISOString())}`
    : `无进行中签到 · 更新于 ${fmtTime(new Date().toISOString())}`;

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = items
    .map((item) => {
      const settled = item.settled || item.attendance === 'signed' || item.attendance === 'leave';
      const signed = item.attendance === 'signed';
      const countInfo =
        item.attendanceCount !== undefined && item.totalStudents
          ? `<span class="card-sub">已到 ${item.attendanceCount}/${item.totalStudents} 人</span>`
          : '';
      const code = item.numberCode ? `<div class="code-box">${esc(item.numberCode)}</div>` : '';

      let form = '';
      if (!settled && item.type === 'number') {
        form = `<form class="answer-form" data-answer="number" data-id="${item.id}">
          <input name="numberCode" type="text" inputmode="numeric" value="${esc(item.numberCode ?? '')}" placeholder="签到码" required />
          <button class="btn primary" type="submit">提交数字签到</button>
        </form>`;
      } else if (!settled && item.type === 'qr') {
        form = `<form class="answer-form" data-answer="qr" data-id="${item.id}">
          <input name="qrData" type="text" placeholder="粘贴二维码链接或内容" required />
          <button class="btn primary" type="submit">立刻提交</button>
        </form>
        <p class="card-sub">二维码里的数据接口不下发，扫一下或把链接粘进来就能一键交上去。</p>`;
      } else if (!settled && item.type === 'radar') {
        form = `<div class="answer-form">
          <button class="btn primary" data-answer-radar="${item.id}" type="button">用已保存的位置签到</button>
        </div>`;
      }

      return `<article class="card live">
        <div class="card-top">
          <span class="card-title">${esc(item.courseName || item.title || '未命名课程')}</span>
          <div class="badges">
            ${rollcallTypeBadge(item)}
            ${signed ? '<span class="badge ok">已签到</span>' : '<span class="badge warn">待签到</span>'}
            ${item.source ? `<span class="badge">${esc(item.source)}</span>` : ''}
          </div>
        </div>
        <div class="card-sub">
          ${esc(item.title ?? '')} · ${fmtTime(item.time)} ${item.endTime ? `· 截止 ${fmtTime(item.endTime)}` : ''}
        </div>
        ${code}
        ${countInfo}
        ${form}
      </article>`;
    })
    .join('');

  list.querySelectorAll('form[data-answer]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const type = form.dataset.answer;
      const id = form.dataset.id;
      const fd = new FormData(form);
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const payload = { type, rollcallId: Number(id) };
        if (type === 'number') payload.numberCode = fd.get('numberCode');
        if (type === 'qr') payload.qrData = fd.get('qrData');
        const result = await api('/api/answer', { method: 'POST', body: payload });
        toast(result.ok ? '签到提交成功' : result.message, !result.ok);
        if (result.ok) await loadActive();
      } catch (error) {
        toast(error.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll('[data-answer-radar]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await api('/api/answer', {
          method: 'POST',
          body: { type: 'radar', rollcallId: Number(btn.dataset.answerRadar) },
        });
        toast(result.ok ? '雷达签到成功' : result.message, !result.ok);
        if (result.ok) await loadActive();
      } catch (error) {
        toast(error.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function loadActive() {
  if (!state.session?.loggedIn) return;
  try {
    const data = await api('/api/active');
    state.active = data.items ?? [];
    renderActive();
  } catch (error) {
    if (error.message !== '请先登录') toast(`拉取签到失败：${error.message}`, true);
  }
}

async function loadMonitor() {
  try {
    state.monitor = await api('/api/monitor');
    renderMonitor();
  } catch {
    /* 未登录时忽略 */
  }
}

$('#btn-poll')?.addEventListener('click', async () => {
  const btn = $('#btn-poll');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    await api('/api/monitor', { method: 'POST', body: { action: 'poll' } });
    await Promise.all([loadActive(), loadMonitor()]);
    toast('已重新检查');
  } catch (error) {
    toast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即检查';
  }
});

// 手机扫码后整条链接粘进来时，自动拆出签到 ID 与 data
$('#qr-data')?.addEventListener('input', () => {
  const raw = $('#qr-data').value.trim();
  const idMatch = /\/rollcall\/(\d+)/.exec(raw);
  const dataMatch = /[?&]data=([^&\s]+)/.exec(raw);
  if (idMatch && !$('#qr-rollcall').value) $('#qr-rollcall').value = idMatch[1];
  if (dataMatch) $('#qr-data').value = decodeURIComponent(dataMatch[1]);
});

$('#qr-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/answer', {
      method: 'POST',
      body: {
        type: 'qr',
        rollcallId: Number($('#qr-rollcall').value.trim()),
        qrData: $('#qr-data').value.trim(),
      },
    });
    toast(result.ok ? '二维码签到成功' : result.message, !result.ok);
    if (result.ok) {
      $('#qr-form').reset();
      await loadActive();
    }
  } catch (error) {
    toast(error.message, true);
  }
});

/* ------------------------------------------------------------ 记录页 */

function fillCourseFilter() {
  const select = $('#filter-course');
  const current = select.value;
  select.innerHTML =
    '<option value="">全部课程</option>' +
    state.courses
      .map((c) => `<option value="${c.id}">${esc(c.shortName || c.name)}</option>`)
      .join('');
  select.value = current;
}

async function loadCoursesForFilter() {
  try {
    const data = await api('/api/courses');
    state.courses = data.courses ?? [];
    fillCourseFilter();
  } catch {
    /* 忽略 */
  }
}

function historyQuery() {
  const params = new URLSearchParams();
  const course = $('#filter-course').value;
  const status = $('#filter-status').value;
  const type = $('#filter-type').value;
  const days = $('#filter-days').value;
  if (course) params.set('course', course);
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (days && days !== '0') params.set('days', days);
  return params.toString();
}

function renderHistory() {
  const items = state.history.items ?? [];
  const summary = state.history.summary ?? { total: 0, signed: 0, absent: 0, byType: {} };

  $('#history-summary').innerHTML = `
    <span class="pill">共 ${summary.total} 条</span>
    <span class="pill on">已签到 ${summary.signed}</span>
    <span class="pill warn">出勤率 ${summary.rate ?? 0}%</span>
    ${summary.leave ? `<span class="pill">请假 ${summary.leave}</span>` : ''}
    <span class="pill bad">缺勤 ${summary.absent}</span>
    ${Object.entries(summary.byType ?? {})
      .map(([k, v]) => `<span class="pill">${esc(k)} ${v}</span>`)
      .join('')}
  `;

  if (!items.length) {
    $('#history-list').innerHTML = '<div class="empty"><p>没有符合条件的记录。</p></div>';
    return;
  }

  $('#history-list').innerHTML = `<table>
    <thead><tr>
      <th>时间</th><th>课程</th><th>类型</th><th>状态</th><th>标题</th>
    </tr></thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
        <td class="num">${fmtTime(item.time)}</td>
        <td>${esc(item.courseName || '—')}</td>
        <td>${rollcallTypeBadge(item)}</td>
        <td>${
          item.attendance === 'signed'
            ? '<span class="badge ok">已签到</span>'
            : item.attendance === 'leave'
              ? `<span class="badge">请假${item.detail ? `· ${esc(item.detail)}` : ''}</span>`
              : item.attendance === 'absent'
                ? '<span class="badge bad">缺勤</span>'
                : '<span class="badge">未知</span>'
        }</td>
        <td>${esc(item.title ?? '')}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`;
}

async function loadHistory(force = false) {
  const list = $('#history-list');
  if (force) list.innerHTML = '<div class="empty"><p>正在重新抓取全部课程签到记录，约需十几秒…</p></div>';
  try {
    const query = historyQuery();
    const data = await api(`/api/rollcalls?${query}${force ? '&force=1' : ''}`);
    state.history = { items: data.items ?? [], summary: data.summary };
    $('#history-meta').textContent = `抓取于 ${fmtTime(data.fetchedAt)}`;
    renderHistory();
  } catch (error) {
    list.innerHTML = `<div class="empty"><p>加载失败：${esc(error.message)}</p></div>`;
  }
}

['#filter-course', '#filter-status', '#filter-type', '#filter-days'].forEach((sel) => {
  $(sel)?.addEventListener('change', () => loadHistory());
});

$('#btn-history-refresh')?.addEventListener('click', () => loadHistory(true));

/* ------------------------------------------------------------ 课表页 */

function slotLabel(cell) {
  return cell.slotName || String(cell.slot);
}

function renderTimetable() {
  const grid = $('#timetable-grid');
  const cells = state.timetable?.cells ?? [];
  if (!cells.length) {
    grid.innerHTML = '<div class="empty"><p>本学期没有排课信息。</p></div>';
    return;
  }

  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
  const slots = [...new Set(cells.map((c) => c.slot))].sort((a, b) => a - b);

  const slotTimes = new Map();
  for (const c of cells) if (!slotTimes.has(c.slot)) slotTimes.set(c.slot, c);

  let html = '<div class="tt-head"></div>';
  html += days
    .map((d, i) => `<div class="tt-head ${i + 1 === today ? 'today' : ''}">${d}</div>`)
    .join('');

  for (const slot of slots) {
    const ref = slotTimes.get(slot);
    const time = ref?.startTime ? `<br><span style="font-size:10px">${ref.startTime.slice(0, 5)}</span>` : '';
    html += `<div class="tt-slot">${esc(slotLabel(ref ?? { slot, slotName: '' }))}${time}</div>`;
    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      const hits = cells.filter((c) => c.slot === slot && c.dayOfWeek === day);
      if (!hits.length) {
        html += '<div class="tt-cell"></div>';
        continue;
      }
      const inner = hits
        .map(
          (h) => `<span class="tt-name">${esc(h.courseName)}</span>
            ${h.classroom ? `<span class="tt-extra">${esc(h.classroom)}</span>` : ''}`,
        )
        .join('<hr style="border:0;border-top:1px dashed var(--line);margin:4px 0">');
      html += `<div class="tt-cell has">${inner}</div>`;
    }
  }
  grid.innerHTML = html;
}

async function loadTimetable(force = false) {
  const grid = $('#timetable-grid');
  if (force) grid.innerHTML = '<div class="empty"><p>正在逐门课程抓取课表，约需十几秒…</p></div>';
  try {
    const data = await api(`/api/timetable${force ? '?force=1' : ''}`);
    state.timetable = data;
    $('#timetable-meta').textContent = `${data.cells?.length ?? 0} 个课时格 · 抓取于 ${fmtTime(data.fetchedAt)}`;
    renderTimetable();
  } catch (error) {
    grid.innerHTML = `<div class="empty"><p>加载失败：${esc(error.message)}</p></div>`;
  }
}

$('#btn-timetable-refresh')?.addEventListener('click', () => loadTimetable(true));

/* ------------------------------------------------------------ 作业页 */

function homeworkCard(item) {
  // 顺序很重要：已截止的作业剩余小时数是负数，先判 overdue 才不会显示成「即将截止」
  const badge = item.overdue
    ? '<span class="badge bad">已截止</span>'
    : item.dueInHours !== null && item.dueInHours !== undefined && item.dueInHours <= 24
      ? '<span class="badge bad">即将截止</span>'
      : '<span class="badge">进行中</span>';
  const remain =
    item.dueInHours === null || item.dueInHours === undefined
      ? ''
      : item.overdue
        ? ` · 已过期 ${Math.abs(item.dueInHours)} 小时`
        : ` · 还有 ${item.dueInHours} 小时`;
  return `<article class="card">
    <div class="card-top">
      <span class="card-title">${esc(item.title)}</span>
      <div class="badges">${badge}${item.type ? `<span class="badge">${esc(item.type)}</span>` : ''}</div>
    </div>
    <div class="card-sub">${esc(item.courseName || '')} · 截止 ${fmtTime(item.dueAt)}${remain}</div>
    <div class="card-actions">
      <button class="btn ghost tiny" data-hw="${item.id}">查看详情</button>
    </div>
    <div class="hw-detail" data-hw-detail="${item.id}" hidden></div>
  </article>`;
}

async function loadHomework() {
  try {
    const data = await api('/api/todos');
    $('#homework-meta').textContent = `更新于 ${fmtTime(new Date().toISOString())} · 进行中 ${data.ongoing.length} · 已截止 ${data.overdue.length}`;
    $('#homework-ongoing').innerHTML =
      data.ongoing.map(homeworkCard).join('') || '<div class="empty"><p>没有进行中的作业 🎉</p></div>';
    $('#homework-overdue').innerHTML =
      data.overdue.map(homeworkCard).join('') || '<div class="empty"><p>没有已截止的作业。</p></div>';

    $$('[data-hw]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const box = $(`[data-hw-detail="${btn.dataset.hw}"]`);
        if (!box.hidden) {
          box.hidden = true;
          return;
        }
        box.hidden = false;
        box.innerHTML = '<p class="muted small">加载中…</p>';
        try {
          const detail = await api(`/api/homework?id=${btn.dataset.hw}`);
          const html = detail.description
            ? detail.description.replace(/<script[\s\S]*?<\/script>/gi, '')
            : '<p class="muted">无描述</p>';
          box.innerHTML = `<div class="hw-body">${html}</div>
            ${detail.submissions?.length ? `<p class="muted small">已提交 ${detail.submissions.length} 次</p>` : ''}`;
        } catch (error) {
          box.innerHTML = `<p class="msg error">${esc(error.message)}</p>`;
        }
      });
    });
  } catch (error) {
    $('#homework-meta').textContent = `加载失败：${error.message}`;
  }
}

/* ------------------------------------------------------------ 设置页 */

function windowsToText(windows) {
  if (!Array.isArray(windows)) return '';
  return windows
    .map((w) => {
      const days = Array.isArray(w.days) && w.days.length ? `@${w.days.join(',')}` : '';
      return `${w.start}-${w.end}${days}`;
    })
    .join('\n');
}

function textToWindows(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [range, daysPart] = trimmed.split('@');
    const m = /^(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})$/.exec(range.trim());
    if (!m) continue;
    const days = daysPart
      ? daysPart.split(',').map((d) => Number(d.trim())).filter((d) => d >= 1 && d <= 7)
      : [];
    out.push({ start: m[1], end: m[2], days });
  }
  return out;
}

async function loadSettings() {
  try {
    const { settings } = await api('/api/settings');
    state.settings = settings;
    $('#set-auto').checked = Boolean(settings.autoAnswer);
    $('#set-type-number').checked = Boolean(settings.autoTypes?.number);
    $('#set-type-qr').checked = Boolean(settings.autoTypes?.qr);
    $('#set-type-radar').checked = Boolean(settings.autoTypes?.radar);
    $('#set-interval').value = Math.round(settings.pollIntervalMs / 1000);
    $('#set-qr-placeholder').checked = Boolean(settings.qrTryPlaceholder);
    $('#set-wait-enabled').checked = Boolean(settings.numberWait?.enabled);
    $('#set-wait-ratio').value = Math.round((settings.numberWait?.minRatio ?? 0.6) * 100);
    $('#set-wait-people').value = settings.numberWait?.minPeople ?? 8;
    $('#set-wait-max').value = Math.round((settings.numberWait?.maxWaitMs ?? 90000) / 1000);
    $('#set-lat').value = settings.radarLocation?.latitude ?? '';
    $('#set-lng').value = settings.radarLocation?.longitude ?? '';
    $('#set-windows').value = windowsToText(settings.detectionWindows);
    renderMonitor();
    const device = await api('/api/device').catch(() => null);
    if (device) $('#device-id').textContent = device.deviceId;
  } catch {
    /* 忽略 */
  }
}

$('#settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('#settings-msg');
  msg.className = 'msg';
  msg.textContent = '保存中…';

  const lat = $('#set-lat').value.trim();
  const lng = $('#set-lng').value.trim();
  const payload = {
    autoAnswer: $('#set-auto').checked,
    autoTypes: {
      number: $('#set-type-number').checked,
      qr: $('#set-type-qr').checked,
      radar: $('#set-type-radar').checked,
    },
    pollIntervalMs: Number($('#set-interval').value) * 1000,
    qrTryPlaceholder: $('#set-qr-placeholder').checked,
    numberWait: {
      enabled: $('#set-wait-enabled').checked,
      minRatio: Number($('#set-wait-ratio').value) / 100,
      minPeople: Number($('#set-wait-people').value),
      maxWaitMs: Number($('#set-wait-max').value) * 1000,
    },
    radarLocation: lat && lng ? { latitude: Number(lat), longitude: Number(lng), accuracy: 35 } : null,
    detectionWindows: textToWindows($('#set-windows').value),
  };

  try {
    const result = await api('/api/settings', { method: 'POST', body: payload });
    state.settings = result.settings;
    msg.className = 'msg ok';
    msg.textContent = '已保存';
    toast('设置已保存');
    renderMonitor();
    // 自动签到的开关变化要让巡检同步启停
    if (result.settings.autoAnswer && !state.monitor?.running) {
      await api('/api/monitor', { method: 'POST', body: { action: 'start' } });
    }
    if (!result.settings.autoAnswer && state.monitor?.running) {
      await api('/api/monitor', { method: 'POST', body: { action: 'stop' } });
    }
    state.monitor = await api('/api/monitor');
    renderMonitor();
  } catch (error) {
    msg.className = 'msg error';
    msg.textContent = error.message;
  }
});

$('#btn-locate')?.addEventListener('click', () => {
  if (!navigator.geolocation) {
    toast('浏览器不支持定位', true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('#set-lat').value = pos.coords.latitude.toFixed(6);
      $('#set-lng').value = pos.coords.longitude.toFixed(6);
      toast('已填入当前坐标，请保存设置');
    },
    (error) => toast(`定位失败：${error.message}`, true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

$('#btn-clear-cache')?.addEventListener('click', async () => {
  await api('/api/cache/clear', { method: 'POST', body: {} });
  toast('缓存已清空');
});

$('#btn-scroll-logs')?.addEventListener('click', () => switchTab('logs'));

$('#btn-notify')?.addEventListener('click', async () => {
  if (typeof Notification === 'undefined') {
    toast('这个浏览器不支持桌面通知', true);
    return;
  }
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? '桌面通知已开启，新签到会弹系统提醒' : `没有拿到通知权限（${permission}）`, permission !== 'granted');
});

/* ------------------------------------------------------------ 日志页 */

async function loadLogs() {
  try {
    const data = await api('/api/logs?limit=300');
    const lines = (data.items ?? [])
      .map((l) => `${l.time.slice(11, 19)} [${l.level.toUpperCase()}] ${l.scope}: ${l.message}`)
      .reverse()
      .join('\n');
    $('#log-output').textContent = lines || '暂无日志';
  } catch (error) {
    $('#log-output').textContent = `加载失败：${error.message}`;
  }
}

$('#btn-logs-refresh')?.addEventListener('click', loadLogs);
$('#btn-logs-clear')?.addEventListener('click', async () => {
  await api('/api/logs/clear', { method: 'POST', body: {} });
  await loadLogs();
});

/* ------------------------------------------------------------ 标签页 */

function switchTab(name) {
  state.view = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  if (name === 'history') loadHistory();
  if (name === 'timetable' && !state.timetable) loadTimetable();
  if (name === 'homework') loadHomework();
  if (name === 'settings') loadSettings();
  if (name === 'logs') loadLogs();
}

$('#tabs')?.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchTab(tab.dataset.tab);
});

$('#btn-refresh')?.addEventListener('click', async () => {
  if (state.view === 'active') await Promise.all([loadActive(), loadMonitor()]);
  if (state.view === 'history') await loadHistory();
  if (state.view === 'timetable') await loadTimetable();
  if (state.view === 'homework') await loadHomework();
  if (state.view === 'logs') await loadLogs();
  toast('已刷新');
});

/* ------------------------------------------------------------ 实时推送 */

/** 已经在界面上提醒过的签到 id，避免每轮巡检重复弹 */
const alerted = new Set();

function desktopNotify(title, body) {
  if (!state.settings?.notify) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: `usst-rollcall-${body}`, renotify: true });
  } catch {
    /* 某些浏览器在非安全上下文里会抛，忽略 */
  }
}

/** 二维码只有几分钟窗口，数字签到也常常一分钟就结束：新签到一出现就要立刻吵醒人 */
function alertActive(items) {
  const fresh = (items ?? []).filter((item) => {
    const settled = item.settled || item.attendance === 'signed' || item.attendance === 'leave';
    return !settled && !alerted.has(item.id);
  });
  if (!fresh.length) return;

  for (const item of fresh) {
    alerted.add(item.id);
    const kind = item.type === 'qr' ? '二维码签到' : item.type === 'radar' ? '雷达签到' : '数字签到';
    const code = item.type === 'number' && item.numberCode ? `，签到码 ${item.numberCode}` : '';
    const tail = item.type === 'qr' ? '，需要你扫码/粘链接' : '';
    const title = `新签到：${item.courseName ?? item.title ?? ''}`;
    const body = `${kind}${code}${tail}${item.endTime ? `，截止 ${fmtTime(item.endTime)}` : ''}`;
    toast(`${title} · ${body}`, item.type === 'qr');
    desktopNotify(title, body);
  }

  if (state.view !== 'active') switchTab('active');
  if (fresh.some((item) => item.type === 'qr')) {
    document.querySelector('#active-list input[name="qrData"]')?.focus();
  }
}

function connectEvents() {
  const dot = $('#conn-dot');
  const source = new EventSource('/events');
  source.addEventListener('open', () => {
    dot.className = 'dot on';
  });
  source.addEventListener('error', () => {
    dot.className = 'dot off';
  });
  source.addEventListener('active', (event) => {
    try {
      const items = JSON.parse(event.data);
      state.active = items;
      // 不管当前在哪个 tab 都要判断「是不是来了新签到」，否则错过了就只剩手动刷新
      if (state.view === 'active') renderActive();
      alertActive(items);
    } catch {
      /* 忽略格式错误 */
    }
  });
  source.addEventListener('monitor', (event) => {
    try {
      state.monitor = JSON.parse(event.data);
      renderMonitor();
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('answered', (event) => {
    try {
      const { item, result } = JSON.parse(event.data);
      const name = item.courseName ?? '签到';
      if (result.needsCode) {
        toast(`${name}：二维码签到需要你扫码，把链接粘到卡片里就能立刻提交`, true);
        if (state.view !== 'active') switchTab('active');
        document.querySelector('#active-list input[name="qrData"]')?.focus();
        return;
      }
      toast(`${name}：${result.ok ? '自动签到成功' : result.message}`, !result.ok);
    } catch {
      /* 忽略 */
    }
  });
  source.addEventListener('session', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!data.loggedIn) showLogin();
    } catch {
      /* 忽略 */
    }
  });
}

/* ------------------------------------------------------------ 启动 */

(async function main() {
  connectEvents();
  await loadSession();
  setInterval(() => {
    if (state.view === 'active' && state.session?.loggedIn) loadActive();
  }, 30000);
})();

import test from 'node:test';
import assert from 'node:assert/strict';

import { withinWindow } from '../server/monitor.mjs';

/* 检测窗口是「自动签到只在几点到几点之间动手」的开关。写错就等于关不掉或全开。 */

const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0); // 2026-11 月

test('空窗口表示不限制', () => {
  assert.equal(withinWindow([], at(23, 3)), true);
  assert.equal(withinWindow(undefined, at(23, 3)), true);
});

test('窗口内命中，窗口外不命中', () => {
  const windows = [{ start: '07:30', end: '12:00', days: [] }];
  assert.equal(withinWindow(windows, at(23, 8)), true);
  assert.equal(withinWindow(windows, at(23, 12)), true);
  assert.equal(withinWindow(windows, at(23, 13)), false);
  assert.equal(withinWindow(windows, at(23, 7, 29)), false);
});

test('指定星期几时只在这些天生效（1=周一 … 7=周日）', () => {
  const windows = [{ start: '00:00', end: '23:59', days: [1, 3, 5] }];
  assert.equal(at(23, 10).getDay(), 1); // 2026-11-23 是周一
  assert.equal(withinWindow(windows, at(23, 10)), true); // 周一
  assert.equal(withinWindow(windows, at(24, 10)), false); // 周二
  assert.equal(withinWindow(windows, at(25, 10)), true); // 周三
});

test('周日按 7 处理', () => {
  const sunday = at(29, 10); // 2026-11-29 是周日
  assert.equal(sunday.getDay(), 0);
  assert.equal(withinWindow([{ start: '09:00', end: '11:00', days: [7] }], sunday), true);
  assert.equal(withinWindow([{ start: '09:00', end: '11:00', days: [1] }], sunday), false);
});

test('多个窗口交集取「任一命中」', () => {
  const windows = [
    { start: '07:30', end: '09:00', days: [] },
    { start: '13:00', end: '15:00', days: [] },
  ];
  assert.equal(withinWindow(windows, at(23, 8)), true);
  assert.equal(withinWindow(windows, at(23, 14)), true);
  assert.equal(withinWindow(windows, at(23, 11)), false);
});

test('格式不对的窗口被忽略而不是抛错', () => {
  assert.equal(withinWindow([{ start: '乱写', end: '12:00', days: [] }], at(23, 8)), false);
  assert.equal(withinWindow([{ start: '25:00', end: '26:00', days: [] }], at(23, 8)), false);
  assert.equal(withinWindow([null], at(23, 8)), false);
});

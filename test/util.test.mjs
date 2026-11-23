import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, asArray, htmlToText, inputValue, pick, toDate, toInt, ymd } from '../server/util.mjs';
import { shortCourseName } from '../server/tron.mjs';

/* ------------------------------------------------------------ 时间 */

test('toDate 认 ISO 字符串', () => {
  const d = toDate('2026-11-23T01:43:06Z');
  assert.equal(d.toISOString(), '2026-11-23T01:43:06.000Z');
});

test('toDate 认秒级与毫秒级时间戳', () => {
  assert.equal(toDate(1763870586).getFullYear(), 2025);
  assert.equal(toDate(1763870586000).getTime(), 1763870586000);
});

test('toDate 认不带 T 的空格时间（畅课常这么给）', () => {
  assert.ok(toDate('2026-11-23 09:43:06') instanceof Date);
});

test('toDate 对空值/垃圾值返回 null，不抛错', () => {
  assert.equal(toDate(null), null);
  assert.equal(toDate(''), null);
  assert.equal(toDate('不是时间'), null);
});

test('ymd 给本地日期补零', () => {
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
});

test('addDays 跨月正确', () => {
  assert.equal(ymd(addDays(new Date(2026, 0, 31), 1)), '2026-02-01');
  assert.equal(ymd(addDays(new Date(2026, 2, 1), -1)), '2026-02-28');
});

/* ------------------------------------------------------------ 结构 */

test('pick 沿路径取值，缺省时给 fallback', () => {
  const obj = { a: { b: { c: 42 } } };
  assert.equal(pick(obj, 'a.b.c'), 42);
  assert.equal(pick(obj, 'a.x.c', '默认'), '默认');
  assert.equal(pick(null, 'a.b', '默认'), '默认');
});

test('asArray 能吃下畅课各种列表形状', () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray({ rollcalls: [1] }), [1]);
  assert.deepEqual(asArray({ data: { list: [2] } }), [2]);
  assert.deepEqual(asArray({ courses: [] }), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray('字符串'), []);
});

test('toInt 安全转整数', () => {
  assert.equal(toInt('42'), 42);
  assert.equal(toInt('42.9'), 42);
  assert.equal(toInt('abc', 0), 0);
});

/* ------------------------------------------------------------ HTML */

test('inputValue 从 CAS 表单里抠出隐藏字段', () => {
  const html = '<input type="hidden" name="execution" value="e1s1" /><input name="lt" value="LT-1" />';
  assert.equal(inputValue(html, 'execution'), 'e1s1');
  assert.equal(inputValue(html, 'lt'), 'LT-1');
  assert.equal(inputValue(html, 'nope'), null);
});

test('htmlToText 去标签、解实体、压空白', () => {
  const text = htmlToText('<div><script>x</script><p>签&nbsp;到&amp;成功</p></div>');
  assert.equal(text, '签 到&成功');
});

/* ------------------------------------------------------------ 课程名 */

test('shortCourseName 去掉学期与课程代码后缀', () => {
  assert.equal(shortCourseName('高等数学A(1)(2025-2026-1)-22000210-05'), '高等数学A(1)');
  assert.equal(shortCourseName('大学物理实验(1)(2026-2027-1)-22100040-03'), '大学物理实验(1)');
});

test('shortCourseName 对已干净的名字原样返回', () => {
  assert.equal(shortCourseName('计算方法B'), '计算方法B');
  assert.equal(shortCourseName(''), '');
  assert.equal(shortCourseName(null), '');
});

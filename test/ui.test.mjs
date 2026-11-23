import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 前端契约测试：app.js 里用到的每个 `#id` / `data-tab` / `data-panel`
 * 必须在 index.html 里真实存在，否则用户点下去就是静默失效（null 报错）。
 * 这类错在前端很难靠肉眼发现，所以固化成测试。
 */

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

const [html, js] = await Promise.all([
  readFile(join(webDir, 'index.html'), 'utf8'),
  readFile(join(webDir, 'app.js'), 'utf8'),
]);

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('app.js 引用的所有 #id 都存在于 index.html', () => {
  const referenced = new Set(
    [...js.matchAll(/\$\('#([a-z0-9-]+)'\)/gi)].map((m) => m[1]),
  );
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id: ${missing.join(', ')}`);
});

test('index.html 里的标签页与面板一一对应', () => {
  const tabs = [...html.matchAll(/class="tab[^"]*"\s+data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, `标签页太少：${tabs.join(',')}`);
  assert.deepEqual([...tabs].sort(), [...panels].sort(), '标签页与面板不匹配');
  assert.ok(tabs.includes('active') && tabs.includes('history') && tabs.includes('settings'));
});

test('index.html 引用的本地资源都真实存在', async () => {
  const refs = [...html.matchAll(/(?:src|href)="((?!https?:|data:)[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, '至少应引用 app.css 与 app.js');
  for (const ref of refs) {
    const file = join(webDir, ref.replace(/^\//, '').split('?')[0]);
    await assert.doesNotReject(readFile(file), `缺少资源文件：${ref}`);
  }
});

test('页面不引用外部 CDN（离线可用）', () => {
  // 普通 <a href> 指向学校门户是正常的帮助链接，不算外部依赖
  const external = [
    ...[...html.matchAll(/<script[^>]*src="(https?:[^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]*href="(https?:[^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<img[^>]*src="(https?:[^"]+)"/g)].map((m) => m[1]),
  ];
  assert.deepEqual(external, [], `不应依赖外部资源：${external.join(', ')}`);
});

test('页面声明中文与移动端视口', () => {
  assert.match(html, /<html[^>]*\blang="zh-CN"/i);
  assert.match(html, /<meta[^>]*name="viewport"[^>]*width=device-width/i);
  assert.match(html, /上理/);
});

test('设置表单里每个被读取的输入框都有 id', () => {
  for (const id of [
    'set-auto',
    'set-type-number',
    'set-type-qr',
    'set-type-radar',
    'set-interval',
    'set-wait-enabled',
    'set-wait-ratio',
    'set-wait-people',
    'set-wait-max',
    'set-lat',
    'set-lng',
    'set-windows',
  ]) {
    assert.ok(htmlIds.has(id), `缺少设置项 #${id}`);
  }
});

test('前端不直接调用畅课域名（一律走本地代理）', () => {
  assert.ok(!js.includes('1906.usst.edu.cn'), 'app.js 不应直连畅课，否则会被跨域/Cookie 挡住');
  assert.ok(js.includes('/api/'), 'app.js 应通过 /api/* 取数');
});

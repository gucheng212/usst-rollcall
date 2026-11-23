import test from 'node:test';
import assert from 'node:assert/strict';

import { CookieJar, HttpError } from '../server/httpx.mjs';

/* 上理登录要跨 1906 / 8600 / ehall / ids6 四个 host，Cookie 收发是核心。

   CookieJar 里曾有个致命 bug：name 只作为 Map 的 key，值对象里没存 name，
   于是 toJSON() 落盘后重新加载，所有 Cookie 都变成 `undefined`，
   重启程序就静静退回「未登录」状态。下面这组测试专门守住它。 */

test('Cookie 落盘再读回：名字和值都必须还原', () => {
  const jar = new CookieJar();
  jar.set({ name: 'session', value: 'abc123', domain: '1906.usst.edu.cn' });
  jar.set({ name: 'JSESSIONID', value: 'cas-1', domain: 'ids6.usst.edu.cn' });

  const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
  assert.equal(restored.headerFor('https://1906.usst.edu.cn/api/profile'), 'session=abc123');
  assert.equal(restored.headerFor('https://ids6.usst.edu.cn/authserver/login'), 'JSESSIONID=cas-1');
});

test('Cookie 不跨 host 泄露（CAS 的 JSESSIONID 不能带到畅课上）', () => {
  const jar = new CookieJar();
  jar.set({ name: 'JSESSIONID', value: 'cas-1', domain: 'ids6.usst.edu.cn' });
  assert.equal(jar.headerFor('https://1906.usst.edu.cn/api/profile'), '');
});

test('Cookie 按子域匹配父域', () => {
  const jar = new CookieJar();
  jar.set({ name: 'broad', value: 'x', domain: 'usst.edu.cn' });
  assert.equal(jar.headerFor('https://ehall.usst.edu.cn/a'), 'broad=x');
  assert.equal(jar.headerFor('https://ids6.usst.edu.cn/a'), 'broad=x');
  assert.equal(jar.headerFor('https://example.com/a'), '');
});

test('过期的 Cookie 不下发也不保留', () => {
  const jar = new CookieJar();
  jar.set({ name: 'old', value: 'x', domain: '1906.usst.edu.cn', expires: Date.now() - 1000 });
  assert.equal(jar.headerFor('https://1906.usst.edu.cn/'), '');
  assert.equal(jar.toJSON().length, 0);
});

test('Secure Cookie 不走 http', () => {
  const jar = new CookieJar();
  jar.set({ name: 's', value: 'x', domain: 'ehall.usst.edu.cn', secure: true });
  assert.equal(jar.headerFor('http://ehall.usst.edu.cn/a'), '');
  assert.equal(jar.headerFor('https://ehall.usst.edu.cn/a'), 's=x');
});

test('Cookie 按 path 限定', () => {
  const jar = new CookieJar();
  jar.set({ name: 'p', value: 'x', domain: '1906.usst.edu.cn', path: '/api' });
  assert.equal(jar.headerFor('https://1906.usst.edu.cn/api/profile'), 'p=x');
  assert.equal(jar.headerFor('https://1906.usst.edu.cn/user/index'), '');
});

test('absorb 能解析 Set-Cookie 的 Domain / Path / Max-Age / HttpOnly', () => {
  const jar = new CookieJar();
  const added = jar.absorb('https://1906.usst.edu.cn/login', {
    getSetCookie: () => [
      'session=xyz; Path=/; Domain=.usst.edu.cn; Max-Age=3600; HttpOnly; Secure',
      'plain=1',
    ],
  });
  assert.deepEqual(added, ['session@usst.edu.cn', 'plain@1906.usst.edu.cn']);

  const saved = jar.toJSON().find((c) => c.name === 'session');
  assert.equal(saved.domain, 'usst.edu.cn');
  assert.equal(saved.path, '/');
  assert.equal(saved.secure, true);
  assert.equal(saved.httpOnly, true);
  assert.ok(saved.expires > Date.now());
});

test('absorb 忽略畸形的 Set-Cookie 而不是崩溃', () => {
  const jar = new CookieJar();
  const added = jar.absorb('https://1906.usst.edu.cn/', {
    getSetCookie: () => ['', 'novalue', '=nameless'],
  });
  assert.deepEqual(added, []);
  assert.equal(jar.toJSON().length, 0);
});

test('HttpError 带上状态码，便于上层区分会话失效', () => {
  const error = new HttpError('无权限', { status: 403, url: 'https://x', body: '{}' });
  assert.equal(error.status, 403);
  assert.equal(error.message, '无权限');
  assert.ok(error instanceof Error);
});

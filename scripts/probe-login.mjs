/**
 * 登录链路自检：真实走一通统一身份认证，验证 cas.mjs 的实现是否与线上一致。
 * 凭据只从环境变量读，不落盘、不打印。
 *
 *   $env:USST_USER='...'; $env:USST_PASS='...'; node scripts/probe-login.mjs
 */
import { CasLogin } from '../server/cas.mjs';
import { config } from '../server/config.mjs';
import { endpoints } from '../server/endpoints.mjs';

const username = process.env.USST_USER;
const password = process.env.USST_PASS;

if (!username || !password) {
  console.error('缺少 USST_USER / USST_PASS 环境变量');
  process.exit(2);
}

const cas = new CasLogin();

console.log('1) 走前置跳转 …');
const begin = await cas.begin();
console.log('   status =', begin.status);
console.log('   casUrl =', begin.casUrl?.slice(0, 140));
console.log('   hops   =', begin.hops.join('\n            '));
if (begin.status !== 'cas') {
  console.log('   未进入登录表单，终止');
  process.exit(1);
}

console.log('2) 提交凭据 …');
const result = await cas.login({ username, password });
console.log('   ok      =', result.ok);
console.log('   message =', result.message ?? '');
console.log('   hops    =', (result.hops ?? []).join('\n            '));
console.log('   profile =', JSON.stringify(result.profile ?? null).slice(0, 400));

if (!result.ok) process.exit(1);

console.log('3) Cookie hosts =', cas.jar.hostNames().join(', '));
console.log('4) 探测课程列表 …');
for (let i = 0; i < 6; i++) {
  const url = endpoints.courseList(i);
  const res = await cas.http.raw(url, {
    headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
  });
  const text = res.text.slice(0, 160).replace(/\s+/g, ' ');
  console.log(`   [${i}] ${res.status} ${url.replace(config.tenantBase, '')} → ${text}`);
  if (res.status === 200 && res.text.trim().startsWith('{')) break;
}

console.log('5) 探测 profile / radar …');
for (const [label, url] of [
  ['profile', endpoints.profile()],
  ['radar', endpoints.radarRollcalls()],
  ['todos', endpoints.todos()],
]) {
  const res = await cas.http.raw(url, {
    headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
  });
  console.log(`   ${label}: ${res.status} ${res.text.slice(0, 300).replace(/\s+/g, ' ')}`);
}

#!/usr/bin/env node
import { config, APP } from './config.mjs';
import { createServer } from './app.mjs';
import { session } from './session.mjs';
import { monitor } from './monitor.mjs';
import { loadSettings } from './store.mjs';
import { log } from './logger.mjs';

const server = createServer();

await session.init();

server.listen(config.port, config.host, async () => {
  const settings = await loadSettings();
  const url = `http://${config.host}:${config.port}`;
  log.info('app', `${APP.name} v${APP.version} 已启动 → ${url}`);
  console.log(`\n  ${APP.name} (${APP.nameEn}) v${APP.version}`);
  console.log(`  地址: ${url}`);
  console.log(`  登录态: ${session.loggedIn ? `已登录（${session.profile?.name ?? ''}）` : '未登录'}`);
  console.log(`  自动签到: ${settings.autoAnswer ? '已开启' : '已关闭'}`);
  console.log(`  数据目录: ${config.dataDir}\n`);

  if (session.loggedIn) {
    monitor.start().catch((error) => log.warn('app', `巡检启动失败：${error.message}`));
  }
});

const shutdown = async (signal) => {
  log.info('app', `收到 ${signal}，正在退出`);
  monitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => log.error('app', `未捕获的 Promise 拒绝：${error?.message ?? error}`));
process.on('uncaughtException', (error) => log.error('app', `未捕获异常：${error?.message ?? error}`));

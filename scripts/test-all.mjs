/**
 * 一次性跑完全部单测。
 *
 * 为什么不直接 `node --test`：本机（以及一些受限的 Windows 环境）下
 * `node --test` 需要派生（spawn）子进程，命名管道被禁时会报 `Error: spawn EPERM`。
 * 直接在同一个进程里 import 各测试文件，node:test 会在进程退出前自动执行并汇总。
 */
import './../test/endpoints.test.mjs';
import './../test/httpx.test.mjs';
import './../test/util.test.mjs';
import './../test/ui.test.mjs';
import './../test/monitor.test.mjs';

# 参考与致谢

这个项目是照着别人的作品学出来的，把参考对象、参考了什么、没参考什么写清楚，方便后来者和原作者核对。

一句话结论：**产品形态参考了厦大的 [xmu-rollcall](https://github.com/MidiAug/xmu-rollcall)（MIT），
接口细节靠拆学校自己的官方 App 安装包取证；没有复制任何一方的源代码。**

---

## 一、直接参考的开源仓库

| 仓库 | 作者 / 许可 | 参考了什么 | 没有沿用 |
|---|---|---|---|
| [MidiAug/xmu-rollcall](https://github.com/MidiAug/xmu-rollcall) | Peter Parker，MIT（Copyright © 2026） | 产品形态与交互口径（见下方清单）、TronClass 接口命名习惯、作答请求的 payload 形状、出勤状态关键字词表、设备标识的持久化策略 | **全部代码**：没有拷贝任何 Dart/Flutter 文件；没有沿用它的 Android/Windows 原生层、托盘、扫码、自动更新；没有沿用它的 Keycloak OAuth 登录链路（厦大特有，上理走的是另一套） |

### 从这个仓库参考到的具体内容

| 参考点 | 上游的做法 | 本项目怎么处理 |
|---|---|---|
| 产品边界 | 数字 / 雷达 / 二维码三种签到、签到记录筛选、本学期课表、作业进行中与已截止分开、多身份协助 | 三种签到、签到记录四态统计、按学期过滤课表、作业分两组；**不做**多身份协助（只服务本机一个账号） |
| 自动签到默认关闭 | 必须用户主动开启，按类型勾选，可设检测窗口 | 同样默认全关，加检测窗口与"数字签到等出勤人数" |
| 设备标识 | 首次生成 UUID v4 后持久化，不每次重新生成 | `.data/persist/device.json` 只生成一次，之后原样复用 |
| 作答请求的方法 | 三种签到统一用 `PUT` | 同样只用 `PUT`；额外用 `OPTIONS` 探 `Allow` 头来确认路由是否存在 |
| 出勤状态归一 | 把 `signed/present/attended/on_call_fine…` 归为已签到，`absent/missed/on_call_absence…` 归为缺勤 | 扩成四态（已签到 / 请假 / 缺勤 / 未知），并修正判定顺序：`on_call` 是 `on_call_absence` 的前缀，必须先判缺勤 |
| 课表口径 | 只展示当前身份的本学期课表，不把入学以来的课都搬出来 | 只取活跃学期的课程逐门拉 `timetables` |
| 免责声明 | 非官方、自动签到需主动配置、位置要真实 | 同样声明，并额外写清"二维码做不到全自动"、"代签是违纪" |

### 上游自己又参考了谁（转述，本项目未直接使用）

xmu-rollcall 的 README 里感谢了这几个仓库，列出以便溯源：

- [wilinz/tronclass_plus](https://github.com/wilinz/tronclass_plus)：Flutter 客户端架构、网络与位置交互
- [KrsMt-0113/XMU-Rollcall-Bot](https://github.com/KrsMt-0113/XMU-Rollcall-Bot)、[dangzitou/xmu-rollcall-bot](https://github.com/dangzitou/xmu-rollcall-bot)：厦大畅课接口参考
- [KrsMt-0113/xmulogin](https://github.com/KrsMt-0113/xmulogin)：厦大统一身份认证参考

本项目的登录链路是自己在上理实测出来的，上述三个仓库的代码与结论都没有直接使用。

## 二、非仓库类参考：官方客户端

接口这块，网页端和公开文档都不足以确定"学生到底怎么交签到"，所以参考了学校自己的官方移动端：

| 对象 | 来源 | 用来做什么 | 边界 |
|---|---|---|---|
| 畅课官方 App（`com.wisdomgarden.trpc` 2.16.1，Capacitor 壳） | 学校自己的移动端引导页 <https://1906.usst.edu.cn/mobile> 给出的直链 | 读出真实的作答接口与请求头：`PUT /api/rollcall/{id}/answer_number_rollcall`、`PUT /api/rollcall/{id}/answer_qr_rollcall`、`PUT /api/rollcall/{id}/answer?api_version=1.76`，以及 App 额外携带的 `x-session-id`（值取自 `GET /api/captcha-code` 响应头） | 只把它当作**行为证据**来读（压缩后的 webpack bundle 是明文 JS），**没有复制、反编译或再分发**任何代码；不包含任何安装包 |
| 一网畅学桌面网页 bundle | 登录后由浏览器加载 | 确认学生作答接口**不在**网页端（网页只有教师侧接口），从而解释"为什么网页里找不到签到按钮对应的请求" | 同样只读不改，不随本项目分发 |

这个取证方式的价值是：结论可复现——谁都能自己下载安装包、自己搜 `answer_number_rollcall` 验证一遍。

## 三、厦大 vs 上理：差异才是本项目的主要工作量

照抄一个 Flutter 项目到另一个学校是跑不起来的，下面这些差异全是实测出来的（详见 [README](README.md) 的"给开发者"）：

| 维度 | 厦大（xmu-rollcall） | 上理（本项目） |
|---|---|---|
| 畅课地址 | `lnt.xmu.edu.cn` | `1906.usst.edu.cn` |
| 登录方式 | Keycloak OAuth 直连 | `1906` → Keycloak(CAS client) → ehall 适配器 → 金智 IDS6，共 5 跳 |
| 密码处理 | AES 加密（有 `pwdEncryptSalt`） | 明文表单提交（**没有** `pwdEncryptSalt`） |
| 数字签到作答 | `PUT /api/rollcall/{id}/answer_number_rollcall` | 同路径，但**必须先带 `x-session-id`**，且已结束的签到一律 404 |
| 雷达作答 | `PUT /api/rollcall/{id}/answer?api_version=1.76` | 同路径 |
| 签到主键 | `id` | `rollcall_id` |
| 签到详情 | `GET /api/rollcall/{id}` | 该接口 500，只能用 `/student_rollcalls` |
| 课表 | 课程列表自带 `timetables` | 要逐门课带 `?fields=…timetables…` 拉，且**不返回教室** |
| 404 语义 | 单一含义 | 两种：中文「未找到资源」= 路由不存在；英文 `Not Found` = 路由在但当前不可作答 |
| 技术栈 | Flutter 3.44 / Dart 3.12，Android + Windows | Node.js 零依赖本地服务 + 网页前端（因为要能在没有 SDK 的机器上双击就跑） |

## 四、许可与合规

- 本项目以 [MIT License](LICENSE) 发布。
- 上游 xmu-rollcall 同为 MIT，其版权声明为 `Copyright (c) 2026 Peter Parker`；本项目**未包含**其源代码，
  但在此保留署名与许可信息，以便任何一方追溯来源。
- 官方 App 与畅课网页的接口、字段名属于平台方；本项目只是按照公开可观测的行为调用它们，
  不包含、不修改、不绕过任何平台代码，也不分发安装包。
- 如果你的作品在这里被引用而希望调整措辞或移除，请开 issue，会尽快处理。

## 五、怎么引用本项目

```
上理畅课助手 (USST Rollcall) — 上海理工大学一网畅学第三方客户端
https://github.com/<your-name>/usst-rollcall
```

请不要把本项目说成官方客户端；也不要把它伪装成厦大或其他学校版本发布——
不同学校的接口不一样，改了域名并不会让签到生效。

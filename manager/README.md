# 自动化管理器

本管理器完全运行在本机，地址：`http://127.0.0.1:4765`（只绑 127.0.0.1，不对外网开放）。

端口以 LaunchAgent 的环境变量为准：`~/Library/LaunchAgents/com.pikachu.automation-manager.plist`
里的 `AUTOMATION_MANAGER_PORT`。`manager/server.mjs` 的默认值和 `manager/open-manager` 的回退值都只是
兜底；改端口改 plist 一处即可，启动器会自动读到。

## 没有 LaunchAgent 时怎么起（新克隆就走这条）

`open-manager` 和双击 App 都依赖上面那个 plist。仓里不带现成文件，但带生成器：

```bash
manager/install-launchagent --dry-run   # 先看要写什么
manager/install-launchagent             # 写入并加载，随后 curl 健康检查
```

不想装 LaunchAgent、只想手起服务，也不需要任何依赖：

```bash
cp manager/registry.example.json manager/registry.json   # 首次：空登记表
cd manager && npm start                                   # 等价于 node server.mjs
```

端口冲突时用 `AUTOMATION_MANAGER_PORT=4788 npm start`。完整上手说明（含录制链路要装的依赖、隔离实例的环境变量）在仓库根的 `README.md`。

## 代码结构

| 位置 | 作用 |
| --- | --- |
| `manager/server.mjs` | Node HTTP 服务：任务读写、launchd 操作、录制/登录/测试进程托管 |
| `manager/registry.json` | 任务登记表（含 plist 路径、命令、日志路径等非密码信息） |
| `manager/web/` | 前端源码：React 18 + TypeScript + Ant Design v5 + Vite |
| `manager/public/` | 前端**构建产物**，由 `server.mjs` 静态托管，不要手改 |
| `manager/open-manager` | 启动器：健康就复用，不健康才拉起服务并打开页面 |
| `manager/backups/` | 本次改造前的原始文件备份 |

改完 `manager/web/src/` 必须重新构建，页面才会变（首次要先装前端依赖，否则 `npm run build` 会报 `sh: tsc: command not found`）：

```bash
cd <项目目录>/manager/web && npm install && npm run build
```

本地开发（带 /api 代理，不用每次 build）：

```bash
cd <项目目录>/manager/web && npm run dev     # http://127.0.0.1:4760
```

## 接口参考

全部同源、只监听 `127.0.0.1`。除 `GET` 外都校验 `Origin`（不带 Origin 的请求放行，方便 curl 调试）。
成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": "给人看的话", "code": "machine_code", "hint": "怎么修" }`。
状态码：400 入参 · 403 跨站或路径越界 · 404 找不到 · 409 同任务在跑（`task_busy`）· 413 body 超 64KB · 422 数据不自洽 · 500 服务端异常（原话同时进 `logs/automation-manager.err`）· 503 登记表缺失。

| 方法与路径 | 作用 | 备注 |
| --- | --- | --- |
| `GET /api/system` | 健康检查 | 返回 `{manager:"running", port}`；`open-manager` 靠它判断端口上是不是自己 |
| `GET /api/tasks` | 任务列表 | 每项带 `loaded` `schedule` `plistExists` `profileExists` `lastLog` `active` `lastRun` `credentialBackend` |
| `GET /api/tasks/:id/log?from=<字节偏移>` | 取增量日志 | 运行面板每 1.5 秒拉一次；共享日志文件靠偏移量互不串台 |
| `POST /api/recordings/create` | 新建录制/空白任务 | body `{id,name,url,blank?}`；会写脚手架到 `tasks/<id>/` |
| `POST /api/tasks/:id/run` | 立即运行 | 返回 `{pid}`；同任务并发返回 409 |
| `POST /api/tasks/:id/schedule` | 改执行时间 | body `{hour,minute}`，写 plist 并重新 bootstrap |
| `POST /api/tasks/:id/enable` / `disable` | 启用 / 暂停 | 暂停会 bootout 并 `launchctl disable` |
| `POST /api/tasks/:id/remove` | 移除定时 | 只删 plist，保留脚本、账号和 Profile |
| `POST /api/tasks/:id/purge` | 彻底删除 | body `{confirm:"<id>", deleteCredential, deleteProfile, deleteLogs}`；confirm 必须原样等于任务 ID |
| `POST /api/recordings/:id/login` | ① 准备登录 | 拉起独立 Chrome Profile，关窗后自动导出 `auth.json` |
| `POST /api/recordings/:id/record` | ② 开始录制 | `playwright codegen --channel=chrome` |
| `POST /api/recordings/:id/open` | ③ 打开代码 | 优先 VS Code，退回到文件管理器定位 |
| `POST /api/recordings/:id/test` | ④ 可视化测试 | 带 `PW_HEADLESS=0` 跑一次 `run-recorded-task` |
| `POST /api/system/shutdown` | 关闭管理器 | 只关管理器；四个每日签到的 LaunchAgent 不受影响 |

## 日常使用

直接打开：`~/Applications/自动化管理器.app`

任务卡支持：

- 立即运行（会自动打开右侧「运行输出」面板）
- 启用 / 暂停
- 修改每天执行时间
- 移除定时（保留脚本、账号和 Profile）
- 彻底删除（逐项确认是否一起删除凭据、Profile、日志，需输入任务 ID）

录制类任务额外支持：① 准备登录 → ② 开始录制 → ③ 打开代码 → ④ 可视化测试。

## 「运行输出」面板

点「立即运行」或「可视化测试」后自动打开：每 1.5 秒取一次本次运行新增的日志（按字节偏移截取，
所以 同站点多账号 共用一个日志文件也不会串），结束时把状态翻成「成功 · 用时」或
「失败 · 退出码 · 用时」，只提示一次。关掉后卡片上仍保留
「上次运行：成功/失败 · 时间 · 用时」和「看输出」按钮，随时回看同一次输出。

同一任务在运行时，「立即运行 / 准备登录 / 开始录制 / 可视化测试」四个按钮会按住
（后端 `task_busy`），不会出现连点多次却看不出在跑什么的情况。

## 录制任务的依赖前提

任务脚本在 `<项目目录>/tasks/<ID>/`，位于 `manager/` 之外，所以运行器
`manager/run-recorded-task` 会自动建一个软链
`<项目目录>/tasks/node_modules -> <项目目录>/manager/node_modules`，
让 `playwright.config.mjs` / `recorded.spec.js` 能解析到 `@playwright/test`；
node 也是显式解析的（管理器传 `NODE_BIN`，否则退回 nvm 最新版 → Homebrew → /usr/local）。
少任何一环，任务会以退出码 127 或 1 失败，日志里会写明 `node_not_found` /
`playwright_cli_missing` / `script_not_found`，运行面板直接显示出来。

所有确认、提示、表单校验都用 Ant Design 组件（Modal / Popconfirm / message / notification / Form），
不使用浏览器原生 `alert` / `confirm`。

## 连接状态怎么读

页面右上角的状态标签只有四种含义：

- **管理器运行中**：轮询正常。
- **管理器已关闭**：你主动点了「关闭管理器」，端口已释放；重新双击 App 即恢复，页面会自动重连。
- **连接中断**：服务进程没了（被杀、注销、开机后未启动）。这是异常，但只提示一次，之后看横幅。
- **后端异常**：进程还在但接口返回异常，包括「这个端口上应答的不是自动化管理器」。

页面切到后台会停止轮询，回到前台立即刷新一次。

## 内置演示站点

`http://127.0.0.1:4765/demo/` 是一个纯本地假站点（源码在 `web/public/demo/index.html`，随构建产出），
带「立即签到 / 今日已签到」「立即抽奖 / 暂无抽奖机会」和北京时区日期，状态存在浏览器 localStorage，
页面上有重置按钮。想试录制流程又不想碰真实站点，就新建一个任务指向它：

- 网址：`http://127.0.0.1:4765/demo/`
- 任务 ID：`demo-daily`

它的文案和示例 runner 的判定标记完全一致，可以拿来演示"已领取过不该算失败"这类状态判定。

## 自己录制一个新网站

1. 点击右上角 **新建自动化**。
2. 填名称、任务 ID 和网址，选择 **录制操作**。
3. 在新任务卡点 **① 准备登录**。
4. 在独立 Chrome 中完成登录，然后关闭该 Chrome（登录状态会自动存到 `auth.json`）。
5. 点 **② 开始录制**，完成网页操作后关闭录制窗口。
6. 点 **③ 打开代码**，可在 VS Code 中检查或修改生成代码。
7. 点 **④ 可视化测试**。
8. 测试通过后设置执行时间并启用。

## 自己编写脚本

新建自动化时选择 **新建空白脚本**，然后点 **打开代码**。

每个自己创建的任务位于 `<项目目录>/tasks/<任务 ID>/`：

- `recorded.spec.js`：自动化代码
- `playwright.config.mjs`：Playwright 配置
- `auth.json`：登录状态（敏感文件，不要上传或分享）
- `task.json`：任务基本信息

## 管理器故障恢复

后台服务名称：`com.pikachu.automation-manager`，日志在 `<项目目录>/logs/automation-manager.{out,err}`。

- 双击 App 没反应：终端执行 `<项目目录>/manager/open-manager`，它会把端口占用情况打印出来。
- `open-manager` 退出码 2 并提示「没有 LaunchAgent」：这台机器还没装过，跑 `manager/install-launchagent`；只想临时看一眼就 `cd manager && npm start`。
- 页面显示「连接中断」但签到照常：说明管理器进程没了，重新双击 App 即可。
- 页面显示「后端异常 · 端口上应答的不是自动化管理器」：有别的程序占了 4765，先让对方换端口。

管理器本身不依赖 Docker。四个每日签到任务由各自的 LaunchAgent 独立运行，关闭或重启管理器都不影响它们。

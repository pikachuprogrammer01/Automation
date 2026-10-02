# Automation：本机自动化任务管理器

在 macOS 上跑定时网页任务的管理器：录制浏览器操作生成 Playwright 脚本、按天定时执行、在网页界面里看每次运行的输出与失败原因。
后端只有 Node 标准库，不需要 Docker，不需要数据库，只监听 `127.0.0.1`。

## 边界（先说清楚）

- **不针对任何第三方站点做合规评估。** 本工具能自动化任何网页，但目标站点的服务条款是否允许脚本化访问，由使用者自己确认并承担后果。作者未做这项评估，也不为任何具体站点的用法背书。
- **示例只用内置演示站点。** 仓内自带的 `http://127.0.0.1:<port>/demo/` 是纯本地假站点，专门用来演示录制与状态判定。作者实际使用的站点专用 runner 不在发布范围内（见「数据与隐私边界」）。

## 环境要求

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| macOS | 任意近期版本 | 定时、凭据、进程托管都建立在 launchd + macOS Keychain 上 |
| Node.js | ≥ 20.11 | 实测 v24.18.0。下限由 `import.meta.dirname`（数据根推导）决定，20.11 以下直接崩；`@playwright/test` 依赖的 `playwright-core` 也要求 ≥ 20 |
| Google Chrome | 稳定版 | 登录与录制用系统 Chrome（`manager/server.mjs` 里的 `CHROME` 常量写死路径） |

## setup

### 1. 只想起服务、看界面（零 npm 依赖）

```bash
mkdir -p var
cp manager/registry.example.json var/registry.json   # 首次：生成空的任务登记表
npm start                                           # 等价于 node manager/server.mjs
```

打开 `http://127.0.0.1:4765`。空登记表下界面会给「还没有任务 / 新建自动化」的引导。

本机已经有一个管理器在 4765 上跑着的话，换端口避免撞车：

```bash
AUTOMATION_MANAGER_PORT=4788 npm start
```

### 2. 先拿内置演示站点练一遍（不联网，不含任何真实站点）

`http://127.0.0.1:4765/demo/` 是随构建产物一起入库的本地假站点，带「立即签到 / 今日已签到」和「立即抽奖 / 已参与」，状态存在你自己浏览器的 localStorage，页面上有重置按钮。

界面右上「新建自动化」→ 网址填 `http://127.0.0.1:4765/demo/` → 依次点 ① 准备登录 → ② 开始录制 → ③ 打开代码 → ④ 可视化测试。

录制链路要装一次依赖（`@playwright/test`，走系统 Chrome，不用额外下载浏览器）：

```bash
cd manager && npm install
```

不装的话任务会以退出码 3 失败，日志里写 `playwright_cli_missing`。

### 3. 改前端

`manager/public/` 是构建产物且已入库，所以第 1 步不需要构建。改 `manager/web/src/` 之后：

```bash
npm install --prefix manager/web    # 首次
npm run build                       # 产出到 manager/public/
npm run dev                         # 或者本地开发：http://127.0.0.1:4760，带 /api 代理
```

## 试改不动本机数据

**一个变量就够。** `AUTOMATION_HOME` 指到哪，任务脚本、浏览器 Profile、日志和登记表 `registry.json` 就全在哪 —— 同一个根，不存在"设了一个漏了另一个，结果改到正在跑的生产登记表"这种坑。服务启动会把 `base=` 和 `registry=` 两行打进 stdout，起完先看一眼：两行都该落在你的沙箱里。

```bash
mkdir -p /tmp/automation-trial/var
cp manager/registry.example.json /tmp/automation-trial/var/registry.json
AUTOMATION_HOME=/tmp/automation-trial/var AUTOMATION_MANAGER_PORT=4799 node manager/server.mjs
```

想连 LaunchAgent 和凭据都不碰到，再加一个假 HOME：`HOME=/tmp/automation-trial-home`。plist 路径、Chrome Profile 等都从 `$HOME` 推导，生产会话的 launchd 域不会被写入。

## 环境变量一览

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AUTOMATION_MANAGER_PORT` | `4765` | 监听端口，只绑 `127.0.0.1` |
| `AUTOMATION_HOME` | 仓根的 `var/` | 数据根：`tasks/`、`logs/`、`browser-data/`、`registry.json` 全在这里 |
| `AUTOMATION_MANAGER_REGISTRY` | `$AUTOMATION_HOME/registry.json` | 单独指定登记表位置。默认就跟着 `AUTOMATION_HOME` 走，隔离时不必设 |
| `AUTOMATION_LAUNCH_LABEL_PREFIX` | `com.pikachu.automation` | 新建任务的 launchd 标签前缀；只影响新建，已登记任务用自己的 `launchLabel` |
| `NODE_BIN` | 自动探测 | 子脚本用哪个 node（管理器会自动传入自己这个） |
| `PW_HEADLESS` | 非 `0` 即无头 | 「可视化测试」时设 `0` 让浏览器可见 |
| `AUTOMATION_OSASCRIPT` | `/usr/bin/osascript` | 提醒走的命令。测试里指向垫片即可避免弹真实通知，日常不用设 |
| `AUTOMATION_LAUNCHCTL` | `/bin/launchctl` | 同上，测试用垫片挡住真实 launchd 域，日常不用设 |
| `AUTOMATION_PLUTIL` | `/usr/bin/plutil` | 同上，plist 语法校验用的命令 |

## 查运行历史与故障

每次运行都会往 `var/logs/runs/<日期>.jsonl` 落一条结构化记录，失败时同时把截图和页面文本留在 `var/logs/diagnostics/`。查它们不用翻日志：

```bash
manager/automation-log.mjs                       # 最近 20 次
manager/automation-log.mjs --failed --days 7     # 这周哪些失败了、为什么
manager/automation-log.mjs --task demo-a         # 单个任务历史（判断是不是偶发）
manager/automation-log.mjs --run <runId> --open  # 摊开一次运行并打开它的截图
manager/automation-log.mjs --stale               # 已启用但超时没有成功记录的任务
```

定时运行（launchd 触发）失败会弹 macOS 通知，同一任务同一原因当天只提醒一次；界面点和终端手跑不弹，因为当场就能看到。记录字段与提醒规则的实现说明在 `manager/README.md` 和 `manager/automation-log.mjs --help`。

## 代码在哪

仓里只有三个区，这个划分决定什么东西会进版本库：

| 区 | 内容 | 入库 |
| --- | --- | --- |
| `manager/` `lib/` `docs/` `README.md` `LICENSE` `package.json` | **发布内核**：引擎后端、前端、共享模块 | 是 |
| `private/` | **你自己的站点适配层**：按站点写的 runner 与入口脚本 | 否，`.gitignore` 一行挡住整棵 |
| `var/` | **运行期数据**：登记表、录制任务、日志、浏览器 Profile | 否，同上 |

`private/` 和 `var/` 不随本仓分发，克隆下来是空的。排除规则写在**入库的** `.gitignore` 里而不是 `.git/info/exclude`，所以重新克隆后依然生效 —— 后者不随仓库走，一旦忘记补回，一次 `git add -A` 就会把站点名和账号写进无法事后清洗的 git 历史。

引擎：

| 路径 | 作用 |
| --- | --- |
| `manager/server.mjs` | 唯一的后端：任务读写、launchd 操作、录制/登录/测试进程托管、静态托管前端 |
| `manager/web/` | 前端源码：React 18 + TypeScript + Ant Design v5 + Vite |
| `manager/public/` | 前端构建产物，**不要手改** |
| `manager/open-manager` | 本机日常入口：健康就复用，不健康才拉起服务并打开页面（需要 LaunchAgent，见下） |
| `manager/install-launchagent` | 生成并加载管理器的 LaunchAgent；`--dry-run` 先看，`--uninstall` 卸载 |
| `manager/automation-log.mjs` | 查运行记录、失败原因、证据文件、漏跑任务 |
| `manager/run-record.mjs` | 每次运行时落一条记录（由 wrapper 调用，不用手动跑） |
| `manager/run-recorded-task` | 录制任务的执行器：解析 node、建 `var/tasks/node_modules` 软链、加锁、写日志 |
| `manager/task-format.mjs` | 纯格式化与校验层：可移植路径、plist 生成与 XML 转义、任务 ID、静态越界、同源、日志字节窗口 |
| `lib/run-result.mjs` | 数据根（`baseDir()`）、运行记录、状态与原因词表的**单一来源** |
| `lib/keychain-credential.mjs` | 从 macOS Keychain 取凭据 |
| `lib/automation-run.zsh` | 入口脚本共用的一次运行上下文（runId、触发来源、记录写入） |
| `manager/README.md` | 运维细节：连接状态标签含义、故障恢复、彻底删除的逐项确认、接口参考 |
| `docs/PRD.md` | 产品边界：给谁用、故意不做什么、成功标准与验收标准 |

数据（都在 `var/` 下，全部 gitignore）：

| 路径 | 作用 |
| --- | --- |
| `var/registry.json` | 任务登记表：站点 URL、账号别名、排期、launchd 标签 |
| `var/tasks/<任务 ID>/` | 每个录制任务的 `recorded.spec.js` / `playwright.config.mjs` / `auth.json` |
| `var/logs/runs/<日期>.jsonl` | 每次运行一条结构化记录 |
| `var/logs/diagnostics/` | 失败取证的截图与页面文本 |
| `var/browser-data/` | Chrome Profile，含 Cookies 与 Local Storage |

想要开机自启和崩溃自拉起（也就是双击 App 那条路），跑一次安装器：

```bash
manager/install-launchagent --dry-run   # 先看要写什么，不落盘不碰 launchd
manager/install-launchagent             # 生成并加载 ~/Library/LaunchAgents/com.pikachu.automation-manager.plist
```

`manager/open-manager` 以这个 plist 为配置真源（端口和标签都从它读），所以 `--port` 改端口、`--label` 改标签都不用碰代码。`--uninstall` 只注销并删 plist，不动任务脚本、凭据和日志。

每个任务自己的定时 plist 由管理器界面生成（启用/修改时间/移除定时），不在安装器里。

## 数据与隐私边界

三个区，两条排除规则，都写在**入库的** `.gitignore` 里：

| 区 | 内容 | 入库 |
| --- | --- | --- |
| `manager/` `lib/` `docs/` + `README.md` `LICENSE` `package.json` | 通用引擎：后端、前端、共享模块。不含任何具体站点的适配代码 | 是 |
| `private/` | 使用者自己按站点写的 runner、入口脚本、交接文档。含目标站点域名、签到判定标记、本机绝对路径 | 否 |
| `var/` | 运行期个人数据：`registry.json`（站点 URL、账号别名、launchd 标签）、`tasks/*/auth.json`（录制出来的登录态）、`browser-data/`（Cookies 与 Local Storage）、`logs/`（运行日志与失败取证截图）、`backups/` | 否 |

另加 `.env`、`.env.*` 作守卫——本项目不读环境变量文件，但它们一旦出现在工作区就不该入库。还有一条 `skyvern/`：那套 787M + AGPL 的上游 clone 已删除，规则留着是防止有人再把它 clone 进来。

**为什么排除规则必须在 `.gitignore` 而不是 `.git/info/exclude`**：后者不随仓库走，重新克隆后就没了；此后再来一次 `git add -A`，站点名和账号就被写进 git 历史 —— 而历史是 `.gitignore` 事后清不掉的东西。所以本仓的边界靠 `private/` 与 `var/` 这两个**目录名**成立，不靠任何只存在于单台机器上的配置。

把自己的 runner 留在本地、只分发引擎，做法就是放进 `private/`：那一行排除规则天然替你守着，不用记着补配置。

## 测试

```bash
npm run check         # 交付前跑这一个：门禁 + 构建产物一致性
npm test              # 全部用例，不装任何依赖
npm run test:coverage # 带每文件覆盖率报告
npm run test:ci       # 门禁：纯逻辑层行 ≥90 / 分支 ≥85，不达标 exit 1
```

`node:test` 自带，所以 `npm test` 在空 `node_modules` 上也能跑。四分层：

| 层 | 位置 | 覆盖什么 | 需要装依赖 |
| --- | --- | --- | --- |
| 纯逻辑 | `test/lib.run-result.test.mjs` `test/manager.task-format.test.mjs` | 状态与原因词表、时间键、数据根、记录读写与清理、提醒去重；可移植路径、plist 生成与 XML 转义、任务 ID、静态越界、同源、日志字节窗口 | 否 |
| API 契约 | `test/api.contract.test.mjs` | 入参校验矩阵、错误码、409 并发、403 跨站、413/422/503 | 否 |
| 生命周期 | `test/e2e.lifecycle.test.mjs` | 建→定时→运行→暂停→启用→移除→删除全链路；`launchctl` 调用序列 | 否 |
| 故障注入 | `test/fault.*.test.mjs` | 被强杀后的锁接管、连接被拒、500、挂站超时、DNS 失败、只读目录 | 网络层需要 |

副作用全走注入点（`AUTOMATION_LAUNCHCTL` / `AUTOMATION_PLUTIL` / `AUTOMATION_OSASCRIPT`），加上假 `HOME` 与独立 launchd 标签前缀，**测试不会碰到真实 launchd 域、真实凭据或生产登记表**。另有 `test/docs.drift.test.mjs` 机械校验文档与实现是否还一致。

两点口径：覆盖率门禁只统计纯逻辑层（`lib/*.mjs` 与 `manager/task-format.mjs`），不把 `server.mjs` 和压缩后的前端 bundle 算进分母——副作用层由契约层与生命周期层从外部压行为；`check:artifact` 在没装 `manager/web` 依赖时自动跳过并说明原因。

## 已知限制（截至本版）

- 只支持 macOS，没有 Linux/Windows 路径。
- launchd 标签前缀可配置：任务标签默认 `com.pikachu.automation.<任务 ID>`，用 `AUTOMATION_LAUNCH_LABEL_PREFIX` 换掉（改了只影响新建任务，已登记的沿用各自存下的 `launchLabel`）。
- 前端构建产物 `manager/public/` 随源码一起入库，好处是克隆下来直接能跑，代价是改 `manager/web/src/` 后必须重新 `npm run build`，否则界面与后端静默失同步。CI 的 `artifact` 作业专门盯这条。
- 网络异常与强杀接管两类用例需要 `cd manager && npm install`，否则自动 skip（CI 里由 `deps` 作业真跑）。

## 许可

MIT © 2026 pikachuprogrammer01。详见 `LICENSE`。

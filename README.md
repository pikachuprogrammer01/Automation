# Automation：本机自动化任务管理器

在 macOS 上跑定时网页任务的管理器：录制浏览器操作生成 Playwright 脚本、按天定时执行、在网页界面里看每次运行的输出与失败原因。
后端只有 Node 标准库，不需要 Docker，不需要数据库，只监听 `127.0.0.1`。

## 边界（先说清楚）

- **AS IS，无担保，不提供支持。** MIT 协议原文见 `LICENSE`，其中已包含完整的免责与责任上限条款。作者不承诺修复、不承诺兼容、不承诺响应 issue。
- **不针对任何第三方站点做合规评估。** 本工具能自动化任何网页，但目标站点的服务条款是否允许脚本化访问，由使用者自己确认并承担后果。作者未做这项评估，也不为任何具体站点的用法背书。
- **示例只用内置演示站点。** 仓内自带的 `http://127.0.0.1:<port>/demo/` 是纯本地假站点，专门用来演示录制与状态判定。作者实际使用的站点专用 runner 不在发布范围内（见「数据与隐私边界」）。

## 环境要求

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| macOS | 任意近期版本 | 定时、凭据、进程托管都建立在 launchd + macOS Keychain 上 |
| Node.js | ≥ 18 | 实测 v24.18.0。脚本用 ESM 与 `Array.at`，16 以下会报错 |
| Google Chrome | 稳定版 | 登录与录制用系统 Chrome（`manager/server.mjs:18` 写死路径） |

## 跑起来

### 1. 只想起服务、看界面（零 npm 依赖）

```bash
cp manager/registry.example.json manager/registry.json   # 首次：生成空的任务登记表
npm start                                                # 等价于 node manager/server.mjs
```

打开 `http://127.0.0.1:4765`。空登记表下界面会给「还没有任务 / 新建自动化」的引导。

本机已经有一个管理器在 4765 上跑着的话，换端口避免撞车：

```bash
AUTOMATION_MANAGER_PORT=4788 npm start
```

### 2. 先拿内置演示站点练一遍（不联网，不含任何真实站点）

`http://127.0.0.1:4765/demo/` 是随构建产物一起入库的本地假站点，带「立即签到 / 今日已签到」和「立即抽奖 / 暂无抽奖机会」，状态存在你自己浏览器的 localStorage，页面上有重置按钮。

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

**两个变量都要设。** `AUTOMATION_HOME` 只搬任务脚本、Profile 和日志的根目录；登记表 `manager/registry.json` 默认跟着 `server.mjs` 所在目录走，**不受 `AUTOMATION_HOME` 影响**。只设前一个就动手写接口，改的就是你正在跑的那份生产登记表。服务启动时会把 `base=` 和 `registry=` 两行打进 stdout，起完先看一眼。

```bash
AUTOMATION_HOME=/tmp/automation-trial \
AUTOMATION_MANAGER_REGISTRY=/tmp/automation-trial/registry.json \
AUTOMATION_MANAGER_PORT=4799 node manager/server.mjs
```

想连 LaunchAgent 和凭据都不碰到，再加一个假 HOME：`HOME=/tmp/automation-trial-home`。plist 路径、Chrome Profile 等都从 `$HOME` 推导，生产会话的 launchd 域不会被写入。

## 环境变量一览

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AUTOMATION_MANAGER_PORT` | `4765` | 监听端口，只绑 `127.0.0.1` |
| `AUTOMATION_HOME` | 仓根 | 数据根：`tasks/`、`logs/`、`browser-data/` |
| `AUTOMATION_MANAGER_REGISTRY` | `manager/registry.json` | 任务登记表路径。**不跟随 `AUTOMATION_HOME`**，隔离时必须单独设 |
| `AUTOMATION_LAUNCH_LABEL_PREFIX` | `com.pikachu.automation` | 新建任务的 launchd 标签前缀；只影响新建，已登记任务用自己的 `launchLabel` |
| `NODE_BIN` | 自动探测 | 子脚本用哪个 node（管理器会自动传入自己这个） |
| `PW_HEADLESS` | 非 `0` 即无头 | 「可视化测试」时设 `0` 让浏览器可见 |

## 查运行历史与故障

每次运行都会往 `logs/runs/<日期>.jsonl` 落一条结构化记录，失败时同时把截图和页面文本留在 `logs/diagnostics/`。查它们不用翻日志：

```bash
manager/automation-log.mjs                       # 最近 20 次
manager/automation-log.mjs --failed --days 7     # 这周哪些失败了、为什么
manager/automation-log.mjs --task demo-a   # 单个任务历史（判断是不是偶发）
manager/automation-log.mjs --run <runId> --open  # 摊开一次运行并打开它的截图
manager/automation-log.mjs --stale               # 已启用但超时没有成功记录的任务
```

定时运行（launchd 触发）失败会弹 macOS 通知，同一任务同一原因当天只提醒一次；界面点和终端手跑不弹，因为当场就能看到。完整设计见 `docs/OBSERVABILITY.md`，需求与验收见 `docs/OBSERVABILITY-PRD.md`。

## 代码在哪

| 路径 | 作用 |
| --- | --- |
| `manager/server.mjs` | 唯一的后端：任务读写、launchd 操作、录制/登录/测试进程托管、静态托管前端 |
| `manager/web/` | 前端源码：React 18 + TypeScript + Ant Design v5 + Vite |
| `manager/public/` | 前端构建产物，**不要手改** |
| `manager/registry.json` | 任务登记表（个人数据，已 gitignore） |
| `manager/open-manager` | 本机日常入口：健康就复用，不健康才拉起服务并打开页面（需要 LaunchAgent，见下） |
| `manager/install-launchagent` | 生成并加载管理器的 LaunchAgent；`--dry-run` 先看，`--uninstall` 卸载 |
| `manager/automation-log.mjs` | 查运行记录、失败原因、证据文件、漏跑任务 |
| `manager/run-record.mjs` | 每次运行时落一条记录（由 wrapper 调用，不用手动跑） |
| `docs/OBSERVABILITY.md` | 错误排查体系设计：runId、记录格式、提醒规则、保留清理 |
| `manager/run-recorded-task` | 录制任务的执行器：解析 node、建 `tasks/node_modules` 软链、加锁、写日志 |
| `tasks/<任务 ID>/` | 每个录制任务的 `recorded.spec.js` / `playwright.config.mjs` / `auth.json` |
| `manager/README.md` | 运维细节：连接状态标签含义、故障恢复、彻底删除的逐项确认、接口参考 |
| `docs/PRD.md` | 产品边界：给谁用、故意不做什么、成功标准与验收标准 |
| `HANDOFF.md` | 维护者交接文档（含作者本机绝对路径） |

想要开机自启和崩溃自拉起（也就是双击 App 那条路），跑一次安装器：

```bash
manager/install-launchagent --dry-run   # 先看要写什么，不落盘不碰 launchd
manager/install-launchagent             # 生成并加载 ~/Library/LaunchAgents/com.pikachu.automation-manager.plist
```

`manager/open-manager` 以这个 plist 为配置真源（端口和标签都从它读），所以 `--port` 改端口、`--label` 改标签都不用碰代码。`--uninstall` 只注销并删 plist，不动任务脚本、凭据和日志。

每个任务自己的定时 plist 由管理器界面生成（启用/修改时间/移除定时），不在安装器里。

## 数据与隐私边界

`.gitignore` 已经排除以下含真实账号、邮箱或浏览器登录态的路径：`manager/registry.json`、`manager/registry.json.bak`、`manager/backups/`、`tasks/*/auth.json`、`browser-data/`、`logs/`、`site/accounts.json`、`site/accounts.json`、`.gstack/`。另有一条 `skyvern/` 是历史守卫：那套 787M + AGPL 的上游 clone 已于 2026-10-02 整体删除，规则留着是防止有人再把它 clone 进来。

下面是作者的个人运行层，不在 `.gitignore` 里（它们是代码，删数据文件不等于干净）。对外分发时按整块剔除：

| 路径 | 为什么是个人的 |
| --- | --- |
| `setup-local-keychain` | 只认那四个账号，且写死了作者本机的 nvm node 路径（`setup-local-keychain:44`） |
| `HANDOFF.md`、`AGENT_SYSTEM_PROMPT.md` | 维护者/AI 交接文档，含 31 处本机绝对路径与真实账号信息 |

真正可分发的核心是 `manager/` 加 `lib/keychain-credential.mjs`。

## 已知限制（截至本版）

- 只支持 macOS，没有 Linux/Windows 路径。
- launchd 标签前缀可配置：任务标签默认 `com.pikachu.automation.<任务 ID>`，用 `AUTOMATION_LAUNCH_LABEL_PREFIX` 换掉（改了只影响新建任务，已登记的沿用各自存下的 `launchLabel`）。
- 没有自动化测试，也没有 CI。改动只能靠上面的隔离实例手工验证。
- 入参校验失败目前返回 HTTP 500 而不是 400，且会把 Node 原生错误消息透出来（`POST /api/recordings/create` 缺字段是最明显的一例）。

## 许可

MIT © 2026 pikachuprogrammer01。详见 `LICENSE`。

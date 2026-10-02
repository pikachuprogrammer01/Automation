import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { lastRunFor } from '../lib/run-result.mjs';

const HOME = os.homedir();
const UID = process.getuid();
// 仓库根从自身文件位置推导，不假设项目目录叫什么名字；
// AUTOMATION_HOME 只用于把整棵数据目录指到别处（测试/迁移用）。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.AUTOMATION_HOME || path.dirname(ROOT);
const PUBLIC = path.join(ROOT, 'public');
const TASKS = path.join(BASE, 'tasks');
// 允许把登记表指向别处：回归测试用独立 registry，避免误触发真实签到任务。
const REGISTRY = process.env.AUTOMATION_MANAGER_REGISTRY || path.join(ROOT, 'registry.json');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.AUTOMATION_MANAGER_PORT || 4765);
// 新建任务生成的 launchd 标签前缀。默认值沿用作者机器的历史命名；
// 已登记的任务读自己的 launchLabel 字段，改这个变量不会影响它们。
const LABEL_PREFIX = process.env.AUTOMATION_LAUNCH_LABEL_PREFIX || 'com.pikachu.automation';
if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(LABEL_PREFIX)) {
  throw new Error(`AUTOMATION_LAUNCH_LABEL_PREFIX 不合法：${LABEL_PREFIX}（只允许字母、数字、点和连字符）`);
}
const active = new Map();
const results = new Map();

fs.mkdirSync(TASKS, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });

// registry 里存可移植路径：`~/...` 或相对仓库根；这样换机器、改目录名、克隆仓库都不用重写数据。
function fromPortable(v) {
  if (typeof v !== 'string' || !v || v.includes('://')) return v;
  if (v.startsWith('~/')) return path.join(HOME, v.slice(2));
  if (v.startsWith('/') || v.startsWith('\\"')) return v;
  return path.join(BASE, v);
}
function toPortable(v) {
  if (typeof v !== 'string' || !v) return v;
  if (v === HOME) return '~';
  if (v.startsWith(HOME + '/')) return '~/' + v.slice(HOME.length + 1);
  if (v.startsWith(BASE + '/')) return v.slice(BASE.length + 1);
  return v;
}
const PORTABLE_KEYS = ['plistPath', 'logPath', 'configPath', 'profileDir', 'taskDir', 'stdoutPath', 'stderrPath'];
function mapTaskPaths(task, fn) {
  const out = { ...task };
  for (const k of PORTABLE_KEYS) if (k in out) out[k] = fn(out[k]);
  // 约定：command[0] 是解释器、command[1] 是脚本（可移植路径）、command[2+] 是参数（永不改写）。
  if (Array.isArray(out.command) && out.command.length > 1) {
    const cmd = [...out.command];
    cmd[1] = fn(cmd[1]);
    out.command = cmd;
  }
  return out;
}
function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new ApiError('registry_missing', `任务登记表不存在：${toPortable(REGISTRY)}`, '执行 cp manager/registry.example.json manager/registry.json 生成一份空登记表', 503);
    }
    throw e;
  }
  const data = JSON.parse(raw);
  return { ...data, tasks: (data.tasks || []).map((t) => mapTaskPaths(t, fromPortable)) };
}
function saveRegistry(data) {
  if (fs.existsSync(REGISTRY)) fs.copyFileSync(REGISTRY, REGISTRY + '.bak');
  const portable = { ...data, tasks: (data.tasks || []).map((t) => mapTaskPaths(t, toPortable)) };
  fs.writeFileSync(REGISTRY, JSON.stringify(portable, null, 2) + '\n', { mode: 0o600 });
}
function findTask(id) {
  return loadRegistry().tasks.find((x) => x.id === id);
}
function okJson(res, payload = {}) {
  const body = JSON.stringify({ ok: true, ...payload });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function failJson(res, status, error, extra = {}) {
  const body = JSON.stringify({ ok: false, error: String(error), ...extra });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
/**
 * 带 HTTP 语义的接口错误：message 是给人看的（前端直接显示在 error 字段），
 * code 是给程序分支的，hint 是怎么修。抛这个错才会得到 4xx，其余一律 500。
 */
class ApiError extends Error {
  constructor(code, message, hint, status = 400) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}
function readBody(req) {
  return collectBody(req).catch((e) => {
    if (e instanceof ApiError) throw e;
    throw new ApiError('invalid_json', '请求体不是合法 JSON', '检查 Content-Type 与 body 是否成对', 400);
  });
}
async function collectBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length > 64 * 1024) throw new ApiError('request_too_large', `请求体过大（${text.length} 字节，上限 64KB）`, undefined, 413);
  return JSON.parse(text);
}
function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(id);
}
function runSync(file, args = [], options = {}) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
}
function isLoaded(task) {
  if (!task?.launchLabel) return false;
  return runSync('/bin/launchctl', ['print', `gui/${UID}/${task.launchLabel}`]).status === 0;
}
function readSchedule(task) {
  if (!task.plistPath || !fs.existsSync(task.plistPath)) return task.defaultSchedule || null;
  const p = runSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', task.plistPath]);
  if (p.status !== 0) return task.defaultSchedule || null;
  try {
    const data = JSON.parse(p.stdout);
    const s = data.StartCalendarInterval || {};
    return { hour: Number(s.Hour), minute: Number(s.Minute) };
  } catch {
    return task.defaultSchedule || null;
  }
}
function tailLine(file, accountKey) {
  if (!file || !fs.existsSync(file)) return '';
  let lines = [];
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 16384);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    lines = buf.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  } catch { return ''; }
  // Tasks with the same log file share it; without this the B card shows the A account's line.
  if (accountKey && /^[a-z0-9]$/.test(accountKey)) {
    const mine = lines.filter((l) => l.includes(`[${accountKey}]`) || new RegExp(`"account"\\s*:\\s*"${accountKey}"`).test(l));
    if (mine.length) return mine.at(-1);
  }
  return lines.at(-1) || '';
}
function credentialInfo(task) {
  if (task.configPath && task.accountKey && fs.existsSync(task.configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(task.configPath, 'utf8'));
      const account = data.accounts?.[task.accountKey] || {};
      if (account.keychainService && account.username) {
        return { backend: 'macOS Keychain', service: account.keychainService, username: account.username };
      }
    } catch {}
  }
  return { backend: task.credentialBackend || '无', service: null, username: null };
}
/**
 * 界面上的「上次运行」优先取内存（管理器自己拉起的那次，信息最全），
 * 没有就回落到 logs/runs/ 的最后一条 —— 否则重启管理器历史就没了，
 * 而且 launchd 定时跑的那几次本来就不经过内存。
 */
function diskLastRun(task) {
  const r = lastRunFor(BASE, task.id);
  if (!r) return null;
  return {
    kind: r.trigger === 'test' ? '测试中' : '运行中',
    startedAt: r.startedAt || r.ts,
    endedAt: r.endedAt || null,
    code: Number.isFinite(r.exitCode) ? r.exitCode : null,
    ok: r.status === 'completed',
    runId: r.runId || null,
    status: r.status || null,
    reason: r.reason || null,
    note: r.note || null,
    durationS: Number.isFinite(r.durationS) ? r.durationS : null,
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    trigger: r.trigger || null,
    fromDisk: true,
  };
}
function taskView(task) {
  const credential = credentialInfo(task);
  return {
    ...task,
    plistExists: Boolean(task.plistPath && fs.existsSync(task.plistPath)),
    profileExists: Boolean(task.profileDir && fs.existsSync(task.profileDir)),
    taskDirExists: Boolean(task.taskDir && fs.existsSync(task.taskDir)),
    logExists: Boolean(task.logPath && fs.existsSync(task.logPath)),
    loaded: isLoaded(task),
    schedule: readSchedule(task),
    credentialBackend: credential.backend,
    credentialService: credential.service || null,
    credentialUsername: credential.username || null,
    lastLog: tailLine(task.logPath, task.accountKey),
    active: active.get(task.id) || null,
    lastRun: results.get(task.id) || diskLastRun(task) || null,
  };
}
function xml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function plistText(task, hour, minute) {
  const args = task.command.map((x) => `<string>${xml(x)}</string>`).join('');
  const out = task.stdoutPath || `${task.logPath}.launchd.out`;
  const err = task.stderrPath || `${task.logPath}.launchd.err`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${xml(task.launchLabel)}</string>\n` +
    `<key>ProgramArguments</key><array>${args}</array>\n` +
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n` +
    `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>\n` +
    `<key>ProcessType</key><string>Background</string>\n` +
    `<key>StandardOutPath</key><string>${xml(out)}</string>\n` +
    `<key>StandardErrorPath</key><string>${xml(err)}</string>\n` +
    `</dict></plist>\n`;
}
function bootout(task) {
  runSync('/bin/launchctl', ['bootout', `gui/${UID}/${task.launchLabel}`]);
}
function installTask(task, schedule) {
  const { hour, minute } = schedule;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new ApiError('invalid_schedule', `执行时间不合法：${hour}:${minute}`, '小时取 0-23，分钟取 0-59');
  }
  fs.mkdirSync(path.dirname(task.plistPath), { recursive: true });
  fs.writeFileSync(task.plistPath, plistText(task, hour, minute));
  runSync('/usr/bin/plutil', ['-lint', task.plistPath]);
  bootout(task);
  runSync('/bin/launchctl', ['enable', `gui/${UID}/${task.launchLabel}`]);
  const r = runSync('/bin/launchctl', ['bootstrap', `gui/${UID}`, task.plistPath]);
  if (r.status !== 0 && !isLoaded(task)) {
    throw new ApiError('launchctl_bootstrap_failed', `launchd 没能加载 ${task.launchLabel}，定时未生效`, (r.stderr || '').trim() || `看 logs/automation-manager.err 与 ${toPortable(task.plistPath)}`, 500);
  }
}
function disableTask(task) {
  bootout(task);
  runSync('/bin/launchctl', ['disable', `gui/${UID}/${task.launchLabel}`]);
  if (isLoaded(task)) {
    throw new ApiError('disable_failed', `${task.launchLabel} 仍处于已加载状态，暂停未生效`, '看 logs/automation-manager.err 里 launchctl 的报错', 500);
  }
}
function enableTask(task) {
  const schedule = readSchedule(task) || task.defaultSchedule || { hour: 9, minute: 0 };
  installTask(task, schedule);
}
function removeSchedule(task) {
  bootout(task);
  runSync('/bin/launchctl', ['enable', `gui/${UID}/${task.launchLabel}`]);
  if (task.plistPath && fs.existsSync(task.plistPath)) fs.rmSync(task.plistPath);
  if (isLoaded(task)) {
    throw new ApiError('remove_schedule_failed', `${task.launchLabel} 仍在 launchd 中，移除定时未生效`, '看 logs/automation-manager.err 里 launchctl 的报错', 500);
  }
}
function busyError(task) {
  return new ApiError('task_busy', `任务 ${task.id} 正在运行中`, '等上一次运行结束；进度看右侧「运行输出」面板或卡片上的「看输出」', 409);
}
function runTask(task, env = {}) {
  if (!Array.isArray(task.command) || !task.command.length) {
    throw new ApiError('task_has_no_command', `任务 ${task.id} 没有配置 command`, '检查 manager/registry.json 里该任务的 command 数组', 422);
  }
  if (active.has(task.id)) throw busyError(task);
  const proc = spawn(task.command[0], task.command.slice(1), {
    detached: true,
    stdio: 'ignore',
    // launchd 给的 PATH 里没有 nvm 的 node；把自己就是 node 这件事告诉子脚本。
    // trigger/task 让 wrapper 知道这次是谁点的（docs/OBSERVABILITY.md）。
    env: { ...process.env, NODE_BIN: process.execPath, AUTOMATION_TRIGGER: 'manager', AUTOMATION_TASK: task.id, AUTOMATION_SITE: task.site || '', ...env },
  });
  proc.unref();
  markActive(task, '运行中', proc, true);
  return proc.pid;
}
function upsertTask(task) {
  const data = loadRegistry();
  const i = data.tasks.findIndex((x) => x.id === task.id);
  if (i >= 0) data.tasks[i] = task; else data.tasks.push(task);
  saveRegistry(data);
}
function writeRecordedScaffold(task, url, blank = false) {
  const dir = task.taskDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(task.profileDir, { recursive: true, mode: 0o700 });
  const auth = path.join(dir, 'auth.json');
  const cfg = `import fs from 'node:fs';\nimport { defineConfig } from '@playwright/test';\nconst auth = './auth.json';\nexport default defineConfig({\n  testDir: '.',\n  testMatch: /recorded\\.spec\\.js/,\n  timeout: 120000,\n  workers: 1,\n  use: { channel: 'chrome', headless: process.env.PW_HEADLESS !== '0', ...(fs.existsSync(auth) ? { storageState: auth } : {}) },\n});\n`;
  fs.writeFileSync(path.join(dir, 'playwright.config.mjs'), cfg);
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id: task.id, name: task.name, url }, null, 2) + '\n');
  if (blank || !fs.existsSync(path.join(dir, 'recorded.spec.js'))) {
    const spec = `import { test, expect } from '@playwright/test';\n\ntest('${task.name.replaceAll("'", '')}', async ({ page }) => {\n  await page.goto(${JSON.stringify(url)});\n  // 在这里继续编写你的自动化操作。\n  await expect(page).toHaveURL(/./);\n});\n`;
    fs.writeFileSync(path.join(dir, 'recorded.spec.js'), spec, { mode: 0o600 });
  }
  if (fs.existsSync(auth)) fs.chmodSync(auth, 0o600);
}
function createRecordedTask({ id, name, url, blank }) {
  if (typeof id !== 'string' || !id) throw new ApiError('missing_id', '缺少任务 ID', '任务 ID 用小写字母、数字和连字符，2-41 位');
  if (!validId(id)) throw new ApiError('invalid_id', `任务 ID 不合法：${id}`, '只能使用小写字母、数字和连字符，2-41 位，且以字母或数字开头');
  if (typeof name !== 'string' || !name.trim()) throw new ApiError('missing_name', '缺少任务名称', '给任务起个能认出来的名字');
  if (name.length > 80) throw new ApiError('name_too_long', `任务名称过长（${name.length} 字符，上限 80）`);
  if (typeof url !== 'string' || !url.trim()) throw new ApiError('missing_url', '缺少网址', '例如 http://127.0.0.1:4765/demo/ 或你自己要自动化的页面');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ApiError('invalid_url', `网址不是合法 URL：${url}`, '需要以 http:// 或 https:// 开头');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ApiError('unsupported_scheme', `不支持的协议：${u.protocol}`, '只接受 http 和 https');
  if (findTask(id)) throw new ApiError('task_id_exists', `任务 ID 已存在：${id}`, '换一个 ID，或先在列表里删除已有任务');
  const taskDir = path.join(TASKS, id);
  const profileDir = path.join(BASE, 'browser-data', `managed-${id}`);
  const task = {
    id, name, site: u.hostname, type: 'recorded', url,
    launchLabel: `${LABEL_PREFIX}.${id}`,
    plistPath: path.join(HOME, 'Library', 'LaunchAgents', `${LABEL_PREFIX}.${id}.plist`),
    command: ['/bin/zsh', path.join(ROOT, 'run-recorded-task'), id],
    defaultSchedule: { hour: 9, minute: 0 },
    logPath: path.join(BASE, 'logs', `${id}.log`),
    profileDir, taskDir,
    credentialBackend: '浏览器登录状态 / 可改用 Keychain',
    url,
  };
  writeRecordedScaffold(task, url, Boolean(blank));
  upsertTask(task);
  return task;
}
function markActive(task, kind, proc, recordResult = false) {
  const id = task.id;
  let logStart = 0;
  try { if (task.logPath && fs.existsSync(task.logPath)) logStart = fs.statSync(task.logPath).size; } catch { /* 读不到就从头给 */ }
  const entry = { kind, pid: proc.pid, startedAt: new Date().toISOString(), logStart };
  active.set(id, entry);
  proc.once('exit', (code) => {
    const cur = active.get(id);
    if (cur?.pid === proc.pid) active.delete(id);
    if (recordResult) {
      results.set(id, { ...entry, endedAt: new Date().toISOString(), code, ok: code === 0 });
    }
    console.log(`[${id}] ${kind} exited ${code}`);
  });
}
function captureState(task) {
  if (!task.taskDir || !task.profileDir) return;
  const out = path.join(task.taskDir, 'auth.json');
  const r = runSync(process.execPath, [path.join(ROOT, 'capture-state.mjs'), task.profileDir, out], { cwd: ROOT, timeout: 60000 });
  if (r.status !== 0) console.error(`[${task.id}] capture state failed`, r.stderr);
}
function prepareLogin(task) {
  if (active.has(task.id)) throw busyError(task);
  const proc = spawn(CHROME, [
    `--user-data-dir=${task.profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode', task.url,
  ], { stdio: 'ignore' });
  markActive(task, '准备登录中', proc);
  proc.once('exit', () => {
    try { captureState(task); } catch (e) { console.error(e); }
  });
  return proc.pid;
}
function startRecording(task) {
  if (active.has(task.id)) throw busyError(task);
  const bin = path.join(ROOT, 'node_modules', '.bin', 'playwright');
  const output = path.join(task.taskDir, 'recorded.spec.js');
  const proc = spawn(bin, ['codegen', '--channel=chrome', `--user-data-dir=${task.profileDir}`, '--output', output, task.url], {
    cwd: task.taskDir,
    stdio: 'ignore',
  });
  markActive(task, '录制中', proc);
  proc.once('exit', () => {
    if (fs.existsSync(output)) fs.chmodSync(output, 0o600);
  });
  return proc.pid;
}
function openCode(task) {
  const file = path.join(task.taskDir, 'recorded.spec.js');
  if (!fs.existsSync(file)) {
    throw new ApiError('script_not_found', `还没有生成脚本：${toPortable(file)}`, '先点「② 开始录制」，或新建时选「新建空白脚本」');
  }
  let r = runSync('/usr/bin/open', ['-a', 'Visual Studio Code', file]);
  if (r.status !== 0) r = runSync('/usr/bin/open', ['-R', file]);
  if (r.status !== 0) {
    throw new ApiError('cannot_open_editor', '打不开代码编辑器', '没装 VS Code 时直接去文件管理器打开 tasks/ 下该任务的 recorded.spec.js', 500);
  }
}
function testRecorded(task) {
  if (active.has(task.id)) throw busyError(task);
  const proc = spawn('/bin/zsh', [path.join(ROOT, 'run-recorded-task'), task.id], {
    stdio: 'ignore',
    env: { ...process.env, NODE_BIN: process.execPath, PW_HEADLESS: '0', AUTOMATION_TRIGGER: 'test', AUTOMATION_TASK: task.id, AUTOMATION_SITE: task.site || '' },
  });
  markActive(task, '测试中', proc, true);
  return proc.pid;
}
function removeAccountConfig(task) {
  if (!task.configPath || !task.accountKey || !fs.existsSync(task.configPath)) return;
  const data = JSON.parse(fs.readFileSync(task.configPath, 'utf8'));
  if (data.accounts && data.accounts[task.accountKey]) {
    delete data.accounts[task.accountKey];
    fs.writeFileSync(task.configPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
}
function deleteCredential(task) {
  const info = credentialInfo(task);
  if (info.backend !== 'macOS Keychain') return;
  const exists = runSync('/usr/bin/security', [
    'find-generic-password', '-a', info.username, '-s', info.service,
  ], { timeout: 10000 });
  if (exists.status !== 0) return;
  const r = runSync('/usr/bin/security', [
    'delete-generic-password', '-a', info.username, '-s', info.service,
  ], { timeout: 10000 });
  if (r.status !== 0) {
    throw new ApiError('keychain_delete_failed', '删除 macOS Keychain 凭据失败', '可以取消勾选「删除凭据」后重试，凭据本身不会被改动', 500);
  }
}
function purgeTask(task, opts) {
  if (opts.deleteCredential) deleteCredential(task);
  removeSchedule(task);
  if (task.type === 'imported') removeAccountConfig(task);
  if (opts.deleteProfile && task.profileDir && fs.existsSync(task.profileDir)) fs.rmSync(task.profileDir, { recursive: true, force: true });
  if (opts.deleteLogs && task.logPath && fs.existsSync(task.logPath)) {
    const others = loadRegistry().tasks.filter((x) => x.id !== task.id && x.logPath === task.logPath);
    if (!others.length) fs.rmSync(task.logPath, { force: true });
  }
  if (task.type === 'recorded' && task.taskDir && fs.existsSync(task.taskDir)) fs.rmSync(task.taskDir, { recursive: true, force: true });
  const data = loadRegistry();
  data.tasks = data.tasks.filter((x) => x.id !== task.id);
  saveRegistry(data);
}
/** 从指定字节偏移读日志；运行面板靠它只取本次运行新增的部分。 */
function readLog(task, from) {
  const file = task.logPath;
  if (!file || !fs.existsSync(file)) return { text: '', size: 0, from: 0, missing: true };
  const size = fs.statSync(file).size;
  const start = Number.isFinite(from) && from >= 0 ? Math.min(from, size) : Math.max(0, size - 65536);
  const len = Math.min(size - start, 65536);
  let text = '';
  if (len > 0) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  }
  return { text, size, from: start };
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(path.resolve(PUBLIC) + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return failJson(res, 403, '禁止访问该路径', { code: 'forbidden', hint: '静态文件只能取 manager/public 目录下的内容' });
  }
  let target = file;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return failJson(res, 404, `没有找到页面：${pathname}`, { code: 'not_found', hint: '管理界面是 /，内置演示站点是 /demo/' });
  }
  const ext = path.extname(target);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/tasks') {
      const tasks = loadRegistry().tasks.map(taskView);
      return okJson(res, { tasks });
    }
    if (req.method === 'GET' && p === '/api/system') {
      return okJson(res, { manager: 'running', port: PORT });
    }
    const logMatch = p.match(/^\/api\/tasks\/([a-z0-9-]+)\/log$/);
    if (req.method === 'GET' && logMatch) {
      const task = findTask(logMatch[1]);
      if (!task) return failJson(res, 404, `找不到任务：${logMatch[1]}`, { code: 'task_not_found', hint: '刷新列表确认任务 ID' });
      const raw = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('from');
      return okJson(res, readLog(task, raw === null ? NaN : Number(raw)));
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return failJson(res, 403, '跨站请求被拒绝', { code: 'bad_origin', hint: `只能从 ${`http://127.0.0.1:${PORT}`} 这个页面发起写操作` });
    }
    if (req.method === 'POST' && p === '/api/system/shutdown') {
      okJson(res, { shuttingDown: true });
      setTimeout(() => server.close(() => process.exit(0)), 150);
      return;
    }
    if (req.method === 'POST' && p === '/api/recordings/create') {
      const body = await readBody(req);
      const task = createRecordedTask(body);
      return okJson(res, { task: taskView(task) });
    }
    const m = p.match(/^\/api\/tasks\/([a-z0-9-]+)\/(run|enable|disable|schedule|remove|purge)$/);
    if (req.method === 'POST' && m) {
      const task = findTask(m[1]);
      if (!task) return failJson(res, 404, `找不到任务：${m[1]}`, { code: 'task_not_found', hint: '刷新列表确认任务 ID' });
      const action = m[2];
      const body = await readBody(req);
      if (action === 'run') return okJson(res, { pid: runTask(task) });
      if (action === 'enable') { enableTask(task); return okJson(res); }
      if (action === 'disable') { disableTask(task); return okJson(res); }
      if (action === 'schedule') {
        if (body.hour === undefined || body.minute === undefined) {
          return failJson(res, 400, '缺少执行时间', { code: 'missing_schedule', hint: 'body 需要 hour（0-23）和 minute（0-59）' });
        }
        installTask(task, { hour: Number(body.hour), minute: Number(body.minute) });
        return okJson(res);
      }
      if (action === 'remove') { removeSchedule(task); return okJson(res); }
      if (action === 'purge') {
        if (body.confirm !== task.id) {
          return failJson(res, 400, `删除确认不匹配：需要原样输入任务 ID「${task.id}」`, { code: 'confirmation_required', hint: '这是防误删；勾选要一起删除的凭据/Profile/日志后仍需输入 ID' });
        }
        purgeTask(task, body);
        return okJson(res);
      }
    }
    const r = p.match(/^\/api\/recordings\/([a-z0-9-]+)\/(login|record|open|test)$/);
    if (req.method === 'POST' && r) {
      const task = findTask(r[1]);
      if (!task || task.type !== 'recorded') {
        return failJson(res, 404, `找不到录制类任务：${r[1]}`, { code: 'recorded_task_not_found', hint: '① 准备登录 / ② 开始录制 / ③ 打开代码 / ④ 可视化测试 只对「录制操作」或「新建空白脚本」建的任务开放' });
      }
      if (r[2] === 'login') return okJson(res, { pid: prepareLogin(task) });
      if (r[2] === 'record') return okJson(res, { pid: startRecording(task) });
      if (r[2] === 'open') { openCode(task); return okJson(res); }
      if (r[2] === 'test') return okJson(res, { pid: testRecorded(task) });
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    return failJson(res, 404, `没有这个接口：${req.method} ${p}`, {
      code: 'not_found',
      hint: 'GET /api/system · GET /api/tasks · GET /api/tasks/<id>/log?from=<字节偏移> · POST /api/recordings/create · POST /api/tasks/<id>/{run,enable,disable,schedule,remove,purge} · POST /api/recordings/<id>/{login,record,open,test} · POST /api/system/shutdown',
    });
  } catch (e) {
    console.error(e);
    const status = Number.isInteger(e?.status) ? e.status : 500;
    const code = e?.code || 'internal_error';
    const hint = e?.hint || (status >= 500 ? `服务端日志：logs/automation-manager.err（${new Date().toISOString()}）` : undefined);
    return failJson(res, status, e?.message || String(e), { code, ...(hint ? { hint } : {}) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Automation Manager http://127.0.0.1:${PORT}`);
  // AUTOMATION_HOME 只搬数据目录，不搬登记表；两者分别打出来，避免误把生产 registry 当沙箱写。
  console.log(`  base=${BASE}`);
  console.log(`  registry=${REGISTRY}${process.env.AUTOMATION_MANAGER_REGISTRY ? '' : '  (默认跟随 server.mjs 所在目录，不受 AUTOMATION_HOME 影响)'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

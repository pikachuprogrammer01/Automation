import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STATUS = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  WAITING: 'waiting',
  SKIPPED: 'skipped',
};

/** 需要提醒的状态。skipped 不算：上一轮还在跑不是故障。 */
export const ALERT_STATUSES = new Set([STATUS.FAILED, STATUS.BLOCKED, STATUS.WAITING]);

/**
 * 站点要人工的信号词。刻意保持与迁移前那份清单一致，没有扩充：
 * 多匹配几个词能少一些误判，但那是在扩大对页面文案的匹配面，与「不绕过人机验证」的边界擦边。
 */
export const CHALLENGE_WORDS = [
  'captcha', 'verification code', 'security verification', 'device verification',
  'scan qr', '验证码', '安全验证',
];

const REASON_LABEL = {
  not_authenticated: '没登上',
  login_form_rejected: '登录框没消失（凭据被当场拒绝或要二次验证）',
  login_timeout: '登录超时',
  security_challenge: '站点要安全验证',
  terms_update_required: '站点要确认新条款',
  terms_decision_timeout: '条款确认超时',
  terms_decision_required: '等你确认条款',
  account_mismatch: '登进去的不是这个账号',
  wrong_account_logout_failed: '登出错账号且登出失败',
  sign_in_not_confirmed: '点了签到但没确认成功',
  sign_in_state_timeout: '页面既没有签到入口也没有已领取标记',
  sign_in_button_not_ready: '签到按钮始终不可点',
  lottery_button_not_ready: '抽奖按钮不可点',
  unknown_account: '登记表里没有这个账号',
  keychain_credential_unavailable: 'Keychain 里取不到凭据',
  keychain_account_not_configured: '账号没配 keychainService/username',
  node_not_found: '找不到 node',
  playwright_cli_missing: '缺 playwright CLI',
  script_not_found: '找不到任务脚本',
  runner_script_missing: '找不到 runner',
  runner_no_output: 'runner 没有任何输出',
  task_busy: '同一任务还在运行',
  lock_held: '上一轮还没结束',
  already_running: '上一轮还没结束',
  playwright_failed: 'Playwright 脚本执行失败',
  corrupt_record: '运行记录有一行坏了',
  TimeoutError: '超时',
  Error: '未知错误',
};

export function reasonLabel(reason) {
  if (!reason) return '未记录原因';
  return REASON_LABEL[reason] || reason;
}

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间的 YYYYMMDD-HHMMSS，和文件名、人眼读的时间对得上，不用 UTC。 */
export function stampOf(when = new Date()) {
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}
export function dateKeyOf(when = new Date()) {
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}
export function newRunId(task, when = new Date()) {
  return `${task}-${stampOf(when)}`;
}
/** 带时区偏移的本地 ISO，直接可读也能被 Date.parse。 */
export function isoLocal(when = new Date()) {
  const offsetMin = -when.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${dateKeyOf(when)}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 仓根 = lib/ 的上一级；AUTOMATION_HOME 可整体改指向（隔离实例用）。 */
export function baseDir() {
  return process.env.AUTOMATION_HOME || path.resolve(import.meta.dirname, '..');
}
export function runsDir(base = baseDir()) {
  return path.join(base, 'logs', 'runs');
}
export function runsFile(base, when = new Date()) {
  return path.join(runsDir(base), `${dateKeyOf(when)}.jsonl`);
}
export function diagnosticsDir(base = baseDir()) {
  return path.join(base, 'logs', 'diagnostics');
}
/** 证据文件名带上日期和 runId，人工 ls 就能归到某一次运行。 */
export function evidenceStem(base, runId, scenario, when = new Date()) {
  return path.join(diagnosticsDir(base), `${dateKeyOf(when).replaceAll('-', '')}-${runId}-${scenario}`);
}

export function appendRun(base, record) {
  fs.mkdirSync(runsDir(base), { recursive: true, mode: 0o700 });
  const file = runsFile(base, new Date(record.startedAt || record.ts || Date.now()));
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return file;
}

function readRunFiles(base, days) {
  let names = [];
  try {
    names = fs.readdirSync(runsDir(base)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400000);
  const cutoffKey = dateKeyOf(cutoff);
  const out = [];
  for (const name of names) {
    if (name.slice(0, 10) < cutoffKey) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(runsDir(base), name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ status: 'failed', reason: 'corrupt_record', raw: line.slice(0, 200), ts: name.slice(0, 10) });
      }
    }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return out;
}

export function queryRuns(base, { days = 14, task = null, statuses = null, failedOnly = false, limit = 0 } = {}) {
  let rows = readRunFiles(base, days);
  if (task) rows = rows.filter((r) => r.task === task);
  if (statuses) rows = rows.filter((r) => statuses.includes(r.status));
  if (failedOnly) rows = rows.filter((r) => ALERT_STATUSES.has(r.status));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * 取某任务最后一次运行。从最新的文件倒着读、行内倒着找，命中就返回：
 * 界面每 5 秒轮询四个任务，这里不能把 90 天记录全量解析一遍。
 */
export function lastRunFor(base, task) {
  let names = [];
  try {
    names = fs.readdirSync(runsDir(base)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(runsDir(base), name), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.task === task) return r;
      } catch { /* 坏行跳过 */ }
    }
  }
  return null;
}

/** 当天该 task+reason 是否已经提醒过，避免持续失败变成通知轰炸。 */
export function alreadyNotifiedToday(base, task, reason) {
  return queryRuns(base, { days: 1 }).some(
    (r) => r.task === task && r.reason === reason && r.notified && dateKeyOf(new Date(r.ts || 0)) === dateKeyOf(),
  );
}

export function notify({ title, message, modal = false }) {
  const esc = (s) => String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const r = modal
    ? spawnSync('/usr/bin/osascript', ['-e', `display dialog "${esc(message)}" with title "${esc(title)}" buttons {"知道了"} default button 1 with icon caution`], { timeout: 5000 })
    : spawnSync('/usr/bin/osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"`], { timeout: 5000 });
  return r.status === 0;
}

/** runs 留 90 天；diagnostics 14 天且最多 200 个文件，取更严的那个。 */
export function prune(base = baseDir(), { runsDays = 90, diagDays = 14, diagMax = 200 } = {}) {
  const removed = { runs: 0, diagnostics: 0 };
  const runNames = (() => { try { return fs.readdirSync(runsDir(base)); } catch { return []; } })();
  for (const name of runNames) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    if (name.slice(0, 10) < dateKeyOf(new Date(Date.now() - runsDays * 86400000))) {
      try { fs.unlinkSync(path.join(runsDir(base), name)); removed.runs += 1; } catch { /* 下轮再清 */ }
    }
  }
  let diag = [];
  try {
    diag = fs.readdirSync(diagnosticsDir(base)).map((n) => ({ n, t: fs.statSync(path.join(diagnosticsDir(base), n)).mtimeMs }));
  } catch { return removed; }
  const cutoff = Date.now() - diagDays * 86400000;
  const alive = [];
  for (const f of diag) {
    if (f.t < cutoff) {
      try { fs.unlinkSync(path.join(diagnosticsDir(base), f.n)); removed.diagnostics += 1; } catch { alive.push(f); }
    } else alive.push(f);
  }
  if (alive.length > diagMax) {
    for (const f of alive.sort((a, b) => a.t - b.t).slice(0, alive.length - diagMax)) {
      try { fs.unlinkSync(path.join(diagnosticsDir(base), f.n)); removed.diagnostics += 1; } catch { /* 下轮再清 */ }
    }
  }
  return removed;
}

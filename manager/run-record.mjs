#!/usr/bin/env node
// 把一次运行的「运行事实」（env 传来）和「站点事实」（stdin 那行 JSON）合成一条记录，
// 追加到 logs/runs/<日期>.jsonl，顺带做保留清理和失败提醒。
// 观测性不该变成新的故障源：任何异常都只写 stderr，退出码永远是 0。
import fs from 'node:fs';
import {
  ALERT_STATUSES, appendRun, baseDir, alreadyNotifiedToday, isoLocal, newRunId,
  notify, prune, reasonLabel, stampOf,
} from '../lib/run-result.mjs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function runnerDetail(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch { /* 继续往上找 */ }
  }
  return {};
}

const env = process.env;
const base = env.AUTOMATION_BASE ? env.AUTOMATION_BASE : baseDir();
const task = env.AUTOMATION_TASK || 'unknown';
const startedEpoch = Number(env.AUTOMATION_STARTED_AT) || Math.floor(Date.now() / 1000);
const startedAt = new Date(startedEpoch * 1000);
const endedAt = new Date();
const exitCode = Number.isFinite(Number(env.AUTOMATION_EXIT_CODE)) ? Number(env.AUTOMATION_EXIT_CODE) : null;
const detail = runnerDetail(readStdin());

const status = typeof detail.status === 'string' ? detail.status : (exitCode === 0 ? 'completed' : 'failed');
const reason = typeof detail.reason === 'string' ? detail.reason : (status === 'completed' ? null : `exit_${exitCode}`);

const record = {
  ...detail,
  runId: env.AUTOMATION_RUN_ID || newRunId(task, startedAt),
  ts: isoLocal(endedAt),
  task,
  site: env.AUTOMATION_SITE || detail.site || null,
  accountKey: env.AUTOMATION_ACCOUNT_KEY || detail.account || null,
  trigger: env.AUTOMATION_TRIGGER || 'manual',
  pid: Number(env.AUTOMATION_PID) || process.pid,
  startedAt: isoLocal(startedAt),
  endedAt: isoLocal(endedAt),
  durationS: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
  exitCode,
  status,
  reason,
};
if (detail.note) record.note = detail.note;
if (Array.isArray(detail.evidence)) record.evidence = detail.evidence;
// 接管了上一轮遗留的锁：必须留在记录里，否则"曾经停跑"这件事再次变成不可知。
if (env.AUTOMATION_LOCK_STALE === '1') record.lockStale = true;

let notified = false;
try {
  if (env.AUTOMATION_NOTIFY === '1' && ALERT_STATUSES.has(status) && !alreadyNotifiedToday(base, task, reason)) {
    const modal = status === 'blocked' || status === 'waiting';
    const message = `${reasonLabel(reason)}${record.note ? ` · ${String(record.note).slice(0, 90)}` : ''}（${record.durationS}s，${record.trigger}）`;
    notified = notify({ title: `自动化 · ${record.site || task}`, message, modal });
    if (notified) {
      record.notified = true;
      record.notifiedAt = isoLocal(endedAt);
    }
  }
} catch (e) {
  console.error(`run-record 提醒失败：${e?.message || e}`);
}

let file = null;
try {
  file = appendRun(base, record);
} catch (e) {
  console.error(`run-record 写记录失败：${e?.message || e}`);
}

try {
  prune(base);
} catch { /* 下轮再清 */ }

console.log(JSON.stringify({ ...record, notified, recordFile: file ? file.replace(base + '/', '') : null }));
process.exit(0);

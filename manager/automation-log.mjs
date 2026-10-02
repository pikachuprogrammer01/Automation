#!/usr/bin/env node
// 运行记录怎么查。设计见 docs/OBSERVABILITY.md。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { baseDir, queryRuns, reasonLabel, ALERT_STATUSES } from '../lib/run-result.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY = process.env.AUTOMATION_MANAGER_REGISTRY || path.join(ROOT, 'manager', 'registry.json');

const USAGE = [
  '用法：manager/automation-log [选项]',
  '',
  '  （无参数）                最近 20 次运行',
  '  --failed [--days N]       只看需要关注的失败，默认回看 7 天',
  '  --task <任务 ID>          只看某个任务',
  '  --run <runId> [--open]    摊开一次运行的全部字段，--open 顺带打开它的截图',
  '  --stale [--hours N]       按登记表排期判断哪些已启用的任务超时没有成功记录，默认 26 小时',
  '  --days N                  回看天数',
  '  --json                    输出原始 JSON',
  '  -h, --help                本说明',
  '',
  '记录来自 logs/runs/<日期>.jsonl，由 manager/run-record.mjs 在每次运行时写入。',
];

const STATUS_TEXT = {
  completed: '成功', failed: '失败', blocked: '受阻', waiting: '等人工', skipped: '跳过',
};

function parseArgs(argv) {
  const o = { mode: 'recent', days: 7, daysSet: false, hours: 26, task: null, run: null, open: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.mode = 'help';
    else if (a === '--failed') o.mode = 'failed';
    else if (a === '--stale') o.mode = 'stale';
    else if (a === '--open') o.open = true;
    else if (a === '--json') o.json = true;
    else if (a === '--task') o.task = argv[++i];
    else if (a === '--run') { o.mode = 'run'; o.run = argv[++i]; }
    else if (a === '--days') { o.days = Number(argv[++i]) || o.days; o.daysSet = true; }
    else if (a === '--hours') o.hours = Number(argv[++i]) || o.hours;
    else { console.error('未知参数：' + a); console.error(USAGE.join(String.fromCharCode(10))); process.exit(2); }
  }
  return o;
}

function ageHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 3600000;
}
function humanAge(hours) {
  if (hours === null) return '未知';
  if (hours < 1) return Math.round(hours * 60) + ' 分钟前';
  if (hours < 48) return hours.toFixed(1) + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}
function line(r) {
  const bits = [
    String(r.ts || '').slice(5, 16),
    (STATUS_TEXT[r.status] || r.status || '?').padEnd(3),
    String(r.task || '?').padEnd(14),
    String(r.trigger || '?').padEnd(8),
    String(r.durationS ?? '?').padStart(4) + 's',
    r.reason ? reasonLabel(r.reason) : '',
  ];
  if (r.note) bits.push('| ' + String(r.note).slice(0, 70));
  if (Array.isArray(r.evidence) && r.evidence.length) bits.push('| 证据 ' + r.evidence.length + ' 份');
  return bits.filter(Boolean).join('  ');
}

function registryTasks() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return (data.tasks || []).map((t) => {
      const v = { ...t };
      if (typeof v.plistPath === 'string' && v.plistPath.startsWith('~/')) {
        v.plistPath = path.join(process.env.HOME || '', v.plistPath.slice(2));
      }
      return v;
    });
  } catch {
    return [];
  }
}
function launchdLoaded(task) {
  if (!task.launchLabel) return false;
  return spawnSync('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + task.launchLabel], { timeout: 5000 }).status === 0;
}

const opt = parseArgs(process.argv.slice(2));
if (opt.mode === 'help') {
  console.log(USAGE.join(String.fromCharCode(10)));
  process.exit(0);
}
const base = baseDir();

if (opt.mode === 'stale') {
  const tasks = registryTasks();
  if (!tasks.length) {
    console.error('读不到登记表：' + REGISTRY);
    process.exit(1);
  }
  const rows = [];
  for (const t of tasks) {
    if (!launchdLoaded(t)) { rows.push({ task: t.id, verdict: '未启用', note: '不参与漏跑判断' }); continue; }
    const mine = queryRuns(base, { days: 30, task: t.id });
    if (!mine.length) { rows.push({ task: t.id, verdict: '无记录', note: '刚上线还没跑过，或用 --days 拉长窗口' }); continue; }
    const last = mine.find((r) => r.status === 'completed') || null;
    if (!last) {
      rows.push({ task: t.id, verdict: '只有失败', note: `最近一次 ${mine[0].status}/${mine[0].reason}` });
      continue;
    }
    const h = ageHours(last.ts);
    if (h > opt.hours) rows.push({ task: t.id, verdict: '漏跑', note: `最后一次成功 ${humanAge(h)}` });
    else rows.push({ task: t.id, verdict: '正常', note: humanAge(h) });
  }
  if (opt.json) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const r of rows) console.log(r.verdict.padEnd(10) + String(r.task).padEnd(16) + r.note);
    const bad = rows.filter((r) => r.verdict === '漏跑' || r.verdict === '只有失败').length;
    const unknown = rows.filter((r) => r.verdict === '无记录').length;
    console.log('');
    if (bad) console.log(bad + ' 个任务需要看');
    else if (unknown) console.log('没有漏跑；' + unknown + ' 个任务还没有记录（刚上线属正常）');
    else console.log('没有漏跑');
  }
  process.exit(0);
}

if (opt.mode === 'run') {
  const all = queryRuns(base, { days: 90 });
  const hit = all.find((r) => r.runId === opt.run);
  if (!hit) {
    console.error('没有这条运行记录：' + opt.run);
    process.exit(1);
  }
  console.log(JSON.stringify(hit, null, 2));
  if (opt.open && Array.isArray(hit.evidence)) {
    for (const ev of hit.evidence) {
      const abs = path.isAbsolute(ev) ? ev : path.join(base, ev);
      if (fs.existsSync(abs)) spawnSync('/usr/bin/open', [abs]);
      else console.error('证据文件不在：' + abs);
    }
  }
  process.exit(0);
}

let rows = queryRuns(base, { days: opt.daysSet ? opt.days : (opt.task ? 30 : 7), task: opt.task });
if (opt.mode === 'failed') rows = rows.filter((r) => ALERT_STATUSES.has(r.status));
else rows = rows.slice(0, 20);
if (opt.json) console.log(JSON.stringify(rows, null, 2));
else if (!rows.length) console.log('没有记录。跑一次任务，或用 --days 把窗口拉长。');
else for (const r of rows) console.log(line(r));

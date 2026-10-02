import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  STATUS, ALERT_STATUSES, CHALLENGE_WORDS, reasonLabel,
  stampOf, dateKeyOf, newRunId, isoLocal,
  baseDir, runsDir, runsFile, diagnosticsDir, evidenceStem,
  appendRun, queryRuns, lastRunFor, alreadyNotifiedToday, notify, prune,
} from '../lib/run-result.mjs';

function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-rr-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  return base;
}
function rec(over = {}) {
  const when = new Date(2026, 9, 3, 8, 20, 5);
  return {
    runId: 'loveapi-a-20261003-082005', ts: isoLocal(when), task: 'loveapi-a', site: 'LoveAPI',
    trigger: 'launchd', startedAt: isoLocal(when), endedAt: isoLocal(when), durationS: 12,
    exitCode: 0, status: STATUS.COMPLETED, reason: null, ...over,
  };
}

describe('状态与原因词表（产品原则 1：无事可做不等于失败）', () => {
  test('正常：completed/skipped 不报警，failed/blocked/waiting 报警', () => {
    assert.equal(ALERT_STATUSES.has(STATUS.COMPLETED), false);
    assert.equal(ALERT_STATUSES.has(STATUS.SKIPPED), false, '上一轮还在跑不是故障，不该报警');
    for (const s of [STATUS.FAILED, STATUS.BLOCKED, STATUS.WAITING]) assert.equal(ALERT_STATUSES.has(s), true);
    assert.deepEqual(Object.values(STATUS).sort(), ['blocked', 'completed', 'failed', 'skipped', 'waiting']);
  });

  test('异常：未知 reason 原样回显，空 reason 走兜底文案', () => {
    assert.equal(reasonLabel('not_authenticated'), '没登上');
    assert.equal(reasonLabel('made_up_reason'), 'made_up_reason', '不许把未知原因吞成空字符串');
    assert.equal(reasonLabel(null), '未记录原因');
    assert.equal(reasonLabel(''), '未记录原因');
  });

  test('安全边界：人工验证信号词表不得被悄悄扩充', () => {
    assert.equal(CHALLENGE_WORDS.length, 7, '扩充匹配面等于扩大对页面文案的猜测面，需显式改动');
    assert.ok(CHALLENGE_WORDS.includes('captcha'));
    assert.ok(CHALLENGE_WORDS.includes('安全验证'));
  });
});

describe('时间键（全部用本地时间，与文件名和人眼一致）', () => {
  const d = new Date(2026, 0, 5, 9, 8, 7);
  test('正常：个位月日时分秒补零', () => {
    assert.equal(dateKeyOf(d), '2026-01-05');
    assert.equal(stampOf(d), '20260105-090807');
    assert.equal(newRunId('demo-a', d), 'demo-a-20260105-090807');
  });
  test('边界：跨年与 0 点', () => {
    const z = new Date(2027, 11, 31, 0, 0, 0);
    assert.equal(dateKeyOf(z), '2027-12-31');
    assert.equal(stampOf(z), '20271231-000000');
  });
  test('isoLocal 带正确偏移且可被 Date 解析回来', () => {
    const s = isoLocal(d);
    const off = -d.getTimezoneOffset();
    const p = (n) => String(n).padStart(2, '0');
    const expect = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
    assert.match(s, /^2026-01-05T09:08:07[+-]\d{2}:\d{2}$/);
    assert.ok(s.endsWith(expect), `末尾偏移应为 ${expect}，实际 ${s.slice(19)}`);
    assert.equal(new Date(s).getTime(), d.getTime(), '字符串必须能无损解析回同一瞬间');
  });
  test('异常：默认参数取当前时间而不是 undefined', () => {
    assert.match(stampOf(), /^\d{8}-\d{6}$/);
    assert.match(dateKeyOf(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('数据根（本次重组的核心，必须锁死）', () => {
  test('正常：AUTOMATION_HOME 未设时落仓根的 var/', () => {
    const saved = process.env.AUTOMATION_HOME;
    delete process.env.AUTOMATION_HOME;
    try {
      assert.equal(path.basename(baseDir()), 'var');
      assert.ok(fs.existsSync(path.join(path.dirname(baseDir()), 'lib', 'run-result.mjs')), '数据根必须与 lib/ 同级（即仓根下）');
      assert.ok(fs.existsSync(path.join(path.dirname(baseDir()), 'manager', 'server.mjs')), '数据根必须与 manager/ 同级');
    } finally { if (saved !== undefined) process.env.AUTOMATION_HOME = saved; }
  });
  test('隔离：AUTOMATION_HOME 一旦设了，登记表与数据同根一起搬走', () => {
    const b = '/tmp/some-sandbox/var';
    assert.equal(runsDir(b), path.join(b, 'logs', 'runs'));
    assert.equal(diagnosticsDir(b), path.join(b, 'logs', 'diagnostics'));
    assert.equal(runsFile(b, new Date(2026, 9, 3)), path.join(b, 'logs', 'runs', '2026-10-03.jsonl'));
  });
  test('证据文件名带日期与 runId，能人工对上某次运行', () => {
    const stem = evidenceStem('/tmp/x', 'loveapi-a-20261003-082005', 'challenge', new Date(2026, 9, 3));
    assert.equal(stem, path.join('/tmp/x', 'logs', 'diagnostics', '20261003-loveapi-a-20261003-082005-challenge'));
  });
});

describe('记录写入与查询', () => {
  test('正常：写一条读一条，权限收紧到 0600', (t) => {
    const b = tmpBase(t);
    const file = appendRun(b, rec());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    const rows = queryRuns(b, { days: 30 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, 'loveapi-a-20261003-082005');
  });

  test('边界：空目录与不存在的目录都不能抛异常', (t) => {
    const b = tmpBase(t);
    assert.deepEqual(queryRuns(b, {}), []);
    assert.equal(lastRunFor(b, 'loveapi-a'), null);
    assert.deepEqual(prune(b, {}), { runs: 0, diagnostics: 0 });
  });

  test('异常：坏行降级成 corrupt_record，其余行照常读', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ runId: 'r1' }));
    fs.appendFileSync(path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`), '这不是 JSON\n\n{半截\n');
    appendRun(b, rec({ runId: 'r2' }));
    const rows = queryRuns(b, {});
    const corrupt = rows.filter((r) => r.reason === 'corrupt_record');
    assert.equal(corrupt.length, 2, '两行坏数据各自成一条，不能整文件丢弃');
    assert.ok(rows.some((r) => r.runId === 'r2'), '好行必须存活');
  });

  test('过滤：按任务、按需要报警的状态、按 limit，且新→旧', (t) => {
    const b = tmpBase(t);
    const f = path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`);
    fs.mkdirSync(runsDir(b), { recursive: true });
    for (const [i, status] of [[1, STATUS.COMPLETED], [2, STATUS.FAILED], [3, STATUS.SKIPPED], [4, STATUS.BLOCKED]]) {
      fs.appendFileSync(f, JSON.stringify(rec({
        runId: `r${i}`, status, reason: status === STATUS.COMPLETED || status === STATUS.SKIPPED ? null : 'security_challenge',
        ts: isoLocal(new Date(Date.now() - i * 1000)),
      })) + '\n');
    }
    assert.deepEqual(queryRuns(b, { failedOnly: true }).map((r) => r.runId), ['r2', 'r4'], '新→旧，且 skipped 不混进来');
    assert.deepEqual(queryRuns(b, { task: 'nope' }), []);
    assert.deepEqual(queryRuns(b, { statuses: [STATUS.SKIPPED] }).map((r) => r.runId), ['r3'], 'skipped 可以按状态查到，但不进 failedOnly');
    assert.equal(queryRuns(b, { limit: 2 }).length, 2);
    assert.equal(queryRuns(b, {}).length, 4);
  });

  test('中断/权限：记录文件读不了就跳过它，其余文件照常', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ runId: 'good' }));
    const other = path.join(runsDir(b), '2026-10-02.jsonl');
    fs.writeFileSync(other, `${JSON.stringify(rec({ runId: 'bad-perm', ts: '2026-10-02T08:00:00+08:00' }))}\n`);
    fs.chmodSync(other, 0o000);
    try {
      const rows = queryRuns(b, { days: 30 });
      assert.ok(rows.every((r) => r.runId !== 'bad-perm'), '读不了就跳过，不能把整个查询炸掉');
      assert.ok(rows.some((r) => r.runId === 'good'));
      assert.equal(lastRunFor(b, 'loveapi-a').runId, 'good');
    } finally {
      fs.chmodSync(other, 0o600);
    }
  });

  test('中断：最新那个文件读不了，lastRunFor 要退到上一个而不是返回 null', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(runsDir(b), { recursive: true });
    const older = path.join(runsDir(b), '2026-10-02.jsonl');
    fs.writeFileSync(older, `${JSON.stringify(rec({ runId: 'prev', ts: '2026-10-02T08:00:00+08:00' }))}\n`);
    const newest = path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`);
    fs.writeFileSync(newest, `${JSON.stringify(rec({ runId: 'unreachable' }))}\n`);
    fs.chmodSync(newest, 0o000);
    try {
      assert.equal(lastRunFor(b, 'loveapi-a').runId, 'prev');
    } finally {
      fs.chmodSync(newest, 0o600);
    }
  });

  test('中断：文件末尾是半截 JSON（写入被强杀），取到上一条完整记录', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ runId: 'complete' }));
    fs.appendFileSync(path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`), '{"runId":"trunc","stat');
    assert.equal(lastRunFor(b, 'loveapi-a').runId, 'complete');
  });

  test('窗口：超出 days 的记录不读，读不到文件也不炸', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(runsDir(b), { recursive: true });
    fs.writeFileSync(path.join(runsDir(b), '2020-01-01.jsonl'), JSON.stringify(rec({ runId: 'old' })) + '\n');
    appendRun(b, rec({ runId: 'new' }));
    assert.deepEqual(queryRuns(b, { days: 14 }).map((r) => r.runId), ['new']);
    assert.deepEqual(queryRuns(b, { days: 40000 }).map((r) => r.runId).sort(), ['new', 'old']);
  });

  test('缺陷回归：runs 目录里的非 jsonl 文件必须被忽略', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ runId: 'real' }));
    // 一次被 SIGKILL 打断的写入可能留下临时文件；它含合法 JSON，但不是记录真源
    fs.writeFileSync(
      path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl.tmp`),
      `${JSON.stringify(rec({ runId: 'ghost', ts: isoLocal(new Date(Date.now() + 60000)) }))}\n`,
    );
    assert.equal(queryRuns(b, {}).find((r) => r.runId === 'ghost'), undefined, 'queryRuns 已经忽略 .tmp');
    assert.equal(lastRunFor(b, 'loveapi-a').runId, 'real', 'lastRunFor 必须与 queryRuns 同一套文件筛选');
  });

  test('性能契约：界面每 5 秒轮询，lastRunFor 不得全量解析 90 天', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(runsDir(b), { recursive: true });
    const hit = rec({ runId: 'hit' });
    for (let i = 0; i < 60; i += 1) {
      fs.writeFileSync(path.join(runsDir(b), `2026-0${(i % 9) + 1}-0${(i % 9) + 1}.jsonl`), '""\n'.repeat(2000));
    }
    fs.writeFileSync(path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`), JSON.stringify(rec({ runId: 'older' })) + '\n' + `${JSON.stringify(hit)}\n`.repeat(50));
    const t0 = process.hrtime.bigint();
    const r = lastRunFor(b, 'loveapi-a');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.runId, 'hit', '同文件内必须从尾部先取最新一条');
    assert.ok(ms < 400, `轮询路径应在百毫秒级，实测 ${ms.toFixed(0)}ms`);
  });
});

describe('提醒去重（同一任务同一原因当天只提醒一次）', () => {
  test('正常：当天已提醒过则不再提醒', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ status: STATUS.FAILED, reason: 'security_challenge', notified: true, notifiedAt: isoLocal(new Date()) }));
    assert.equal(alreadyNotifiedToday(b, 'loveapi-a', 'security_challenge'), true);
  });
  test('边界：reason 不同或没提醒过都不算', (t) => {
    const b = tmpBase(t);
    appendRun(b, rec({ status: STATUS.FAILED, reason: 'security_challenge', notified: true }));
    assert.equal(alreadyNotifiedToday(b, 'loveapi-a', 'not_authenticated'), false);
    assert.equal(alreadyNotifiedToday(b, 'loveapi-b', 'security_challenge'), false, '去重必须按任务隔离');
    assert.equal(alreadyNotifiedToday(b, 'loveapi-a', 'login_timeout'), false);
  });
});

describe('通知（走 shim，测试里绝不弹真实通知）', () => {
  test('正常：osascript 返回 0 即视为已发出', (t) => {
    const b = tmpBase(t);
    const shim = path.join(b, 'osascript-ok');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const saved = process.env.AUTOMATION_OSASCRIPT;
    process.env.AUTOMATION_OSASCRIPT = shim;
    try {
      assert.equal(notify({ title: 'A', message: 'B' }), true);
      assert.equal(notify({ title: 'A', message: 'B', modal: true }), true);
    } finally {
      if (saved === undefined) delete process.env.AUTOMATION_OSASCRIPT; else process.env.AUTOMATION_OSASCRIPT = saved;
    }
  });
  test('异常：发不出去只返回 false，不抛、不影响任务退出码', (t) => {
    const b = tmpBase(t);
    const shim = path.join(b, 'osascript-bad');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const saved = process.env.AUTOMATION_OSASCRIPT;
    process.env.AUTOMATION_OSASCRIPT = shim;
    try { assert.equal(notify({ title: 'A', message: 'B' }), false); } finally {
      if (saved === undefined) delete process.env.AUTOMATION_OSASCRIPT; else process.env.AUTOMATION_OSASCRIPT = saved;
    }
  });
});

describe('保留清理（磁盘必须有上限）', () => {
  test('正常：runs 超期删、未超期留', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(runsDir(b), { recursive: true });
    fs.writeFileSync(path.join(runsDir(b), '2020-01-01.jsonl'), '{}\n');
    fs.writeFileSync(path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`), '{}\n');
    assert.deepEqual(prune(b, { runsDays: 90 }), { runs: 1, diagnostics: 0 });
    assert.equal(fs.existsSync(path.join(runsDir(b), '2020-01-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(runsDir(b), `${dateKeyOf(new Date())}.jsonl`)), true);
  });

  test('上限：diagMax 取更严的那个，先删最旧', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(diagnosticsDir(b), { recursive: true });
    const names = ['a.png', 'b.png', 'c.png', 'd.png'];
    names.forEach((n, i) => {
      const p = path.join(diagnosticsDir(b), n);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, new Date(), new Date(Date.now() - (names.length - i) * 3_600_000));
    });
    const r = prune(b, { runsDays: 90, diagDays: 14, diagMax: 2 });
    assert.equal(r.diagnostics, 2);
    assert.deepEqual(fs.readdirSync(diagnosticsDir(b)).sort(), ['c.png', 'd.png']);
  });

  test('异常：目录只读也不抛（观测层不得变成新故障源）', (t) => {
    const b = tmpBase(t);
    fs.mkdirSync(diagnosticsDir(b), { recursive: true });
    const p = path.join(diagnosticsDir(b), 'old.png');
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.chmodSync(diagnosticsDir(b), 0o500);
    try {
      const r = prune(b, { diagDays: 14 });
      assert.equal(typeof r.diagnostics, 'number', '删不掉就记账或静默跳过，但不能崩');
    } finally {
      fs.chmodSync(diagnosticsDir(b), 0o700);   // 必须在本测试内恢复，否则临时目录清不掉
    }
  });
});

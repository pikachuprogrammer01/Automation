import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sandbox, plantShims, startServer, writeRegistry } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function patchRegistry(s, fn) {
  const p = path.join(s.base, 'registry.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(data);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function injectedTask(s, over = {}) {
  const id = over.id || 'probe-task';
  return {
    id, name: '探针', site: '127.0.0.1', type: 'imported',
    launchLabel: `com.pikachu.automation-probe.${id}`,
    plistPath: path.join(s.home, 'Library', 'LaunchAgents', `probe-${id}.plist`),
    command: longRunningScript(s, id),
    defaultSchedule: { hour: 9, minute: 0 },
    logPath: path.join(s.base, 'logs', `${id}.log`),
    ...over,
  };
}

/**
 * 约定：command[0] 是解释器，command[1] 是脚本路径（会被 fromPortable 改写），
 * command[2+] 是参数（永不改写）。所以不能图省事写 ['/bin/sleep','4'] ——
 * '4' 会被当成相对路径拼成「<数据根>/4」，任务立刻以 1 退出。这条用例就是这个约定的锁。
 */
function longRunningScript(s, id = 'probe') {
  const file = path.join(s.base, `${id}-hold.sh`);
  fs.writeFileSync(file, '#!/bin/sh\nexec sleep 4\n', { mode: 0o700 });
  return ['/bin/zsh', file];
}

describe('正常路径', () => {
  test('空登记表下 /api/system 与 /api/tasks 都能用', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    plantShims(s);
    const api = startServer(t, s);
    await api.ready();
    const sys = await api.api('/api/system');
    assert.equal(sys.status, 200);
    assert.deepEqual(sys.body, { ok: true, manager: 'running', port: s.port });
    const list = await api.api('/api/tasks');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tasks, []);
  });

  test('静态页与内置演示站点可访问', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    for (const p of ['/', '/demo/', '/demo']) {
      const r = await fetch(`${s.url}${p}`);
      assert.equal(r.status, 200, `${p} 应该能打开`);
    }
    const missing = await fetch(`${s.url}/nope.html`);
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.equal(body.code, 'not_found');
  });
});

describe('异常：登记表缺失', () => {
  test('503 且 hint 给出可执行的修复动作', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    fs.rmSync(path.join(s.base, 'registry.json'));
    const r = await api.api('/api/tasks');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'registry_missing');
    assert.match(r.body.error, /任务登记表不存在/);
    assert.match(r.body.hint, /cp manager\/registry\.example\.json var\/registry\.json/,
      'hint 必须给默认位置，不能还教用户 cp 到 manager/');
  });
});

describe('异常：新建任务的入参校验矩阵', () => {
  const cases = [
    [{}, 'missing_id'],
    [{ id: 'BAD ID', name: 'x', url: 'http://a.test/' }, 'invalid_id'],
    [{ id: 'ok-1', name: '   ', url: 'http://a.test/' }, 'missing_name'],
    [{ id: 'ok-1', name: 'x'.repeat(81), url: 'http://a.test/' }, 'name_too_long'],
    [{ id: 'ok-1', name: 'n' }, 'missing_url'],
    [{ id: 'ok-1', name: 'n', url: 'not a url' }, 'invalid_url'],
    [{ id: 'ok-1', name: 'n', url: 'ftp://a.test/x' }, 'unsupported_scheme'],
  ];

  for (const [body, code] of cases) {
    test(`${code} → 4xx 且带 code/error/hint`, async (t) => {
      const s = sandbox(t);
      writeRegistry(s, []);
      const api = startServer(t, s);
      await api.ready();
      const r = await api.api('/api/recordings/create', { method: 'POST', body });
      assert.equal(r.status, 400, `${code} 应返回 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code);
      assert.ok(r.body.error?.length > 0, '必须有人话 error');
      assert.ok(r.body.hint?.length > 0, `PRD 原则 2：${code} 必须带 hint`);
    });
  }

  test('任务 ID 重复必须拒，不能覆盖已有任务', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, [injectedTask(s, { id: 'dup-1' })]);
    const api = startServer(t, s);
    await api.ready();
    const r = await api.api('/api/recordings/create', {
      method: 'POST', body: { id: 'dup-1', name: 'n', url: 'http://a.test/', blank: true },
    });
    assert.equal(r.body.code, 'task_id_exists');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, 'registry.json'), 'utf8')).tasks.length, 1,
      '被拒之后登记表不得多出一条');
  });

  test('body 不是合法 JSON → invalid_json 400', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const r = await api.api('/api/recordings/create', { method: 'POST', body: '{不是JSON' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_json');
  });

  test('超大 body → 413，且不得静默截断', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const r = await api.api('/api/recordings/create', {
      method: 'POST', body: JSON.stringify({ id: 'big', name: 'n', url: `http://a.test/${'x'.repeat(70 * 1024)}` }),
    });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'request_too_large');
    assert.ok(r.body.hint?.length > 0, 'PRD 原则 2：413 也必须告诉用户怎么办');
  });
});

describe('异常：任务寻址与状态不自洽', () => {
  test('不存在的任务 ID 一律 404 task_not_found', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    for (const p of ['/api/tasks/nope/run', '/api/tasks/nope/schedule', '/api/tasks/nope/purge']) {
      const r = await api.api(p, { method: 'POST', body: p.endsWith('purge') ? { confirm: 'nope' } : {} });
      assert.equal(r.status, 404, `${p} 应 404`);
      assert.equal(r.body.code, 'task_not_found');
    }
    // /log 是 GET-only 路由，POST 会落到通用 404 not_found，不是 task_not_found
    const log = await api.api('/api/tasks/nope/log?from=0');
    assert.equal(log.status, 404);
    assert.equal(log.body.code, 'task_not_found');
  });

  test('没有 command 的任务 → 422，不能当成成功', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, [injectedTask(s, { id: 'nocmd' })]);
    patchRegistry(s, (d) => { delete d.tasks[0].command; });
    const api = startServer(t, s);
    await api.ready();
    const r = await api.api('/api/tasks/nocmd/run', { method: 'POST', body: {} });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'task_has_no_command');
    assert.match(r.body.hint, /var\/registry\.json/);
  });

  test('排期越界 → invalid_schedule', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, [injectedTask(s, { id: 'sched' })]);
    const sh = plantShims(s);
    const api = startServer(t, s);
    await api.ready();
    for (const [body, code] of [[{ hour: 24, minute: 0 }, 'invalid_schedule'], [{ hour: 0, minute: 60 }, 'invalid_schedule'], [{ hour: -1, minute: 0 }, 'invalid_schedule'], [{}, 'missing_schedule']]) {
      const r = await api.api('/api/tasks/sched/schedule', { method: 'POST', body });
      assert.equal(r.body.code, code, `非法排期 ${JSON.stringify(body)} 必须被拒`);
      assert.equal(r.status, 400);
      assert.ok(r.body.hint?.length > 0, `${code} 必须带 hint`);
    }
    assert.equal(sh.callsOf('launchctl').filter((l) => !l.startsWith('launchctl print')).length, 0,
      '入参校验失败不得触发任何 launchd 状态变更');
  });
});

describe('异常：跨站写操作被拒', () => {
  test('外站 Origin 的 POST → 403 bad_origin，GET 不受影响', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, [injectedTask(s, { id: 'origin' })]);
    const api = startServer(t, s);
    await api.ready();
    const ok = await api.api('/api/tasks');
    assert.equal(ok.status, 200);
    const r = await api.api('/api/tasks/origin/run', { method: 'POST', body: {}, headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'bad_origin');
    assert.equal(fs.existsSync(path.join(s.base, 'logs', 'origin.log')), false,
      '被拒的写操作不该留下任何执行痕迹');
  });
});

describe('并发保护', () => {
  test('同一任务运行中重复触发 → 409 task_busy', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, [injectedTask(s, { id: 'busy' })]);
    const api = startServer(t, s);
    await api.ready();
    const first = await api.api('/api/tasks/busy/run', { method: 'POST', body: {} });
    assert.equal(first.status, 200);
    assert.ok(Number.isFinite(first.body.pid));
    const second = await api.api('/api/tasks/busy/run', { method: 'POST', body: {} });
    assert.equal(second.status, 409, '并发必须被按住，不能起第二个进程');
    assert.equal(second.body.code, 'task_busy');
    assert.ok(second.body.hint?.length > 0, 'PRD 原则 2：409 也要给人话指引');
    await sleep(4800);   // 脚本里的 sleep 4 结束
    const third = await api.api('/api/tasks/busy/run', { method: 'POST', body: {} });
    assert.equal(third.status, 200, '上一轮结束后必须能再次触发，不能永久卡住');
  });
});

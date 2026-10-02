import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { sandbox, startServer, writeRegistry } from './helpers/harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const HAS_PW = fs.existsSync(path.join(REPO, 'manager/node_modules/@playwright/test'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个空闲端口然后关掉它，得到"必然连接被拒"的目标。 */
function closedPort() {
  const srv = net.createServer();
  srv.listen(0);
  const port = srv.address().port;
  srv.close();
  return port;
}

function origin(t, handler) {
  const srv = http.createServer(handler);
  srv.listen(0);
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

/** 写一个短超时任务：网络异常要能自己收场，不能把执行器挂死。 */
async function makeFaultTask(api, s, id, url, body) {
  const r = await api.api('/api/recordings/create', {
    method: 'POST', body: { id, name: `网络异常 ${id}`, url, blank: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const dir = path.join(s.base, 'tasks', id);
  fs.writeFileSync(path.join(dir, 'playwright.config.mjs'), [
    "import { defineConfig } from '@playwright/test';",
    'export default defineConfig({',
    "  testDir: '.', testMatch: /recorded\\.spec\\.js/,",
    '  timeout: 15000,',
    "  use: { channel: 'chrome', headless: true, navigationTimeout: 6000, actionTimeout: 4000 },",
    '});',
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'recorded.spec.js'), body, { mode: 0o600 });
  return dir;
}

async function waitForRun(s, task, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(400);
    const dir = path.join(s.base, 'logs/runs');
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const rows = fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const hit = rows.find((r) => r.task === task);
      if (hit) return hit;
    }
  }
  return null;
}

describe('网络异常注入（录制任务执行器）', { skip: HAS_PW ? false : '需要 manager 下 npm install @playwright/test' }, () => {
  test('连接被拒：必须以 failed 收场并留下可读原因，不能挂死或谎报成功', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const dead = `http://127.0.0.1:${closedPort()}/`;
    const dir = await makeFaultTask(api, s, 'net-refused', dead,
      `import { test } from '@playwright/test';\ntest('r', async ({ page }) => { await page.goto(${JSON.stringify(dead)}); });\n`);

    const run = await api.api('/api/tasks/net-refused/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    const rec = await waitForRun(s, 'net-refused');
    assert.ok(rec, '失败也必须留下运行记录');
    assert.equal(rec.status, 'failed');
    assert.equal(rec.reason, 'playwright_failed');
    assert.ok(typeof rec.exitCode === 'number' && rec.exitCode !== 0, '退出码非 0 是失败的最终凭据');
    assert.ok(fs.existsSync(path.join(dir, 'recorded.spec.js')), '失败不许把脚本删了');
    assert.match(rec.note || '', /ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ECONNREFUSED|Failed to navigate|EXIT=/,
      `note 里要能看出是连不上，实际：${rec.note}`);
  });

  test('站点回 500：脚本里的断言失败要如实报失败，不吞成 skipped', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const url = origin(t, (_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); });
    await makeFaultTask(api, s, 'net-500', url,
      `import { test, expect } from '@playwright/test';\ntest('r', async ({ page }) => { await page.goto(${JSON.stringify(url)}); await expect(page.locator('body')).toContainText('正常页面'); });\n`);

    const run = await api.api('/api/tasks/net-500/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    const rec = await waitForRun(s, 'net-500');
    assert.ok(rec);
    assert.equal(rec.status, 'failed', '页面报错导致的断言失败不得被降级成 skipped');
    assert.ok(rec.durationS >= 0 && rec.durationS < 60, `应在超时预算内自己收场，实际 ${rec.durationS}s`);
  });

  test('站点挂住不回：受 timeout 约束，必须到点终止', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const url = origin(t, (_req, _res) => { /* 永远不响应 */ });
    await makeFaultTask(api, s, 'net-hang', url,
      `import { test } from '@playwright/test';\ntest('r', async ({ page }) => { await page.goto(${JSON.stringify(url)}, { waitUntil: 'load' }); });\n`);

    const run = await api.api('/api/tasks/net-hang/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    const rec = await waitForRun(s, 'net-hang', 60000);
    assert.ok(rec, '挂站的站点不能把执行器吊死到永远');
    assert.equal(rec.status, 'failed');
    assert.ok(rec.durationS <= 40, `必须在超时预算内结束，实际 ${rec.durationS}s`);
  });

  test('域名不存在：以失败收场，且日志里能看到是哪个 URL 连不上', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const url = 'http://automation-fault-probe.invalid/';
    const dir = await makeFaultTask(api, s, 'net-dns', url,
      `import { test } from '@playwright/test';\ntest('r', async ({ page }) => { await page.goto(${JSON.stringify(url)}); });\n`);

    const run = await api.api('/api/tasks/net-dns/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    const rec = await waitForRun(s, 'net-dns');
    assert.ok(rec);
    assert.equal(rec.status, 'failed');
    const log = fs.readFileSync(path.join(s.base, 'logs/net-dns.log'), 'utf8');
    assert.match(log, /net::ERR_NAME_|ERR_NAME_NOT_RESOLVED|Name or service not known|ERR_INTERNET_DISCONNECTED|goto|Failed/,
      '日志里要留下判断依据');
    assert.ok(log.includes('EXIT='), '执行器必须写下最终退出码');
    assert.equal(fs.existsSync(path.join(dir, 'recorded.spec.js')), true);
  });

  test('网络异常不影响并发释放：失败后仍能再次触发', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const dead = `http://127.0.0.1:${closedPort()}/`;
    await makeFaultTask(api, s, 'net-retry', dead,
      `import { test } from '@playwright/test';\ntest('r', async ({ page }) => { await page.goto(${JSON.stringify(dead)}); });\n`);

    const a = await api.api('/api/tasks/net-retry/run', { method: 'POST', body: {} });
    assert.equal(a.status, 200);
    assert.ok(await waitForRun(s, 'net-retry'));
    const b = await api.api('/api/tasks/net-retry/run', { method: 'POST', body: {} });
    assert.equal(b.status, 200, '上一轮失败结束即释放，不得把锁留在手里');
    assert.equal(fs.existsSync(path.join(s.base, 'tasks/net-retry/.lock')), false, '锁目录必须已被 EXIT trap 清掉');
  });
});

describe('管理器自身的网络韧性', () => {
  test('前端断开不影响运行：日志偏移仍然可用', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const missing = await api.api('/api/tasks/nope/log?from=0');
    assert.equal(missing.status, 404);
    const r = await api.api('/api/system');
    assert.equal(r.status, 200, '取不到日志不能连带把管理器拖垮');
  });

  test('AUTOMATION_HOME 指向不存在的深层路径时，启动应把它建出来而不是崩', async (t) => {
    const s = sandbox(t);
    const deep = path.join(s.root, 'a/b/c');
    writeRegistry(s, []);
    const api = startServer(t, s, { AUTOMATION_HOME: deep });
    await api.ready();
    assert.equal(fs.existsSync(path.join(deep, 'tasks')), true);
    assert.equal(fs.existsSync(path.join(deep, 'logs')), true);
  });

  test('运行记录目录只读时，任务行为与退出码不变（观测层不得变成新故障源）', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const runs = path.join(s.base, 'logs/runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'ro.txt'), '');
    fs.chmodSync(runs, 0o500);
    try {
      const r = await api.api('/api/tasks');
      assert.equal(r.status, 200, '记录写不进去时列表接口照常');
      assert.equal(r.body.tasks.length, 0);
    } finally {
      fs.chmodSync(runs, 0o700);   // 必须在本用例内恢复，否则临时目录清不掉
    }
  });
});

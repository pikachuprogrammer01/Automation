import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sandbox, startServer, writeRegistry } from './helpers/harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const LIB = path.join(REPO, 'lib', 'automation-run.zsh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 直接 source 共享库来驱动锁函数，不需要 @playwright/test，CI 零依赖作业也能跑。 */
function drive(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const r = spawnSync('/bin/zsh', ['-u', '-c', `source '${LIB}'; LOCK_DIR='${root}/l'; ${script}`], {
    encoding: 'utf8', cwd: root, env: { ...process.env, TMPDIR: root },
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), root };
}

describe('并发锁：skipped 不得伪装成无事可做（中断测试）', () => {
  test('首次上锁成功，并把 pid 写进锁目录', (t) => {
    const r = drive(t, `
      acquire_lock "$LOCK_DIR"; echo "acquired=$?"; echo "stale=$LOCK_STALE";
      echo "pidfile=$(cat "$LOCK_DIR/pid")"; echo "self=$$";
      release_lock "$LOCK_DIR"; echo "gone=$([ -d "$LOCK_DIR" ] && echo no || echo yes)"`);
    assert.match(r.out, /acquired=0/);
    assert.match(r.out, /stale=0/);
    assert.match(r.out, /gone=yes/);
    const pid = /pidfile=(\d+)/.exec(r.out)[1];
    const self = /self=(\d+)/.exec(r.out)[1];
    assert.equal(pid, self, '锁里必须记下持有者的 pid，否则无从判断死活');
  });

  test('持有者活着 → 第二个必须让位（真并发保护不许被削弱）', (t) => {
    const r = drive(t, `
      acquire_lock "$LOCK_DIR" || exit 9
      mkdir "$LOCK_DIR" 2>/dev/null && echo "BUG: 锁没生效"
      printf '%s\\n' "$$" > "$LOCK_DIR/pid"
      acquire_lock "$LOCK_DIR"; echo "second=$?"
      echo "stale=$LOCK_STALE"
      kill -0 "$(cat "$LOCK_DIR/pid")" && echo holder=alive`);
    assert.match(r.out, /second=1/, '锁主存活时第二次上锁必须失败');
    assert.match(r.out, /stale=0/, '让位不算接管');
    assert.match(r.out, /holder=alive/);
  });

  test('锁主已被强杀 → 必须接管并标 lock_stale，而不是永远 skipped', (t) => {
    const r = drive(t, `
      mkdir "$LOCK_DIR"
      printf '%s\\n' 99999999 > "$LOCK_DIR/pid"        # 一个不可能存活的 pid
      acquire_lock "$LOCK_DIR"; echo "acquired=$?"
      echo "stale=$LOCK_STALE"
      echo "pidfile=$(cat "$LOCK_DIR/pid")"; echo "self=$$"`);
    assert.match(r.out, /acquired=0/, '遗留锁必须能接管，否则任务永久停跑');
    assert.match(r.out, /stale=1/, '接管必须被标记出来，不能静默');
    const pid = /pidfile=(\d+)/.exec(r.out)[1];
    assert.equal(pid, /self=(\d+)/.exec(r.out)[1], '接管后锁要归新持有者');
  });

  test('旧版本遗留的无 pid 锁 → 按接管处理（可用性优先，不赌它还在跑）', (t) => {
    const r = drive(t, `
      mkdir "$LOCK_DIR"                                 # 没有 pid 文件
      acquire_lock "$LOCK_DIR"; echo "acquired=$?"; echo "stale=$LOCK_STALE"`);
    assert.match(r.out, /acquired=0/);
    assert.match(r.out, /stale=1/);
  });

  test('锁目录本身不可建（数据根被删权限）→ 让位而不是崩', (t) => {
    const r = drive(t, `
      mkdir "$LOCK_DIR"; chmod 500 "$LOCK_DIR"
      printf '%s\\n' 99999999 > "$LOCK_DIR/pid" 2>/dev/null
      chmod 700 "$LOCK_DIR"
      acquire_lock "$LOCK_DIR"; echo "acquired=$?"; release_lock "$LOCK_DIR"; echo "cleaned=$([ -d "$LOCK_DIR" ] && echo no || echo yes)"`);
    assert.match(r.out, /acquired=0/);
    assert.match(r.out, /cleaned=yes/);
  });

  test('release_lock 对不存在的锁是幂等的（EXIT trap 不能反过来制造新故障）', (t) => {
    const r = drive(t, `release_lock "$LOCK_DIR"; echo "status=$?"; release_lock ""; echo "empty=$?"`);
    assert.match(r.out, /status=0/);
    assert.match(r.out, /empty=0/);
  });

  test('接管信号必须能传到运行记录（env → run-record.mjs）', (t) => {
    const r = drive(t, `
      mkdir "$LOCK_DIR"; printf '%s\\n' 99999999 > "$LOCK_DIR/pid"
      acquire_lock "$LOCK_DIR"
      echo "env=$AUTOMATION_LOCK_STALE"`);
    assert.match(r.out, /env=1/, 'acquire_lock 要把接管状态导出给子进程，记录层才拿得到');
  });
});

describe('录制任务执行器：被强杀后下一轮必须真跑（端到端）', { skip: !fs.existsSync(path.join(REPO, 'manager/node_modules/@playwright/test')) }, () => {
  test('SIGKILL 掉正在跑的一轮 → 锁残留 → 再跑一次要接管并留下 lockStale', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    const created = await api.api('/api/recordings/create', {
      method: 'POST', body: { id: 'killme', name: '会被强杀', url: `http://127.0.0.1:${s.port}/demo/`, blank: true },
    });
    assert.equal(created.status, 200);
    // 换成一个会停留的脚本，保证有窗口可以强杀
    fs.writeFileSync(path.join(s.base, 'tasks/killme/recorded.spec.js'),
      `import { test } from '@playwright/test';\ntest('hang', async ({ page }) => { await page.goto(${JSON.stringify(`http://127.0.0.1:${s.port}/demo/`)}); await page.waitForTimeout(30000); });\n`, { mode: 0o600 });

    const first = await api.api('/api/tasks/killme/run', { method: 'POST', body: {} });
    assert.equal(first.status, 200);
    await sleep(2500);
    const lock = path.join(s.base, 'tasks/killme/.lock');
    assert.ok(fs.existsSync(lock), '运行期间锁目录应存在');
    spawnSync('/bin/kill', ['-9', String(first.body.pid)]);
    await sleep(800);
    assert.ok(fs.existsSync(lock), 'SIGKILL 不执行 EXIT trap，锁目录必然残留 —— 这正是要治的情形');

    // 换成秒完的脚本：接管那一轮要能在合理的等待时间内留下记录
    fs.writeFileSync(path.join(s.base, 'tasks/killme/recorded.spec.js'),
      `import { test } from '@playwright/test';\ntest('quick', async ({ page }) => { await page.goto(${JSON.stringify(`http://127.0.0.1:${s.port}/demo/`)}); });\n`, { mode: 0o600 });

    const second = await api.api('/api/tasks/killme/run', { method: 'POST', body: {} });
    assert.equal(second.status, 200, '遗留锁必须被接管，不能因为锁还在就 409/skip');
    assert.notEqual(second.body.pid, first.body.pid);

    const until = Date.now() + 40000;
    let ran = null;
    while (Date.now() < until && !ran) {
      await sleep(500);
      const dir = path.join(s.base, 'logs/runs');
      if (!fs.existsSync(dir)) continue;
      const rows = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
        .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      ran = rows.find((r) => r.task === 'killme') || null;
    }
    assert.ok(ran, '接管后的那一轮必须留下运行记录');
    assert.equal(ran.lockStale, true, '接管事件必须写进记录，否则"曾经停跑"再次变成不可知');
    assert.equal(ran.trigger, 'manager');
  });
});

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sandbox, plantShims, startServer, writeRegistry } from './helpers/harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const PROD_REGISTRY = path.join(REPO, 'var', 'registry.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOrNull = (p) => { try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

function plistTextFor(s, id) {
  return path.join(s.home, 'Library', 'LaunchAgents', `com.pikachu.automation-selftest.${id}.plist`);
}

/** 建一个录制任务并把 command 换成沙箱内的常驻脚本，避免依赖 @playwright/test。 */
async function makeTask(api, s, id) {
  const r = await api.api('/api/recordings/create', {
    method: 'POST',
    body: { id, name: `生命周期 ${id}`, url: `http://127.0.0.1:${s.port}/demo/`, blank: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = path.join(s.base, 'registry.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const holder = path.join(s.base, `${id}-hold.sh`);
  fs.writeFileSync(holder, '#!/bin/sh\nexec sleep 3\n', { mode: 0o700 });
  data.tasks[0].command = ['/bin/zsh', holder];
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return data.tasks[0];
}

describe('任务全生命周期（PRD 验收标准 1）', () => {
  test('建 → 定时 → 启用 → 立即运行 → 暂停 → 移除定时 → 彻底删除', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const sh = plantShims(s);
    const api = startServer(t, s);
    await api.ready();
    const prodBefore = hashOrNull(PROD_REGISTRY);

    // --- 建
    const task = await makeTask(api, s, 'life-demo');
    assert.equal(task.type, 'recorded');
    assert.ok(fs.existsSync(path.join(s.base, 'tasks', 'life-demo', 'recorded.spec.js')), '脚手架必须落在数据根的 var/tasks 下');
    assert.ok(fs.existsSync(path.join(s.base, 'browser-data', 'managed-life-demo')), 'Profile 目录必须落在 var/browser-data 下');
    assert.equal(fs.statSync(path.join(s.base, 'tasks', 'life-demo', 'recorded.spec.js')).mode & 0o777, 0o600);

    // --- 定时
    const sched = await api.api('/api/tasks/life-demo/schedule', { method: 'POST', body: { hour: 7, minute: 15 } });
    assert.equal(sched.status, 200);
    const plist = plistTextFor(s, 'life-demo');
    assert.ok(fs.existsSync(plist), 'plist 必须落在 $HOME/Library/LaunchAgents（测试里是假 HOME）');
    const body = fs.readFileSync(plist, 'utf8');
    assert.match(body, /<key>Hour<\/key><integer>7<\/integer>/);
    assert.match(body, /<key>Minute<\/key><integer>15<\/integer>/);
    assert.match(body, /run-recorded-task|life-demo-hold\.sh/, 'plist 必须指向本任务的执行入口');
    // print 是只读探测（建任务的响应里 taskView 就会调），顺序只看改状态的那几个
    const order = sh.callsOf('launchctl').map((l) => l.split(' ')[1]).filter((c) => c !== 'print');
    assert.deepEqual(order.slice(0, 3), ['bootout', 'enable', 'bootstrap'], '加载顺序必须是 bootout→enable→bootstrap');
    assert.ok(sh.loaded().includes('com.pikachu.automation-selftest.life-demo'), 'bootstrap 后应视为已加载');

    // --- 立即运行
    const run = await api.api('/api/tasks/life-demo/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    assert.ok(Number.isFinite(run.body.pid));
    const busy = await api.api('/api/tasks/life-demo/run', { method: 'POST', body: {} });
    assert.equal(busy.status, 409, '运行中不得起第二个进程');
    await sleep(3400);

    // --- 暂停
    const dis = await api.api('/api/tasks/life-demo/disable', { method: 'POST', body: {} });
    assert.equal(dis.status, 200, JSON.stringify(dis.body));
    assert.ok(!sh.loaded().includes('com.pikachu.automation-selftest.life-demo'), '暂停后 launchd 里不该还有它');

    // --- 重新启用
    const en = await api.api('/api/tasks/life-demo/enable', { method: 'POST', body: {} });
    assert.equal(en.status, 200);
    assert.ok(sh.loaded().includes('com.pikachu.automation-selftest.life-demo'), '启用要真的把它放回 launchd');

    // --- 移除定时（脚本与数据必须保留）
    const rm = await api.api('/api/tasks/life-demo/remove', { method: 'POST', body: {} });
    assert.equal(rm.status, 200);
    assert.equal(fs.existsSync(plist), false, '移除定时要删 plist');
    assert.ok(fs.existsSync(path.join(s.base, 'tasks', 'life-demo', 'recorded.spec.js')), '移除定时不得动脚本');

    // --- 彻底删除：确认串不匹配必须被拒
    const badPurge = await api.api('/api/tasks/life-demo/purge', {
      method: 'POST', body: { confirm: 'WRONG', deleteLogs: true, deleteProfile: true },
    });
    assert.equal(badPurge.status, 400);
    assert.equal(badPurge.body.code, 'confirmation_required');
    assert.ok(JSON.parse(fs.readFileSync(path.join(s.base, 'registry.json'), 'utf8')).tasks.length === 1, '被拒的任务必须还在');

    // --- 彻底删除：确认后逐项清干净
    const purge = await api.api('/api/tasks/life-demo/purge', {
      method: 'POST', body: { confirm: 'life-demo', deleteLogs: true, deleteProfile: true },
    });
    assert.equal(purge.status, 200, JSON.stringify(purge.body));
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, 'registry.json'), 'utf8')).tasks.length, 0);
    assert.equal(fs.existsSync(path.join(s.base, 'tasks', 'life-demo')), false, '录制任务删除后脚本目录必须消失');
    assert.equal(fs.existsSync(path.join(s.base, 'browser-data', 'managed-life-demo')), false, '勾了删除 Profile 就要删');

    // --- 生产零污染
    assert.equal(hashOrNull(PROD_REGISTRY), prodBefore, '测试期间生产登记表必须一字未动');
    assert.equal(
      fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.pikachu.automation-selftest.life-demo.plist')),
      false, '真实 HOME 下不得出现测试 plist',
    );
  });

  test('收尾：真实 launchd 域里不得留下任何 selftest 标签', (t) => {
    // 曾经踩过：harness 只做 PATH 垫片时，server.mjs 用绝对路径 /bin/launchctl，PATH 拦不住，
    // 测试真的往真实域注册了定时任务。这条断言就是防它再犯——直接问真 launchctl。
    const listed = spawnSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
    if (listed.status !== 0) { t.skip(`这台机器读不到 launchd 域（${(listed.stderr || '').trim().slice(0, 60)}）`); return; }
    // 只断言"没有测试残留"。不能断言生产服务在不在——那等于要求跑测试的人已经装好 LaunchAgent，
    // 在 CI 和别人的机器上必然红。
    assert.ok(!listed.stdout.includes('com.pikachu.automation-selftest'),
      `真实域残留了测试标签：${listed.stdout.split('\n').filter((l) => l.includes('selftest')).join(' | ')}`);
    assert.ok(!listed.stdout.includes('life-demo') && !listed.stdout.includes('boot-fail'),
      '真实域残留了生命周期用例的标签');
  });
});

describe('暂停/移除的失败分支', () => {
  test('launchd 拒绝卸载时，暂停必须报错而不是假装成功', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    plantShims(s, { printLoaded: true });        // print 永远成功 = 一直"仍在加载"
    const api = startServer(t, s);
    await api.ready();
    await makeTask(api, s, 'stuck');
    const r = await api.api('/api/tasks/stuck/disable', { method: 'POST', body: {} });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'disable_failed');
    assert.match(r.body.hint, /var\/logs/, '失败必须指向具体日志');
  });

  test('bootstrap 失败且未加载时，定时必须报 launchctl_bootstrap_failed', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    plantShims(s, { launchctlFail: true });
    const api = startServer(t, s);
    await api.ready();
    await makeTask(api, s, 'boot-fail');
    const r = await api.api('/api/tasks/boot-fail/schedule', { method: 'POST', body: { hour: 8, minute: 0 } });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'launchctl_bootstrap_failed');
    assert.match(r.body.error, /定时未生效/);
  });
});

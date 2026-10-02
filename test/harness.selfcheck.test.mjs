import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { sandbox, startServer, writeRegistry, freePort } from './helpers/harness.mjs';

describe('测试基础设施自检（防"假绿"）', () => {
  test('连续分配 12 个端口必须互不相同', async () => {
    const ports = new Set();
    for (let i = 0; i < 12; i += 1) ports.add(await freePort());
    assert.equal(ports.size, 12, '端口重复意味着并行文件可能互相打到对方的管理器');
    for (const p of ports) assert.ok(p > 0 && p < 65536, `拿到的不是合法端口：${p}`);
  });

  test('两个实例各自只看得见自己的登记表', async (t) => {
    const a = sandbox(t);
    const b = sandbox(t);
    writeRegistry(a, []);
    writeRegistry(b, []);
    const sa = startServer(t, a);
    const sb = startServer(t, b);
    await sa.ready();
    await sb.ready();
    assert.ok(a.port && b.port, 'ready() 之后端口必须已分配');
    assert.notEqual(a.port, b.port);

    const r = await sa.api('/api/recordings/create', {
      method: 'POST', body: { id: 'only-in-a', name: '隔离', url: 'http://127.0.0.1:1/', blank: true },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await sa.api('/api/tasks')).body.tasks.map((x) => x.id), ['only-in-a']);
    assert.deepEqual((await sb.api('/api/tasks')).body.tasks, [],
      '另一个实例被写入了——说明请求串到了别人的端口上');
  });

  test('ready() 必须确认应答者就是自己起的那个实例', async (t) => {
    const s = sandbox(t);
    writeRegistry(s, []);
    const api = startServer(t, s);
    await api.ready();
    // 端口写进登记表以外的地方不该出现；这里验 /api/system 自报端口与 s.port 一致
    const sys = await api.api('/api/system');
    assert.equal(sys.body.port, s.port, '自报端口不符说明连错实例');
  });
});

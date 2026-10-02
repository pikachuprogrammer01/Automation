import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  xml, validId, PORTABLE_KEYS, fromPortable, toPortable, mapTaskPaths,
  plistText, resolveStatic, isSameOrigin, logWindow,
} from '../manager/task-format.mjs';

const HOME = '/Users/tester';
const BASE = '/Users/tester/code/Automation/var';
const CTX = { base: BASE, home: HOME };

describe('XML 转义：登记表里的值都会进 LaunchAgent', () => {
  test('正常：三个 XML 元字符被转义', () => {
    assert.equal(xml('a&b<c>d'), 'a&amp;b&lt;c&gt;d');
  });
  test('注入：任务名/URL 里的闭合标签必须被吞成文本', () => {
    const evil = '</string></dict><key>UserName</key><string>root';
    const out = xml(evil);
    assert.ok(!out.includes('</string>'), '不得提前关掉 string 节点');
    assert.ok(!out.includes('<key>'), '不得注入新键');
    const plist = plistText({
      launchLabel: 'com.x.y', command: ['/bin/zsh', evil], logPath: '/tmp/l.log',
    }, 8, 30);
    assert.equal((plist.match(/<key>/g) || []).length, 10, '键数量必须还是 10 个，没被注入撑开');
  });
  test('边界：非字符串输入不得抛', () => {
    assert.equal(xml(42), '42');
    assert.equal(xml(null), 'null');
    assert.equal(xml(undefined), 'undefined');
  });
});

describe('任务 ID 校验：它会被拼进路径和 launchd 标签', () => {
  const ok = ['a1', 'loveapi-a', 'modelscope-b', 'z'.repeat(2), 'x'.repeat(41), '0-ab9'];
  const bad = ['', 'a', 'A', 'Abc', '-lead', 'has space', 'has_underscore', 'x'.repeat(42),
    '../etc', 'a/b', 'a\nb', '任务', null, undefined, 42, {}, ['a1']];
  for (const v of ok) test(`合法：${JSON.stringify(v)}`, () => assert.equal(validId(v), true));
  for (const v of bad) test(`非法：${JSON.stringify(v)}`, () => assert.equal(validId(v), false));
});

describe('可移植路径：换机器/改目录名不重写数据', () => {
  test('~/ 前缀落到 home', () => {
    assert.equal(fromPortable('~/code/A/x', CTX), path.join(HOME, 'code/A/x'));
  });
  test('绝对路径原样通过', () => {
    assert.equal(fromPortable('/usr/bin/zsh', CTX), '/usr/bin/zsh');
  });
  test('裸相对路径落到数据根', () => {
    assert.equal(fromPortable('tasks/a1/recorded.spec.js', CTX), path.join(BASE, 'tasks/a1/recorded.spec.js'));
  });
  test('带协议的 URL 绝不当路径改写', () => {
    assert.equal(fromPortable('http://127.0.0.1:4765/demo/', CTX), 'http://127.0.0.1:4765/demo/');
  });
  test('非字符串与空串原样返回', () => {
    for (const v of [null, undefined, 42, '', {}]) assert.equal(fromPortable(v, CTX), v);
  });
  test('toPortable 回写：home 优先于 base（数据根常在家目录下，两者有前缀关系）', () => {
    assert.equal(toPortable(HOME, CTX), '~');
    assert.equal(toPortable(`${HOME}/Library/LaunchAgents/x.plist`, CTX), '~/Library/LaunchAgents/x.plist');
    // BASE 在 HOME 里面时，数据根下的路径以 ~/ 形式写出；关键是往返不失真（下面那条用例锁这个）
    assert.equal(toPortable(`${BASE}/logs/a.log`, CTX), '~/code/Automation/var/logs/a.log');
    assert.equal(toPortable('/elsewhere/a.log', CTX), '/elsewhere/a.log');
    assert.equal(toPortable(null, CTX), null);
  });
  test('数据根不在家目录下时，回写成相对数据根的形式', () => {
    const c = { base: '/srv/automation/var', home: HOME };
    assert.equal(toPortable('/srv/automation/var/logs/a.log', c), 'logs/a.log');
    assert.equal(fromPortable('logs/a.log', c), '/srv/automation/var/logs/a.log');
  });
  test('往返一致：home 与 base 下的路径写出去读回来不变', () => {
    for (const p of [`${HOME}/Library/LaunchAgents/a.plist`, `${BASE}/logs/a.log`, `${BASE}/tasks/a1`]) {
      assert.equal(fromPortable(toPortable(p, CTX), CTX), p, `${p} 往返失真`);
    }
  });
  test('边界：BASE 与 HOME 有前缀关系时，home 下的路径不得被当成数据根', () => {
    const c = { base: `${HOME}/code/Automation/var`, home: HOME };
    assert.equal(toPortable(`${HOME}/code/plain`, c), '~/code/plain');
  });
});

describe('mapTaskPaths：只改脚本位，不改参数位', () => {
  test('command[1] 被改写，command[2+] 原样', () => {
    const t = { id: 'a', command: ['/bin/zsh', '~/code/Automation/private/run-x', 'a'] };
    const out = mapTaskPaths(t, (v) => fromPortable(v, CTX));
    assert.deepEqual(out.command, ['/bin/zsh', path.join(HOME, 'code/Automation/private/run-x'), 'a']);
  });
  test('约定被破坏会静默改变行为——把参数当路径拼上数据根（文档级回归锁）', () => {
    const t = { command: ['/bin/sleep', '4'] };
    const out = mapTaskPaths(t, (v) => fromPortable(v, CTX));
    assert.equal(out.command[1], path.join(BASE, '4'),
      '这条断言锁的是"command[1] 必须是路径"的约定；哪天想改这个行为，先改文档和适配器');
  });
  test('只处理 PORTABLE_KEYS，其余字段不动', () => {
    const t = { id: 'a', name: 'x', logPath: `${BASE}/logs/a.log`, site: 'http://a.test/' };
    const out = mapTaskPaths(t, (v) => fmtShort(v));
    assert.equal(out.name, 'x');
    assert.equal(out.site, 'http://a.test/');
    assert.equal(out.logPath, 'F');
    function fmtShort() { return 'F'; }
  });
  test('不修改原对象（登记表复用时的浅拷贝不变量）', () => {
    const t = { logPath: `${BASE}/logs/a.log`, command: ['/bin/zsh', `${BASE}/s`, 'b'] };
    const snapshot = JSON.parse(JSON.stringify(t));
    mapTaskPaths(t, () => 'X');
    assert.deepEqual(t, snapshot);
  });
  test('PORTABLE_KEYS 与 server.mjs 里的字段清单同序', () => {
    const server = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'manager/server.mjs'), 'utf8');
    assert.ok(server.includes('mapTaskPaths(t, fromPortable)'), '登记表读写仍必须走同一套映射');
    assert.deepEqual(PORTABLE_KEYS, [
      'plistPath', 'logPath', 'configPath', 'profileDir', 'taskDir', 'stdoutPath', 'stderrPath',
    ]);
  });
});

describe('plist 生成：明天几点跑、跑什么，全在这份文本里', () => {
  const base = {
    launchLabel: 'com.pikachu.automation.demo-a',
    command: ['/bin/zsh', '/Users/me/code/Automation/manager/run-recorded-task', 'demo-a'],
    logPath: '/Users/me/code/Automation/var/logs/demo-a.log',
  };
  test('排期写成整数 Hour/Minute', () => {
    const p = plistText(base, 8, 5);
    assert.match(p, /<key>StartCalendarInterval<\/key><dict><key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>5<\/integer><\/dict>/);
  });
  test('未显式给 stdout/stderr 时从 logPath 派生', () => {
    const p = plistText(base, 8, 5);
    assert.ok(p.includes('<key>StandardOutPath</key><string>/Users/me/code/Automation/var/logs/demo-a.log.launchd.out</string>'));
    assert.ok(p.includes('<key>StandardErrorPath</key><string>/Users/me/code/Automation/var/logs/demo-a.log.launchd.err</string>'));
  });
  test('显式 stdoutPath/stderrPath 优先于派生', () => {
    const p = plistText({ ...base, stdoutPath: '/tmp/o', stderrPath: '/tmp/e' }, 9, 0);
    assert.ok(p.includes('<string>/tmp/o</string>') && p.includes('<string>/tmp/e</string>'));
    assert.ok(!p.includes('launchd.out'), '给了显式路径就不该再派生');
  });
  test('ProgramArguments 逐项成 string，参数不丢', () => {
    const p = plistText(base, 9, 0);
    // 8 = Label 1 + 命令 3 + PATH 1 + ProcessType 1 + 两条日志路径 2
    assert.equal((p.match(/<string>/g) || []).length, 8);
    assert.ok(p.includes('<string>demo-a</string>'));
  });
  test('launchd 需要的 PATH 必须在里面，否则找不到 node', () => {
    const p = plistText(base, 9, 0);
    assert.match(p, /<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>.*\/usr\/bin.*<\/string>/);
  });
  test('产出的 plist 真能被 plutil 接受（macOS 才有，缺就跳过）', () => {
    if (!fs.existsSync('/usr/bin/plutil')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-plist-'));
    try {
      const f = path.join(dir, 'x.plist');
      fs.writeFileSync(f, plistText(base, 7, 15));
      const r = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, `plutil 认为这份 plist 不合法：${r.stdout}${r.stderr}`);
      const l = spawnSync('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', f], { encoding: 'utf8' });
      assert.equal(l.stdout.trim(), 'com.pikachu.automation.demo-a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('静态文件越界判定', () => {
  const PUB = path.join(path.resolve(import.meta.dirname, '..'), 'manager/public');
  test('根路径与子目录都落在 public 内', () => {
    assert.equal(resolveStatic('/', PUB).file, path.join(PUB, 'index.html'));
    assert.equal(resolveStatic('/demo', PUB).forbidden, false);
    assert.equal(resolveStatic('/assets/index.css', PUB).forbidden, false);
  });
  test('穿越写法必须判 forbidden', () => {
    for (const p of ['/../package.json', '/../server.mjs', '/../../etc/passwd', '/a/../../b']) {
      const r = resolveStatic(p, PUB);
      assert.equal(r.forbidden, true, `${p} 不该被放行`);
      assert.equal(r.file, null);
    }
  });
  test('写成绝对路径的 URL 也只会落在 public 里面（读不到家目录）', () => {
    const r = resolveStatic('/Users/x/.ssh/id_rsa', PUB);
    assert.equal(r.forbidden, false, 'URL 路径永远相对服务根解析，不算穿越');
    assert.ok(r.file.startsWith(PUB + path.sep), `解析结果必须仍在 public 内，实际 ${r.file}`);
    assert.equal(r.file, path.join(PUB, 'Users/x/.ssh/id_rsa'), '它只会当成 public 下的一个子路径，然后 404');
  });
  test('index.html 本身即便等于根目录也要放行（原逻辑的例外分支）', () => {
    assert.equal(resolveStatic('/index.html', PUB).forbidden, false);
  });
});

describe('同源判定', () => {
  test('无 Origin 头放行（命令行与同源页面）', () => {
    assert.equal(isSameOrigin(undefined, 4765), true);
    assert.equal(isSameOrigin('', 4765), true);
  });
  test('本端口两种写法都算同源', () => {
    assert.equal(isSameOrigin('http://127.0.0.1:4765', 4765), true);
    assert.equal(isSameOrigin('http://localhost:4765', 4765), true);
  });
  test('外站、错端口、错协议都拒', () => {
    assert.equal(isSameOrigin('http://evil.example:4765', 4765), false);
    assert.equal(isSameOrigin('http://127.0.0.1:4766', 4765), false);
    assert.equal(isSameOrigin('https://127.0.0.1:4765', 4765), false);
    assert.equal(isSameOrigin('null', 4765), false);
  });
});

describe('日志字节窗口（两个账号共用一个日志文件不串台的基础）', () => {
  test('给定偏移就从那里读到末尾，最多 64KB', () => {
    assert.deepEqual(logWindow(100, 1000), { start: 100, len: 900 });
    assert.deepEqual(logWindow(0, 200000), { start: 0, len: 65536 });
  });
  test('偏移越过文件末尾时收敛到末尾（日志被轮转/截断不能读飞）', () => {
    assert.deepEqual(logWindow(5000, 1000), { start: 1000, len: 0 });
  });
  test('偏移非法或为负时取尾部 64KB', () => {
    for (const from of [NaN, -1, undefined, null]) {
      const { start, len } = logWindow(from, 100000);
      assert.equal(start, 100000 - 65536, `${String(from)} 应取尾部`);
      assert.equal(len, 65536);
    }
  });
  test('空文件读出 0 长度', () => {
    assert.deepEqual(logWindow(0, 0), { start: 0, len: 0 });
    assert.deepEqual(logWindow(NaN, 0), { start: 0, len: 0 });
  });
});

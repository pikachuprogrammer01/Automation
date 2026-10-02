import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');

const usedPorts = new Set();

/** 必须等内核分完端口、再等 close 的回调把句柄放掉；同步读 address() 只会拿到 null。 */
function probePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 向内核要一个当下空闲的端口。
 * 不要按 process.pid 推导：同一进程里每个 sandbox 都会拿到同一个端口，而 node --test
 * 默认按 CPU 数并行跑各个测试文件，取值空间只有几十个数——撞车时本文件的请求会打到
 * 另一个文件的管理器上，任务被建进别人的数据根，本文件报 ENOENT；更坏的情况是双方
 * 恰好错开，测试看着绿其实验的是别人的实例。
 */
export async function freePort() {
  for (let i = 0; i < 20; i += 1) {
    const p = await probePort();
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
  throw new Error('拿不到未被本进程用过的空闲端口');
}

/**
 * 建一个完全隔离的测试环境：独立数据根、独立 HOME、独立端口。
 * 生产 var/ 与真实 launchd 域永远不被触碰（docs/PRD.md 验收标准 7、8）。
 * 端口是惰性的——分配要等异步事件，所以 `s.port` / `s.url` 在 ready() 之后才有值。
 */
export function sandbox(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-test-'));
  const home = path.join(root, 'home');
  const base = path.join(root, 'var');
  const shim = path.join(root, 'shim');
  const s = { root, home, base, shim, port: null };
  Object.defineProperty(s, 'url', { get: () => `http://127.0.0.1:${s.port}`, enumerable: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(shim, { recursive: true });

  // 默认 deny 垫片：print 一律报"未加载"，其余调用记下来。这样任何用例——包括忘了装垫片的——
  // 都不可能碰到真实 launchd 域（PRD 验收标准 8）。plantShims 会把它升级成有状态版本。
  fs.writeFileSync(path.join(shim, 'launchctl'), [
    '#!/bin/sh',
    `CMD="$1"; shift`,
    `echo "launchctl $CMD $*" >> '${path.join(root, 'calls.jsonl')}'`,
    'case "$CMD" in',
    '  print) exit 1 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });

  const env = {
    ...process.env,
    AUTOMATION_HOME: base,
    // 端口在 launch() 里随 s.port 一起给，不在这里定死（分配是异步的）
    AUTOMATION_LAUNCH_LABEL_PREFIX: 'com.pikachu.automation-selftest',
    AUTOMATION_LAUNCHCTL: path.join(shim, 'launchctl'),
    AUTOMATION_OSASCRIPT: path.join(shim, 'osascript'),
    HOME: home,
    TMPDIR: root,
    PATH: `${shim}:${process.env.PATH}`,
  };

  t.after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

  s.env = env;
  return s;
}

/**
 * 假 launchctl / security / osascript：把调用记到 calls.jsonl，返回可控结果。
 * 没有它，installTask / enableTask / notify 这些副作用代码只能打真 launchd 域。
 *
 * launchctl 是有状态的：bootstrap 把标签加进 state，bootout/disable 摘掉，
 * print 按 state 返回 0/1。否则 disableTask 里「仍在已加载状态」那条分支永远测不到。
 */
export function plantShims(s, { launchctlFail = false, printLoaded = null } = {}) {
  const state = path.join(s.root, 'launchd-state');
  fs.writeFileSync(state, '');
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const write = (name, body) => fs.writeFileSync(path.join(s.shim, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  write('launchctl', [
    `CMD="$1"; shift`,
    `echo "launchctl $CMD $*" >> ${q(path.join(s.root, 'calls.jsonl'))}`,
    `TARGET="$1"`,
    `LABEL="\${TARGET##*/}"`,
    `ST=${q(state)}`,
    'case "$CMD" in',
    '  print)',
    ...(printLoaded ? ['    exit 0'] : []),
    `    grep -qx -- "$LABEL" "$ST" && exit 0 || exit 1`,
    '    ;;',
    '  bootout)',
    `    touch "$ST"; grep -vx -- "$LABEL" "$ST" > "$ST.n" || true; mv "$ST.n" "$ST"`,
    '    exit 0',
    '    ;;',
    '  disable)',
    `    touch "$ST"; grep -vx -- "$LABEL" "$ST" > "$ST.n" || true; mv "$ST.n" "$ST"`,
    '    exit 0',
    '    ;;',
    '  bootstrap)',
    ...(launchctlFail ? ['    exit 1'] : []),
    '    for a in "$@"; do PL="$a"; done',
    `    L=$(/usr/bin/plutil -extract Label raw -o - "$PL" 2>/dev/null || true)`,
    `    [ -n "$L" ] && echo "$L" >> "$ST"`,
    '    exit 0',
    '    ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));

  write('security', `echo "security $*" >> ${q(path.join(s.root, 'calls.jsonl'))}\nexit 0`);
  write('osascript', `echo "osascript $*" >> ${q(path.join(s.root, 'calls.jsonl'))}\nexit 0`);

  const loaded = () => fs.readFileSync(state, 'utf8').split('\n').filter(Boolean);
  return {
    state,
    loaded,
    calls: () => {
      try {
        return fs.readFileSync(path.join(s.root, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((l) => ({ cmd: l }));
      } catch { return []; }
    },
    callsOf: (name) => {
      try {
        return fs.readFileSync(path.join(s.root, 'calls.jsonl'), 'utf8').split('\n').filter((l) => l.startsWith(`${name} `));
      } catch { return []; }   // 一次都没调用过是合法结果，不是错误
    },
  };
}

/** 起一个隔离的管理器实例。端口在 ready() 里惰性分配，所以别在 ready() 前发请求。 */
export function startServer(t, s, extraEnv = {}) {
  let proc = null;
  let stdout = '';
  let up = false;

  const launch = () => {
    stdout = '';
    proc = spawn(process.execPath, [path.join(REPO, 'manager', 'server.mjs')], {
      env: { ...s.env, ...extraEnv, AUTOMATION_MANAGER_PORT: String(s.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO,
    });
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stdout += d; });
  };
  t.after(() => { if (proc) { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } } });

  const waitUp = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${s.url}/api/system`);
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          if (body.port !== s.port) throw new Error(`端口 ${s.url} 上应答的是别人的实例（它自报 ${body.port}）`);
          return true;
        }
      } catch (e) {
        if (e instanceof RangeError || /应答的是别人/.test(String(e))) throw e;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    return false;
  };

  return {
    get proc() { return proc; },
    get log() { return stdout; },
    async ready(timeoutMs = 8000) {
      if (up) return true;
      for (let i = 0; i < 4; i += 1) {
        if (s.port == null) s.port = await freePort();
        launch();
        if (await waitUp(timeoutMs)) { up = true; return true; }
        // 分配到真正 bind 之间有窗口，可能被别的并行文件抢占：换端口重来。
        // 绝不能带着"连到了别人的实例"继续跑——那会产出看起来正常的假绿。
        if (!/EADDRINUSE/.test(stdout)) break;
        if (proc) { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } }
        s.port = await freePort();
      }
      throw new Error(`管理器没起来。stdout:\n${stdout}`);
    },
    async api(p, { method = 'GET', body, headers = {} } = {}) {
      const r = await fetch(`${s.url}${p}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      let json = null;
      try { json = await r.json(); } catch { /* 非 JSON 响应 */ }
      return { status: r.status, body: json };
    },
  };
}

export function writeRegistry(s, tasks) {
  fs.writeFileSync(path.join(s.base, 'registry.json'), JSON.stringify({ version: 1, tasks }, null, 2) + '\n', { mode: 0o600 });
}

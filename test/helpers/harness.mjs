import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');

/**
 * 建一个完全隔离的测试环境：独立数据根、独立 HOME、独立端口。
 * 生产 var/ 与真实 launchd 域永远不被触碰（docs/PRD.md 验收标准 7、8）。
 */
export function sandbox(t, { port = 4900 + (process.pid % 90) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-test-'));
  const home = path.join(root, 'home');
  const base = path.join(root, 'var');
  const shim = path.join(root, 'shim');
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
    AUTOMATION_MANAGER_PORT: String(port),
    // 测试专用标签前缀：既验证该变量真生效，又保证测试标签永不与生产 com.pikachu.automation.* 撞名
    AUTOMATION_LAUNCH_LABEL_PREFIX: 'com.pikachu.automation-selftest',
    AUTOMATION_LAUNCHCTL: path.join(shim, 'launchctl'),
    AUTOMATION_OSASCRIPT: path.join(shim, 'osascript'),
    HOME: home,
    TMPDIR: root,
    PATH: `${shim}:${process.env.PATH}`,
  };

  t.after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

  return { root, home, base, shim, port, env, url: `http://127.0.0.1:${port}` };
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

/** 起一个隔离的管理器实例，等它健康。 */
export function startServer(t, s, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(REPO, 'manager', 'server.mjs')], {
    env: { ...s.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO,
  });
  t.after(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } });

  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stdout += d; });

  return {
    proc,
    get log() { return stdout; },
    async ready(timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${s.url}/api/system`);
          if (r.ok) return true;
        } catch { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 100));
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

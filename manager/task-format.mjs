import path from 'node:path';

/**
 * 纯格式化/校验层：不碰磁盘、不碰 launchd、不读模块级全局。
 * 抽出来只为一个原因——这些函数决定了写进 LaunchAgent 的内容和静态文件的可读范围，
 * 却曾经和副作用长在 server.mjs 里，导致它们一行测试都写不了。
 */

/** XML 文本节点转义。plist 里所有值都来自登记表（用户可写），必须过这一道。 */
export function xml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 任务 ID：2-41 位，小写字母数字开头，允许连字符。它会被拼进路径与 launchd 标签。 */
export function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(id);
}

export const PORTABLE_KEYS = ['plistPath', 'logPath', 'configPath', 'profileDir', 'taskDir', 'stdoutPath', 'stderrPath'];

/** 登记表里存可移植路径（`~/...` 或相对数据根），换机器/改目录名都不用重写数据。 */
export function fromPortable(v, { base, home }) {
  if (typeof v !== 'string' || !v || v.includes('://')) return v;
  if (v.startsWith('~/')) return path.join(home, v.slice(2));
  if (v.startsWith('/') || v.startsWith('\\"')) return v;
  return path.join(base, v);
}

export function toPortable(v, { base, home }) {
  if (typeof v !== 'string' || !v) return v;
  if (v === home) return '~';
  if (v.startsWith(home + '/')) return '~/' + v.slice(home.length + 1);
  if (v.startsWith(base + '/')) return v.slice(base.length + 1);
  return v;
}

/**
 * 约定：command[0] 是解释器、command[1] 是脚本（可移植路径）、command[2+] 是参数（永不改写）。
 * 所以 `['/bin/sleep','4']` 是错的——'4' 会被当成相对路径拼上数据根。
 */
export function mapTaskPaths(task, fn) {
  const out = { ...task };
  for (const k of PORTABLE_KEYS) if (k in out) out[k] = fn(out[k]);
  if (Array.isArray(out.command) && out.command.length > 1) {
    const cmd = [...out.command];
    cmd[1] = fn(cmd[1]);
    out.command = cmd;
  }
  return out;
}

export function plistText(task, hour, minute) {
  const args = task.command.map((x) => `<string>${xml(x)}</string>`).join('');
  const out = task.stdoutPath || `${task.logPath}.launchd.out`;
  const err = task.stderrPath || `${task.logPath}.launchd.err`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${xml(task.launchLabel)}</string>\n` +
    `<key>ProgramArguments</key><array>${args}</array>\n` +
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n` +
    `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>\n` +
    `<key>ProcessType</key><string>Background</string>\n` +
    `<key>StandardOutPath</key><string>${xml(out)}</string>\n` +
    `<key>StandardErrorPath</key><string>${xml(err)}</string>\n` +
    `</dict></plist>\n`;
}

/** 静态文件解析 + 越界判定。返回 forbidden 时调用方必须回 403，不得继续拼路径。 */
export function resolveStatic(pathname, publicDir) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  const root = path.resolve(publicDir);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
    return { file: null, forbidden: true };
  }
  return { file, forbidden: false };
}

/** 同源判定：只允许本机这个端口发起写操作。 */
export function isSameOrigin(origin, port) {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** 读日志的字节窗口：起始偏移越界时收敛到文件末尾，最多取 64KB。 */
export function logWindow(from, size, maxBytes = 64 * 1024) {
  const start = Number.isFinite(from) && from >= 0 ? Math.min(from, size) : Math.max(0, size - maxBytes);
  const len = Math.min(size - start, maxBytes);
  return { start, len };
}

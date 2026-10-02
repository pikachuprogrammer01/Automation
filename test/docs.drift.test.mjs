import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const PUBLIC_DEMO = 'manager/public/demo/index.html';
const SOURCE_DEMO = 'manager/web/public/demo/index.html';
const DOCS = ['README.md', 'manager/README.md', 'docs/PRD.md'];

/** 取 <script> 里的内容；页面上的说明文字不是"会被渲染的状态"。 */
function scriptOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

describe('漂移守卫 1：演示站点的示例标记词必须真能被渲染出来', () => {
  const html = read(PUBLIC_DEMO);
  const script = scriptOf(html);
  const legend = [...html.matchAll(/页面上的([\s\S]*?)这些文案/g)].map((m) => [...m[1].matchAll(/<code>([^<]+)<\/code>/g)].map((x) => x[1]))[0] ?? [];

  test('demo 页自己的说明段不得提到页面上不会出现的文案', () => {
    assert.ok(legend.length >= 4, '说明段应列出示例标记词，数量异常说明页面被改坏');
    const ghost = legend.filter((w) => !script.includes(w));
    assert.deepEqual(ghost, [], `这些词只存在于说明文字里，页面永远不会渲染：${ghost.join('、')}`);
  });

  test('README 引用的 demo 文案必须与页面实际渲染一致', () => {
    const m = read('README.md').match(/带「([^」]+)」和「([^」]+)」/);
    assert.ok(m, 'README 里"带「A / B」和「C / D」"这个句式没了——文案挪位置就同步改这条守卫，别让它静默失效');
    const quoted = `${m[1]} ${m[2]}`.split(/[ /、]+/).filter(Boolean);
    const wrong = quoted.filter((w) => !script.includes(w) && !html.includes(`>${w}<`));
    assert.deepEqual(wrong, [], `README 里引用了 demo 页不存在的文案：${wrong.join('、')}`);
  });

  test('构建产物与源码里的 demo 必须逐字节一致', () => {
    assert.equal(read(PUBLIC_DEMO), read(SOURCE_DEMO), 'manager/public/ 是入库产物，改了一边忘改另一边 = 界面与文档静默失同步');
  });
});

describe('漂移守卫 2：文档不得用行号定位代码', () => {
  for (const doc of DOCS) {
    test(`${doc} 不含 file.ext:123 式引用`, () => {
      const hits = [...read(doc).matchAll(/[\w./-]+\.(?:mjs|js|cjs|ts|tsx|sh|zsh|html):\d+/g)].map((m) => m[0]);
      assert.deepEqual(hits, [], '行号会随每次改动腐烂（今天 README 里的 server.mjs:18 就已经指错）。用符号名或常量名指代。');
    });
  }
});

describe('漂移守卫 3：环境变量表与代码双向一致', () => {
  // 由包装脚本自己传给子进程的运行时契约，不是用户配置，不进 README 表。
  const RUNTIME_CONTRACT = new Set([
    'AUTOMATION_BASE', 'AUTOMATION_TASK', 'AUTOMATION_SITE', 'AUTOMATION_ACCOUNT_KEY',
    'AUTOMATION_RUN_ID', 'AUTOMATION_STARTED_AT', 'AUTOMATION_TRIGGER', 'AUTOMATION_NOTIFY',
    'AUTOMATION_EXIT_CODE', 'AUTOMATION_PID', 'AUTOMATION_MANAGER_LABEL', 'AUTOMATION_LOCK_STALE',
  ]);
  const codeVars = new Set();
  for (const f of ['manager/server.mjs', 'manager/automation-log.mjs', 'manager/run-record.mjs', 'manager/install-launchagent', 'manager/open-manager', 'manager/run-recorded-task', 'lib/run-result.mjs', 'lib/automation-run.zsh']) {
    for (const m of read(f).matchAll(/(?:process\.env\.|env\.|\$\{?)(AUTOMATION_[A-Z_]+|NODE_BIN|PW_HEADLESS)\b/g)) codeVars.add(m[1]);
  }
  const userVars = new Set([...codeVars].filter((v) => !RUNTIME_CONTRACT.has(v)));
  const table = read('README.md').match(/## 环境变量一览([\s\S]*?)\n## /)[1];
  const docVars = new Set([...table.matchAll(/^\| `(AUTOMATION_[A-Z_]+|NODE_BIN|PW_HEADLESS)`/gm)].map((m) => m[1]));

  test('用户可设的变量都在表里', () => {
    const missing = [...userVars].filter((v) => !docVars.has(v));
    assert.deepEqual(missing, [], `代码在用但文档没写：${missing.join('、')}`);
  });
  test('表里写的变量代码真在用', () => {
    const stale = [...docVars].filter((v) => !codeVars.has(v));
    assert.deepEqual(stale, [], `文档写了但没人读：${stale.join('、')}`);
  });
  test('运行时契约变量不得混进用户配置表', () => {
    const mixed = [...docVars].filter((v) => RUNTIME_CONTRACT.has(v));
    assert.deepEqual(mixed, [], `${mixed.join('、')} 是脚本间传值，写进用户表会让人以为可以手动设`);
  });
  test('登记表的默认位置必须跟着数据根走（本次重组的 D2 决策）', () => {
    const server = read('manager/server.mjs');
    assert.match(server, /AUTOMATION_MANAGER_REGISTRY \|\| path\.join\(BASE, 'registry\.json'\)/,
      'registry 默认一旦退回 path.join(ROOT, ...)，README「一个变量就够」的说明立刻变成谎话');
    assert.doesNotMatch(server, /不受 AUTOMATION_HOME 影响/, '过时的警告文案不得回来');
  });
});

describe('漂移守卫 4：文档指出的路径必须存在', () => {
  const RUNTIME_ZONE = /^(var|private)\//;   // 克隆下来是空的，由使用者自己填
  const resolves = (doc, p) => fs.existsSync(path.join(REPO, p)) || fs.existsSync(path.join(REPO, path.dirname(doc), p));
  for (const doc of DOCS) {
    test(`${doc} 里指代的仓内文件都真的存在`, () => {
      const files = [...read(doc).matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.(?:mjs|js|cjs|ts|tsx|json|html|md|zsh|sh|png))`/g)]
        .map((m) => m[1]).filter((p) => !RUNTIME_ZONE.test(p) && !p.includes('~') && !p.includes('$'));
      const bad = files.filter((p) => !resolves(doc, p));
      assert.deepEqual(bad, [], `文档指向不存在的文件：${bad.join('、')}`);
    });
    test(`${doc} 里带斜杠的目录名都真的存在`, () => {
      const dirs = [...read(doc).matchAll(/`((?:manager|lib|docs)\/[\w.-]+\/)`/g)].map((m) => m[1]);
      const bad = [...new Set(dirs)].filter((p) => !fs.existsSync(path.join(REPO, p)));
      assert.deepEqual(bad, [], `文档提到不存在的目录：${bad.join('、')}`);
    });
  }
});

describe('漂移守卫 5：私有层守卫不得退回本地配置', () => {
  test('入库的 .gitignore 必须挡住 private/ 与 var/', () => {
    const gi = read('.gitignore');
    assert.match(gi, /^private\/$/m, '缺这行，一次 git add -A 就会把站点名写进 git 历史');
    assert.match(gi, /^var\/$/m, '缺这行，真实账号与浏览器登录态会被提交');
  });

  test('.git/info/exclude 不得成为唯一的守卫', () => {
    const p = path.join(REPO, '.git/info/exclude');
    if (!fs.existsSync(p)) return;
    const body = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    assert.deepEqual(body, [], '本地 exclude 里的条目不随仓库走；边界规则必须放在入库的 .gitignore');
  });

  test('公开 .gitignore 里不得出现任何站点名', () => {
    const gi = read('.gitignore');
    const leaked = [...gi.matchAll(/^(?:loveapi|modelscope)\b.*$/gmi)].map((m) => m[0]);
    assert.deepEqual(leaked, [], '守卫规则本身一旦写出站点目录名，就等于把站点名放进发布仓');
  });
});

describe('漂移守卫 7：README 引用的界面按钮名必须真的在界面上', () => {
  const bundle = fs.readdirSync(path.join(REPO, 'manager/public/assets'))
    .filter((n) => n.endsWith('.js')).map((n) => read(`manager/public/assets/${n}`)).join('\n');

  test('录制四步与主要操作按钮的文案对得上', () => {
    const labels = ['新建自动化', '准备登录', '开始录制', '打开代码', '可视化测试', '立即运行', '启用', '暂停', '修改时间', '移除定时', '彻底删除', '看输出'];
    const missing = labels.filter((l) => !bundle.includes(l));
    assert.deepEqual(missing, [], `README 教用户点的按钮在界面产物里找不到：${missing.join('、')}（改名要同步改文档）`);
  });

  test('界面连接状态四态与文档口径一致', () => {
    for (const s of ['管理器运行中', '管理器已关闭', '连接中断', '后端异常']) {
      assert.ok(bundle.includes(s), `docs/PRD.md 承诺的连接状态「${s}」不在界面里`);
    }
  });
});

describe('漂移守卫 8：接口清单与文档对得上', () => {
  const server = read('manager/server.mjs');
  // 后端是正则路由（/^\/api\/tasks\/([a-z0-9-]+)\/(run|enable|...)$/），源码里不存在
  // "/api/tasks/:id/run" 这种字面串，所以只能按「前缀 + 动作词」校验，别改成字面匹配。
  test('文档写出的接口路径都被后端实现', () => {
    const documented = new Set();
    for (const doc of ['README.md', 'manager/README.md', 'docs/PRD.md']) {
      for (const m of read(doc).matchAll(/`(GET|POST) (\/api[\w/{}:.-]*)`/g)) documented.add(`${m[1]} ${m[2]}`);
    }
    assert.ok(documented.size >= 4, '一条接口都没从文档里抓到，守卫本身失效了');
    const missing = [...documented].filter((entry) => {
      const [, p] = entry.split(' ');
      const path = p.split('?')[0].replace(/<[^>]*>/g, '');
      const segs = path.split('/').filter(Boolean);              // api, tasks, :id, run
      const prefix = `/${segs.slice(0, 2).join('/')}`;            // /api/tasks
      const action = segs.length > 3 ? segs[segs.length - 1] : null;
      if (!server.includes(prefix)) return true;
      if (action && !new RegExp(`\\b${action}\\b`).test(server)) return true;
      return false;
    });
    assert.deepEqual(missing, [], `文档写了但后端没有：${missing.join('、')}`);
  });
});

describe('漂移守卫 6：数据根只允许一处定义', () => {
  test('manager/ 与 lib/ 不得自己推导 AUTOMATION_HOME 的默认值', () => {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(REPO, 'manager')).filter((n) => n.endsWith('.mjs'))) {
      const body = read(path.join('manager', f));
      if (/process\.env\.AUTOMATION_HOME\s|\|\|\s*path\.dirname\(ROOT\)/.test(body)) offenders.push(`manager/${f}`);
    }
    for (const f of fs.readdirSync(path.join(REPO, 'lib')).filter((n) => n.endsWith('.mjs'))) {
      const body = read(path.join('lib', f));
      const hits = (body.match(/process\.env\.AUTOMATION_HOME/g) || []).length;
      if (hits > 1) offenders.push(`lib/${f}`);
    }
    assert.deepEqual(offenders, [], '数据根必须只在 lib/run-result.mjs 的 baseDir() 里定义；两处定义就是"两个变量都要设"那个脚枪的根因');
  });
});

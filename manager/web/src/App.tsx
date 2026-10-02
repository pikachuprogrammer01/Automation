import { PlusOutlined, PoweroffOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Alert, Button, Col, Collapse, Empty, Row, Space, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { api, currentPort } from './api';
import { NewTaskModal, PurgeModal, ScheduleModal } from './Modals';
import RunPanel from './RunPanel';
import TaskCard, { recordLabel } from './TaskCard';
import type { CardAction } from './TaskCard';
import { clockText, phaseMeta } from './status';
import type { Task } from './types';
import { useManagerState } from './useManagerState';

const FAIL_LABEL: Record<CardAction, string> = {
  run: '无法启动运行',
  enable: '启用失败',
  disable: '暂停失败',
  remove: '移除定时失败',
  login: '无法打开登录窗口',
  record: '录制器启动失败',
  open: '无法打开代码',
  test: '可视化测试启动失败',
};

const GUIDE = [
  '点「新建自动化」，填名称和网址。',
  '点「① 准备登录」，在弹出的专属 Chrome 里登录，然后关闭该窗口。',
  '点「② 开始录制」，完成操作后关闭录制窗口。',
  '点「③ 打开代码」可以在编辑器里继续改。',
  '点「④ 可视化测试」确认流程能跑通。',
  '用「修改时间」设定每天执行时间，或「暂停」临时停掉。',
];

export default function Manager() {
  const { message, notification } = AntApp.useApp();
  const { snap, busy, controls } = useManagerState();
  const { phase, tasks, detail, lastSync } = snap;
  const meta = phaseMeta(phase);
  const locked = phase === 'closed';

  const [pending, setPending] = useState<{ id: string; action: CardAction } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [scheduleTask, setScheduleTask] = useState<Task | null>(null);
  const [purgeTask, setPurgeTask] = useState<Task | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const call = async (fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => {
    try {
      const res = await fn();
      message.success(typeof ok === 'function' ? ok(res) : ok, 5);
      return true;
    } catch (e) {
      notification.error({
        message: (e as Error).message || '请求失败',
        description: '管理器仍在运行，可以点「刷新」重试；反复失败请看 var/logs/automation-manager.err。',
        duration: 9,
      });
      return false;
    }
  };

  const scheduleOf = (t: Task) => {
    const s = t.schedule;
    return s && !Number.isNaN(s.hour) ? `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` : '未设置';
  };

  const runAction = async (task: Task, action: CardAction) => {
    setPending({ id: task.id, action });
    const withPid = (label: string) => (r: unknown) => {
      const pid = (r as { pid?: number })?.pid;
      return pid ? `${label}（PID ${pid}）` : label;
    };
    const spec: Record<CardAction, [() => Promise<unknown>, (r: unknown) => string]> = {
      run: [() => api.run(task.id), withPid(`${task.name} 已开始运行，右侧已打开实时输出面板`)],
      enable: [() => api.enable(task.id), () => `${task.name} 已启用，每天 ${scheduleOf(task)} 执行`],
      disable: [() => api.disable(task.id), () => `${task.name} 已暂停；launchd 已卸载，脚本和账号都保留`],
      remove: [() => api.remove(task.id), () => `${task.name} 的定时已移除；脚本、凭据和浏览器数据都保留`],
      login: [() => api.recording(task.id, 'login'), withPid(recordLabel('login'))],
      record: [() => api.recording(task.id, 'record'), withPid(recordLabel('record'))],
      open: [() => api.recording(task.id, 'open'), () => recordLabel('open')],
      test: [() => api.recording(task.id, 'test'), withPid(`${recordLabel('test')}，右侧已打开实时输出面板`)],
    };
    const [fn, ok] = spec[action];
    try {
      const res = await fn();
      message.success(ok(res), 5);
      if (action === 'run' || action === 'test') setPanelId(task.id);
    } catch (e) {
      notification.error({
        message: `${task.name} · ${FAIL_LABEL[action]}`,
        description: (e as Error).message,
        duration: 9,
      });
    } finally {
      setPending(null);
      controls.current.refresh();
    }
  };

  const createTask = async (v: { name: string; id: string; url: string; blank: boolean }) => {
    setCreating(true);
    const done = await call(() => api.create(v), () => (v.blank
      ? `${v.name} 已创建，可直接「打开代码」编写。`
      : `${v.name} 已创建。建议先「准备登录」，再「开始录制」。`));
    setCreating(false);
    if (done) {
      setNewOpen(false);
      controls.current.refresh();
    }
  };

  const saveSchedule = async (hour: number, minute: number) => {
    if (!scheduleTask) return;
    setSavingSchedule(true);
    const done = await call(
      () => api.schedule(scheduleTask.id, hour, minute),
      () => `${scheduleTask.name} 的执行时间已保存并启用（每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}）`,
    );
    setSavingSchedule(false);
    if (done) {
      setScheduleTask(null);
      controls.current.refresh();
    }
  };

  const purge = async (v: { deleteCredential: boolean; deleteProfile: boolean; deleteLogs: boolean }, confirm: string) => {
    if (!purgeTask) return;
    setPurging(true);
    const done = await call(
      () => api.purge(purgeTask.id, { ...v, confirm }),
      () => `${purgeTask.name} 已彻底删除${v.deleteCredential ? '（含 Keychain 凭据）' : ''}${v.deleteProfile ? '（含浏览器 Profile）' : ''}${v.deleteLogs ? '（含日志）' : ''}`,
    );
    setPurging(false);
    if (done) {
      setPurgeTask(null);
      controls.current.refresh();
    }
  };

  const allKeychain = tasks.length > 0 && tasks.every((t) => t.credentialBackend === 'macOS Keychain');

  return (
    <div className="shell">
      <header className="head">
        <div>
          <Typography.Text className="eyebrow">LOCAL AUTOMATION</Typography.Text>
          <Typography.Title level={2} style={{ margin: '6px 0 4px' }}>自动化管理器</Typography.Title>
          <Typography.Text type="secondary">录制、测试、定时、暂停和清理，都在这里完成。</Typography.Text>
        </div>
        <Space direction="vertical" align="end" size={10}>
          <Space size={8} wrap>
            <Tooltip title={lastSync ? `最近同步 ${clockText(lastSync)}` : '尚未成功同步'}>
              <Tag color={meta.color} data-testid="status-pill">{meta.label}</Tag>
            </Tooltip>
            <Tooltip title={allKeychain ? '所有任务的密码都在 macOS Keychain，运行不依赖 Docker' : '有任务的凭据不是 macOS Keychain，点卡片上的凭据栏看详情'}>
              <Tag color={allKeychain ? 'success' : 'default'}>
                {tasks.length === 0 ? '暂无任务' : allKeychain ? '凭据 macOS Keychain' : '凭据 混合'}
              </Tag>
            </Tooltip>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={busy.refreshing} onClick={() => controls.current.refresh()}>刷新</Button>
            <Button icon={<PoweroffOutlined />} loading={busy.shuttingDown} disabled={locked} onClick={() => controls.current.shutDown()}>
              关闭管理器
            </Button>
            <Button type="primary" icon={<PlusOutlined />} disabled={locked} onClick={() => setNewOpen(true)}>新建自动化</Button>
          </Space>
        </Space>
      </header>

      {phase !== 'ok' ? (
        <Alert
          className="state-alert"
          type={meta.alertType}
          showIcon
          message={meta.heading}
          description={meta.body(detail)}
          data-testid="state-banner"
          action={phase === 'lost' || phase === 'backend'
            ? <Button size="small" loading={busy.refreshing} onClick={() => controls.current.refresh()}>立即重试</Button>
            : undefined}
        />
      ) : null}

      <Collapse
        style={{ marginTop: 20 }}
        items={[{
          key: 'guide',
          label: '第一次自己录制？点这里看流程',
          children: <ol className="guide">{GUIDE.map((g) => <li key={g}>{g}</li>)}</ol>,
        }]}
      />

      <div className="section-head">
        <Typography.Title level={4} style={{ margin: 0 }}>我的自动化</Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tasks.length ? `${tasks.length} 个任务 · 每 5 秒同步` : '暂无任务'}
        </Typography.Text>
      </div>

      {tasks.length === 0 ? (
        <Empty description="还没有任务" style={{ marginTop: 24 }}>
          <Button type="primary" icon={<PlusOutlined />} disabled={locked} onClick={() => setNewOpen(true)}>新建自动化</Button>
        </Empty>
      ) : (
        <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
          {tasks.map((t) => (
            <Col key={t.id} xs={24} lg={12} xxl={8}>
              <TaskCard
                task={t}
                locked={locked}
                pending={pending?.id === t.id ? pending.action : null}
                onAction={runAction}
                onSchedule={setScheduleTask}
                onPurge={setPurgeTask}
                onShowLog={(t) => setPanelId(t.id)}
              />
            </Col>
          ))}
        </Row>
      )}

      <footer className="foot">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          管理器只监听 127.0.0.1:{currentPort()}，不对外网开放；关闭管理器不会影响 launchd 每日签到。
        </Typography.Text>
      </footer>

      <NewTaskModal
        open={newOpen}
        loading={creating}
        initialId={`task-${String(Date.now()).slice(-6)}`}
        onCancel={() => setNewOpen(false)}
        onSubmit={createTask}
      />
      <ScheduleModal
        task={scheduleTask}
        open={scheduleTask !== null}
        loading={savingSchedule}
        onCancel={() => setScheduleTask(null)}
        onSubmit={saveSchedule}
      />
      <RunPanel task={tasks.find((t) => t.id === panelId) ?? null} onClose={() => setPanelId(null)} />

      <PurgeModal
        task={purgeTask}
        open={purgeTask !== null}
        loading={purging}
        onCancel={() => setPurgeTask(null)}
        onSubmit={purge}
      />
    </div>
  );
}

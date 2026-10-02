import {
  CodeOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  LoginOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Alert, Badge, Button, Card, Descriptions, Divider, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { elapsedText, scheduleText, startedText, taskState } from './status';
import type { Task } from './types';

export type CardAction = 'run' | 'enable' | 'disable' | 'remove' | 'login' | 'record' | 'open' | 'test';

interface Props {
  task: Task;
  pending: CardAction | null;
  locked: boolean;
  onAction: (task: Task, action: CardAction) => void;
  onSchedule: (task: Task) => void;
  onPurge: (task: Task) => void;
  onShowLog: (task: Task) => void;
}

const SPAWN_ACTIONS: CardAction[] = ['run', 'login', 'record', 'test'];

/** “上次运行中：成功” 读起来很怪，展示时去掉尾部的“中”。 */
function runLabel(kind: string) {
  return kind.replace(/中$/, '');
}

const RECORD_LABEL: Record<string, string> = {
  login: '已打开专属 Chrome。完成登录后关闭该窗口，登录状态会自动保存。',
  record: '录制器已启动。操作完成后关闭录制窗口，代码会写入 recorded.spec.js。',
  open: '已在编辑器中打开脚本。',
  test: '可视化测试已启动。',
};

export function recordLabel(action: string) {
  return RECORD_LABEL[action] ?? '';
}

export default function TaskCard({ task, pending, locked, onAction, onSchedule, onPurge, onShowLog }: Props) {
  const st = taskState(task);
  const busy = pending !== null;
  /** 管理器主动关闭时所有写操作都不可用；同一张卡片上只允许一个动作在飞。 */
  // 后端对同一任务只允许一个托管进程（task_busy），前端直接把这几个按钮按住，而不是点了再报错。
  const spawned = Boolean(task.active);
  const dis = (self: CardAction) => locked || (busy && pending !== self) || (spawned && SPAWN_ACTIONS.includes(self));

  return (
    <Card
      style={{ height: '100%' }}
      title={
        <Space direction="vertical" size={0}>
          {task.site ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{task.site}</Typography.Text> : null}
          <Typography.Text strong style={{ fontSize: 17 }}>{task.name}</Typography.Text>
        </Space>
      }
      extra={<Badge status={st.badge} text={st.text} />}
    >
      <Descriptions size="small" column={2} items={[
        { key: 'time', label: '每天执行', children: scheduleText(task.schedule) },
        { key: 'cred', label: '凭据 / 登录状态', children: task.credentialBackend },
        { key: 'id', label: '任务 ID', children: <Typography.Text code>{task.id}</Typography.Text> },
        { key: 'label', label: 'launchd 标签', children: task.launchLabel ?? '—' },
      ]} />

      {task.active ? (
        <Alert
          style={{ margin: '8px 0 0' }}
          type="info"
          showIcon
          message={`${task.active.kind} · 开始于 ${startedText(task.active.startedAt)} · PID ${task.active.pid} · 已跑 ${elapsedText(task.active.startedAt) || '0 秒'}`}
          description="管理器在跟踪这个进程，下面是它的运行输出。"
          action={<Button size="small" onClick={() => onShowLog(task)}>查看实时输出</Button>}
        />
      ) : null}

      {!task.active && task.lastRun ? (
        <Alert
          style={{ margin: '8px 0 0' }}
          type={task.lastRun.ok ? 'success' : 'error'}
          showIcon
          message={`上次${runLabel(task.lastRun.kind)}：${task.lastRun.ok ? '成功' : `失败（退出码 ${task.lastRun.code ?? '未知'}）`} · ${startedText(task.lastRun.startedAt)} · 用时 ${elapsedText(task.lastRun.startedAt, task.lastRun.endedAt) || '未知'}`}
          action={<Button size="small" onClick={() => onShowLog(task)}>看输出</Button>}
        />
      ) : null}

      <Typography.Paragraph
        style={{ margin: '12px 0 0', fontSize: 12 }}
        type="secondary"
      >
        最近日志：
      </Typography.Paragraph>
      <Tooltip title={task.lastLog || '暂无运行日志'}>
        <Typography.Paragraph
          className="task-log"
          code
          ellipsis={{ rows: 2, expandable: false }}
        >
          {task.lastLog || '暂无运行日志'}
        </Typography.Paragraph>
      </Tooltip>

      <Space wrap style={{ marginTop: 14 }}>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={pending === 'run'}
          disabled={dis('run')}
          onClick={() => onAction(task, 'run')}
        >
          立即运行
        </Button>
        <Button
          icon={task.loaded ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          loading={pending === 'enable' || pending === 'disable'}
          disabled={dis('enable')}
          onClick={() => onAction(task, task.loaded ? 'disable' : 'enable')}
        >
          {task.loaded ? '暂停' : '启用'}
        </Button>
        <Button
          icon={<FieldTimeOutlined />}
          disabled={locked}
          onClick={() => onSchedule(task)}
        >
          修改时间
        </Button>
        {task.plistExists ? (
          <Popconfirm
            title="移除定时任务？"
            description="只解除 launchd 定时。脚本、账号凭据和浏览器数据都会保留。"
            okText="移除定时"
            cancelText="取消"
            disabled={dis('remove')}
            onConfirm={() => onAction(task, 'remove')}
          >
            <Button loading={pending === 'remove'} disabled={dis('remove')}>移除定时</Button>
          </Popconfirm>
        ) : null}
        <Button danger disabled={locked} onClick={() => onPurge(task)}>彻底删除</Button>
      </Space>

      {task.type === 'recorded' ? (
        <>
          <Divider style={{ margin: '14px 0 10px' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>自己录制 / 编写</Typography.Text>
          <Space wrap style={{ marginTop: 8 }}>
            <Button icon={<LoginOutlined />} loading={pending === 'login'} disabled={dis('login')} onClick={() => onAction(task, 'login')}>
              ① 准备登录
            </Button>
            <Button icon={<VideoCameraOutlined />} loading={pending === 'record'} disabled={dis('record')} onClick={() => onAction(task, 'record')}>
              ② 开始录制
            </Button>
            <Button icon={<CodeOutlined />} loading={pending === 'open'} disabled={dis('open')} onClick={() => onAction(task, 'open')}>
              ③ 打开代码
            </Button>
            <Button icon={<ExperimentOutlined />} loading={pending === 'test'} disabled={dis('test')} onClick={() => onAction(task, 'test')}>
              ④ 可视化测试
            </Button>
          </Space>
        </>
      ) : null}

      {locked ? <Tag style={{ marginTop: 12 }} color="warning">管理器已关闭，操作暂时不可用</Tag> : null}
    </Card>
  );
}
